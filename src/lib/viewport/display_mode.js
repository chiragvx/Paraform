import * as THREE from 'three';

const HIDDEN_EDGE_MARKER = '__pf4_hidden_edges__';
const TECHNICAL_EDGE_MARKER = '__pf4_technical_edges__';
const TECHNICAL_HIDE_MARKER = '__pf4_technical_hidden_mesh__';

/** True for the "technical / blueprint" mode — black lines on white, no fills. */
export function isTechnicalMode(mode) { return mode === 'technical'; }

/**
 * Valid display modes. The first four are mutually exclusive — they're the
 * solid material fill style. `hiddenEdges` and `xray` are *overlays* that the
 * caller toggles independently (so "shaded + hidden edges" or "wireframe +
 * x-ray" both compose). For palette-level commands we keep the legacy single-
 * mode string for the four core modes; the toggles are persisted via
 * settings.viewport.{showHiddenEdges,xray}.
 *
 * E6.1 — hidden edges renders an overlay of LineSegments with depthTest=false
 * and a dashed material so occluded geometry shows through as faded lines.
 * X-ray applies opacity + depthWrite=false to the body materials so internal
 * features are visible through skin.
 */
const EDGE_GROUP_NAME = '__pf4_display_edges__';

/** Apply a display mode + overlay flags to every mesh under the bridge body group. */
export function applyDisplayMode(bridge, mode, opts = {}) {
  const root = bridge?.bodyTransform;
  if (!root) return;

  const technical = mode === 'technical';
  const wireframe = mode === 'wireframe' || mode === 'wireframe-edges';
  const wantEdges = mode === 'shaded-edges' || mode === 'wireframe-edges';
  const wantHidden = !!opts.hiddenEdges && !technical;
  const wantXray = !!opts.xray && !technical;
  // viewport-v3 #9 — when a section plane is active, edges should be clipped
  // by it too (without this the silhouette/crease lines bleed through the
  // cut surface). The caller passes the active THREE.Plane[]; empty/null
  // means "no clipping."
  const edgeClipPlanes = Array.isArray(opts.clippingPlanes) && opts.clippingPlanes.length > 0
    ? opts.clippingPlanes
    : null;

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.userData?.__pf4_edge_overlay__) return;
    if (obj.userData?.[HIDDEN_EDGE_MARKER]) return;
    if (obj.userData?.[TECHNICAL_EDGE_MARKER]) return;
    // Technical mode hides the solid fill so only the black line overlay
    // remains. We mark the original visible state so we can restore later.
    if (technical) {
      if (obj.userData[TECHNICAL_HIDE_MARKER] == null) {
        obj.userData[TECHNICAL_HIDE_MARKER] = obj.visible !== false;
      }
      obj.visible = false;
    } else if (obj.userData[TECHNICAL_HIDE_MARKER] != null) {
      obj.visible = !!obj.userData[TECHNICAL_HIDE_MARKER];
      delete obj.userData[TECHNICAL_HIDE_MARKER];
    }
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      if ('wireframe' in m) m.wireframe = wireframe;
      // X-ray: translucent body + no depth-write so interior features show.
      // Preserve the original opacity once so we can restore.
      if (wantXray) {
        if (m.userData?.__pf4_xray_orig__ == null) {
          m.userData = m.userData || {};
          m.userData.__pf4_xray_orig__ = {
            opacity: m.opacity,
            transparent: m.transparent,
            depthWrite: m.depthWrite,
          };
        }
        m.opacity = 0.35;
        m.transparent = true;
        m.depthWrite = false;
        m.needsUpdate = true;
      } else if (m.userData?.__pf4_xray_orig__) {
        const o = m.userData.__pf4_xray_orig__;
        m.opacity = o.opacity ?? 1;
        m.transparent = o.transparent ?? false;
        m.depthWrite = o.depthWrite ?? true;
        delete m.userData.__pf4_xray_orig__;
        m.needsUpdate = true;
      }
    }
  });

  removeEdgeOverlay(root);
  removeHiddenEdgeOverlay(root);
  removeTechnicalEdgeOverlay(root);
  if (wantEdges) addEdgeOverlay(root, edgeClipPlanes);
  if (wantHidden) addHiddenEdgeOverlay(root, edgeClipPlanes);
  if (technical) addTechnicalEdgeOverlay(root, edgeClipPlanes);
}

function removeTechnicalEdgeOverlay(root) {
  const stale = [];
  root.traverse((obj) => {
    if (obj.userData?.[TECHNICAL_EDGE_MARKER]) stale.push(obj);
  });
  for (const o of stale) {
    o.parent?.remove(o);
    o.geometry?.dispose();
    o.material?.dispose();
  }
}

function addTechnicalEdgeOverlay(root, clippingPlanes) {
  // Solid black crease lines, depth-tested so back lines hide behind front
  // ones (blueprint convention — hidden-line removal). Sits at parent of
  // each mesh because the mesh itself has been hidden in technical mode.
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x000000,
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
  if (clippingPlanes) { edgeMat.clippingPlanes = clippingPlanes; edgeMat.clipIntersection = false; }
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData?.__pf4_edge_overlay__) return;
    if (obj.userData?.[HIDDEN_EDGE_MARKER]) return;
    if (obj.userData?.[TECHNICAL_EDGE_MARKER]) return;
    try {
      const edges = new THREE.EdgesGeometry(obj.geometry, 22);
      const lines = new THREE.LineSegments(edges, edgeMat);
      lines.userData[TECHNICAL_EDGE_MARKER] = true;
      // The owning mesh has been set to visible=false so we parent the
      // lines to the mesh's parent and copy the local transform — this
      // way EdgesGeometry's world-space placement is preserved.
      lines.matrix.copy(obj.matrix);
      lines.matrixAutoUpdate = obj.matrixAutoUpdate;
      lines.position.copy(obj.position);
      lines.quaternion.copy(obj.quaternion);
      lines.scale.copy(obj.scale);
      lines.renderOrder = 3;
      (obj.parent || root).add(lines);
    } catch {}
  });
}

function removeEdgeOverlay(root) {
  const stale = [];
  root.traverse((obj) => {
    if (obj.userData?.__pf4_edge_overlay__) stale.push(obj);
  });
  for (const o of stale) {
    o.parent?.remove(o);
    o.geometry?.dispose();
    o.material?.dispose();
  }
}

function addEdgeOverlay(root, clippingPlanes) {
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x0a0d12, transparent: true, opacity: 0.85 });
  if (clippingPlanes) { edgeMat.clippingPlanes = clippingPlanes; edgeMat.clipIntersection = false; }
  root.traverse((obj) => {
    if (!obj.isMesh || obj.userData?.__pf4_edge_overlay__) return;
    if (obj.userData?.[HIDDEN_EDGE_MARKER]) return;
    if (!obj.geometry) return;
    try {
      const edges = new THREE.EdgesGeometry(obj.geometry, 22);
      const lines = new THREE.LineSegments(edges, edgeMat);
      lines.userData.__pf4_edge_overlay__ = true;
      lines.renderOrder = 1;
      obj.add(lines);
    } catch {}
  });
}

function removeHiddenEdgeOverlay(root) {
  const stale = [];
  root.traverse((obj) => {
    if (obj.userData?.[HIDDEN_EDGE_MARKER]) stale.push(obj);
  });
  for (const o of stale) {
    o.parent?.remove(o);
    o.geometry?.dispose();
    o.material?.dispose();
  }
}

function addHiddenEdgeOverlay(root, clippingPlanes) {
  // Dashed line material; depthTest=false so it bleeds through solid faces.
  const hiddenMat = new THREE.LineDashedMaterial({
    color: 0x556677,
    dashSize: 0.6,
    gapSize: 0.35,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
  });
  if (clippingPlanes) { hiddenMat.clippingPlanes = clippingPlanes; hiddenMat.clipIntersection = false; }
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData?.__pf4_edge_overlay__) return;
    if (obj.userData?.[HIDDEN_EDGE_MARKER]) return;
    try {
      const edges = new THREE.EdgesGeometry(obj.geometry, 22);
      const lines = new THREE.LineSegments(edges, hiddenMat);
      lines.computeLineDistances?.();
      lines.userData[HIDDEN_EDGE_MARKER] = true;
      lines.renderOrder = 2;
      obj.add(lines);
    } catch {}
  });
}

/** Test-only convenience: list every overlay child under `root`. */
export function _countOverlays(root, marker = '__pf4_edge_overlay__') {
  if (!root) return 0;
  let n = 0;
  root.traverse((o) => { if (o.userData?.[marker]) n++; });
  return n;
}

export const DISPLAY_MARKERS = {
  EDGE: '__pf4_edge_overlay__',
  HIDDEN: HIDDEN_EDGE_MARKER,
  TECHNICAL: TECHNICAL_EDGE_MARKER,
};
