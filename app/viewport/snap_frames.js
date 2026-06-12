/**
 * Frame math for dragging a placed component whose subgroup sits at IDENTITY
 * under the GLB wrap (×1000 mm→m + Y-up→Z-up), with placement baked into the
 * kernel geometry (see lib/document/bridge.js). We never write world-mm into
 * the subgroup's local transform — we drive it by a world-space delta.
 *
 * Notation (all THREE.Matrix4, world frame unless noted):
 *   P        — subgroup parent (the GLB wrap) world matrix
 *   objStart — subgroup world matrix captured at drag start (= P, since the
 *              subgroup's own matrix is identity at rest)
 *   W0       — component's baked world pose (compose of its doc origin)
 *   Wnew     — desired component world pose (mate solver output, mm Z-up)
 *
 * Identities used (proven in __tests__/snap_frames.mjs):
 *   objLocal       = P⁻¹ · Wnew · W0⁻¹ · objStart           (drive to Wnew)
 *   componentWorld = objWorld · objStart⁻¹ · W0             (read pose back)
 *   liveConnector  = objWorld · objStart⁻¹ · worldOrigin    (live node pos)
 */

import * as THREE from 'three';

const _ONE = new THREE.Vector3(1, 1, 1);

/** Compose a 4×4 from a position triple + Euler-XYZ triple (radians). */
export function composeMatrix(position, euler) {
    const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(euler[0] || 0, euler[1] || 0, euler[2] || 0, 'XYZ'));
    return new THREE.Matrix4().compose(
        new THREE.Vector3(position[0] || 0, position[1] || 0, position[2] || 0), q, _ONE);
}

/** Decompose a 4×4 into { position:[x,y,z], rotation:[x,y,z] } (Euler XYZ). */
export function decomposePose(m) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return { position: [p.x, p.y, p.z], rotation: [e.x, e.y, e.z] };
}

/** Subgroup LOCAL matrix that drives the component to world pose Wnew. */
export function localForWorldPose(Pinv, objStart, W0inv, Wnew) {
    const t = Wnew.clone().multiply(W0inv).multiply(objStart);
    return Pinv.clone().multiply(t);
}

/** Component world pose given the subgroup's current world matrix. */
export function componentWorldFromObject(objWorld, objStartInv, W0) {
    return objWorld.clone().multiply(objStartInv).multiply(W0);
}

/** Live world position of a connector whose drag-start world origin is given. */
export function liveConnectorWorld(objWorld, objStartInv, worldOrigin) {
    return new THREE.Vector3(worldOrigin[0], worldOrigin[1], worldOrigin[2])
        .applyMatrix4(objStartInv).applyMatrix4(objWorld);
}
