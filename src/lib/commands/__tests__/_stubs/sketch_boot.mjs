// Stub for $lib/sketch/boot.js
let _active = false;
export const enterSketch = () => { _active = true; };
export const cancelSketch = () => { _active = false; };
export const isSketchActive = () => _active;
