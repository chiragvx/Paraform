/**
 * Browser stub for Node's `fs` module. occt-import-js's Emscripten glue
 * references `fs.readFile` / `readFileSync` / `readSync` inside its
 * `ENVIRONMENT_IS_NODE` branch (which doesn't fire in the browser).
 * package.json already declares `"browser": { "fs": false }` but Vite's
 * resolver doesn't always honour that for transitive Node-glue blocks,
 * so we shim it explicitly.
 *
 * Every method throws — these aren't meant to be called at runtime in
 * the browser. .mjs node tests bypass Vite and use the real `fs`.
 */
function _nope() {
  throw new Error('fs is not available in the browser (occt-import-js shim)');
}

export const readFile = _nope;
export const readFileSync = _nope;
export const readSync = _nope;
export const writeFile = _nope;
export const writeFileSync = _nope;
export const existsSync = () => false;
export const statSync = _nope;
export const promises = { readFile: _nope, writeFile: _nope };

export default { readFile, readFileSync, readSync, writeFile, writeFileSync, existsSync, statSync, promises };
