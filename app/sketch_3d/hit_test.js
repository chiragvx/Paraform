/**
 * Hit-testing for the in-viewport sketcher.
 *
 * Takes a pointer event (in browser screen coords relative to the canvas)
 * plus the sketch plane and the camera, and returns the cursor's 2D
 * sketch-local position by raycasting against the plane.
 *
 * Uses Three.js (`THREE.Raycaster`, `THREE.Plane`) for the math but exposes
 * a plain-data API so the rest of the sketch_3d code stays renderer-agnostic.
 */

import * as THREE from 'three';
import { resolvePlane, worldToLocal, VEC } from './plane.js';

/** Reusable scratch objects to avoid allocations on every mousemove. */
const _raycaster = new THREE.Raycaster();
const _ndc       = new THREE.Vector2();
const _plane     = new THREE.Plane();
const _hit       = new THREE.Vector3();
const _origin    = new THREE.Vector3();
const _normal    = new THREE.Vector3();

/**
 * Compute the sketch-local 2D cursor position from a pointer event.
 *
 * @param {object} args
 * @param {{clientX:number,clientY:number}} args.event   — pointer event
 * @param {HTMLElement}        args.canvas               — viewport DOM element (renderer.domElement)
 * @param {THREE.Camera}       args.camera               — viewport camera
 * @param {object}             args.plane                — resolved plane from plane.js
 * @returns {{ world:[number,number,number]|null, local:{x:number,y:number}|null, behindCamera:boolean }}
 */
export function cursorOnPlane({ event, canvas, camera, plane }) {
    if (!canvas || !camera || !plane) {
        return { world: null, local: null, behindCamera: false };
    }
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { world: null, local: null, behindCamera: false };

    _ndc.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    _ndc.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_ndc, camera);

    _origin.fromArray(plane.origin);
    _normal.fromArray(plane.normal);
    _plane.setFromNormalAndCoplanarPoint(_normal, _origin);

    const ok = _raycaster.ray.intersectPlane(_plane, _hit);
    if (!ok) {
        // Ray is parallel to the plane — happens at extreme camera angles.
        // Fall back to projecting the ray origin onto the plane so the
        // cursor stays usable.
        const origin = [_raycaster.ray.origin.x, _raycaster.ray.origin.y, _raycaster.ray.origin.z];
        const proj   = VEC.sub(origin, VEC.scale(_normal.toArray(),
            VEC.dot(VEC.sub(origin, plane.origin), _normal.toArray())));
        return {
            world: proj,
            local: worldToLocal(proj, plane),
            behindCamera: false,
        };
    }

    const world = [_hit.x, _hit.y, _hit.z];
    const local = worldToLocal(world, plane);

    // Detect "behind the camera" — happens when the user orbited past the plane.
    // In that case the ray still intersects but the hit is behind the eye.
    const fromCam = VEC.sub(world, [camera.position.x, camera.position.y, camera.position.z]);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const behindCamera = VEC.dot(fromCam, [forward.x, forward.y, forward.z]) <= 0;

    return { world, local, behindCamera };
}

/**
 * Convenience: bind a host element + camera and plane resolver and return a
 * function that takes a pointer event → { world, local }.
 *
 * @param {object} opts
 * @param {HTMLElement}  opts.canvas
 * @param {THREE.Camera} opts.camera
 * @param {object|()=>object} opts.plane  — resolved plane or a getter
 * @returns {(ev: PointerEvent) => ReturnType<typeof cursorOnPlane>}
 */
export function makeCursorResolver({ canvas, camera, plane }) {
    return (ev) => {
        const p = typeof plane === 'function' ? plane() : plane;
        return cursorOnPlane({ event: ev, canvas, camera, plane: p });
    };
}

// Re-export for callers that want to feed in a raw planeRef.
export { resolvePlane };
