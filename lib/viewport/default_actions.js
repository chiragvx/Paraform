/**
 * Default action catalogue — view/selection/document/feature actions
 * registered into the ActionRegistry at app boot.
 *
 * Each action closes over the ctx supplied at execution time (not at
 * registration time). The ctx must carry:
 *
 *   ctx.viewportCtl  : { home, goView, smartFit, normalTo, controls }
 *   ctx.ops          : v4 ops bag — addBox, addCylinder, addExtrude, …
 *   ctx.bridge       : v4 bridge (for runNow on edits)
 *   ctx.store        : v4 DocumentStore
 *   ctx.selection    : PickingSelection
 *   ctx.toast        : (msg, kind?) => void
 *   ctx.enterSketch  : (planeName) => void   // optional — host provides
 *   ctx.sketchActive : boolean
 */

import { makeFeature } from '../document/types.js';

const hasSelection = (ctx) => ctx.selection && ctx.selection.size > 0;
const noSketch     = (ctx) => !ctx.sketchActive;

/**
 * Pull the feature id that owns the picked entries. Modifier features
 * (Fillet / Chamfer / Shell / Hole) need a single target body; if the
 * selection spans multiple bodies the action toasts and aborts.
 */
function targetBodyIdFromSelection(selection) {
    if (!selection || selection.size === 0) return null;
    const ids = new Set();
    for (const entry of selection.toArray()) {
        const desc = entry && entry.descriptor;
        const fid = (desc && (desc.feature || desc.featureId)) || (entry.payload && entry.payload.featureId);
        if (fid) ids.add(fid);
    }
    if (ids.size !== 1) return null;
    return [...ids][0];
}

/** Filter picking entries by descriptor.kind ('face' / 'edge'). */
function entriesOfKind(selection, kind) {
    if (!selection) return [];
    return selection.toArray().filter(e => e && e.descriptor && e.descriptor.kind === kind);
}
const hasOp        = (ctx, name) => ctx.ops && typeof ctx.ops[name] === 'function';
const callOp       = (ctx, name, ...args) => {
    if (!hasOp(ctx, name)) { ctx.toast?.(`v4: ${name} not available`, 'error'); return null; }
    const r = ctx.ops[name](...args);
    ctx.bridge?.runNow?.();
    return r;
};

/**
 * Open a feature-command dialog if the host wired one; otherwise fall back
 * to running the op immediately with defaults.
 *
 * @param {object}   ctx
 * @param {object}   spec
 * @param {string}   spec.featureType   — also used for ops[`add${type}`] when no commit override
 * @param {string}   spec.opName        — fallback ops[name] if no add<Type> matches
 * @param {Array}    spec.schema
 * @param {object}   spec.initial
 * @param {(params)=>void} [spec.commit]
 * @param {Array}    [spec.selectionFields]
 * @param {(params)=>object} [spec.buildFeature]
 */
function openOrRun(ctx, spec) {
    if (typeof ctx.openCommand === 'function') {
        return ctx.openCommand({
            title:         spec.title || spec.featureType,
            featureType:   spec.featureType,
            schema:        spec.schema,
            initial:       spec.initial,
            selectionFields: spec.selectionFields,
            buildFeature:  spec.buildFeature,
            commit: spec.commit || ((params) => {
                const fn = ctx.ops && (ctx.ops[`add${spec.featureType}`] || ctx.ops[spec.opName]);
                if (typeof fn !== 'function') {
                    ctx.toast?.(`v4: add${spec.featureType} not available`, 'error'); return;
                }
                fn(params);
            }),
        });
    }
    // Fallback — no command runtime wired; just run with defaults.
    const fn = ctx.ops && (ctx.ops[`add${spec.featureType}`] || ctx.ops[spec.opName]);
    if (typeof fn !== 'function') return null;
    const r = fn(spec.initial);
    ctx.bridge?.runNow?.();
    return r;
}

/**
 * Open a modifier-command (Fillet / Chamfer / Shell) on the currently-picked
 * edges/faces. Resolves the target body from the selection, converts the
 * picks into emit-ready fingerprint refs, and configures the CommandDialog
 * with a single read-only "Edges"/"Open faces" row that shows the pick count.
 *
 * @param {object} ctx
 * @param {object} spec
 * @param {string} spec.featureType   — 'Fillet' | 'Chamfer' | 'Shell'
 * @param {string} spec.opName        — `ctx.ops[opName](bodyId, params)`
 * @param {'edge'|'face'} spec.selKind — picking kind to bundle into the op
 * @param {string} [spec.selFieldLabel]
 * @param {string} [spec.paramKey]    — name of the param key receiving refs (default 'edges')
 */
function openModifierCommand(ctx, spec) {
    const bodyId = targetBodyIdFromSelection(ctx.selection);
    if (!bodyId) {
        ctx.toast?.(`${spec.featureType}: pick edges/faces on a single body first`, 'warning');
        return null;
    }
    const picks = entriesOfKind(ctx.selection, spec.selKind);
    if (picks.length === 0) {
        ctx.toast?.(`${spec.featureType}: needs at least one ${spec.selKind}`, 'warning');
        return null;
    }
    // Convert picking entries → fingerprint refs (cheap; payload.center is
    // captured at pick time so the refs survive a regen).
    const refs = picks
        .map(entry => {
            if (!entry.payload || !entry.payload.center) return null;
            return {
                descriptor: entry.descriptor || null,
                fingerprint: {
                    centerRounded: entry.payload.center.slice(),
                    normalRounded: (entry.payload.normal || entry.payload.tangent || [0, 0, 1]).slice(),
                    areaBucket:    1,
                    sourceNodeId:  entry.payload.featureId
                                || (entry.descriptor && (entry.descriptor.feature || entry.descriptor.featureId))
                                || bodyId,
                },
            };
        })
        .filter(Boolean);
    const paramKey = spec.paramKey || 'edges';

    if (typeof ctx.openCommand === 'function') {
        return ctx.openCommand({
            title:        spec.featureType,
            featureType:  spec.featureType,
            schema:       getCommandSchema(spec.featureType),
            initial:      getInitialValues(spec.featureType),
            selectionFields: [{
                key: paramKey,
                label: spec.selFieldLabel || (spec.selKind === 'edge' ? 'Edges' : 'Faces'),
                required: true,
                resolveValue: () => refs,
                countLabel:   () => `${refs.length} ${spec.selKind}${refs.length === 1 ? '' : 's'}`,
            }],
            buildFeature: (params /*, selections */) => {
                // Build a candidate feature carrying the modifier's params +
                // edge/face refs + target body input. The kernel emit reads
                // .params[paramKey] for fingerprint resolution.
                const allParams = { ...params, [paramKey]: refs };
                return makeFeature(spec.featureType, allParams, { body: { kind: 'body', featureId: bodyId, bodyKey: 'main' } });
            },
            commit: (params) => {
                const fn = ctx.ops && ctx.ops[spec.opName];
                if (typeof fn !== 'function') {
                    ctx.toast?.(`v4: ${spec.opName} not available`, 'error'); return;
                }
                fn(bodyId, { ...params, [paramKey]: refs });
            },
        });
    }
    // No runtime — fall back to immediate commit.
    const fn = ctx.ops && ctx.ops[spec.opName];
    if (typeof fn !== 'function') return null;
    const initial = getInitialValues(spec.featureType);
    const r = fn(bodyId, { ...initial, [paramKey]: refs });
    ctx.bridge?.runNow?.();
    return r;
}

// Inline schemas — kept in sync with app/v4_panel/schemas.js but duplicated
// here so the registry doesn't pull the v4 panel module into Node test runs.
const N = (key, label, extras = {}) => ({ key, label, kind: 'number', unit: 'mm', step: 0.5, ...extras });
const B = (key, label) => ({ key, label, kind: 'bool' });
const COMMAND_SCHEMAS = {
    Box: [
        N('length', 'Length', { min: 0.001 }),
        N('width',  'Width',  { min: 0.001 }),
        N('height', 'Height', { min: 0.001 }),
        B('centered', 'Centered'),
    ],
    Cylinder: [
        N('radius', 'Radius', { min: 0.001 }),
        N('height', 'Height', { min: 0.001 }),
        B('centered', 'Centered'),
    ],
    Sphere: [N('radius', 'Radius', { min: 0.001 })],
    Torus: [
        N('majorRadius', 'Major Radius', { min: 0.001 }),
        N('minorRadius', 'Minor Radius', { min: 0.001 }),
    ],
    Extrude: [
        N('amount', 'Distance', { min: 0.001 }),
        B('both', 'Both directions'),
    ],
    Fillet:  [N('radius', 'Radius', { min: 0.001 })],
    Chamfer: [N('length', 'Length', { min: 0.001 })],
    Shell:   [N('thickness', 'Thickness', { min: 0.001 })],
    Hole:    [
        N('diameter', 'Diameter', { min: 0.001 }),
        N('depth',    'Depth',    { min: 0.001 }),
    ],
};
const INITIAL_VALUES = {
    Box:      { length: 10, width: 10, height: 10, centered: false },
    Cylinder: { radius: 5,  height: 10, centered: false },
    Sphere:   { radius: 5  },
    Torus:    { majorRadius: 10, minorRadius: 2 },
    Extrude:  { amount: 10, both: false },
    Fillet:   { radius: 1 },
    Chamfer:  { length: 1 },
    Shell:    { thickness: 1 },
    Hole:     { diameter: 5, depth: 10 },
};

export function getCommandSchema(featureType) { return COMMAND_SCHEMAS[featureType] || []; }
export function getInitialValues(featureType) { return { ...(INITIAL_VALUES[featureType] || {}) }; }

/** Build the default action list. Returns an array; register via registry.registerAll. */
export function buildDefaultActions() {
    return [
        // ── View ───────────────────────────────────────────────────────────
        { id: 'view.front',   label: 'Front View',   category: 'View', hotkey: 'Ctrl+1',
          icon: 'view_in_ar', keywords: ['cardinal', '-y'],
          run: (ctx) => ctx.viewportCtl?.goView?.('front') },
        { id: 'view.back',    label: 'Back View',    category: 'View', hotkey: 'Ctrl+2',
          run: (ctx) => ctx.viewportCtl?.goView?.('back') },
        { id: 'view.left',    label: 'Left View',    category: 'View', hotkey: 'Ctrl+3',
          run: (ctx) => ctx.viewportCtl?.goView?.('left') },
        { id: 'view.right',   label: 'Right View',   category: 'View', hotkey: 'Ctrl+4',
          run: (ctx) => ctx.viewportCtl?.goView?.('right') },
        { id: 'view.top',     label: 'Top View',     category: 'View', hotkey: 'Ctrl+5',
          run: (ctx) => ctx.viewportCtl?.goView?.('top') },
        { id: 'view.bottom',  label: 'Bottom View',  category: 'View', hotkey: 'Ctrl+6',
          run: (ctx) => ctx.viewportCtl?.goView?.('bottom') },
        { id: 'view.iso',     label: 'Isometric View', category: 'View', hotkey: 'Ctrl+7',
          keywords: ['iso'],
          run: (ctx) => ctx.viewportCtl?.goView?.('iso') },
        { id: 'view.normal',  label: 'Normal to Selection', category: 'View', hotkey: 'Ctrl+8',
          isEnabled: hasSelection,
          disabledReason: () => 'Select a face or plane first.',
          run: (ctx) => ctx.viewportCtl?.normalTo?.() },
        { id: 'view.fit',     label: 'Fit to View',  category: 'View', hotkey: 'F',
          keywords: ['zoom', 'extents', 'frame'],
          run: (ctx) => ctx.viewportCtl?.smartFit?.() },
        { id: 'view.home',    label: 'Home View',    category: 'View',
          icon: 'home', keywords: ['reset'],
          run: (ctx) => ctx.viewportCtl?.home?.() },

        // ── Selection / visibility ─────────────────────────────────────────
        { id: 'sel.clear',    label: 'Clear Selection', category: 'Selection', hotkey: 'Esc',
          isEnabled: hasSelection,
          disabledReason: () => 'Nothing is selected.',
          run: (ctx) => ctx.selection?.clear?.() },
        { id: 'sel.hide',     label: 'Hide Selected', category: 'Selection', hotkey: 'V',
          isEnabled: hasSelection,
          disabledReason: () => 'Select something to hide.',
          run: (ctx) => ctx.viewportCtl?.hide?.(ctx.selection?.toArray()) },
        { id: 'sel.showAll',  label: 'Show All Hidden', category: 'Selection', hotkey: 'Shift+H',
          run: (ctx) => ctx.viewportCtl?.showAll?.() },

        // ── Sketch ─────────────────────────────────────────────────────────
        { id: 'sketch.xy', label: 'Sketch on XY Plane', category: 'Sketch',
          icon: 'edit_square',
          isVisible: noSketch,
          run: (ctx) => ctx.enterSketch?.('XY') },
        { id: 'sketch.xz', label: 'Sketch on XZ Plane', category: 'Sketch',
          isVisible: noSketch,
          run: (ctx) => ctx.enterSketch?.('XZ') },
        { id: 'sketch.yz', label: 'Sketch on YZ Plane', category: 'Sketch',
          isVisible: noSketch,
          run: (ctx) => ctx.enterSketch?.('YZ') },

        // ── Primitives ─────────────────────────────────────────────────────
        // These open the CommandDialog (which renders a yellow preview) if
        // the runtime is wired; otherwise fall back to immediate addBox().
        { id: 'add.box',      label: 'Box',      category: 'Primitive',
          keywords: ['cube', 'block'],
          isVisible: noSketch,
          run: (ctx) => openOrRun(ctx, {
              featureType: 'Box',
              schema:  getCommandSchema('Box'),
              initial: getInitialValues('Box'),
          }) },
        { id: 'add.cylinder', label: 'Cylinder', category: 'Primitive',
          keywords: ['tube'],
          isVisible: noSketch,
          run: (ctx) => openOrRun(ctx, {
              featureType: 'Cylinder',
              schema:  getCommandSchema('Cylinder'),
              initial: getInitialValues('Cylinder'),
          }) },
        { id: 'add.sphere',   label: 'Sphere',   category: 'Primitive',
          keywords: ['ball'],
          isVisible: noSketch,
          run: (ctx) => openOrRun(ctx, {
              featureType: 'Sphere',
              schema:  getCommandSchema('Sphere'),
              initial: getInitialValues('Sphere'),
          }) },
        { id: 'add.torus',    label: 'Torus',    category: 'Primitive',
          keywords: ['donut', 'ring'],
          isVisible: noSketch,
          run: (ctx) => openOrRun(ctx, {
              featureType: 'Torus',
              schema:  getCommandSchema('Torus'),
              initial: getInitialValues('Torus'),
          }) },

        // ── Feature ops needing a selection ────────────────────────────────
        // Each routes through openCommand with a pre-populated edge / face
        // selection field. The CommandDialog opens with the radius/length/
        // thickness pre-filled, the preview channel renders the modifier
        // in yellow on the existing body, and Accept commits with the real
        // edge refs.
        { id: 'feat.fillet',  label: 'Fillet',  category: 'Feature',
          keywords: ['round', 'radius'],
          isEnabled: hasSelection,
          isVisible: noSketch,
          disabledReason: () => 'Select one or more edges first.',
          run: (ctx) => openModifierCommand(ctx, {
              featureType: 'Fillet',
              opName:      'addFillet',
              selKind:     'edge',
              selFieldLabel: 'Edges',
          }) },
        { id: 'feat.chamfer', label: 'Chamfer', category: 'Feature',
          keywords: ['bevel', 'edge'],
          isEnabled: hasSelection,
          isVisible: noSketch,
          disabledReason: () => 'Select one or more edges first.',
          run: (ctx) => openModifierCommand(ctx, {
              featureType: 'Chamfer',
              opName:      'addChamfer',
              selKind:     'edge',
              selFieldLabel: 'Edges',
          }) },
        { id: 'feat.shell',   label: 'Shell',   category: 'Feature',
          keywords: ['hollow', 'wall'],
          isEnabled: hasSelection,
          isVisible: noSketch,
          disabledReason: () => 'Select one or more open faces first.',
          run: (ctx) => openModifierCommand(ctx, {
              featureType: 'Shell',
              opName:      'addShell',
              selKind:     'face',
              selFieldLabel: 'Open faces',
              paramKey:    'openFaces',
          }) },
        { id: 'feat.hole',    label: 'Hole',    category: 'Feature',
          keywords: ['drill', 'bore'],
          isEnabled: hasSelection,
          isVisible: noSketch,
          disabledReason: () => 'Select a face to place the hole on.',
          run: (ctx) => callOp(ctx, 'addHole') },

        // ── Booleans ───────────────────────────────────────────────────────
        { id: 'bool.union',     label: 'Union',     category: 'Boolean',
          keywords: ['combine', 'merge', 'add'],
          isVisible: noSketch,
          run: (ctx) => callOp(ctx, 'addUnion') },
        { id: 'bool.cut',       label: 'Cut',       category: 'Boolean',
          keywords: ['subtract', 'minus'],
          isVisible: noSketch,
          run: (ctx) => callOp(ctx, 'addCut') },
        { id: 'bool.intersect', label: 'Intersect', category: 'Boolean',
          keywords: ['common'],
          isVisible: noSketch,
          run: (ctx) => callOp(ctx, 'addIntersect') },

        // ── Document ───────────────────────────────────────────────────────
        { id: 'doc.undo',      label: 'Undo',      category: 'Document', hotkey: 'Ctrl+Z',
          run: (ctx) => { ctx.store?.undo?.(); ctx.bridge?.runNow?.(); } },
        { id: 'doc.redo',      label: 'Redo',      category: 'Document', hotkey: 'Ctrl+Y',
          run: (ctx) => { ctx.store?.redo?.(); ctx.bridge?.runNow?.(); } },
    ];
}

/**
 * Marking-menu layout — pick eight actions to surface around the cursor
 * for the current context. Order is N, NE, E, SE, S, SW, W, NW.
 * The host can override per-context; this is the default for empty-selection
 * + non-sketch mode (the most common state at app open).
 */
export function defaultMarkingMenu(ctx) {
    if (ctx.sketchActive) return null;
    if (hasSelection(ctx)) {
        return [
            'feat.fillet',
            'feat.chamfer',
            'feat.hole',
            'feat.shell',
            'sel.hide',
            'view.normal',
            'view.fit',
            'sel.clear',
        ];
    }
    return [
        'sketch.xy',
        'add.box',
        'add.cylinder',
        'add.sphere',
        'view.fit',
        'view.iso',
        'view.front',
        'view.top',
    ];
}
