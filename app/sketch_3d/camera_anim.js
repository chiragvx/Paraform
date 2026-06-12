/**
 * Camera animation — tween a Three.js Camera (and its OrbitControls target)
 * to a target view, and back, on a fixed-duration schedule.
 *
 * Used by the sketch-mode controller to:
 *   1. Smoothly fly to top-down view of the chosen sketch plane on enter.
 *   2. Smoothly return to the user's previous angle on exit.
 *
 * Easing: easeInOutCubic. No external animation library — single `rAF` loop
 * per running tween, cancelable via the returned token.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Snapshot a camera + controls state for later restoration.
 *
 * @param {THREE.Camera} camera
 * @param {THREE.OrbitControls} [controls] — optional; `controls.target` is captured if present
 */
export function snapshotView(camera, controls = null) {
    return {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        up:       camera.up.toArray(),
        target:   controls ? controls.target.toArray() : [0, 0, 0],
    };
}

/**
 * Animate the camera to a new view.
 *
 * @param {object} args
 * @param {THREE.Camera} args.camera
 * @param {THREE.OrbitControls} [args.controls]
 * @param {[number,number,number]} args.toPosition
 * @param {[number,number,number]} args.toTarget
 * @param {[number,number,number]} [args.toUp]
 * @param {number} [args.durationMs]
 * @param {() => void} [args.onDone]
 * @returns {{ cancel: () => void }}
 */
export function tweenTo({
    camera, controls = null,
    toPosition, toTarget, toUp = null,
    durationMs = 450,
    onDone = null,
}) {
    if (!camera) throw new Error('tweenTo: missing camera');

    const fromPos    = camera.position.toArray();
    const fromTarget = controls ? controls.target.toArray() : [0, 0, 0];
    const fromUp     = camera.up.toArray();
    const tgtUp      = toUp || fromUp;

    // Compute the start and end quaternions so we orient via spherical lerp
    // rather than aiming with lookAt each frame (smoother on cardinal axes).
    const startQuat = camera.quaternion.clone();
    const endQuat = (() => {
        const sav = {
            pos: camera.position.clone(),
            quat: camera.quaternion.clone(),
            up: camera.up.clone(),
        };
        camera.position.fromArray(toPosition);
        camera.up.fromArray(tgtUp);
        camera.lookAt(toTarget[0], toTarget[1], toTarget[2]);
        const q = camera.quaternion.clone();
        camera.position.copy(sav.pos);
        camera.quaternion.copy(sav.quat);
        camera.up.copy(sav.up);
        return q;
    })();

    const t0 = performance.now();
    let cancelled = false;
    let rafId = 0;

    function step(now) {
        if (cancelled) return;
        const t = Math.min(1, (now - t0) / durationMs);
        const e = easeInOutCubic(t);

        camera.position.set(
            fromPos[0] + (toPosition[0] - fromPos[0]) * e,
            fromPos[1] + (toPosition[1] - fromPos[1]) * e,
            fromPos[2] + (toPosition[2] - fromPos[2]) * e,
        );
        camera.up.set(
            fromUp[0] + (tgtUp[0] - fromUp[0]) * e,
            fromUp[1] + (tgtUp[1] - fromUp[1]) * e,
            fromUp[2] + (tgtUp[2] - fromUp[2]) * e,
        );
        _q.copy(startQuat).slerp(endQuat, e);
        camera.quaternion.copy(_q);
        if (controls) {
            controls.target.set(
                fromTarget[0] + (toTarget[0] - fromTarget[0]) * e,
                fromTarget[1] + (toTarget[1] - fromTarget[1]) * e,
                fromTarget[2] + (toTarget[2] - fromTarget[2]) * e,
            );
            controls.update();
        }

        if (t < 1) {
            rafId = requestAnimationFrame(step);
        } else if (onDone) {
            try { onDone(); } catch (e) { console.error('[tweenTo onDone]', e); }
        }
    }
    rafId = requestAnimationFrame(step);

    return {
        cancel() {
            cancelled = true;
            if (rafId) cancelAnimationFrame(rafId);
        },
    };
}

/**
 * Restore a captured snapshot in one animated step.
 */
export function tweenToSnapshot({ camera, controls, snapshot, durationMs = 450, onDone = null }) {
    return tweenTo({
        camera, controls,
        toPosition: snapshot.position,
        toTarget:   snapshot.target,
        toUp:       snapshot.up,
        durationMs, onDone,
    });
}
