/**
 * Spec 17 v2 — contact-region overlay helper.
 *
 * Given a list of triangle pairs from `findIntersectingTriangles`,
 * build a three.js Group containing red line-segments between the
 * centroids of every intersecting triangle pair. The caller mounts the
 * group into the scene and disposes it via `disposeContactOverlay` when
 * the pose changes or interference clears.
 *
 * We deliberately do NOT compute the boolean intersection body. Centroid
 * lines (a) carry no manifold / topology requirement, (b) update at
 * slider speed, and (c) make "where do they collide" obvious in the
 * viewport. Boolean bodies are the CSG follow-up.
 *
 * The line material follows the Z-up scene convention — no special
 * orientation handling required; centroids are already in worldspace.
 */

import * as THREE from 'three';

/**
 * @param {Array<{centroidA:number[], centroidB:number[]}>} pairs
 * @param {{ color?: number, linewidth?: number, name?: string }} [opts]
 * @returns {THREE.Group} group with one LineSegments child per pair-batch
 */
export function buildContactOverlay(pairs, opts = {}) {
    const { color = 0xff2030, name = 'interference-overlay' } = opts;
    const group = new THREE.Group();
    group.name = name;
    group.userData.kind = 'interference-overlay';
    group.userData.pairCount = pairs ? pairs.length : 0;
    if (!pairs || pairs.length === 0) return group;

    const positions = new Float32Array(pairs.length * 6);
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        const a = p.centroidA, b = p.centroidB;
        positions[i * 6 + 0] = a[0];
        positions[i * 6 + 1] = a[1];
        positions[i * 6 + 2] = a[2];
        positions[i * 6 + 3] = b[0];
        positions[i * 6 + 4] = b[1];
        positions[i * 6 + 5] = b[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = `${name}-lines`;
    lines.renderOrder = 999;
    group.add(lines);

    // Small contact markers at the midpoints — gives the eye a focus
    // when there are dense intersections.
    const pointPositions = new Float32Array(pairs.length * 3);
    for (let i = 0; i < pairs.length; i++) {
        const c = pairs[i].contact;
        pointPositions[i * 3 + 0] = c[0];
        pointPositions[i * 3 + 1] = c[1];
        pointPositions[i * 3 + 2] = c[2];
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
    const pMat = new THREE.PointsMaterial({
        color,
        size: 4,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: 1.0,
    });
    const pts = new THREE.Points(pGeo, pMat);
    pts.name = `${name}-points`;
    pts.renderOrder = 1000;
    group.add(pts);

    return group;
}

/**
 * Dispose a group built by `buildContactOverlay`. Frees the underlying
 * BufferGeometry and material. Safe to call on a group that has already
 * been removed from the scene.
 */
export function disposeContactOverlay(group) {
    if (!group) return;
    group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
            else obj.material.dispose?.();
        }
    });
    group.clear?.();
}
