import { BodyHighlightLayer } from '../../../app/picking/body_highlight.js';

/**
 * Tints the meshes belonging to the currently-selected feature in the scene.
 * Subscribes to:
 *   - store: re-applies highlight on feature-selection events
 *   - bridge.onRender: re-resolves mesh refs after each kernel re-render
 *     (the bridge replaces the body group each commit)
 */
export function bootBodyHighlight({ store, bridge }) {
  if (!store || !bridge) throw new Error('bootBodyHighlight: store + bridge required');

  const layer = new BodyHighlightLayer();

  function meshesForId(featureId) {
    if (!featureId || !bridge.bodyTransform) return [];
    const out = [];
    bridge.bodyTransform.traverse((child) => {
      if (child.isMesh && child.userData?.featureId === featureId) out.push(child);
    });
    return out;
  }

  function reapply() {
    const id = store.selectedFeatureId();
    const meshes = meshesForId(id);
    if (meshes.length === 0) layer.clearSelection();
    else layer.setSelected(meshes);
  }

  const offStore = store.subscribe(() => reapply());
  const offRender = bridge.onRender(() => reapply());

  return {
    dispose() {
      offStore?.();
      offRender?.();
      layer.clearAll?.();
      layer.dispose?.();
    },
  };
}
