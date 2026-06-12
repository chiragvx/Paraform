/**
 * Node ESM resolver hook for the face-pick test.
 *
 * Stubs the heavy modules pulled in by src/lib/sketch/boot.js:
 *   - $lib/studio/runtime.svelte.js  (Svelte 5 runes — invalid plain JS)
 *   - ../../../app/sketch_3d/index.js (DOM + three.js at module load)
 *
 * Everything else resolves normally so we can exercise real operations.js +
 * the real lib/document/* surface against an in-memory store.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stubDir = pathToFileURL(here).href + '/_stubs/';

const repoRoot = resolvePath(here, '..', '..', '..', '..');
const libAlias = pathToFileURL(resolvePath(repoRoot, 'src/lib')).href + '/';
const sketch3dAbs = pathToFileURL(resolvePath(repoRoot, 'app/sketch_3d/index.js')).href;

const stubMap = new Map([
  ['$lib/studio/runtime.svelte.js', stubDir + 'studio_runtime.mjs'],
  [sketch3dAbs, stubDir + 'sketch_3d.mjs'],
]);

export async function resolve(specifier, context, nextResolve) {
  // Match the bare $lib alias and the resolved app/sketch_3d/index.js path.
  if (stubMap.has(specifier)) {
    return { url: stubMap.get(specifier), shortCircuit: true };
  }
  if (specifier.startsWith('$lib/')) {
    const rest = specifier.slice('$lib/'.length);
    return { url: libAlias + rest, shortCircuit: true };
  }
  // Resolve relative imports normally, then intercept the sketch_3d index.
  const next = await nextResolve(specifier, context);
  if (next?.url === sketch3dAbs) {
    return { url: stubMap.get(sketch3dAbs), shortCircuit: true };
  }
  return next;
}
