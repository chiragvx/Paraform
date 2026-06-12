/**
 * PickProxyLayer — exact face/edge picking via invisible per-element meshes.
 *
 * Picking architecture
 * ────────────────────
 * The kernel ships per-face triangulation and per-edge polylines in
 * `result.geometry` (already used by `app/picking/face_overlay.js` to render
 * the hover/select tint). This module builds an INVISIBLE mesh per face
 * (and a fat invisible tube per edge) tagged with `userData.descriptor`,
 * so a single raycast against the proxy group returns the exact descriptor
 * the cursor is over — no center-distance heuristic, no normal weighting,
 * no "small adjacent face steals the click" failure mode.
 *
 * Coordinates: the kernel's per-element geometry is already in world-frame
 * millimetres (Z-up), the same frame as `FaceHighlightOverlay`. The proxy
 * group is attached to the scene at identity — do NOT parent it to the
 * bridge's GLB wrap or you inherit the 1000× / Y-up→Z-up correction twice.
 *
 *   layer = new PickProxyLayer({ scene })
 *   layer.setGeometry(bridge.geometry)        // call on every regen
 *   layer.pick(camera, raycaster, ndc)        // returns { descriptor, kind, … } | null
 *   layer.dispose()
 *
 * The proxy meshes are kept un-rendered via `mesh.visible = false`.
 * `THREE.Raycaster` does NOT honour `visible` (only `layers`), so the
 * raycast still hits them.
 */

import * as THREE from 'three';
import { parse as parseDescriptor } from '../document/descriptor.js';
import { getDocumentStore } from '../document/store.js';
import { componentPathFor } from '../document/types.js';

// Base radius the tube geometry is built at, in mm. The actual on-screen
// thickness is driven by `updateScreenSpaceRadius(camera, height)` which
// rescales every edge proxy each frame (or on camera change) so the
// effective pick width stays around `EDGE_PICK_TARGET_PX` regardless of
// zoom level. This replaces the old fixed-world-space tube that felt
// tiny when zoomed out and huge when zoomed in.
const EDGE_PICK_RADIUS_MM = 1.0;
const EDGE_PICK_TARGET_PX = 6.0;
const EDGE_TUBE_SEGMENTS  = 8;

/** Shared invisible material — colour irrelevant, only the bounds matter. */
const PROXY_MATERIAL = new THREE.MeshBasicMaterial({
    visible: false,        // doesn't matter (mesh.visible=false too); set as belt-and-braces
    side:    THREE.DoubleSide,  // pick from inside the cube too (section views)
});

export class PickProxyLayer {
    /**
     * @param {object} args
     * @param {THREE.Scene} args.scene
     */
    constructor({ scene }) {
        if (!scene) throw new Error('PickProxyLayer: missing scene');
        this.scene = scene;
        this.group = new THREE.Group();
        this.group.name = '__pf4_pick_proxies__';
        this.group.visible = false;       // never rendered; raycaster still hits children
        this.group.renderOrder = -10000;  // belt-and-braces: even if accidentally rendered, behind everything
        scene.add(this.group);

        /** @type {Map<string, THREE.Mesh>} key → proxy mesh */
        this._faceProxies = new Map();
        /** @type {Map<string, THREE.Mesh>} key → proxy tube */
        this._edgeProxies = new Map();
        // Per-edge cache of the source polyline curve + segment count so we
        // can rebuild the tube at a new world-space radius cheaply when the
        // camera distance changes.
        /** @type {Map<string, {curve: THREE.CatmullRomCurve3, segments: number}>} */
        this._edgeCurves = new Map();
        // Last world-space radius the tubes were built at; used to debounce
        // rebuilds so we only re-tessellate when the camera has moved enough
        // to perceptibly change pick tolerance.
        this._lastEdgeRadius = EDGE_PICK_RADIUS_MM;
    }

    /**
     * Rebuild edge tubes so each one has a world-space radius that
     * corresponds to ~EDGE_PICK_TARGET_PX on screen at the camera's
     * current distance to the target. Cheap to call every camera-change
     * event — internally debounced via a fractional-change threshold.
     *
     * For PerspectiveCamera: worldPerPixel = 2 * dist * tan(fov/2) / height.
     * For OrthographicCamera: worldPerPixel = (top - bottom) / (height * zoom).
     *
     * @param {THREE.Camera} camera
     * @param {number} viewportHeightPx
     * @param {THREE.Vector3} [target]  controls.target — used for the dist term.
     */
    updateScreenSpaceRadius(camera, viewportHeightPx, target) {
        if (!camera || !Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return;
        let worldPerPixel;
        if (camera.isOrthographicCamera) {
            const zoom = camera.zoom || 1;
            const top = camera.top || 1;
            const bot = camera.bottom || -1;
            worldPerPixel = (top - bot) / (viewportHeightPx * zoom);
        } else {
            const fov = (camera.fov || 50) * Math.PI / 180;
            const t = target || new THREE.Vector3();
            const dist = camera.position.distanceTo(t) || 1;
            worldPerPixel = 2 * dist * Math.tan(fov / 2) / viewportHeightPx;
        }
        const desiredRadius = Math.max(0.05, EDGE_PICK_TARGET_PX * worldPerPixel);
        // Debounce: only rebuild when desired radius differs by >25% from
        // current. Keeps the cost bounded during wheel-zoom storms.
        if (this._lastEdgeRadius > 0) {
            const ratio = desiredRadius / this._lastEdgeRadius;
            if (ratio > 0.8 && ratio < 1.25) return;
        }
        this._lastEdgeRadius = desiredRadius;
        for (const [key, mesh] of this._edgeProxies) {
            const cached = this._edgeCurves.get(key);
            if (!cached) continue;
            try {
                const newGeo = new THREE.TubeGeometry(
                    cached.curve, cached.segments, desiredRadius, EDGE_TUBE_SEGMENTS, false,
                );
                if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
                mesh.geometry = newGeo;
            } catch {}
        }
    }

    /**
     * Rebuild proxies from a kernel-shipped geometry blob:
     *   { faces: { [descKey]: { vertices, indices, center?, normal? } },
     *     edges: { [descKey]: { points, center?, tangent? } } }
     */
    setGeometry(geometry) {
        this._dispose();
        if (!geometry) return;

        const faces = geometry.faces || {};
        for (const key of Object.keys(faces)) {
            const src = faces[key];
            if (!src || !Array.isArray(src.vertices) || !Array.isArray(src.indices)) continue;
            const mesh = this._buildFaceProxy(key, src);
            if (mesh) {
                this.group.add(mesh);
                this._faceProxies.set(key, mesh);
            }
        }

        const edges = geometry.edges || {};
        for (const key of Object.keys(edges)) {
            const src = edges[key];
            if (!src || !Array.isArray(src.points) || src.points.length < 6) continue;
            const mesh = this._buildEdgeProxy(key, src);
            if (mesh) {
                this.group.add(mesh);
                this._edgeProxies.set(key, mesh);
            }
        }
    }

    /**
     * Optimistic prune — drop any proxy whose owning featureId is no longer
     * present in `featureIds`. Mirrors the bridge's `_pruneOrphanMeshes` so
     * the raycast layer stays 1:1 with the document the instant a feature is
     * deleted, instead of lingering until the next (debounced) kernel regen
     * rebuilds geometry. Proxies that carry no featureId are left untouched
     * (we can't attribute them, so we don't guess). Returns the count removed.
     *
     * @param {Set<string>} featureIds  live `Object.keys(doc.features)` set
     * @returns {number}
     */
    pruneOrphans(featureIds) {
        if (!(featureIds instanceof Set)) return 0;
        let removed = 0;
        const sweep = (map, isEdge) => {
            for (const [key, mesh] of map) {
                const ud = mesh.userData || {};
                const fid = ud.featureId || (ud.descriptor && ud.descriptor.feature) || null;
                if (fid && !featureIds.has(fid)) {
                    this._destroyProxy(mesh);
                    map.delete(key);
                    if (isEdge) this._edgeCurves.delete(key);
                    removed++;
                }
            }
        };
        sweep(this._faceProxies, false);
        sweep(this._edgeProxies, true);
        return removed;
    }

    /**
     * Raycast against face + edge proxies and return the closest hit's
     * pick payload, or null on miss. Edges win ties at the same depth
     * because the edge tube is fatter than the underlying face surface
     * by `EDGE_PICK_RADIUS_MM`, so a click near an edge naturally hits
     * the tube first — the same intent as `EDGE_PREFERENCE_MM` in the
     * old heuristic, but enforced by geometry rather than scoring.
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Raycaster} raycaster
     * @param {{x:number,y:number}} ndc
     */
    pick(camera, raycaster, ndc) {
        const all = this.pickAll(camera, raycaster, ndc);
        return all.length ? all[0] : null;
    }

    /**
     * Same raycast as `pick()` but returns EVERY hit in distance order,
     * de-duplicated by descriptor key (a single edge tube can produce
     * multiple ray hits — front + back wall — but is logically one pick).
     * The pick-cycle handler in `attachPicking` advances through this list
     * on repeated clicks at the same screen position.
     *
     * @returns {Array<object>} Same shape as `pick()` per entry.
     */
    pickAll(camera, raycaster, ndc) {
        if (this._faceProxies.size === 0 && this._edgeProxies.size === 0) return [];
        raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
        const hits = raycaster.intersectObjects(this.group.children, false);
        if (!hits.length) return [];
        const seen = new Set();
        const out = [];
        for (const hit of hits) {
            const ud = hit.object.userData;
            if (!ud || !ud.descriptor) continue;
            // De-dupe per logical entity. Same edge tube's front + back wall
            // is one pick; two distinct face proxies happen to overlap on
            // screen are two picks.
            const dedupeKey = `${ud.kind}:${(ud.descriptor && (ud.descriptor.key || JSON.stringify(ud.descriptor))) || hit.object.id}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const featureId = ud.featureId || (ud.descriptor && ud.descriptor.feature) || null;
            const componentPath = _resolveComponentPath(featureId, ud.componentPath);
            out.push({
                descriptor: ud.descriptor,
                kind:       ud.kind,
                featureId,
                componentPath,
                center:     ud.center  || [hit.point.x, hit.point.y, hit.point.z],
                normal:     ud.normal  || null,
                tangent:    ud.tangent || null,
                worldHit:   [hit.point.x, hit.point.y, hit.point.z],
                distance:   hit.distance,
                score:      hit.distance,
                // Expose the proxy mesh for downstream tools (MeasureTool reads
                // its geometry to compute face area + bbox). The mesh itself
                // is invisible and shared-material so callers must not mutate it.
                object:     hit.object,
            });
        }
        return out;
    }

    dispose() {
        this._dispose();
        if (this.group.parent) this.group.parent.remove(this.group);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    _dispose() {
        for (const m of this._faceProxies.values()) this._destroyProxy(m);
        for (const m of this._edgeProxies.values()) this._destroyProxy(m);
        this._faceProxies.clear();
        this._edgeProxies.clear();
        this._edgeCurves.clear();
        // Force-remove any stragglers (defensive — should be a no-op).
        while (this.group.children.length) this.group.remove(this.group.children[0]);
    }

    _destroyProxy(mesh) {
        this.group.remove(mesh);
        if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
        // Material is shared (PROXY_MATERIAL) — do NOT dispose.
    }

    _buildFaceProxy(key, src) {
        const geo = new THREE.BufferGeometry();
        const verts = new Float32Array(src.vertices.length);
        for (let i = 0; i < src.vertices.length; i++) verts[i] = src.vertices[i];
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        const idx = src.indices.length < 65536
            ? new Uint16Array(src.indices)
            : new Uint32Array(src.indices);
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, PROXY_MATERIAL);
        mesh.visible = false;  // not rendered; raycaster ignores `visible`
        mesh.userData.kind        = 'face';
        mesh.userData.descriptor  = src.descriptor || _safeParseKey(key);
        mesh.userData.featureId   = src.featureId  || null;
        mesh.userData.center      = src.center     || null;
        mesh.userData.normal      = src.normal     || null;
        // Foundation 6 — derive componentPath once at proxy-build time so
        // callers reading directly off `mesh.userData` (not via `pick()`)
        // see the same value. Path is *not* part of the canonical
        // descriptor — it's pick-time metadata.
        mesh.userData.componentPath = _resolveComponentPath(
            mesh.userData.featureId || (mesh.userData.descriptor && mesh.userData.descriptor.feature),
        );
        return mesh;
    }

    _buildEdgeProxy(key, src) {
        // Fat tube around the polyline so the raycast tolerance feels
        // generous — same intent as the old EDGE_PREFERENCE_MM scoring
        // bonus, but realised as actual geometric volume.
        const pts = [];
        for (let i = 0; i + 2 < src.points.length; i += 3) {
            pts.push(new THREE.Vector3(src.points[i], src.points[i + 1], src.points[i + 2]));
        }
        if (pts.length < 2) return null;
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
        const segments = Math.min(120, Math.max(8, pts.length * 2));
        // Build at the most recent screen-space radius so newly added proxies
        // immediately match the rest. Falls back to EDGE_PICK_RADIUS_MM
        // pre-camera-update.
        const radius = this._lastEdgeRadius || EDGE_PICK_RADIUS_MM;
        const geo = new THREE.TubeGeometry(curve, segments, radius, EDGE_TUBE_SEGMENTS, false);
        // Cache for later rebuilds.
        this._edgeCurves.set(key, { curve, segments });
        const mesh = new THREE.Mesh(geo, PROXY_MATERIAL);
        mesh.visible = false;
        mesh.userData.kind        = 'edge';
        mesh.userData.descriptor  = src.descriptor || _safeParseKey(key);
        mesh.userData.featureId   = src.featureId  || null;
        mesh.userData.center      = src.center     || null;
        mesh.userData.tangent     = src.tangent    || null;
        mesh.userData.componentPath = _resolveComponentPath(
            mesh.userData.featureId || (mesh.userData.descriptor && mesh.userData.descriptor.feature),
        );
        return mesh;
    }
}

function _safeParseKey(key) {
    try { return parseDescriptor(key); } catch { return null; }
}

/**
 * Resolve a featureId → componentPath via the live document store. Returns
 * `['root']` when:
 *   - no featureId is supplied (descriptor lacks the field, or pre-Foundation-6
 *     entries),
 *   - the store / document is unavailable (early init, tests without a store),
 *   - the feature is unknown (raced render vs. just-deleted feature).
 * Honours an explicit `prefer` argument so userData-cached paths from prior
 * builds (or test fixtures) win over a fresh lookup.
 */
function _resolveComponentPath(featureId, prefer) {
    if (Array.isArray(prefer) && prefer.length > 0) return prefer.slice();
    if (!featureId) return ['root'];
    let store;
    try { store = getDocumentStore(); } catch { return ['root']; }
    const doc = store && store.doc;
    if (!doc || !doc.features) return ['root'];
    const feat = doc.features[featureId];
    const componentId = (feat && feat.componentId) || 'root';
    return componentPathFor(doc, componentId);
}
