import {
  standardView,
  frameBox,
  aabbOf,
} from '../../../lib/viewport/view_animator.js';

/** Camera/controls/bridge bundle used by every helper here. */
export function makeViewController({ camera, controls, bridge }) {
  function toNamed(name) {
    standardView(camera, controls, name, { durationMs: 280 });
  }

  function fit() {
    const obj = bridge?.bodyTransform;
    if (!obj) {
      // No body yet — recentre on origin at a sane distance.
      standardView(camera, controls, 'iso', { durationMs: 200 });
      return;
    }
    const box = aabbOf([obj]);
    if (!box || box.isEmpty()) return;
    frameBox(camera, controls, box, { fillFactor: 0.7, durationMs: 280 });
  }

  return {
    toNamed,
    fit,
    top:    () => toNamed('top'),
    bottom: () => toNamed('bottom'),
    front:  () => toNamed('front'),
    back:   () => toNamed('back'),
    left:   () => toNamed('left'),
    right:  () => toNamed('right'),
    iso:    () => toNamed('iso'),
  };
}

/** Maps numeric keys (1..7) to named views — SolidWorks convention. */
export const NUMERIC_VIEW_KEYS = {
  1: 'front',
  2: 'back',
  3: 'left',
  4: 'right',
  5: 'top',
  6: 'bottom',
  7: 'iso',
};
