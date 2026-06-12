/**
 * E6 — drag-to-reparent helpers.
 *
 * Pure validators consumed by ComponentBrowserPanel.svelte's HTML5 DnD
 * handlers. The actual reassignment happens via `setFeatureComponent` (for
 * feature → component drops) or by a new component-tree reparent change
 * (currently only feature-into-component is supported; component-into-component
 * tree restructure is a v2 follow-up — we expose `canReparentComponent` for
 * completeness but the operation is opt-in via setComponentParent).
 *
 * Tests cover both paths.
 */

/** Walk component ancestors from `id` up to 'root'. */
export function componentAncestors(doc, id) {
  const out = [];
  let cur = id;
  const components = doc?.components || {};
  const guard = new Set();
  while (cur && components[cur] && !guard.has(cur)) {
    guard.add(cur);
    out.push(cur);
    cur = components[cur].parentId || null;
    if (cur === 'root') { out.push('root'); break; }
  }
  return out;
}

/**
 * Can `source` feature move into `targetComponentId`?
 * - target must exist
 * - source must exist
 * - if already in target, false (no-op)
 */
export function canReparentFeature(doc, sourceFeatureId, targetComponentId) {
  if (!doc) return { ok: false, reason: 'no document' };
  const f = doc.features?.[sourceFeatureId];
  if (!f) return { ok: false, reason: 'feature missing' };
  if (!doc.components?.[targetComponentId]) return { ok: false, reason: 'target component missing' };
  const cur = f.componentId || 'root';
  if (cur === targetComponentId) return { ok: false, reason: 'already in target' };
  return { ok: true };
}

/**
 * Can component `source` move under `targetParent`?
 * - both must exist
 * - source !== target
 * - target is not a descendant of source (no cycles)
 * - source is not already a direct child of target
 */
export function canReparentComponent(doc, sourceId, targetParentId) {
  if (!doc) return { ok: false, reason: 'no document' };
  if (sourceId === 'root') return { ok: false, reason: 'cannot move root' };
  const src = doc.components?.[sourceId];
  const tgt = doc.components?.[targetParentId];
  if (!src) return { ok: false, reason: 'source missing' };
  if (!tgt && targetParentId !== 'root') return { ok: false, reason: 'target missing' };
  if (sourceId === targetParentId) return { ok: false, reason: 'self-reparent' };
  if (src.parentId === targetParentId) return { ok: false, reason: 'no-op' };

  // Walk target's ancestor chain — if we encounter source, that's a cycle.
  const ancestors = componentAncestors(doc, targetParentId);
  if (ancestors.includes(sourceId)) return { ok: false, reason: 'would create cycle' };
  return { ok: true };
}
