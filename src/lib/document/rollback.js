/**
 * E6.5 — timeline scrub / rollback head.
 *
 * Non-destructive rollback: instead of mutating the changelog (which is what
 * store.setHead does — moves popped changes to redo), the timeline-scrub
 * rollback marker is a *render-time* suppression flag that hides every feature
 * appearing after the marker.
 *
 * Why not setHead? setHead is destructive (changes leave the timeline until
 * you redo them) and trips autosave. The scrub marker is a UX overlay — it
 * shows the model "as of feature N" without throwing away later edits.
 *
 * Implementation:
 *   - studio.rollbackHead = featureId | null   (set by the scrub UI)
 *   - kernel emit / display walks `featureOrder` and treats every feature
 *     past the marker as `enabled = false`.
 *
 * The helpers below are pure: they compute the index in featureOrder, decide
 * which features fall past the marker, and validate the marker against the
 * document. The actual emit-side wiring is a one-liner in `emit.js` and the
 * scene-side respect of the flag happens through the existing
 * `feature.enabled` propagation in the bridge.
 */

/** Return the index of `featureId` in doc.featureOrder, or -1 when absent. */
export function rollbackIndex(doc, featureId) {
  if (!doc || !featureId) return -1;
  const order = doc.featureOrder || [];
  return order.indexOf(featureId);
}

/**
 * Compute the set of feature ids that should be suppressed (enabled=false)
 * by a rollback marker pointing at `featureId`. The marker feature itself is
 * INCLUDED in the visible set — "roll back to here" means stop AFTER this
 * feature.
 */
export function featuresSuppressedByRollback(doc, featureId) {
  const idx = rollbackIndex(doc, featureId);
  if (idx < 0) return new Set();
  const order = doc.featureOrder || [];
  return new Set(order.slice(idx + 1));
}

/** Is `featureId` past the rollback marker? */
export function isFeatureRolledOut(doc, rollbackHead, featureId) {
  if (!rollbackHead) return false;
  const headIdx = rollbackIndex(doc, rollbackHead);
  const fIdx = rollbackIndex(doc, featureId);
  if (headIdx < 0 || fIdx < 0) return false;
  return fIdx > headIdx;
}

/** Clamp a candidate head id to a valid feature id (or null if invalid). */
export function clampRollbackHead(doc, candidate) {
  if (!candidate) return null;
  return rollbackIndex(doc, candidate) >= 0 ? candidate : null;
}
