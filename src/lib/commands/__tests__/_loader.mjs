/**
 * Node ESM resolver hook for the registry test.
 *
 * The registry imports a handful of `.svelte.js` files that use Svelte 5
 * runes (`$state`, …) at module top-level — those tokens aren't valid plain
 * JS so they crash a vanilla `node` evaluation. This hook rewrites the
 * relevant specifiers to dependency-free stubs alongside this file, so we
 * can exercise the pure COMMANDS table + its enabled/run callbacks under
 * node:assert.
 *
 * This file is a *hook module*. It is loaded into the loader thread by
 * `register.mjs` (sibling) via `module.register(...)`.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stubDir = pathToFileURL(here).href + '/_stubs/';

// repo root: src/lib/commands/__tests__ → ../../../..  (four ups)
const repoRoot = resolvePath(here, '..', '..', '..', '..');
const libAlias = pathToFileURL(resolvePath(repoRoot, 'src/lib')).href + '/';

const stubMap = new Map([
  ['$lib/studio/runtime.svelte.js',       stubDir + 'studio_runtime.mjs'],
  ['$lib/dialogs/dialogs.svelte.js',      stubDir + 'dialogs.mjs'],
  ['$lib/dialogs/extras.svelte.js',       stubDir + 'extras.mjs'],
  ['$lib/document/persistence.svelte.js', stubDir + 'persistence.mjs'],
  ['$lib/sketch/boot.js',                 stubDir + 'sketch_boot.mjs'],
  ['$lib/commands/palette.svelte.js',     stubDir + 'palette.mjs'],
]);

export async function resolve(specifier, context, nextResolve) {
  if (stubMap.has(specifier)) {
    return { url: stubMap.get(specifier), shortCircuit: true };
  }
  if (specifier.startsWith('$lib/')) {
    const rest = specifier.slice('$lib/'.length);
    return { url: libAlias + rest, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
