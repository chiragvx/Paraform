/**
 * Persistent sketch overlay — keeps every committed Sketch feature visible
 * in the 3D viewport as line geometry on its plane, Fusion-style. The
 * overlay group is parented to the scene at identity (the kernel emits
 * sketch entity coords as world-frame Z-up mm via `localToWorld(pt, plane)`
 * exactly like `lib/picking/pick_proxies.js` does for face proxies, so no
 * transform inheritance is needed).
 *
 * The currently-edited sketch (the one the live `Sketch3DRenderer` is
 * drawing) is suppressed via `setActiveSketchId(id)` so the two layers
 * never double up.
 *
 * Per-feature visibility honours `feature.visible !== false` (defaults to
 * visible) — a future browser-tree toggle can flip that field and the next
 * `refresh()` will reflect it.
 *
 * No incremental diffing: every `refresh()` disposes and rebuilds. Sketch
 * counts are small (<20 typically) and each rebuild is a handful of
 * Float32Arrays — well below the per-frame budget.
 */

import * as THREE from 'three';
import { ENTITY_KIND } from '../../lib/sketch/entities.js';
import { slotLinearPath, splinePath } from '../../lib/sketch/sketch_shapes.js';
import { resolvePlane } from '../sketch_3d/plane.js';
import { localToWorld } from '../sketch_3d/plane.js';

const COLOR_SOLID        = 0xff8f6b;
const COLOR_CONSTRUCTION = 0x6f6c68;
const ARC_SEG_PER_RAD    = 32;

export class SketchOverlay {
    /**
     * @param {object} args
     * @param {THREE.Scene} args.scene
     * @param {object} args.store    — document store from getDocumentStore()
     */
    constructor({ scene, store }) {
        if (!scene) throw new Error('SketchOverlay: missing scene');
        if (!store) throw new Error('SketchOverlay: missing store');
        this.scene = scene;
        this.store = store;
        this.group = new THREE.Group();
        this.group.name = '__pf4_sketch_overlay__';
        // Rendered above bodies but below the active sketch (which uses 999/1000).
        this.group.renderOrder = 997;
        scene.add(this.group);

        this._activeSketchId = null;
        this._visible = true;
        this._disposed = false;

        this._unsub = store.subscribe(() => this.refresh());
        this.refresh();
    }

    /** Set the id of the sketch currently being edited; that feature is
     *  skipped on subsequent rebuilds (the live renderer covers it). Pass
     *  null when no edit session is active. */
    setActiveSketchId(id) {
        if (this._activeSketchId === id) return;
        this._activeSketchId = id || null;
        this.refresh();
    }

    setVisible(flag) {
        this._visible = !!flag;
        this.group.visible = this._visible;
    }

    refresh() {
        if (this._disposed) return;
        this._clear();
        if (!this._visible) return;
        const doc = this.store.doc;
        if (!doc || !doc.features) return;
        for (const f of Object.values(doc.features)) {
            if (!f || f.type !== 'Sketch') continue;
            if (f.enabled === false) continue;
            if (f.visible === false) continue;
            if (this._activeSketchId && f.id === this._activeSketchId) continue;
            try { this._buildSketch(f); }
            catch (err) { console.warn('[sketch-overlay] build failed', f.id, err); }
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        try { this._unsub?.(); } catch {}
        this._clear();
        if (this.group.parent) this.group.parent.remove(this.group);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    _clear() {
        while (this.group.children.length) {
            const c = this.group.children.pop();
            try {
                c.geometry?.dispose?.();
                const mats = Array.isArray(c.material) ? c.material : [c.material];
                for (const m of mats) m?.dispose?.();
            } catch {}
        }
    }

    _buildSketch(feature) {
        const sketch = feature.params?.sketch;
        if (!sketch || !sketch.entities || !sketch.entityOrder) return;
        const plane = resolvePlane(sketch.planeRef);

        // Merge into two buffers per sketch: solid + construction. Each
        // segment contributes a pair of vertices to a LineSegments geometry.
        const solid = [];
        const dashed = [];

        for (const id of sketch.entityOrder) {
            const e = sketch.entities[id];
            if (!e) continue;
            // Skip raw points — they're referenced by parent entities. Visible
            // points (mark-only entities) are not produced by any current tool.
            if (e.kind === ENTITY_KIND.POINT) continue;
            const bucket = e.construction ? dashed : solid;
            this._appendEntitySegments(e, sketch, plane, bucket);
        }

        if (solid.length) {
            this.group.add(this._buildLineSegments(solid, COLOR_SOLID, false));
        }
        if (dashed.length) {
            this.group.add(this._buildLineSegments(dashed, COLOR_CONSTRUCTION, true));
        }
    }

    /** Append a flat list of [x,y,z, x,y,z, ...] pairs (one per segment). */
    _appendEntitySegments(e, sketch, plane, out) {
        const polyline = this._entityPolyline(e, sketch);
        if (!polyline || polyline.length < 2) return;
        // Convert a polyline of N points → N-1 segments → 2*(N-1) world points.
        for (let i = 0; i < polyline.length - 1; i++) {
            const a = localToWorld(polyline[i], plane);
            const b = localToWorld(polyline[i + 1], plane);
            out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
    }

    /** Convert an entity to a polyline of sketch-local 2D points. */
    _entityPolyline(e, sketch) {
        switch (e.kind) {
            case ENTITY_KIND.LINE: {
                const a = sketch.entities[e.params.startId];
                const b = sketch.entities[e.params.endId];
                if (!a || !b) return null;
                return [a.params, b.params];
            }
            case ENTITY_KIND.CIRCLE: {
                const c = sketch.entities[e.params.centerId];
                if (!c) return null;
                return arcPoints(c.params, e.params.radius, 0, Math.PI * 2);
            }
            case ENTITY_KIND.ARC: {
                const c = sketch.entities[e.params.centerId];
                if (!c) return null;
                return arcPoints(c.params, e.params.radius, e.params.startAngle, e.params.sweepAngle);
            }
            case ENTITY_KIND.RECTANGLE: {
                const a = sketch.entities[e.params.cornerStartId];
                const b = sketch.entities[e.params.cornerEndId];
                if (!a || !b) return null;
                return [
                    { x: a.params.x, y: a.params.y },
                    { x: b.params.x, y: a.params.y },
                    { x: b.params.x, y: b.params.y },
                    { x: a.params.x, y: b.params.y },
                    { x: a.params.x, y: a.params.y },
                ];
            }
            case ENTITY_KIND.POLYGON: {
                const c = sketch.entities[e.params.centerId];
                if (!c) return null;
                const n = e.params.sides, r = e.params.radius, rot = e.params.rotation;
                const pts = [];
                for (let i = 0; i <= n; i++) {
                    const a = rot + (2 * Math.PI * i) / n;
                    pts.push({ x: c.params.x + r * Math.cos(a), y: c.params.y + r * Math.sin(a) });
                }
                return pts;
            }
            case ENTITY_KIND.SLOT_LINEAR: {
                const a = sketch.entities[e.params.centerStartId];
                const b = sketch.entities[e.params.centerEndId];
                if (!a || !b) return null;
                const pts = slotLinearPath(a.params, b.params, e.params.radius);
                pts.push(pts[0]);
                return pts;
            }
            case ENTITY_KIND.SPLINE: {
                const ids = e.params.controlPointIds || [];
                const ctrl = [];
                for (const cid of ids) {
                    const p = sketch.entities[cid];
                    if (p) ctrl.push(p.params);
                }
                if (ctrl.length < 2) return null;
                const pts = splinePath(ctrl, { closed: !!e.params.closed });
                if (e.params.closed && pts.length) pts.push(pts[0]);
                return pts;
            }
            // ELLIPSE / ELLIPTICAL_ARC / SLOT_ARC / TEXT are kinds the
            // schema enumerates but no tool emits today — when they land,
            // add a case here. The overlay silently skips unknown kinds
            // rather than failing the whole sketch.
            default:
                return null;
        }
    }

    _buildLineSegments(positions, color, dashed) {
        const arr = new Float32Array(positions);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const Mat = dashed ? THREE.LineDashedMaterial : THREE.LineBasicMaterial;
        const mat = new Mat({
            color,
            transparent: true,
            opacity: dashed ? 0.75 : 0.85,
            depthTest: true,
            ...(dashed ? { dashSize: 0.6, gapSize: 0.4 } : {}),
            linewidth: 1,
        });
        const seg = new THREE.LineSegments(geom, mat);
        if (dashed) seg.computeLineDistances();
        seg.renderOrder = 997;
        // Exclude from any traversal-based pickers that walk the scene
        // (rubber-band / lasso already filter by bridge._root, but tag
        // defensively for future pickers).
        seg.userData.__pf4_sketch_overlay__ = true;
        return seg;
    }
}

function arcPoints(centerP, radius, startAngle, sweepAngle) {
    const segments = Math.max(32, Math.ceil(Math.abs(sweepAngle) * ARC_SEG_PER_RAD));
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const a = startAngle + t * sweepAngle;
        pts.push({ x: centerP.x + radius * Math.cos(a), y: centerP.y + radius * Math.sin(a) });
    }
    return pts;
}
