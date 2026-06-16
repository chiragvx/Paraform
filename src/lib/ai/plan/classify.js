/**
 * Leaf classification — buy / reuse / fabricate (Phase 1).
 *
 * Each plan leaf is sorted by what the user DOES with it:
 *   - buy       — a COTS standard (servo, bearing, fastener, battery, camera,
 *                 controller). Fabricating one of these is a failure.
 *   - reuse     — matches an existing verified Paraform library part.
 *   - fabricate — no catalogue match → a parametric part we generate.
 *
 * `classifyNode` is deterministic + total (role/keyword based, never throws).
 * `findPartFor` is the async library lookup that resolves a concrete partId for
 * a buy/reuse leaf (matching by interface + keywords, not just name).
 */

import { loadLibrary, findPart, isVerifiedPart } from '../../library/index.js';

// Roles that are inherently off-the-shelf.
const COTS_ROLES = new Set(['actuator', 'compute', 'driver', 'power', 'sensor', 'contact', 'fastener', 'bearing']);
// Keywords that name a standard part even when the role wasn't set.
const COTS_WORDS = /\b(servo|bearing|screw|bolt|nut|washer|standoff|camera|battery|lipo|controller|esp32|raspberry|pi|pca9685|imu|sensor|motor|gear ?motor|encoder|pcb|wire|connector|magnet|spring|bushing|coupler|belt|pulley)\b/i;

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

/**
 * Classify a node deterministically from its spec/role/label.
 * @returns {{ cls:'buy'|'fabricate', reason:string }}
 */
export function classifyNode(node) {
    const spec = isObj(node?.spec) ? node.spec : {};
    const role = typeof spec.role === 'string' ? spec.role.toLowerCase() : '';
    const text = `${node?.label || ''} ${role}`;
    if (COTS_ROLES.has(role)) return { cls: 'buy', reason: `role "${role}" is off-the-shelf` };
    if (COTS_WORDS.test(text)) return { cls: 'buy', reason: 'names a standard/COTS part' };
    return { cls: 'fabricate', reason: 'no standard match — generate it parametrically' };
}

/**
 * Look up concrete library candidates for a node (buy/reuse resolution). Async —
 * loads + searches the verified library. Returns the best partId plus ranked
 * candidates, or an empty list when nothing matches (→ stays fabricate).
 *
 * @returns {Promise<{ partId:string|null, candidates:Array<{partId,name,category,score}> }>}
 */
export async function findPartFor(node) {
    try {
        await loadLibrary();
        const spec = isObj(node?.spec) ? node.spec : {};
        const q = [node?.label, spec.role, ...(Array.isArray(spec.interface) ? spec.interface : [])]
            .filter(Boolean).join(' ').trim();
        if (!q) return { partId: null, candidates: [] };
        const hits = (findPart(q) || []).filter((h) => isVerifiedPart(h.part)).slice(0, 6);
        const candidates = hits.map((h) => ({ partId: h.part.id, name: h.part.name, category: h.part.category, score: h.score }));
        return { partId: candidates.length ? candidates[0].partId : null, candidates };
    } catch {
        return { partId: null, candidates: [] };
    }
}

export default classifyNode;
