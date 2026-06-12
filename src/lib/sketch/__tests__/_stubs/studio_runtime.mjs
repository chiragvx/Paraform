// Stub for $lib/studio/runtime.svelte.js — tests need a plain-JS port of the
// runtime that mirrors the face-pick + measure API surface used by boot.js.
class StudioStub {
  constructor() {
    this.viewport = { ready: true };
    this.bridge   = { lastError: null };
    this.facePickMode = null;
    this._measureImpl = async () => { throw new Error('no measure impl set'); };
  }
  setMeasureImpl(fn) { this._measureImpl = fn; }
  async measure(q) { return this._measureImpl(q); }
  startFacePick({ purpose = 'sketch', accept = ['face'], onPick = () => {}, onCancel = () => {} } = {}) {
    if (!this.viewport) return false;
    if (this.facePickMode) { try { this.facePickMode.onCancel?.(); } catch {} }
    this.facePickMode = { purpose, accept: new Set(accept), onPick, onCancel };
    return true;
  }
  cancelFacePick() {
    const m = this.facePickMode;
    this.facePickMode = null;
    if (m) { try { m.onCancel?.(); } catch {} }
  }
  // Reset between tests
  _reset() {
    this.viewport = { ready: true };
    this.bridge = { lastError: null };
    this.facePickMode = null;
    this._measureImpl = async () => { throw new Error('no measure impl set'); };
  }
}

export const studio = new StudioStub();
