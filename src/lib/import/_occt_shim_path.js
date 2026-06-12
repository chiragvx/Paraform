/**
 * Browser stub for Node's `path` module — only the entry points that
 * `occt-import-js`'s Emscripten glue references inside its
 * `ENVIRONMENT_IS_NODE` branch (which never fires in the browser, but
 * the static `require("path")` still needs to resolve to *something*
 * for Vite's bundler to be happy).
 *
 * Implementations are POSIX-style string manipulation — good enough for
 * the bundler's static analysis pass even though the runtime branch
 * never executes them in the browser. Aliased in vite.config.js.
 *
 * .mjs node tests don't go through Vite, so this shim is browser-only.
 */
function _toStr(p) { return typeof p === 'string' ? p : String(p ?? ''); }

export function normalize(p) {
  p = _toStr(p).replace(/\\/g, '/');
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + parts.join('/');
}
export function resolve(...parts) {
  let acc = '/';
  for (const part of parts) {
    if (!part) continue;
    const s = _toStr(part);
    if (s.startsWith('/')) acc = s;
    else acc = acc.endsWith('/') ? acc + s : acc + '/' + s;
  }
  return normalize(acc);
}
export function join(...parts) {
  return normalize(parts.filter(Boolean).map(_toStr).join('/'));
}
export function dirname(p) {
  const s = _toStr(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '.' : s.slice(0, i);
}
export function basename(p, ext) {
  const s = _toStr(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  let base = i >= 0 ? s.slice(i + 1) : s;
  if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}
export const sep = '/';
export const delimiter = ':';

export default { normalize, resolve, join, dirname, basename, extname, sep, delimiter };
