/**
 * Reactive Svelte store wrapping the document-level parameter table.
 *
 * Source of truth: `doc.parameters` on the v4 DocumentStore (an
 * `{ id → ParamDef }` map, *not* features — see lib/document/types.js's
 * `emptyDocument()` / `makeParameter()`). Despite the Foundation 5 spec
 * mentioning Parameter/Equation feature types, the actual v4 catalog
 * persists parameters in `doc.parameters` with `{ id, name, value, unit,
 * equation }`. We mirror that exactly — no duplicate state, no extra
 * features.
 *
 * Mutations route back through the v4 operations layer
 * (`addDocumentParameter`, `setDocumentParameter`, `removeDocumentParameter`)
 * so every edit lands in the changelog with undo/redo support.
 *
 * Evaluation: expressions are parsed + evaluated via
 * `src/lib/parameters/expression.js`. The whole table is recomputed on
 * every store notify, using a Kahn topological sort over the dep graph
 * extracted from each `equation`. Anything left unsorted has a cycle
 * and is flagged with `error: 'circular dependency'`.
 */

import { getDocumentStore } from '../../../lib/document/store.js';
import {
  addDocumentParameter as v4AddDocumentParameter,
  setDocumentParameter as v4SetDocumentParameter,
  removeDocumentParameter as v4RemoveDocumentParameter,
} from '../../../lib/document/operations.js';
import { evaluate, extractDeps, validate, parse } from './expression.js';

// ── Reactive surface ─────────────────────────────────────────────────────────

/**
 * Reactive parameter table.
 *
 * Components read `parameters.items` and re-render automatically when the
 * underlying document store commits a change.
 *
 * @type {{ items: ParamRow[] }}
 */
export const parameters = $state({ items: [] });

// Non-reactive caches consumed by getScope() / getDependents() / evaluateInScope().
// These mirror `parameters.items` but stay plain objects so the
// non-Svelte executor / emit pipeline can read them without a runtime
// dependency on Svelte's reactivity.
let _scope = Object.create(null);                 // { name → value-in-mm } (error-free only)
let _dependents = new Map();                      // paramName → Set<consumerFeatureId>
let _rows = [];                                   // plain copy of parameters.items

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeExtractDeps(expr) {
  try { return extractDeps(expr); }
  catch { return []; }
}

/**
 * Topologically sort the parameter rows by their declared dep graph using
 * Kahn's algorithm. Returns `{ order, cyclic }` where `order` is the list
 * of param names in evaluation order and `cyclic` is the Set of names that
 * couldn't be sorted (i.e. they participate in a cycle).
 *
 * @param {Array<{name: string, deps: string[]}>} entries
 */
function topoSort(entries) {
  const nameSet = new Set(entries.map(e => e.name));
  // Only count deps that point at known parameters — unknown identifiers
  // (typos, missing params, function args) are evaluator errors, not cycle
  // candidates, and shouldn't block sorting.
  const indeg = new Map();
  const fanOut = new Map();
  for (const e of entries) {
    indeg.set(e.name, 0);
    fanOut.set(e.name, []);
  }
  for (const e of entries) {
    for (const d of e.deps) {
      if (nameSet.has(d) && d !== e.name) {
        indeg.set(e.name, indeg.get(e.name) + 1);
        fanOut.get(d).push(e.name);
      } else if (d === e.name) {
        // Self-reference is trivially a cycle.
        indeg.set(e.name, indeg.get(e.name) + 1);
      }
    }
  }
  const order = [];
  const ready = [];
  for (const [name, deg] of indeg) if (deg === 0) ready.push(name);
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const m of fanOut.get(n) || []) {
      const d = indeg.get(m) - 1;
      indeg.set(m, d);
      if (d === 0) ready.push(m);
    }
  }
  const cyclic = new Set();
  for (const [name, deg] of indeg) if (deg > 0) cyclic.add(name);
  return { order, cyclic };
}

/**
 * Recompute the full parameter table from `doc.parameters`. Builds
 * `parameters.items` (the reactive view) and the supporting `_scope` +
 * `_dependents` caches.
 *
 * @param {Document} doc
 */
function recompute(doc) {
  const paramMap = doc?.parameters || {};
  const raw = Object.values(paramMap);

  // Build the seed entries — each row carries its declared deps and the
  // index back into the raw map so we can look it up later by name.
  const byName = new Map();
  const entries = raw.map(p => {
    const equation = (typeof p.equation === 'string' && p.equation.trim() !== '')
      ? p.equation
      : null;
    const deps = equation ? safeExtractDeps(equation) : [];
    const entry = {
      id: p.id,
      name: p.name,
      equation,
      unit: p.unit || 'mm',
      literalValue: typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : 0,
      deps,
    };
    byName.set(p.name, entry);
    return entry;
  });

  const { order, cyclic } = topoSort(entries);

  // Walk the sorted entries left → right, accumulating an evaluation scope
  // as we go. Rows with cycles or evaluation errors land with `error` set
  // and are kept out of the scope so dependents on them fail cleanly.
  const scope = Object.create(null);
  const rowsByName = new Map();

  for (const name of order) {
    const e = byName.get(name);
    if (!e.equation) {
      const v = e.literalValue;
      scope[e.name] = v;
      rowsByName.set(e.name, {
        id: e.id, name: e.name, expression: null, value: v,
        unit: e.unit, dependsOn: [],
      });
      continue;
    }
    try {
      const v = evaluate(e.equation, scope);
      if (!Number.isFinite(v)) throw new Error('non-finite result');
      scope[e.name] = v;
      rowsByName.set(e.name, {
        id: e.id, name: e.name, expression: e.equation, value: v,
        unit: e.unit, dependsOn: e.deps,
      });
    } catch (err) {
      rowsByName.set(e.name, {
        id: e.id, name: e.name, expression: e.equation,
        value: e.literalValue, unit: e.unit, dependsOn: e.deps,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  // Cyclic rows weren't reached by the sort — flag them explicitly.
  for (const name of cyclic) {
    const e = byName.get(name);
    rowsByName.set(e.name, {
      id: e.id, name: e.name, expression: e.equation,
      value: e.literalValue, unit: e.unit, dependsOn: e.deps,
      error: 'circular dependency',
    });
  }

  // Preserve the document's authored order (Object.values keeps insertion
  // order for string keys in modern engines).
  const nextRows = raw.map(p => rowsByName.get(p.name)).filter(Boolean);

  // Build reverse-index for getDependents(): paramName → consumerFeatureIds.
  // v1 covers parameter-on-parameter dependencies; feature consumers will be
  // wired in once feature forms learn to read expressions (Foundation 5 step
  // 2). Punted on for now — flagged in the report.
  const dependents = new Map();
  for (const row of nextRows) {
    for (const dep of row.dependsOn || []) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(row.id);
    }
  }

  _rows = nextRows;
  _scope = scope;
  _dependents = dependents;
  parameters.items = nextRows;
}

// ── Wire-up to the document store ────────────────────────────────────────────

let _bound = false;
function ensureBound() {
  if (_bound) return;
  _bound = true;
  const store = getDocumentStore();
  recompute(store.doc);
  store.subscribe((doc) => recompute(doc));
}
ensureBound();

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Add a new document-level parameter. `exprOrValue` may be a literal number
 * (stored as `{ value, equation: null }`) or a string expression (stored
 * with `equation: <string>` and `value` set to the evaluated number, falling
 * back to 0 if it fails to parse).
 *
 * @param {string} name
 * @param {string|number} exprOrValue
 * @param {string} [unit]
 * @returns {string} the new feature/parameter id
 */
export function addParameter(name, exprOrValue, unit = 'mm') {
  let value = 0;
  let equation = null;

  if (typeof exprOrValue === 'number') {
    value = Number.isFinite(exprOrValue) ? exprOrValue : 0;
  } else if (typeof exprOrValue === 'string' && exprOrValue.trim() !== '') {
    // Try parsing as a bare literal first ("4mm", "12") → store as value.
    // Otherwise treat it as an expression.
    const text = exprOrValue.trim();
    const isBareLiteral = /^[+-]?(\d+\.?\d*|\.\d+)([a-zA-Z]+)?$/.test(text);
    if (isBareLiteral) {
      try { value = evaluate(text, _scope); }
      catch { value = 0; }
    } else {
      equation = text;
      try { value = evaluate(text, _scope); }
      catch { value = 0; }
    }
  }

  const p = v4AddDocumentParameter(name, value, unit, equation);
  return p.id;
}

/**
 * Update an existing parameter. `patch` may carry any of `name`,
 * `expression` (mapped to `equation` on the doc), `unit`, or a literal
 * `value`. When `expression` is provided we re-evaluate it in the current
 * scope and write the result through as `value` too.
 *
 * @param {string} id
 * @param {{name?: string, expression?: string|null, unit?: string, value?: number}} patch
 */
export function updateParameter(id, patch = {}) {
  const docPatch = {};
  if (typeof patch.name === 'string') docPatch.name = patch.name;
  if (typeof patch.unit === 'string') docPatch.unit = patch.unit;

  if ('expression' in patch) {
    const expr = patch.expression;
    if (expr == null || expr === '') {
      docPatch.equation = null;
    } else {
      docPatch.equation = String(expr);
      try {
        const v = evaluate(String(expr), _scope);
        if (Number.isFinite(v)) docPatch.value = v;
      } catch { /* leave value untouched; recompute will flag the error */ }
    }
  }
  if (typeof patch.value === 'number' && Number.isFinite(patch.value)) {
    docPatch.value = patch.value;
  }

  v4SetDocumentParameter(id, docPatch);
}

/** Remove a parameter by id (or name — operations.js accepts either). */
export function removeParameter(id) {
  v4RemoveDocumentParameter(id);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Evaluate a free-form expression against the current parameter scope.
 * Always returns a `{ value, error? }` object — never throws — so feature
 * form fields can call it on every keystroke.
 */
export function evaluateInScope(expression) {
  if (expression == null || expression === '') {
    return { value: 0, error: 'empty expression' };
  }
  try {
    const v = evaluate(String(expression), _scope);
    if (!Number.isFinite(v)) return { value: 0, error: 'non-finite result' };
    return { value: v };
  } catch (e) {
    return { value: 0, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Live scope `{ name → value-in-mm }` for non-Svelte consumers (executor,
 * emit pipeline). Only error-free rows are exposed; rows with an `error`
 * are omitted so downstream evaluations fail loudly instead of silently
 * inheriting stale values.
 */
export function getScope() {
  return { ..._scope };
}

/**
 * Quick validation used by the dialog while the user types. Reports
 * parse validity, the evaluated number (when it parses), the dep list,
 * and — crucially — whether adding/updating this expression would create
 * a cycle in the parameter graph.
 *
 * @param {string} expression
 * @param {string} [ownerName] — the parameter name being edited, so we can
 *   detect cycles introduced by a self-reference or a back-edge.
 */
export function validateExpression(expression, ownerName = null) {
  const v = validate(expression);
  if (!v.valid) return { valid: false, error: v.error };

  let deps = [];
  try { deps = extractDeps(expression); } catch { deps = []; }

  // Cycle test: pretend the owner's deps are replaced with these new deps
  // and re-run the topological sort. If the owner ends up in the cyclic
  // set, this expression introduces a cycle.
  let circular = false;
  if (ownerName) {
    const entries = _rows.map(r => ({
      name: r.name,
      deps: r.name === ownerName ? deps : (r.dependsOn || []),
    }));
    if (!entries.some(e => e.name === ownerName)) {
      // New parameter being previewed — add it.
      entries.push({ name: ownerName, deps });
    }
    const { cyclic } = topoSort(entries);
    circular = cyclic.has(ownerName);
  }

  let evaluated;
  let error;
  try {
    const val = evaluate(expression, _scope);
    if (Number.isFinite(val)) evaluated = val;
    else error = 'non-finite result';
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }

  return {
    valid: !circular && error === undefined,
    evaluated,
    deps,
    error,
    circular,
  };
}

/**
 * Reverse-index lookup: which feature ids depend on `name`?
 *
 * v1 only tracks parameter-on-parameter dependencies (one parameter's
 * `equation` referencing another). Feature-on-parameter tracking lands
 * once feature forms learn to evaluate expressions and the document
 * carries a `paramRefs` field per feature.
 */
export function getDependents(name) {
  const set = _dependents.get(name);
  return set ? Array.from(set) : [];
}

// Re-export the expression helpers so dialog callers have one import.
export { parse, evaluate, extractDeps, validate } from './expression.js';
