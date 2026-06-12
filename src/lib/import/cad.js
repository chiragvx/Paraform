/**
 * CAD/mesh import pipeline (client-side).
 *
 * - GLB / GLTF: read via three's GLTFLoader on a Blob URL.
 * - STEP / IGES: read via occt-import-js WASM, meshed in-browser, then
 *   re-encoded as GLB so every imported format shares a single
 *   serialisable representation (base64 GLB on an ImportedMesh feature).
 *
 * v1 wiring: imports both attach to the live scene immediately
 * (addImportedToScene) AND commit an `ImportedMesh` feature carrying the
 * base64 GLB so the timeline + autosave roundtrip survive reload. The
 * bridge re-attaches on reload by decoding `params.glbBase64` through
 * GLTFLoader (see bridge.js `attachImportedMeshFromFeature`).
 *
 * The group is rotated +π/2 about X to convert glTF's Y-up into the
 * project's Z-up (see CLAUDE.md). STEP / IGES output from occt-import-js
 * is already in millimetres and Z-up-friendly (no extra rotation), but
 * we still wrap the meshes in a Group so callers get a single,
 * removable handle.
 *
 * Browser shim: occt-import-js's Emscripten glue statically `require()`s
 * Node's `path` / `crypto` / `fs`. Those resolve via Vite aliases in
 * vite.config.js to empty browser stubs in this directory
 * (`_occt_shim_*.js`). The Node-only branch in the glue never fires at
 * runtime because `ENVIRONMENT_IS_NODE` is false in a browser context.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { studio } from '$lib/studio/runtime.svelte.js';
import { addImportedMesh } from '../../../lib/document/operations.js';

// Lazy-load occt-import-js (large WASM blob, ~200-300KB) so .glb-only users
// don't pay the cost. The first STEP/IGES import pays the one-time
// instantiation; subsequent calls reuse the memoised runtime.
let _occtPromise = null;
function getOcct() {
  if (!_occtPromise) {
    _occtPromise = import('occt-import-js').then(({ default: occtImportJs }) => occtImportJs());
  }
  return _occtPromise;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

async function fileToArrayBuffer(file) {
  // File / Blob both support .arrayBuffer() in modern browsers and Tauri WebView.
  return await file.arrayBuffer();
}

/**
 * Parse a GLB ArrayBuffer into a three Group. Pulled out of importGlb so
 * the bridge re-attach path (decoding ImportedMesh.glbBase64) and the
 * direct file-import path share one code path.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<THREE.Group>}
 */
export async function parseGlbBuffer(buffer) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject);
  });
  const inner = gltf.scene || gltf.scenes?.[0];
  if (!inner) throw new Error('glTF contained no scene');
  // Wrap so we can apply the Y-up → Z-up rotation without mutating the
  // loader output's transform (which downstream code may inspect).
  const wrap = new THREE.Group();
  wrap.name = inner.name || 'gltfImport';
  wrap.rotation.x = Math.PI / 2;
  wrap.add(inner);
  return wrap;
}

/**
 * Import a .glb or .gltf file. Returns a THREE.Group (the parsed scene)
 * already rotated so glTF's +Y becomes world +Z.
 * @param {File} file
 * @returns {Promise<THREE.Group>}
 */
export async function importGlb(file) {
  const buffer = await fileToArrayBuffer(file);
  return parseGlbBuffer(buffer);
}

/**
 * Build a THREE.Group of meshes from an occt-import-js result.
 * @param {{ success: boolean, meshes: any[] }} result
 */
function buildOcctGroup(result) {
  if (!result || !result.success) {
    throw new Error('OCCT import failed');
  }
  const group = new THREE.Group();
  for (const m of result.meshes) {
    const geom = new THREE.BufferGeometry();
    const posArr = m.attributes?.position?.array;
    if (!posArr) continue;
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const normArr = m.attributes?.normal?.array;
    if (normArr) {
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
    }
    const idxArr = m.index?.array;
    if (idxArr) {
      const ctor = posArr.length / 3 > 65535 ? Uint32Array : Uint16Array;
      geom.setIndex(new THREE.BufferAttribute(new ctor(idxArr), 1));
    }
    if (!normArr) geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x9aa6b2,
      metalness: 0.2,
      roughness: 0.6,
    });
    // If the OCCT body carries a per-body colour, prefer it.
    if (Array.isArray(m.color) && m.color.length >= 3) {
      mat.color.setRGB(m.color[0], m.color[1], m.color[2]);
    }

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = m.name || 'occtBody';
    group.add(mesh);
  }
  return group;
}

/**
 * Import a STEP or IGES file via OCCT/WASM.
 * @param {File} file
 * @returns {Promise<THREE.Group>}
 */
export async function importStep(file) {
  const occ = await getOcct();
  const buffer = await fileToArrayBuffer(file);
  const bytes = new Uint8Array(buffer);
  const ext = extOf(file.name);
  let result;
  if (ext === 'iges' || ext === 'igs') {
    result = occ.ReadIgesFile(bytes, null);
  } else {
    result = occ.ReadStepFile(bytes, null);
  }
  return buildOcctGroup(result);
}

/**
 * Encode a three Object3D as a GLB ArrayBuffer. Used to canonicalise
 * imported geometry (STEP/IGES → GLB) so a single representation rides
 * on the ImportedMesh feature and survives serialise / reload.
 *
 * @param {THREE.Object3D} object
 * @returns {Promise<ArrayBuffer>}
 */
export function encodeGlb(object) {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    try {
      exporter.parse(
        object,
        (result) => {
          if (result instanceof ArrayBuffer) resolve(result);
          else reject(new Error('GLTFExporter returned non-binary; pass binary:true'));
        },
        (err) => reject(err),
        { binary: true },
      );
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Base64-encode an ArrayBuffer. Browser-safe — chunks to avoid the
 * `Maximum call stack size exceeded` that String.fromCharCode hits on
 * large payloads (~100KB+).
 *
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * Decode a base64 GLB payload back into an ArrayBuffer. Used by the
 * bridge / re-attach path when reloading a document.
 *
 * @param {string} b64
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/**
 * Dispatch by file extension. Returns the parsed THREE.Group only —
 * use `importCadFileAsFeature` to also commit the ImportedMesh feature.
 * @param {File} file
 * @returns {Promise<THREE.Group>}
 */
export async function importCadFile(file) {
  if (!file) throw new Error('No file provided');
  const ext = extOf(file.name);
  switch (ext) {
    case 'glb':
    case 'gltf':
      return importGlb(file);
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
      return importStep(file);
    default:
      throw new Error(`Unsupported CAD file extension: .${ext || '(none)'}`);
  }
}

/**
 * Full import flow: parse the file → encode as GLB → commit an
 * ImportedMesh feature → return both the group (for immediate scene
 * mount) and the committed feature (so callers can wire selection /
 * timeline UI).
 *
 * Caller is responsible for the scene mount via `addImportedToScene`
 * (we keep the two halves separate so this function stays useful in
 * headless tests).
 *
 * @param {File} file
 * @returns {Promise<{ group: THREE.Group, feature: object }>}
 */
export async function importCadFileAsFeature(file) {
  if (!file) throw new Error('No file provided');
  const ext = extOf(file.name);
  const group = await importCadFile(file);
  // For non-glb formats, encode through GLTFExporter so the persisted
  // representation is uniform. For .glb input we re-encode rather than
  // riding the original bytes — the wrapper group's Z-up rotation gets
  // baked into the GLB this way, so re-loading needs no Y-up→Z-up
  // step. Simpler invariant.
  const ab = await encodeGlb(group);
  const glbBase64 = arrayBufferToBase64(ab);
  const feature = addImportedMesh({
    name: file.name,
    format: (ext === 'gltf' ? 'glb' : ext),
    glbBase64,
  });
  return { group, feature };
}

/**
 * Add an imported group to the live viewport scene.
 * @param {THREE.Group} group
 * @param {string} name
 * @returns {{ dispose: () => void }}
 */
export function addImportedToScene(group, name) {
  const scene = studio.viewport?.scene;
  if (!scene) throw new Error('Viewport scene is not ready');
  group.userData = group.userData || {};
  group.userData.importedName = name;
  if (name && !group.name) group.name = name;
  scene.add(group);
  return {
    dispose() {
      scene.remove(group);
      group.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry?.dispose?.();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mm) => mm?.dispose?.());
          else m?.dispose?.();
        }
      });
    },
  };
}

/**
 * Decode an ImportedMesh feature's `glbBase64` payload back into a
 * three Group. Used by the bridge on document reload.
 *
 * @param {{ params: { glbBase64?: string, name?: string } }} feature
 * @returns {Promise<THREE.Group|null>}
 */
export async function decodeImportedMeshFeature(feature) {
  const b64 = feature?.params?.glbBase64;
  if (!b64) return null;
  try {
    const ab = base64ToArrayBuffer(b64);
    // The GLB was encoded *after* the Z-up rotation wrap was applied, so
    // the persisted payload is already Z-up. Parse it raw — do NOT use
    // parseGlbBuffer, which would apply a second rotation.
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(ab, '', resolve, reject);
    });
    const scene = gltf.scene || gltf.scenes?.[0];
    if (!scene) return null;
    if (!scene.name && feature.params?.name) scene.name = feature.params.name;
    return scene;
  } catch (err) {
    console.warn('decodeImportedMeshFeature: failed to decode', err);
    return null;
  }
}
