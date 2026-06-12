/**
 * Public surface of the in-viewport sketcher.
 *
 *   enterSketchMode({ viewport, store, bridge, plane })
 *     → animates the camera to top-down on the plane, mounts the toolbar +
 *       3D sketch overlay, captures the canvas's pointer events, returns
 *       the active controller.
 *
 *   exitSketchMode()
 *     → cancels and reverses everything.
 *
 *   getActiveSketchController()
 *     → undefined when no sketch is active, otherwise the live instance
 *       (handy from DevTools for ad-hoc poking).
 */

export { enterSketchMode, exitSketchMode, getActiveSketchController, setSketchConfirmFn } from './controller.js';
