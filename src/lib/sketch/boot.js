import {
  enterSketchMode,
  exitSketchMode,
  getActiveSketchController,
  setSketchConfirmFn,
} from '../../../app/sketch_3d/index.js';
import { getDocumentStore } from '../../../lib/document/index.js';
import { studio } from '$lib/studio/runtime.svelte.js';
import { dialogs } from '$lib/dialogs/dialogs.svelte.js';

// Install custom-dialog confirm() so the sketcher's Discard prompt uses our
// own modal (Enter to accept, Esc to cancel) instead of the native popup.
try {
  setSketchConfirmFn((message) => dialogs.askConfirm({
    title: 'Discard sketch changes?',
    message: 'Your in-progress sketch entities will be lost.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
    danger: true,
  }));
} catch {}

/**
 * Drops into the legacy in-viewport sketcher (app/sketch_3d/). The sketcher
 * brings its own DOM overlay + CSS + toolbar — we just hand it the live
 * viewport, store, and bridge.
 *
 * Signatures (both supported):
 *
 *   enterSketch('XY' | 'XZ' | 'YZ')
 *     Legacy: enters on a stock world plane.
 *
 *   enterSketch({ faceDescriptor, featureId?, planeOffset? })
 *     E2.1 face flow: resolves the picked face's centroid + normal via the
 *     measure API and constructs a plane spec for the sketcher. If the face
 *     is missing/topology-stale, surfaces a "Sketch on missing face" error
 *     chip via the bridge and returns null without entering.
 *
 *   enterSketch({ planeFeatureId })
 *     E2.2 custom plane (verifies the E1.4 Plane command surface). Resolves
 *     the referenced Plane feature's authored spec.
 */
export async function enterSketch(planeOrOpts = 'XY') {
  if (!studio.viewport || !studio.bridge) {
    console.warn('[sketch] viewport/bridge not ready');
    return null;
  }

  // ── Legacy string-plane path ──────────────────────────────────────────────
  if (typeof planeOrOpts === 'string') {
    return _enterOn({ plane: planeOrOpts });
  }

  const opts = planeOrOpts || {};

  // ── Face-descriptor path (E2.1) ───────────────────────────────────────────
  if (opts.faceDescriptor) {
    let centroid = null;
    let normal = null;
    try {
      const [c, n] = await studio.measure([
        { type: 'centroid', descriptor: opts.faceDescriptor },
        { type: 'normal',   descriptor: opts.faceDescriptor },
      ]);
      centroid = c?.value || c?.point || c;
      normal   = n?.value || n?.normal || n;
    } catch (err) {
      _surfaceMissingFaceError(err);
      return null;
    }
    if (!_isVec3(centroid) || !_isVec3(normal)) {
      _surfaceMissingFaceError(new Error('measure returned no centroid/normal'));
      return null;
    }
    return _enterOn({
      plane: {
        kind: 'face',
        origin: centroid,
        normal,
        descriptor: opts.faceDescriptor,
        featureId: opts.featureId || null,
      },
    });
  }

  // ── Plane-feature path (E2.2 verification) ────────────────────────────────
  if (opts.planeFeatureId) {
    const store = getDocumentStore();
    const f = store.doc.features?.[opts.planeFeatureId];
    if (!f || f.type !== 'Plane') {
      console.warn('[sketch] enterSketch({planeFeatureId}): not a Plane feature', opts.planeFeatureId);
      return null;
    }
    return _enterOn({
      plane: {
        kind: 'plane-feature',
        featureId: opts.planeFeatureId,
        params: f.params,
      },
    });
  }

  console.warn('[sketch] enterSketch: unrecognised options', opts);
  return null;
}

function _enterOn({ plane }) {
  const controller = enterSketchMode({
    viewport: studio.viewport,
    store: getDocumentStore(),
    bridge: studio.bridge,
    plane,
    toast: (msg, kind = 'info') => {
      const tag = kind === 'error' ? 'error' : 'info';
      console[tag === 'error' ? 'error' : 'log'](`[sketch] ${msg}`);
    },
  });
  // Tell the persistent sketch overlay to suppress this feature so the live
  // Sketch3DRenderer (grid, halos, selection) covers it without doubling up.
  // For a brand-new sketch the in-memory id won't match any committed feature
  // until Finish, but writing it is still cheap; the overlay's refresh() is
  // a no-op for that id and the cleared post-finish refresh picks it up. For
  // re-edits we hide the existing feature immediately.
  try {
    studio.activeSketchFeatureId =
      controller?._editingExistingFeatureId
        || controller?.sketchData?.id
        || null;
  } catch {}
  return controller;
}

function _isVec3(v) {
  if (!v) return false;
  if (Array.isArray(v) && v.length === 3) return v.every((x) => Number.isFinite(x));
  if (typeof v === 'object') return ['x', 'y', 'z'].every((k) => Number.isFinite(v[k]));
  return false;
}

function _surfaceMissingFaceError(err) {
  const msg = err?.message || String(err);
  console.error('[sketch] Sketch on missing face:', msg);
  try {
    if (studio.bridge) studio.bridge.lastError = `Sketch on missing face: ${msg}`;
  } catch {}
}

export function cancelSketch() {
  exitSketchMode();
}

export function isSketchActive() {
  return !!getActiveSketchController();
}
