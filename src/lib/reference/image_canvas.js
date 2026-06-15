/**
 * Reference-image canvas (Phase A1) — client glue between a dropped image
 * file, the `ReferenceImage` document feature, and the live viewport scene.
 *
 * Mirrors the shape of `src/lib/import/cad.js` (ImportedMesh): a feature
 * carries the asset (here a base64 data-URL) so it round-trips autosave, and a
 * separate scene layer mounts a textured plane the user traces against. The
 * kernel never participates — `ReferenceImage` emits a comment only and is
 * excluded from the leaf-body set (see emit.js).
 *
 * Z-up discipline (CLAUDE.md): the plane itself is built by
 * `createReferenceImagePlane` in conventions.js (PlaneGeometry, +Z normal, NO
 * rotation). Placement here orients that plane from the feature's Z-up
 * `origin` / `normal` / `up`.
 */
import * as THREE from 'three';
import { studio } from '$lib/studio/runtime.svelte.js';
import { addReferenceImage, updateReferenceImage } from '../../../lib/document/operations.js';
import { createReferenceImagePlane } from '../../../lib/viewport/conventions.js';

/**
 * Read a File/Blob into a `data:<mime>;base64,...` string.
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
    fr.readAsDataURL(file);
  });
}

/**
 * Read the natural pixel dimensions of an image data-URL so the initial plane
 * keeps the source aspect ratio before the user calibrates. Falls back to a
 * square if the browser can't decode it.
 * @param {string} dataUrl
 * @returns {Promise<{ w: number, h: number }>}
 */
export function imageNaturalSize(dataUrl) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      img.onerror = () => resolve({ w: 1, h: 1 });
      img.src = dataUrl;
    } catch {
      resolve({ w: 1, h: 1 });
    }
  });
}

/**
 * Full import flow: read the file → derive an initial size that preserves the
 * source aspect (defaulting the larger side to ~100 mm until the user
 * calibrates) → commit a `ReferenceImage` feature. Returns the feature so the
 * caller can select it / open the Inspector. The viewport's reference-image
 * sync (see `syncReferenceImages`) mounts the plane on the next store tick.
 *
 * @param {File} file
 * @param {object} [opts]  — placement overrides (origin/normal/up), opacity
 * @returns {Promise<{ feature: object }>}
 */
export async function importImageAsReferenceFeature(file, opts = {}) {
  if (!file) throw new Error('No file provided');
  const dataUrl = await fileToDataUrl(file);
  const mime = (file.type || 'image/png');
  const { w, h } = await imageNaturalSize(dataUrl);
  const longest = Math.max(w, h) || 1;
  const scale = 100 / longest;   // longest side ≈ 100 mm pre-calibration
  const feature = addReferenceImage({
    name: file.name || 'Reference Image',
    dataUrl,
    mime,
    width_mm: Math.max(1, Math.round(w * scale)),
    height_mm: Math.max(1, Math.round(h * scale)),
    ...opts,
  });
  return { feature };
}

/**
 * Pure helper: build an orthonormal basis (as flat arrays) that maps the
 * plane's local +Z onto `normal` and local +Y onto `up` (re-orthonormalised).
 * Z-up inputs. Exposed for unit testing without THREE.
 *
 * @returns {{ x:number[], y:number[], z:number[] }}
 */
export function orthoBasisFromNormalUp(normal = [0, 0, 1], up = [0, 1, 0]) {
  const norm = (v) => {
    const L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / L, v[1] / L, v[2] / L];
  };
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  let z = norm(normal);
  let yGuess = norm(up);
  // If up ∥ normal, pick a fallback so the cross product is well-defined.
  if (Math.abs(z[0] * yGuess[0] + z[1] * yGuess[1] + z[2] * yGuess[2]) > 0.999) {
    yGuess = Math.abs(z[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  }
  let x = norm(cross(yGuess, z));   // in-plane right
  let y = norm(cross(z, x));        // re-orthonormalised up
  return { x, y, z };
}

/**
 * Orient + position a plane mesh from a feature's Z-up placement params.
 * @param {THREE.Object3D} mesh
 * @param {object} params  — { origin, normal, up }
 */
export function placeReferenceMesh(mesh, params = {}) {
  const { origin = [0, 0, 0], normal = [0, 0, 1], up = [0, 1, 0] } = params;
  const { x, y, z } = orthoBasisFromNormalUp(normal, up);
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(x[0], x[1], x[2]),
    new THREE.Vector3(y[0], y[1], y[2]),
    new THREE.Vector3(z[0], z[1], z[2]),
  );
  mesh.quaternion.setFromRotationMatrix(m);
  mesh.position.set(origin[0], origin[1], origin[2]);
}

/**
 * Build a scene mesh for a ReferenceImage feature.
 * @param {object} feature
 * @returns {THREE.Mesh}
 */
export function buildReferenceMesh(feature) {
  const p = feature.params || {};
  const mesh = createReferenceImagePlane({
    dataUrl: p.dataUrl,
    width_mm: p.width_mm,
    height_mm: p.height_mm,
    opacity: p.opacity,
    displayThrough: p.displayThrough,
  });
  mesh.userData.featureId = feature.id;
  mesh.userData.__refImageHash = referenceVisualHash(p);
  placeReferenceMesh(mesh, p);
  mesh.visible = feature.enabled !== false;
  return mesh;
}

/** A cheap signature of the params that affect the geometry/material so the
 *  sync layer can decide whether to rebuild a mesh or just nudge it. */
function referenceVisualHash(p = {}) {
  return [p.dataUrl?.length || 0, p.width_mm, p.height_mm, p.displayThrough].join('|');
}

/**
 * Reconcile the scene's reference-image planes with the document's
 * ReferenceImage features. Idempotent — call on every store tick. Adds new
 * planes, removes deleted ones, and updates opacity / placement / size /
 * visibility in place. Pass the THREE.Scene (defaults to the live viewport).
 *
 * Returns the Map of featureId → mesh it maintains (stashed on the scene so it
 * survives across calls).
 *
 * @param {object} doc
 * @param {THREE.Scene} [scene]
 */
export function syncReferenceImages(doc, scene = studio.viewport?.scene) {
  if (!scene || !doc) return null;
  const registry = scene.userData.__refImages || (scene.userData.__refImages = new Map());
  const features = doc.features || {};
  const order = doc.featureOrder || [];
  const live = new Set();

  for (const id of order) {
    const f = features[id];
    if (!f || f.type !== 'ReferenceImage') continue;
    live.add(id);
    const p = f.params || {};
    let mesh = registry.get(id);
    const hash = referenceVisualHash(p);
    if (mesh && mesh.userData.__refImageHash !== hash) {
      // Geometry/texture changed materially — rebuild.
      disposeMesh(mesh);
      scene.remove(mesh);
      mesh = null;
    }
    if (!mesh) {
      mesh = buildReferenceMesh(f);
      scene.add(mesh);
      registry.set(id, mesh);
    } else {
      // Cheap in-place updates.
      if (mesh.material) {
        mesh.material.opacity = p.opacity ?? 0.65;
        mesh.material.depthTest = !p.displayThrough;
      }
      mesh.renderOrder = p.displayThrough ? 999 : -1;
      placeReferenceMesh(mesh, p);
      mesh.visible = f.enabled !== false;
    }
  }

  // Remove planes whose feature is gone.
  for (const [id, mesh] of registry) {
    if (!live.has(id)) {
      scene.remove(mesh);
      disposeMesh(mesh);
      registry.delete(id);
    }
  }
  return registry;
}

function disposeMesh(mesh) {
  try {
    mesh.geometry?.dispose?.();
    mesh.material?.map?.dispose?.();
    mesh.material?.dispose?.();
  } catch { /* ignore */ }
}

export { updateReferenceImage };
