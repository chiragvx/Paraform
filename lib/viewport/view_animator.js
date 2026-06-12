/**
 * View animator — tweens a camera + controls between viewpoints with
 * cubic ease-out (Material standard ~250ms). All canned view changes go
 * through here so they share one easing, one cancel-on-interrupt policy.
 *
 * Re-exports the sketcher's `tweenTo` / `snapshotView` for callers that
 * just need the basics; adds higher-level utilities for the common
 * navigation tasks:
 *
 *   - standardView(camera, controls, name, opts)      → Front / Top / Iso / …
 *   - frameBox(camera, controls, box, opts)           → fit camera to AABB
 *   - frameTarget(camera, controls, point, dist, opts)→ keep direction, move target
 *   - normalToFace(camera, controls, origin, normal, opts) → align camera to face normal
 */

import * as THREE from 'three';
import { tweenTo as rawTweenTo, snapshotView, tweenToSnapshot as rawTweenToSnapshot } from '../../app/sketch_3d/camera_anim.js';

export { snapshotView };

/** Material-style ease-out cubic (~Fusion ViewCube feel). */
export const STANDARD_DURATION_MS = 280;

// ─── Single-flight tween manager ─────────────────────────────────────────────
// Concurrent view tweens fight: two rAF loops writing camera.position each
// frame produce visible jitter and end up wherever the last-finishing loop
// decided. We cap ourselves to ONE in-flight view tween per (camera, controls)
// pair — a new tween cancels any running one mid-flight, which leaves the
// camera at its current (lerped) state, so the new tween starts from there
// and the transition feels continuous instead of cut.

const _activeTweens = new WeakMap(); // camera → { cancel, controls }

function _trackTween(camera, controls, handle) {
    _activeTweens.set(camera, { cancel: handle.cancel, controls });
    return handle;
}

/**
 * Cancel the camera's currently-running view tween, if any. Safe to call when
 * none is in flight. Exposed for callers that want a hard cut (e.g. test setup
 * or ESC-to-cancel-nav).
 */
export function cancelActiveTween(camera) {
    const live = _activeTweens.get(camera);
    if (live) {
        try { live.cancel(); } catch { /* ignore */ }
        _activeTweens.delete(camera);
    }
}

/**
 * tweenTo — wraps `app/sketch_3d/camera_anim.js#tweenTo` with the single-
 * flight guard above. Cancels any tween already running on the same camera
 * so the new one lerps from wherever the previous one had reached. Caller
 * gets the same `{ cancel }` token shape.
 */
export function tweenTo(args) {
    if (!args || !args.camera) throw new Error('tweenTo: missing camera');
    cancelActiveTween(args.camera);
    const userOnDone = args.onDone;
    const handle = rawTweenTo({
        ...args,
        onDone() {
            // Clear our tracking entry before the user callback, so they're
            // free to start another tween from inside it.
            const entry = _activeTweens.get(args.camera);
            if (entry && entry.cancel === handle.cancel) {
                _activeTweens.delete(args.camera);
            }
            if (typeof userOnDone === 'function') userOnDone();
        },
    });
    return _trackTween(args.camera, args.controls, handle);
}

/** Same guard for the snapshot-based helper. */
export function tweenToSnapshot(args) {
    if (!args || !args.camera) throw new Error('tweenToSnapshot: missing camera');
    cancelActiveTween(args.camera);
    const userOnDone = args.onDone;
    const handle = rawTweenToSnapshot({
        ...args,
        onDone() {
            const entry = _activeTweens.get(args.camera);
            if (entry && entry.cancel === handle.cancel) {
                _activeTweens.delete(args.camera);
            }
            if (typeof userOnDone === 'function') userOnDone();
        },
    });
    return _trackTween(args.camera, args.controls, handle);
}

/**
 * Named cardinal views. Each returns a unit vector `from` (camera direction)
 * and a unit `up`. Distance is taken from the current camera.
 *
 * Conventions: world Z is up (matches the v4 kernel and the sketcher).
 *   - Top    looks down +Z → −Z
 *   - Front  looks down +Y → −Y
 *   - Right  looks down +X → −X
 *   - Iso    looks from (+X, +Y, +Z) bisector
 */
// Custom-view registry. Hosts (e.g. the Svelte ViewBookmarksPanel) push
// user-saved camera snapshots in here so palette commands + the ViewCube
// dropdown can list them alongside the eight cardinal views. Entries
// carry `position / target / up` arrays so `tweenTo()` works as-is.
//   registerCustomView('plan', { position:[…], target:[…], up:[…] })
//   const v = getCustomView('plan')           // → entry | undefined
//   listCustomViews()                          // → string[]
//   unregisterCustomView('plan')
const _customViews = new Map();
export function registerCustomView(name, entry) {
    if (!name || !entry) return;
    _customViews.set(name, entry);
}
export function getCustomView(name) { return _customViews.get(name); }
export function listCustomViews() { return [...(_customViews.keys())]; }
export function unregisterCustomView(name) { _customViews.delete(name); }

export const NAMED_VIEWS = Object.freeze({
    front:  { dir: [ 0,  1,  0], up: [0, 0, 1] },
    back:   { dir: [ 0, -1,  0], up: [0, 0, 1] },
    left:   { dir: [-1,  0,  0], up: [0, 0, 1] },
    right:  { dir: [ 1,  0,  0], up: [0, 0, 1] },
    top:    { dir: [ 0,  0,  1], up: [0, 1, 0] },
    bottom: { dir: [ 0,  0, -1], up: [0, 1, 0] },
    iso:    { dir: [ 1, -1,  1], up: [0, 0, 1] },
    isoBack:{ dir: [-1,  1,  1], up: [0, 0, 1] },
});

/**
 * Tween to a named view, preserving the current camera→target distance and
 * the current target.
 *
 * @param {THREE.Camera} camera
 * @param {object}       controls
 * @param {keyof typeof NAMED_VIEWS} name
 * @param {object}       [opts]
 * @param {THREE.Vector3}[opts.target]   — override target (default: controls.target)
 * @param {number}       [opts.distance] — override camera distance
 * @param {number}       [opts.durationMs]
 */
export function standardView(camera, controls, name, opts = {}) {
    const v = NAMED_VIEWS[name];
    if (!v) throw new Error(`standardView: unknown view "${name}"`);
    const target = (opts.target || controls.target || new THREE.Vector3()).clone();
    const curDist = camera.position.distanceTo(target) || 200;
    const dist = Number.isFinite(opts.distance) ? opts.distance : curDist;
    const dir = new THREE.Vector3(v.dir[0], v.dir[1], v.dir[2]).normalize();
    const pos = target.clone().add(dir.multiplyScalar(dist));
    return tweenTo({
        camera, controls,
        toPosition: pos.toArray(),
        toTarget:   target.toArray(),
        toUp:       v.up,
        durationMs: opts.durationMs ?? STANDARD_DURATION_MS,
        onDone:     opts.onDone,
    });
}

/**
 * Frame an AABB — current view direction kept, camera distance set so the
 * box fills `fillFactor` (default 0.85) of the smaller viewport dimension.
 *
 * @param {THREE.Camera} camera          (PerspectiveCamera; ortho also supported via zoom)
 * @param {object}       controls
 * @param {THREE.Box3}   box
 * @param {object}       [opts]
 * @param {number}       [opts.fillFactor] — 0..1; default 0.7
 * @param {number}       [opts.durationMs]
 */
export function frameBox(camera, controls, box, opts = {}) {
    if (!box || box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov    = (camera.fov || 75) * Math.PI / 180;
    const fill   = opts.fillFactor ?? 0.7;
    const dist   = (maxDim / 2) / Math.tan(fov / 2) / fill;

    const dir = new THREE.Vector3().copy(camera.position).sub(controls.target || center).normalize();
    if (!Number.isFinite(dir.x)) dir.set(1, -1, 1).normalize();
    const pos = center.clone().add(dir.multiplyScalar(dist));
    return tweenTo({
        camera, controls,
        toPosition: pos.toArray(),
        toTarget:   center.toArray(),
        toUp:       camera.up.toArray(),
        durationMs: opts.durationMs ?? STANDARD_DURATION_MS,
        onDone:     opts.onDone,
    });
}

/**
 * Fit-to-selection — fits whatever the picking selection currently holds into
 * roughly `fillFactor` (default 0.7) of the smaller viewport dimension while
 * preserving the current orbit angle.
 *
 * Accepts either:
 *   - a PickingSelection-like object with `.toArray()` whose entries point at
 *     featured Object3Ds via `payload.object` (preferred), OR
 *   - a flat array of THREE.Object3D, OR
 *   - a THREE.Box3 already (skips computation).
 *
 * When the selection is empty (or no payload resolves to an object), the
 * caller should fall back to `frameBox` over the scene AABB — this helper
 * returns `null` in that case so the caller can branch.
 *
 * @param {THREE.PickingSelection|THREE.Object3D[]|THREE.Box3} selection
 * @param {THREE.Camera} camera
 * @param {object}       controls
 * @param {object}       [opts]
 * @param {number}       [opts.fillFactor] — default 0.7
 * @param {number}       [opts.durationMs]
 * @param {(sel:any) => THREE.Object3D[]} [opts.resolveObjects] — host hook for
 *     converting a selection entry into renderable Object3Ds. Useful when the
 *     payload doesn't carry an `object` reference (e.g. face descriptors that
 *     only carry feature IDs).
 */
export function fitToSelection(selection, camera, controls, opts = {}) {
    if (!selection) return null;
    let box = null;
    if (selection && selection.isBox3) {
        box = selection;
    } else {
        const objs = [];
        if (typeof opts.resolveObjects === 'function') {
            const resolved = opts.resolveObjects(selection);
            if (Array.isArray(resolved)) objs.push(...resolved);
        } else if (Array.isArray(selection)) {
            objs.push(...selection);
        } else if (typeof selection.toArray === 'function') {
            for (const entry of selection.toArray()) {
                const obj = entry && entry.payload && entry.payload.object;
                if (obj) objs.push(obj);
            }
        }
        if (objs.length === 0) return null;
        box = aabbOf(objs);
    }
    if (!box || box.isEmpty()) return null;
    return frameBox(camera, controls, box, {
        fillFactor: opts.fillFactor ?? 0.7,
        durationMs: opts.durationMs,
        onDone: opts.onDone,
    });
}

/**
 * Compute the AABB of a list of objects. Returns an empty box when nothing
 * pickable is in the list.
 */
export function aabbOf(objects) {
    const box = new THREE.Box3();
    for (const obj of objects) {
        if (!obj) continue;
        const childBox = new THREE.Box3().setFromObject(obj);
        if (!childBox.isEmpty()) box.union(childBox);
    }
    return box;
}

/**
 * "Normal to" — align the camera so it looks straight down `-normal` at
 * `origin`. Keeps the current camera-target distance.
 */
export function normalToFace(camera, controls, origin, normal, opts = {}) {
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
    if (!Number.isFinite(n.x)) return null;
    const target = new THREE.Vector3(origin[0], origin[1], origin[2]);
    const dist   = camera.position.distanceTo(controls.target || target) || 200;
    const pos    = target.clone().add(n.multiplyScalar(dist));
    // Pick an up vector that isn't parallel to the normal.
    const up = Math.abs(n.dot(new THREE.Vector3(0, 0, 1))) > 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
    return tweenTo({
        camera, controls,
        toPosition: pos.toArray(),
        toTarget:   target.toArray(),
        toUp:       up.toArray(),
        durationMs: opts.durationMs ?? STANDARD_DURATION_MS,
        onDone:     opts.onDone,
    });
}
