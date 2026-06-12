// Stub for $lib/studio/runtime.svelte.js
export const studio = {
  views: null,
  bridge: null,
  viewport: null,
  displayMode: 'shaded',
  activeComponentId: 'root',
  facePickMode: null,
  // E4 — viewport-owned action hooks. Tests can set these to capture calls.
  startMeasure: null,
  startSection: null,
  runInterference: null,
  setActiveComponent() {},
  startFacePick() { return true; },
  cancelFacePick() {},
};
