// Stub for app/sketch_3d/index.js — replaces the real sketcher (which pulls
// three.js + DOM at module load) with a tiny in-memory controller so we can
// drive enterSketch() / cancelSketch() / isSketchActive() under node.

let _ctrl = null;
const _calls = [];

export function enterSketchMode(opts) {
  _ctrl = { ...opts, _entered: true };
  _calls.push({ kind: 'enter', plane: opts?.plane });
  return _ctrl;
}
export function exitSketchMode() {
  if (_ctrl) _calls.push({ kind: 'exit' });
  _ctrl = null;
}
export function getActiveSketchController() {
  return _ctrl;
}

// Test-only helpers
export function _testCalls() { return _calls.slice(); }
export function _testReset() { _ctrl = null; _calls.length = 0; }
