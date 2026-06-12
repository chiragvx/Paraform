/**
 * Browser stub for Node's `crypto` module — only what occt-import-js
 * touches inside its `ENVIRONMENT_IS_NODE` branch (which doesn't run
 * in the browser). The Emscripten glue references `crypto.randomBytes`
 * as a fallback for `crypto.getRandomValues`; in the browser we'd
 * never take that branch, but the static `require("crypto")` still
 * has to resolve.
 *
 * We delegate to `globalThis.crypto.getRandomValues` so that any
 * accidental call actually returns entropy instead of zeros — defence
 * in depth. .mjs node tests don't go through Vite, so this is
 * browser-only.
 */
export function randomBytes(n) {
  const buf = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  }
  return buf;
}

export function randomFillSync(buf) {
  if (buf && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  }
  return buf;
}

export function createHash() {
  // Minimal no-op hash — occt-import-js doesn't actually need a real
  // digest in browser mode; this just satisfies the static import.
  let data = '';
  return {
    update(chunk) { data += String(chunk ?? ''); return this; },
    digest() { return data; },
  };
}

export default { randomBytes, randomFillSync, createHash };
