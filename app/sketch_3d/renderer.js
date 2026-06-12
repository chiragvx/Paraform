/**
 * 3D sketch renderer — turn a SketchData into a Three.js Object3D that lives
 * in the live viewport scene during sketch mode.
 *
 * Entities project from sketch-local 2D coords onto the resolved plane in
 * world space (see `plane.js`). Construction geometry is dashed; the active
 * tool's preview shape and the snap indicator are rendered into separate
 * child groups so they can be cleared independently.
 *
 * The output is a single Group:
 *   __pf4_sketch__
 *     ├─ entities      (LineSegments / Points / Mesh per entity kind)
 *     ├─ preview       (live drawing ghost — set by tools)
 *     └─ snap          (snap marker — set by snap pipeline)
 */

import * as THREE from 'three';
import { ENTITY_KIND } from '../../lib/sketch/entities.js';
import { slotLinearPath, splinePath } from '../../lib/sketch/sketch_shapes.js';
import { localToWorld } from './plane.js';

const COLOR_SOLID        = 0xff8f6b;      // accent — visible against the scene
const COLOR_CONSTRUCTION = 0x6f6c68;
const COLOR_POINT        = 0xffbfa1;
const COLOR_PREVIEW      = 0x88e07a;      // ghost — distinct from committed
const COLOR_SNAP         = 0xffd166;      // snap marker — bright yellow
const COLOR_HOVER        = 0x88c2ff;      // cool blue — entity under cursor
const COLOR_SELECTED     = 0x88e07a;      // bright green — selection
const COLOR_GRID_AXIS_X  = 0xef6b6b;
const COLOR_GRID_AXIS_Y  = 0x88e07a;
const COLOR_GRID_MINOR   = 0x1d2026;
const COLOR_GRID_MAJOR   = 0x363b43;

export class Sketch3DRenderer {
    /**
     * @param {object} args
     * @param {object} args.sketchData
     * @param {object} args.plane           — resolved plane (plane.js)
     * @param {object} [args.opts]
     * @param {boolean}[args.opts.showGrid] — render a finite grid mesh on the plane
     * @param {number} [args.opts.gridSize] — minor grid step (mm)
     * @param {number} [args.opts.gridHalf] — half-extent of the grid (mm)
     */
    constructor({ sketchData, plane, opts = {} }) {
        if (!sketchData) throw new Error('Sketch3DRenderer: missing sketchData');
        if (!plane)      throw new Error('Sketch3DRenderer: missing plane');
        this.sketchData = sketchData;
        this.plane      = plane;
        this.opts       = { showGrid: true, gridSize: 1, gridHalf: 100, ...opts };

        this.group         = new THREE.Group();
        this.group.name    = '__pf4_sketch__';
        this.entitiesGroup = new THREE.Group();
        this.highlightGroup= new THREE.Group();   // hover + selection halos
        this.previewGroup  = new THREE.Group();
        this.snapGroup     = new THREE.Group();
        this.gridGroup     = new THREE.Group();
        this.group.add(this.gridGroup);
        this.group.add(this.entitiesGroup);
        this.group.add(this.highlightGroup);
        this.group.add(this.previewGroup);
        this.group.add(this.snapGroup);

        /** @type {string|null}    hovered entity id (drawn in COLOR_HOVER) */
        this._hoverId = null;
        /** @type {Set<string>}    selected entity ids (drawn in COLOR_SELECTED) */
        this._selectedIds = new Set();

        // Sketch overlay renders on top of solids so the user sees their work
        // even when drawing inside the bounding box of a 3D body.
        this.group.renderOrder = 999;

        this._buildGrid();
        this.render();
    }

    setSketchData(sketchData) {
        this.sketchData = sketchData;
        this.render();
    }

    setPlane(plane) {
        this.plane = plane;
        this._buildGrid();
        this.render();
    }

    /** Replace the contents of the preview slot with a Three.js Object3D (or null to clear). */
    setPreview(obj) {
        this._clearGroup(this.previewGroup);
        if (obj) this.previewGroup.add(obj);
    }

    /** Place a snap marker at world coords (or clear if null). */
    setSnap(hint /* {kind, point2D} or null */) {
        this._clearGroup(this.snapGroup);
        if (!hint) return;
        const world = localToWorld(hint.point, this.plane);
        const marker = this._buildSnapMarker(hint.kind, world, hint.extra);
        if (marker) this.snapGroup.add(marker);
    }

    /** Highlight one entity as hovered. Pass null to clear. */
    setHover(entityId) {
        if (this._hoverId === entityId) return;
        this._hoverId = entityId;
        this._renderHighlights();
    }

    /** Replace the selection set. */
    setSelection(ids) {
        this._selectedIds = new Set(ids || []);
        this._renderHighlights();
        if (typeof this._onSelectionChange === 'function') {
            try { this._onSelectionChange([...this._selectedIds]); }
            catch (e) { console.error('[renderer.onSelectionChange]', e); }
        }
    }

    /** Subscribe to selection changes — called with the fresh id list. */
    setSelectionListener(fn) { this._onSelectionChange = fn; }

    /** Convenience: return the current selected entity ids. */
    getSelection() { return [...this._selectedIds]; }

    dispose() {
        for (const g of [this.entitiesGroup, this.highlightGroup, this.previewGroup, this.snapGroup, this.gridGroup]) {
            this._clearGroup(g);
        }
        if (this.group.parent) this.group.parent.remove(this.group);
    }

    // ── Rendering ──────────────────────────────────────────────────────────

    render() {
        this._clearGroup(this.entitiesGroup);
        for (const id of this.sketchData.entityOrder) {
            const e = this.sketchData.entities[id];
            if (!e) continue;
            const obj = this._buildEntityObject(e);
            if (obj) this.entitiesGroup.add(obj);
        }
        this._renderHighlights();
    }

    /**
     * Draw hover + selection halos. Cheap — rebuilds the halo group only.
     * Hover renders behind selection so a selected+hovered entity reads as
     * selected, not hovered.
     */
    _renderHighlights() {
        this._clearGroup(this.highlightGroup);
        // Selection halos
        for (const id of this._selectedIds) {
            const e = this.sketchData.entities[id];
            if (!e) continue;
            const halo = this._buildEntityHalo(e, COLOR_SELECTED, 2.2);
            if (halo) this.highlightGroup.add(halo);
        }
        // Hover halo — only if not already selected
        if (this._hoverId && !this._selectedIds.has(this._hoverId)) {
            const e = this.sketchData.entities[this._hoverId];
            if (e) {
                const halo = this._buildEntityHalo(e, COLOR_HOVER, 1.6);
                if (halo) this.highlightGroup.add(halo);
            }
        }
    }

    /** Build a halo overlay for `entity` — same shape, fatter & coloured. */
    _buildEntityHalo(e, color, widthScale) {
        const sketch = this.sketchData;
        const dashed = false;
        switch (e.kind) {
            case ENTITY_KIND.POINT:
                return this._pointMesh(e.params, color, 0.5 * widthScale);
            case ENTITY_KIND.LINE: {
                const a = sketch.entities[e.params.startId];
                const b = sketch.entities[e.params.endId];
                if (!a || !b) return null;
                return this._haloLine([a.params, b.params], color, widthScale);
            }
            case ENTITY_KIND.CIRCLE: {
                const c = sketch.entities[e.params.centerId];
                if (!c) return null;
                return this._haloArc(c.params, e.params.radius, 0, Math.PI * 2, color, widthScale);
            }
            case ENTITY_KIND.ARC: {
                const c = sketch.entities[e.params.centerId];
                if (!c) return null;
                return this._haloArc(c.params, e.params.radius,
                    e.params.startAngle, e.params.sweepAngle, color, widthScale);
            }
            case ENTITY_KIND.RECTANGLE: {
                const a = sketch.entities[e.params.cornerStartId];
                const b = sketch.entities[e.params.cornerEndId];
                if (!a || !b) return null;
                return this._haloLine([
                    { x: a.params.x, y: a.params.y },
                    { x: b.params.x, y: a.params.y },
                    { x: b.params.x, y: b.params.y },
                    { x: a.params.x, y: b.params.y },
                    { x: a.params.x, y: a.params.y },
                ], color, widthScale);
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
                return this._haloLine(pts, color, widthScale);
            }
            case ENTITY_KIND.SLOT_LINEAR: {
                const a = sketch.entities[e.params.centerStartId];
                const b = sketch.entities[e.params.centerEndId];
                if (!a || !b) return null;
                const pts = slotLinearPath(a.params, b.params, e.params.radius);
                return this._haloLine(pts, color, widthScale);
            }
            case ENTITY_KIND.SPLINE: {
                const ids = e.params.controlPointIds || [];
                const ctrl = [];
                for (const id of ids) {
                    const p = sketch.entities[id];
                    if (p) ctrl.push(p.params);
                }
                if (ctrl.length < 2) return null;
                const pts = splinePath(ctrl, { closed: !!e.params.closed });
                if (e.params.closed && pts.length) pts.push(pts[0]);
                return this._haloLine(pts, color, widthScale);
            }
            default: return null;
        }
    }

    _haloLine(points2D, color, widthScale) {
        const positions = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const world = localToWorld(points2D[i], this.plane);
            positions[i * 3] = world[0]; positions[i * 3 + 1] = world[1]; positions[i * 3 + 2] = world[2];
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.LineBasicMaterial({
            color, depthTest: false, transparent: true, opacity: 0.65,
            linewidth: 2 * widthScale,
        });
        const line = new THREE.Line(geom, mat);
        // Below the regular entity stroke so the entity colour shows through
        line.renderOrder = 998;
        return line;
    }

    _haloArc(centerP, radius, startAngle, sweepAngle, color, widthScale) {
        const segments = Math.max(32, Math.ceil(Math.abs(sweepAngle) * 32));
        const pts = [];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const a = startAngle + t * sweepAngle;
            pts.push({ x: centerP.x + radius * Math.cos(a), y: centerP.y + radius * Math.sin(a) });
        }
        return this._haloLine(pts, color, widthScale);
    }

    _buildEntityObject(e) {
        const stroke = e.construction ? COLOR_CONSTRUCTION : COLOR_SOLID;
        const dashed = e.construction;
        switch (e.kind) {
            case ENTITY_KIND.POINT:
                return this._pointMesh(e.params, COLOR_POINT, 0.35);
            case ENTITY_KIND.LINE: {
                const a = this.sketchData.entities[e.params.startId];
                const b = this.sketchData.entities[e.params.endId];
                if (!a || !b) return null;
                return this._line2D([a.params, b.params], stroke, dashed);
            }
            case ENTITY_KIND.CIRCLE: {
                const c = this.sketchData.entities[e.params.centerId];
                if (!c) return null;
                return this._arcPolyline(c.params, e.params.radius, 0, Math.PI * 2, stroke, dashed);
            }
            case ENTITY_KIND.ARC: {
                const c = this.sketchData.entities[e.params.centerId];
                if (!c) return null;
                return this._arcPolyline(c.params, e.params.radius, e.params.startAngle, e.params.sweepAngle, stroke, dashed);
            }
            case ENTITY_KIND.RECTANGLE: {
                const a = this.sketchData.entities[e.params.cornerStartId];
                const b = this.sketchData.entities[e.params.cornerEndId];
                if (!a || !b) return null;
                const pts = [
                    { x: a.params.x, y: a.params.y },
                    { x: b.params.x, y: a.params.y },
                    { x: b.params.x, y: b.params.y },
                    { x: a.params.x, y: b.params.y },
                    { x: a.params.x, y: a.params.y },
                ];
                return this._line2D(pts, stroke, dashed);
            }
            case ENTITY_KIND.POLYGON: {
                const c = this.sketchData.entities[e.params.centerId];
                if (!c) return null;
                const n = e.params.sides, r = e.params.radius, rot = e.params.rotation;
                const pts = [];
                for (let i = 0; i <= n; i++) {
                    const a = rot + (2 * Math.PI * i) / n;
                    pts.push({ x: c.params.x + r * Math.cos(a), y: c.params.y + r * Math.sin(a) });
                }
                return this._line2D(pts, stroke, dashed);
            }
            case ENTITY_KIND.SLOT_LINEAR: {
                const a = this.sketchData.entities[e.params.centerStartId];
                const b = this.sketchData.entities[e.params.centerEndId];
                if (!a || !b) return null;
                // Close the outline by appending the first point
                const pts = slotLinearPath(a.params, b.params, e.params.radius);
                pts.push(pts[0]);
                return this._line2D(pts, stroke, dashed);
            }
            case ENTITY_KIND.SPLINE: {
                const ids = e.params.controlPointIds || [];
                const ctrl = [];
                for (const id of ids) {
                    const p = this.sketchData.entities[id];
                    if (p) ctrl.push(p.params);
                }
                if (ctrl.length < 2) return null;
                const pts = splinePath(ctrl, { closed: !!e.params.closed });
                if (e.params.closed && pts.length) pts.push(pts[0]);
                return this._line2D(pts, stroke, dashed);
            }
            default: return null;
        }
    }

    // ── Low-level primitive builders ───────────────────────────────────────

    _line2D(points2D, color, dashed) {
        const positions = new Float32Array(points2D.length * 3);
        for (let i = 0; i < points2D.length; i++) {
            const world = localToWorld(points2D[i], this.plane);
            positions[i * 3] = world[0]; positions[i * 3 + 1] = world[1]; positions[i * 3 + 2] = world[2];
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const matCls = dashed ? THREE.LineDashedMaterial : THREE.LineBasicMaterial;
        const mat = new matCls({
            color, depthTest: false, transparent: true, opacity: 0.95,
            ...(dashed ? { dashSize: 0.6, gapSize: 0.4 } : {}),
            linewidth: 2,
        });
        const line = new THREE.Line(geom, mat);
        if (dashed) line.computeLineDistances();
        line.renderOrder = 999;
        return line;
    }

    _arcPolyline(centerP, radius, startAngle, sweepAngle, color, dashed) {
        const segments = Math.max(32, Math.ceil(Math.abs(sweepAngle) * 32));
        const pts = [];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const a = startAngle + t * sweepAngle;
            pts.push({ x: centerP.x + radius * Math.cos(a), y: centerP.y + radius * Math.sin(a) });
        }
        return this._line2D(pts, color, dashed);
    }

    _pointMesh(point2D, color, radiusMM = 0.3) {
        const world = localToWorld(point2D, this.plane);
        const geom  = new THREE.SphereGeometry(radiusMM, 8, 8);
        const mat   = new THREE.MeshBasicMaterial({ color, depthTest: false });
        const mesh  = new THREE.Mesh(geom, mat);
        mesh.position.set(world[0], world[1], world[2]);
        mesh.renderOrder = 1000;
        return mesh;
    }

    /** Build the snap marker per snap kind. */
    _buildSnapMarker(kind, worldPoint, extra) {
        const r = 0.55;
        switch (kind) {
            case 'vertex': {
                // Open orange square at the snapped vertex
                return this._squareMarker(worldPoint, r, 0xff8f6b);
            }
            case 'midpoint': {
                // Triangle marker
                return this._triangleMarker(worldPoint, r * 1.1, 0xffd166);
            }
            case 'intersect': {
                // X marker
                return this._xMarker(worldPoint, r, 0xffd166);
            }
            case 'on-line': {
                // Small filled dot
                const geom = new THREE.SphereGeometry(0.25, 8, 8);
                const mat  = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false });
                const m = new THREE.Mesh(geom, mat);
                m.position.set(worldPoint[0], worldPoint[1], worldPoint[2]);
                m.renderOrder = 1001;
                return m;
            }
            case 'on-circle': {
                // Same as on-line — small dot in yellow
                const geom = new THREE.SphereGeometry(0.25, 8, 8);
                const mat  = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false });
                const m = new THREE.Mesh(geom, mat);
                m.position.set(worldPoint[0], worldPoint[1], worldPoint[2]);
                m.renderOrder = 1001;
                return m;
            }
            case 'tangent': {
                // A distinctive larger ring so the user knows tangency is firing
                return this._ringMarker(worldPoint, r * 1.2, 0xff8f6b);
            }
            case 'ortho': {
                // Anchor → ortho-locked axis hint is added by the tool; the snap
                // marker itself is a small dot at the snap point
                const geom = new THREE.SphereGeometry(0.2, 6, 6);
                const mat  = new THREE.MeshBasicMaterial({ color: 0x88e07a, depthTest: false });
                const m = new THREE.Mesh(geom, mat);
                m.position.set(worldPoint[0], worldPoint[1], worldPoint[2]);
                m.renderOrder = 1001;
                return m;
            }
            case 'angle': {
                // Small ring with the angle number rendered separately
                return this._ringMarker(worldPoint, r, 0x88e07a);
            }
            case 'grid':
            default: {
                const geom = new THREE.SphereGeometry(0.15, 6, 6);
                const mat  = new THREE.MeshBasicMaterial({ color: 0x707070, depthTest: false });
                const m = new THREE.Mesh(geom, mat);
                m.position.set(worldPoint[0], worldPoint[1], worldPoint[2]);
                m.renderOrder = 1001;
                return m;
            }
        }
    }

    _squareMarker(world, half, color) {
        const u = this.plane.xAxis, v = this.plane.yAxis;
        const corner = (su, sv) => [
            world[0] + su * half * u[0] + sv * half * v[0],
            world[1] + su * half * u[1] + sv * half * v[1],
            world[2] + su * half * u[2] + sv * half * v[2],
        ];
        const pts = [corner(-1,-1), corner(1,-1), corner(1,1), corner(-1,1), corner(-1,-1)];
        const arr = new Float32Array(pts.flat());
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
        const l = new THREE.Line(geom, mat);
        l.renderOrder = 1001;
        return l;
    }
    _triangleMarker(world, size, color) {
        const u = this.plane.xAxis, v = this.plane.yAxis;
        const corner = (su, sv) => [
            world[0] + su * size * u[0] + sv * size * v[0],
            world[1] + su * size * u[1] + sv * size * v[1],
            world[2] + su * size * u[2] + sv * size * v[2],
        ];
        const pts = [corner(-1,-0.7), corner(1,-0.7), corner(0,0.9), corner(-1,-0.7)];
        const arr = new Float32Array(pts.flat());
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
        const l = new THREE.Line(geom, mat);
        l.renderOrder = 1001;
        return l;
    }
    _xMarker(world, size, color) {
        const u = this.plane.xAxis, v = this.plane.yAxis;
        const off = (su, sv) => [
            world[0] + su * size * u[0] + sv * size * v[0],
            world[1] + su * size * u[1] + sv * size * v[1],
            world[2] + su * size * u[2] + sv * size * v[2],
        ];
        const arr = new Float32Array([
            ...off(-1,-1), ...off(1,1),
            ...off(-1,1),  ...off(1,-1),
        ]);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
        const seg = new THREE.LineSegments(geom, mat);
        seg.renderOrder = 1001;
        return seg;
    }
    _ringMarker(world, radius, color) {
        const segs = 24;
        const u = this.plane.xAxis, v = this.plane.yAxis;
        const arr = new Float32Array((segs + 1) * 3);
        for (let i = 0; i <= segs; i++) {
            const a = (i / segs) * 2 * Math.PI;
            const cu = Math.cos(a), sv = Math.sin(a);
            arr[i*3]   = world[0] + radius * (cu * u[0] + sv * v[0]);
            arr[i*3+1] = world[1] + radius * (cu * u[1] + sv * v[1]);
            arr[i*3+2] = world[2] + radius * (cu * u[2] + sv * v[2]);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
        const l = new THREE.Line(geom, mat);
        l.renderOrder = 1001;
        return l;
    }

    /** Public so tools can build their own previews using the same look. */
    previewLine(a2D, b2D) {
        return this._line2D([a2D, b2D], COLOR_PREVIEW, true);
    }
    previewRect(a2D, b2D) {
        const pts = [
            { x: a2D.x, y: a2D.y },
            { x: b2D.x, y: a2D.y },
            { x: b2D.x, y: b2D.y },
            { x: a2D.x, y: b2D.y },
            { x: a2D.x, y: a2D.y },
        ];
        return this._line2D(pts, COLOR_PREVIEW, true);
    }
    previewCircle(c2D, r) {
        return this._arcPolyline(c2D, r, 0, Math.PI * 2, COLOR_PREVIEW, true);
    }
    previewPolygon(c2D, r, n, rot) {
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const a = rot + (2 * Math.PI * i) / n;
            pts.push({ x: c2D.x + r * Math.cos(a), y: c2D.y + r * Math.sin(a) });
        }
        return this._line2D(pts, COLOR_PREVIEW, true);
    }
    previewSlotLinear(a2D, b2D, r) {
        const pts = slotLinearPath(a2D, b2D, r);
        pts.push(pts[0]);
        return this._line2D(pts, COLOR_PREVIEW, true);
    }
    previewSpline(controlPoints, closed = false) {
        if (!controlPoints || controlPoints.length < 2) return null;
        const pts = splinePath(controlPoints, { closed });
        if (closed && pts.length) pts.push(pts[0]);
        return this._line2D(pts, COLOR_PREVIEW, true);
    }

    // ── Grid ───────────────────────────────────────────────────────────────

    _buildGrid() {
        this._clearGroup(this.gridGroup);
        if (!this.opts.showGrid) return;
        const { gridSize, gridHalf } = this.opts;
        // Three line groups: minor, major, axes.
        const minor = this._gridLines(gridHalf, gridSize, COLOR_GRID_MINOR, 0.25);
        const major = this._gridLines(gridHalf, gridSize * 5, COLOR_GRID_MAJOR, 0.40);
        if (minor) this.gridGroup.add(minor);
        if (major) this.gridGroup.add(major);
        // Axis lines (sketch-local X red, Y green)
        const axisX = this._line2D([{ x: -gridHalf, y: 0 }, { x: gridHalf, y: 0 }], COLOR_GRID_AXIS_X, false);
        const axisY = this._line2D([{ x: 0, y: -gridHalf }, { x: 0, y: gridHalf }], COLOR_GRID_AXIS_Y, false);
        if (axisX) { axisX.material.opacity = 0.6; this.gridGroup.add(axisX); }
        if (axisY) { axisY.material.opacity = 0.6; this.gridGroup.add(axisY); }
        this.gridGroup.renderOrder = 998;
    }

    _gridLines(half, step, color, opacity) {
        if (step <= 0) return null;
        const lines = [];
        for (let v = -half; v <= half; v += step) {
            lines.push([{ x: -half, y: v }, { x: half, y: v }]);
            lines.push([{ x: v, y: -half }, { x: v, y: half }]);
        }
        // Combine into one LineSegments call for performance
        const arr = new Float32Array(lines.length * 6);
        for (let i = 0; i < lines.length; i++) {
            const a = localToWorld(lines[i][0], this.plane);
            const b = localToWorld(lines[i][1], this.plane);
            arr[i*6  ] = a[0]; arr[i*6+1] = a[1]; arr[i*6+2] = a[2];
            arr[i*6+3] = b[0]; arr[i*6+4] = b[1]; arr[i*6+5] = b[2];
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity });
        return new THREE.LineSegments(geom, mat);
    }

    _clearGroup(g) {
        while (g.children.length) {
            const c = g.children[0];
            g.remove(c);
            try {
                if (c.geometry) c.geometry.dispose();
                if (c.material) {
                    const mats = Array.isArray(c.material) ? c.material : [c.material];
                    for (const m of mats) m.dispose && m.dispose();
                }
            } catch {}
        }
    }
}
