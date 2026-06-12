import * as v4 from '../../../lib/document/index.js';

/**
 * Boots the DocumentStore + ViewportBridge for a given Three.js scene.
 *
 * - Stores live in singletons (see lib/document/store.js, bridge.js) — calling
 *   this multiple times is safe, but the singletons keep state across calls.
 * - The bridge auto-subscribes to the store and auto-attaches its root group
 *   to `scene`. As features commit, GLB meshes appear in the scene.
 * - With no kernel reachable, commits still succeed; the viewport just stays
 *   empty until a kernel endpoint is set or comes online.
 */
export function bootDocument({ scene, seedIfEmpty = false } = {}) {
  const store = v4.getDocumentStore();
  const bridge = v4.getViewportBridge({ scene });

  // New documents start EMPTY (no demo Box). The AI assembly then builds
  // visibly into a clean scene and the viewport's empty-state hint shows.
  // We keep the `seedIfEmpty` knob for callers/tests that opt back in, but
  // it now defaults off and is no longer driven by the persistence path.
  void seedIfEmpty;

  const errorHandlers = new Set();
  const offError = bridge.onError(({ error, doc }) => {
    for (const fn of errorHandlers) {
      try { fn({ error, doc }); }
      catch (e) { console.error('[bootDocument.onError]', e); }
    }
  });

  return {
    store,
    bridge,
    onKernelError(fn) {
      errorHandlers.add(fn);
      return () => errorHandlers.delete(fn);
    },
    dispose() {
      offError?.();
      v4.disposeViewportBridge();
    },
  };
}
