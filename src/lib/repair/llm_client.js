/**
 * Repair-loop LLM client. Phase 2.2 ships a deterministic mock so the
 * end-to-end loop is testable without burning tokens. The interface is
 * stable so a real provider can be swapped in later without touching
 * the orchestrator.
 *
 *   proposeFix({ goal, failures, context }) → { ops, rationale }
 *
 * - `goal` is a free-text user goal (the original spec).
 * - `failures` is the list of failed checks aggregated by the loop
 *   (invariant + DFM + kernel-error). Each carries a `source` tag.
 * - `context` carries the current doc snapshot, the residualText from
 *   the extractor, and any prior repair attempts.
 *
 * The stub uses a small rule table keyed on (source, id|category) →
 * patch op. Anything unhandled returns `{ ops: [], rationale: 'no rule' }`
 * so the loop short-circuits cleanly.
 *
 * Real provider (Phase 2): when `settings.ai.provider` selects a real backend
 * (`'gemini'` — default — or `'anthropic'`), `callLlmClient` routes through
 * `proposeFixReal`, which asks the selected model (via the provider abstraction
 * in ../ai/providers/) for `{ops, rationale}` in the same op-shape the loop
 * already understands. The deterministic mock stays as the fallback so spec08
 * keeps passing with no key and no network.
 */

import { findPart as _findLibraryPart } from '../library/index.js';

/** Defaults the rule table reaches for. Keep in lockstep with the materials.json keys. */
const DEFAULT_MATERIAL = '6061';

/**
 * Rule table — pure (failure) → (patch op?) projection. Returning `null`
 * means "this rule doesn't apply"; the loop will treat the failure as
 * unresolved.
 *
 * @type {Array<(failure: object, ctx: object) => object|null>}
 */
const RULES = [
    // 1. Missing material on a body → setMaterial with the default grade.
    function ruleMissingMaterial(failure, _ctx) {
        const id = failure.id || failure.name || '';
        if (id !== 'i-material-assigned') return null;
        const featureId = failure.targetId || (failure.result && failure.result.measured && failure.result.measured.featureId);
        return {
            kind: 'setMaterial',
            params: {
                material: 'aluminum',
                grade:    DEFAULT_MATERIAL,
                target:   featureId || 'lastBody',
            },
            _rule: 'ruleMissingMaterial',
        };
    },

    // 2. Missing process profile → setProcess defaulting to 3d-print.
    function ruleMissingProcess(failure, _ctx) {
        const id = failure.id || failure.name || '';
        if (id !== 'i-process-assigned') return null;
        return {
            kind: 'setProcess',
            params: { process: '3d-print', profile: '3d-print' },
            _rule: 'ruleMissingProcess',
        };
    },

    // 3. Missing fastener for a clearance hole → add the matching standard part.
    function ruleMissingFastener(failure, _ctx) {
        const id = failure.id || failure.name || '';
        if (id !== 'i-clearance-hole-for-fastener') return null;
        const measured = failure.result && failure.result.measured;
        const entryId = measured && measured.entryId;
        if (!entryId) return null;
        return {
            kind: 'addStandardPart',
            params: { entryId, qty: 1, role: 'fastener' },
            _rule: 'ruleMissingFastener',
        };
    },

    // 4. Manifold / kernel-error / non-manifold hints — try a small fillet
    //    to round sharp creases. Bounded by the rule (radius 0.5 mm).
    function ruleManifoldHint(failure, ctx) {
        const id = failure.id || failure.name || '';
        const cat = failure.category || '';
        if (id !== 'i-manifold-all-bodies' && cat !== 'kernel-error' && id !== 'manifoldness') {
            return null;
        }
        const targetId = failure.targetId || (ctx && ctx.lastBodyId);
        if (!targetId) return null;
        return {
            kind: 'addFillet',
            params: { target: targetId, radius: 0.5, edges: [] },
            _rule: 'ruleManifoldHint',
        };
    },

    // 4b. Spec 18 — natural-language "add an M4 screw at this hole" via the
    //     library palette. The repair loop sometimes hands us a synthetic
    //     `library-request` failure that carries a `query` string + an
    //     optional `hostConnectorId`. Route through findPart + emit a
    //     placeLibraryPart op.
    function ruleLibraryRequest(failure, ctx) {
        const id = failure.id || failure.name || '';
        if (id !== 'library-request') return null;
        const query = failure.query || (failure.result && failure.result.query);
        if (!query) return null;
        // Dynamic import to keep the LLM client free of library deps at boot.
        let hit = null;
        try {
            const host = ctx && ctx.hostConnector ? { context: { hostConnector: ctx.hostConnector } } : undefined;
            const hits = _findLibraryPart(query, host);
            hit = hits[0] || null;
        } catch {
            // Fallthrough — the cmd loop's async tier will retry.
            return null;
        }
        if (!hit) return null;
        return {
            kind: 'placeLibraryPart',
            params: {
                partId: hit.part.id,
                mate: {
                    hostConnectorRef: failure.hostConnectorId
                        ? { connectorId: failure.hostConnectorId }
                        : undefined,
                    partConnectorId: hit.suggestedMate && hit.suggestedMate.partConnectorId,
                },
            },
            _rule: 'ruleLibraryRequest',
        };
    },

    // 5. Fillet / chamfer / shell with zero param → set a sensible default.
    function ruleZeroSizedFeature(failure, _ctx) {
        const id = failure.id || failure.name || '';
        const mapping = {
            'i-fillet-radius-positive': { param: 'radius',    value: 1 },
            'i-chamfer-length-positive':{ param: 'length',    value: 1 },
            'i-shell-thickness-positive':{ param: 'thickness', value: 1 },
            'i-extrude-amount-positive':{ param: 'amount',    value: 10 },
        };
        const m = mapping[id];
        if (!m) return null;
        const featureId = failure.targetId;
        if (!featureId) return null;
        return {
            kind: 'setFeatureParams',
            params: { featureId, patch: { [m.param]: m.value } },
            _rule: 'ruleZeroSizedFeature',
        };
    },
];

/**
 * Default mock implementation. Drives the loop deterministically off
 * the RULES table above. Returns an op-list (possibly empty) and a
 * short rationale string.
 *
 * @param {{
 *   goal: string,
 *   failures: object[],
 *   context?: object,
 * }} request
 * @returns {Promise<{ ops: object[], rationale: string }>}
 */
export async function proposeFix(request) {
    const { failures = [], context = {} } = request || {};
    const ops = [];
    const ruleHits = [];
    for (const failure of failures) {
        for (const rule of RULES) {
            const op = rule(failure, context);
            if (op) {
                const tag = op._rule || rule.name;
                // De-dup by (kind + serialised params).
                const sig = `${op.kind}:${JSON.stringify(op.params)}`;
                if (!ops.some((o) => `${o.kind}:${JSON.stringify(o.params)}` === sig)) {
                    ops.push(op);
                    ruleHits.push(tag);
                }
                break;
            }
        }
    }
    const rationale = ruleHits.length === 0
        ? 'no matching rule for the failure set'
        : `applied rules: ${ruleHits.join(', ')}`;
    return { ops, rationale };
}

// ── Real model path (Phase 1) ────────────────────────────────────────────────
//
// Ask Claude to repair the failures by returning a structured op-list in the
// SAME shape `applyOps` (src/lib/repair/loop.js) already consumes. We keep this
// out of the hot import path — the provider module pulls in fetch/SSE plumbing
// the headless tests don't want — by importing it lazily only when the real
// path is actually selected.

/** Op kinds the repair loop's applyOps understands — the model is told to stay within these. */
const REPAIR_OP_KINDS = [
    'addBox', 'addCylinder', 'addStandardPart', 'addFillet',
    'setMaterial', 'setProcess', 'setFitClass', 'setTolerance',
    'setFeatureParams', 'placeLibraryPart',
];

const REPAIR_SYSTEM_PROMPT =
    'You are the repair engine for an AI-native CAD tool. You are given a user goal and a list of failed correctness checks (invariants / DFM / kernel errors). '
    + 'Propose the minimal set of typed operations that resolve the failures. The world is Z-up, units are millimetres, and the kernel is the arbiter. '
    + 'Reply ONLY with a JSON object: {"ops":[{"kind":"<one of '
    + REPAIR_OP_KINDS.join('|')
    + '>","params":{...}}],"rationale":"<one sentence>"}. '
    + 'Use setFeatureParams({featureId, patch}) to fix a bad feature param, setMaterial({material, grade, target}) for missing material, '
    + 'addStandardPart({entryId}) for a missing fastener, addFillet({target, radius}) to round sharp creases. '
    + 'If no operation can help, return {"ops":[],"rationale":"no fix"}.';

/**
 * Real-model proposeFix. Calls the Flask `/ai/chat` proxy (no key in the
 * browser) and parses a `{ops, rationale}` JSON object out of the reply. On
 * any transport/parse failure it falls back to the deterministic mock so the
 * loop still makes progress.
 *
 * @param {{ goal:string, failures:object[], context?:object }} request
 * @returns {Promise<{ ops:object[], rationale:string }>}
 */
export async function proposeFixReal(request) {
    const { goal = '', failures = [] } = request || {};
    let sendChat, getProvider;
    try {
        ({ sendChat } = await import('../ai/provider.js'));
        ({ getProvider } = await import('../ai/providers/index.js'));
    } catch {
        return proposeFix(request);
    }

    const compactFailures = failures.map((f) => ({
        source: f.source,
        id: f.id || f.name,
        category: f.category,
        targetId: f.targetId || null,
        message: f.result && f.result.message,
        suggestedFix: f.result && f.result.suggestedFix,
    }));
    const userText =
        `Goal: ${goal || '(none)'}\n\nFailed checks:\n${JSON.stringify(compactFailures, null, 2)}`;

    const { providerName, model } = _repairConfig();
    const provider = getProvider(providerName);

    try {
        // No tools in the repair path — we ask for a JSON op-list in prose.
        const { body } = provider.buildBody({
            system: REPAIR_SYSTEM_PROMPT,
            history: [{ role: 'user', text: userText }],
            tools: undefined,
            model,
            maxTokens: 1024,
            stream: false,
        });
        const reply = await sendChat(body);
        const { text } = provider.parseResponse(reply);
        const parsed = _parseOpsJson(text);
        if (parsed && Array.isArray(parsed.ops)) {
            return { ops: parsed.ops, rationale: parsed.rationale || 'model proposed fix' };
        }
    } catch (_) {
        // fall through to the mock
    }
    return proposeFix(request);
}

/** Resolve { providerName, model } for the repair path from settings. */
function _repairConfig() {
    let providerName = 'gemini';
    let model = 'gemini-2.5-flash';
    try {
        const { readSettings } = _settingsModule || {};
        if (readSettings) {
            const s = readSettings();
            const ai = (s && s.ai) || {};
            if (typeof ai.provider === 'string' && (ai.provider === 'gemini' || ai.provider === 'anthropic')) {
                providerName = ai.provider;
            }
            if (providerName === 'anthropic') {
                model = (typeof ai.anthropicModel === 'string' && ai.anthropicModel.trim())
                    || (typeof ai.model === 'string' && ai.model.startsWith('claude') && ai.model.trim())
                    || 'claude-opus-4-8';
            } else {
                model = (typeof ai.geminiModel === 'string' && ai.geminiModel.trim())
                    || (typeof ai.model === 'string' && ai.model.startsWith('gemini') && ai.model.trim())
                    || 'gemini-2.5-flash';
            }
        }
    } catch { /* ignore */ }
    return { providerName, model };
}

/** Extract the first JSON object from a text reply (tolerant of fences/prose). */
function _parseOpsJson(text) {
    if (!text) return null;
    let s = text.trim();
    // Strip ```json … ``` fences if present.
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    // Find the first balanced {...} block.
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); }
    catch { return null; }
}

// ── Provider selection ────────────────────────────────────────────────────────
//
// Statically import the settings reader (plain ESM, no network) so we can
// decide whether to route to the real model. Done at module top so it's
// resolved once; the provider transport itself is imported lazily above.

import * as _settingsModule from '../../../app/settings/index.js';

/** True when the user has selected a real provider (gemini/anthropic) in settings. */
function _useRealProvider() {
    try {
        const s = _settingsModule.readSettings();
        const p = s && s.ai && s.ai.provider;
        return p === 'gemini' || p === 'anthropic';
    } catch {
        return false;
    }
}

// ── Test seam ───────────────────────────────────────────────────────────────
//
// The loop tests want to assert that the LLM was called with a specific
// failure set without hard-coding the rule table. We export a setter +
// reset so tests can substitute a fake.

let _clientOverride = null;

/** Test-only: install a fake client. Pass `null` to revert. */
export function setLlmClientForTests(fn) {
    _clientOverride = (typeof fn === 'function') ? fn : null;
}

/**
 * Public façade — the loop calls this. Priority:
 *   1. test override (if installed),
 *   2. the real Anthropic provider when settings.ai.provider === 'anthropic',
 *   3. the deterministic mock.
 */
export async function callLlmClient(request) {
    if (_clientOverride) return _clientOverride(request);
    if (_useRealProvider()) return proposeFixReal(request);
    return proposeFix(request);
}
