/**
 * FaceHighlightOverlay — Fusion-style face-conforming hover/select tint.
 *
 * Uses the per-face triangulation and per-edge polyline geometry the kernel
 * now ships in `result.geometry`. Each face's mesh is keyed by its descriptor
 * canonical string; the picker returns that same key as
 * `stringify(pick.descriptor)`.
 *
 *   layer.showHover(descriptorKey, kind)        // 'face' | 'edge'
 *   layer.clearHover()
 *   layer.setSelected(keys[])                   // each key tagged with kind
 *   layer.clearSelected()
 *   layer.setGeometry({faces, edges})           // host calls on each bridge render
 *   layer.dispose()
 *
 * One BufferGeometry is built lazily per descriptor key and cached. Cache is
 * invalidated and disposed whenever a new geometry blob arrives (after a regen).
 *
 * Visual treatment:
 *   - Hover face:    warm tint at low alpha
 *   - Selected face: saturated blue at higher alpha
 *   - Hover edge:    bright orange thick polyline (using TubeGeometry for body)
 *   - Selected edge: blue thick polyline
 *
 * The whole pass is renderOrder-boosted with depthTest enabled so the tint
 * conforms to the body silhouette without Z-fighting.
 */

import * as THREE from 'three';
import { Line2 }         from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial }  from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry }  from 'three/examples/jsm/lines/LineGeometry.js';

const HOVER_COLOR     = 0xff8c28;
const SELECTED_COLOR  = 0x3f8dff;
const FACE_HOVER_OPACITY     = 0.32;
const FACE_SELECTED_OPACITY  = 0.52;
// Edges render as screen-space-thick Line2 segments running ON the real
// edge polyline — not a tube around it. Width is in CSS pixels.
const EDGE_LINEWIDTH_HOVER    = 3;
const EDGE_LINEWIDTH_SELECTED = 4;
const NORMAL_LIFT_MM = 0.05;   // tiny offset so face tint doesn't Z-fight the surface

export class FaceHighlightOverlay {
    /**
     * @param {object}  args
     * @param {THREE.Scene}   args.scene        — viewport scene
     * @param {THREE.Object3D}[args.bodyGroup]  — the bridge's body wrap (carries scale/rotation)
     */
    constructor({ scene, bodyGroup = null, renderer = null }) {
        if (!scene) throw new Error('FaceHighlightOverlay: missing scene');
        this.scene     = scene;
        this.bodyGroup = bodyGroup;
        this.renderer  = renderer;
        this.geometry  = null;                  // { faces:{key:{...}}, edges:{key:{...}} }
        this._geoCache = new Map();             // descriptorKey → BufferGeometry / LineGeometry

        // ── Hover tooltip — small DOM bubble near the cursor that summarises
        //   the dimensions of the face/edge under the pointer ("Face · W × H"
        //   or "Edge · L"). The host can suppress it (e.g. while the
        //   measure tool is active) via `setTooltipSuppressed(true)`.
        this._tooltipEl = null;            // DOM div appended on first show
        this._tooltipSuppressed = false;

        this.group = new THREE.Group();
        this.group.name = '__pf4_face_overlay__';
        this.group.renderOrder = 998;
        // The kernel's per-face geometry already lives in world-frame
        // millimetres (Z-up). The bridge's body wrap exists only to undo
        // the glTF export's "mm-as-meters + Y-up" quirks for the rendered
        // GLB — we should NOT inherit that 1000× scale or the X-rotation,
        // or our vertices end up at 1000× the right size, off-screen.
        // Keep the overlay group at scene identity.
        scene.add(this.group);

        this._matFaceHover = this._makeFaceMaterial(HOVER_COLOR,    FACE_HOVER_OPACITY);
        this._matFaceSel   = this._makeFaceMaterial(SELECTED_COLOR, FACE_SELECTED_OPACITY);
        this._matEdgeHover = this._makeEdgeMaterial(HOVER_COLOR,    EDGE_LINEWIDTH_HOVER);
        this._matEdgeSel   = this._makeEdgeMaterial(SELECTED_COLOR, EDGE_LINEWIDTH_SELECTED);

        this._hoverMeshes    = [];
        this._selectedMeshes = [];

        // LineMaterial does its screen-space thickness math in the vertex
        // shader against `.resolution` — sync it to the renderer once and
        // anytime the canvas resizes. Without this lines render at 1 px.
        this._syncEdgeMaterialResolution();
        this._onWinResize = () => this._syncEdgeMaterialResolution();
        window.addEventListener('resize', this._onWinResize);
    }

    /**
     * Push the current renderer size into the edge LineMaterials. Safe to
     * call any time — also wired to window resize, but call it explicitly
     * after `renderer.setSize(…)` to avoid a one-frame stale-width flicker.
     */
    setResolution(width, height) {
        if (Number.isFinite(width) && Number.isFinite(height)) {
            this._matEdgeHover.resolution.set(width, height);
            this._matEdgeSel.resolution.set(width, height);
        }
    }

    _syncEdgeMaterialResolution() {
        let w = window.innerWidth, h = window.innerHeight;
        if (this.renderer && typeof this.renderer.getSize === 'function') {
            const v = new THREE.Vector2();
            this.renderer.getSize(v);
            if (v.x > 0 && v.y > 0) { w = v.x; h = v.y; }
        }
        this.setResolution(w, h);
    }

    /** Stash a reference to the bridge's body wrap. Doesn't actually re-transform
     *  the overlay group — the kernel coords are already in world-frame mm. */
    setBodyGroup(bodyGroup) {
        this.bodyGroup = bodyGroup;
    }

    /** Receive new per-face / per-edge geometry from the bridge. Invalidates the cache. */
    setGeometry(geometry) {
        this.geometry = geometry || null;
        // Cached BufferGeometries from the prior regen reference stale vertex
        // data — dispose and rebuild on demand.
        for (const g of this._geoCache.values()) {
            try { g.dispose && g.dispose(); } catch {}
        }
        this._geoCache.clear();
        // Stale overlay meshes from the prior regen reference disposed
        // geometries; drop them.
        this.clearHover();
        this.clearSelected();
    }

    showHover(descriptorKey, kind) {
        this.clearHover();
        if (!descriptorKey || !this.geometry) return;
        const mesh = this._buildOverlayMesh(descriptorKey, kind, /*selected*/ false);
        if (mesh) { this.group.add(mesh); this._hoverMeshes.push(mesh); }
        // Stash for the tooltip — updateTooltipAt() formats from these.
        this._hoverKey  = descriptorKey;
        this._hoverKind = kind;
    }
    clearHover() {
        for (const m of this._hoverMeshes) {
            this.group.remove(m);
            this._disposeOverlay(m);
        }
        this._hoverMeshes = [];
        this._hoverKey  = null;
        this._hoverKind = null;
        this._hideTooltip();
    }

    /**
     * Suppress the hover-tooltip bubble (e.g. while the measure tool is
     * active). The face/edge tint itself continues to render — only the
     * dimensions bubble is hidden.
     */
    setTooltipSuppressed(suppressed) {
        this._tooltipSuppressed = !!suppressed;
        if (this._tooltipSuppressed) this._hideTooltip();
    }

    /**
     * Position + populate the tooltip bubble for the current hover. Pass
     * `null` to hide. `client` is the raw `{clientX, clientY}` from a
     * pointermove event; the bubble offsets itself near the cursor.
     */
    updateTooltipAt(client) {
        if (this._tooltipSuppressed) { this._hideTooltip(); return; }
        if (!client || !this._hoverKey || !this._hoverKind) { this._hideTooltip(); return; }
        const text = this._formatHoverDims(this._hoverKey, this._hoverKind);
        if (!text) { this._hideTooltip(); return; }
        const el = this._ensureTooltipEl();
        el.textContent = text;
        el.style.left = `${Math.round(client.clientX + 14)}px`;
        el.style.top  = `${Math.round(client.clientY + 14)}px`;
        el.style.display = 'block';
    }

    _ensureTooltipEl() {
        if (this._tooltipEl) return this._tooltipEl;
        const el = document.createElement('div');
        el.className = '__pf4_face_overlay_tooltip__';
        el.style.cssText = [
            'position:fixed',
            'z-index:60',
            'pointer-events:none',
            'padding:3px 6px',
            'border:1px solid hsl(0 0% 25%)',
            'background:hsl(0 0% 10% / 0.92)',
            'color:hsl(0 0% 95%)',
            'border-radius:3px',
            'font:10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
            'white-space:nowrap',
            'display:none',
        ].join(';');
        document.body.appendChild(el);
        this._tooltipEl = el;
        return el;
    }

    _hideTooltip() {
        if (this._tooltipEl) this._tooltipEl.style.display = 'none';
    }

    /**
     * Format dimensions for the hover bubble:
     *   - face → "Face · 24.0 × 18.0 mm" (axis-aligned bbox along the two
     *     largest dimensions of the triangulation).
     *   - edge → "Edge · 35.4 mm" (sum of polyline segments).
     */
    _formatHoverDims(key, kind) {
        if (kind === 'edge') {
            const src = this.geometry && this.geometry.edges && this.geometry.edges[key];
            if (!src || !Array.isArray(src.points) || src.points.length < 6) return null;
            let len = 0;
            for (let i = 3; i < src.points.length; i += 3) {
                const dx = src.points[i]     - src.points[i - 3];
                const dy = src.points[i + 1] - src.points[i - 2];
                const dz = src.points[i + 2] - src.points[i - 1];
                len += Math.hypot(dx, dy, dz);
            }
            return `Edge · ${len.toFixed(1)} mm`;
        }
        if (kind === 'face') {
            const src = this.geometry && this.geometry.faces && this.geometry.faces[key];
            if (!src || !Array.isArray(src.vertices) || src.vertices.length < 9) return null;
            let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            const vs = src.vertices;
            for (let i = 0; i + 2 < vs.length; i += 3) {
                if (vs[i]     < minX) minX = vs[i];
                if (vs[i]     > maxX) maxX = vs[i];
                if (vs[i + 1] < minY) minY = vs[i + 1];
                if (vs[i + 1] > maxY) maxY = vs[i + 1];
                if (vs[i + 2] < minZ) minZ = vs[i + 2];
                if (vs[i + 2] > maxZ) maxZ = vs[i + 2];
            }
            const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
            // Pick the two largest extents — the third is usually ~0 for
            // planar faces and ~radius for cylindrical, neither of which
            // belongs in the "W × H" readout.
            const dims = [dx, dy, dz].sort((a, b) => b - a);
            return `Face · ${dims[0].toFixed(1)} × ${dims[1].toFixed(1)} mm`;
        }
        return null;
    }

    setSelected(entries) {
        this.clearSelected();
        if (!Array.isArray(entries) || !this.geometry) return;
        for (const e of entries) {
            if (!e || !e.key) continue;
            const mesh = this._buildOverlayMesh(e.key, e.kind || 'face', /*selected*/ true);
            if (mesh) { this.group.add(mesh); this._selectedMeshes.push(mesh); }
        }
    }
    clearSelected() {
        for (const m of this._selectedMeshes) {
            this.group.remove(m);
            this._disposeOverlay(m);
        }
        this._selectedMeshes = [];
    }

    dispose() {
        this.clearHover();
        this.clearSelected();
        for (const g of this._geoCache.values()) { try { g.dispose && g.dispose(); } catch {} }
        this._geoCache.clear();
        this._matFaceHover.dispose();
        this._matFaceSel.dispose();
        this._matEdgeHover.dispose();
        this._matEdgeSel.dispose();
        if (this._onWinResize) {
            window.removeEventListener('resize', this._onWinResize);
            this._onWinResize = null;
        }
        if (this._tooltipEl && this._tooltipEl.parentElement) {
            this._tooltipEl.parentElement.removeChild(this._tooltipEl);
        }
        this._tooltipEl = null;
        if (this.group.parent) this.group.parent.remove(this.group);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    _makeFaceMaterial(color, opacity) {
        return new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthTest:   true,
            depthWrite:  false,
            side:        THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits:  -1,
        });
    }

    _makeEdgeMaterial(color, linewidthPx) {
        // LineMaterial draws a true screen-space-thick line so the highlight
        // sits ON the real edge polyline (not as a tube around it). Width
        // is in CSS pixels; `resolution` is synced in the constructor.
        const mat = new LineMaterial({
            color,
            linewidth:   linewidthPx,
            transparent: true,
            opacity:     0.95,
            depthTest:   true,
            depthWrite:  false,
            // Pull the line a fragment toward the camera so it isn't
            // hidden by the body's own edge tris under shallow viewing.
            polygonOffset:       true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits:  -2,
        });
        return mat;
    }

    _buildOverlayMesh(key, kind, selected) {
        if (kind === 'face') {
            const geo = this._faceGeometry(key);
            if (!geo) return null;
            const mat = selected ? this._matFaceSel : this._matFaceHover;
            const mesh = new THREE.Mesh(geo, mat);
            mesh.renderOrder = selected ? 1000 : 999;
            mesh.raycast = () => {};
            return mesh;
        }
        if (kind === 'edge') {
            const geo = this._edgeGeometry(key);
            if (!geo) return null;
            const mat = selected ? this._matEdgeSel : this._matEdgeHover;
            // Line2 is a screen-space thick line — same maths as the body's
            // edge overlay, just coloured + on top.
            const mesh = new Line2(geo, mat);
            mesh.renderOrder = selected ? 1000 : 999;
            mesh.computeLineDistances();
            mesh.raycast = () => {};
            return mesh;
        }
        return null;
    }

    _faceGeometry(key) {
        if (this._geoCache.has(`f:${key}`)) return this._geoCache.get(`f:${key}`);
        const src = this.geometry && this.geometry.faces && this.geometry.faces[key];
        if (!src || !Array.isArray(src.vertices) || !Array.isArray(src.indices)) return null;
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(src.vertices.length);
        for (let i = 0; i < src.vertices.length; i++) pos[i] = src.vertices[i];
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const indices = src.indices.length < 65536
            ? new Uint16Array(src.indices)
            : new Uint32Array(src.indices);
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        geo.computeBoundingSphere();
        // Lift slightly along each vertex's local outward direction (computed
        // normal). This avoids face-tint Z-fighting with the body surface
        // even when the same triangulation is used.
        geo.computeVertexNormals();
        const normals = geo.attributes.normal.array;
        const lifted  = new Float32Array(pos.length);
        for (let i = 0; i < pos.length; i++) lifted[i] = pos[i] + normals[i] * NORMAL_LIFT_MM;
        geo.setAttribute('position', new THREE.BufferAttribute(lifted, 3));
        this._geoCache.set(`f:${key}`, geo);
        return geo;
    }

    _edgeGeometry(key) {
        if (this._geoCache.has(`e:${key}`)) return this._geoCache.get(`e:${key}`);
        const src = this.geometry && this.geometry.edges && this.geometry.edges[key];
        if (!src || !Array.isArray(src.points) || src.points.length < 6) return null;
        // Build a LineGeometry directly from the kernel polyline — Line2
        // renders it at fixed pixel width through LineMaterial's shader,
        // so the highlight sits ON the edge instead of as a tube around it.
        const geo = new LineGeometry();
        // `setPositions` expects a flat [x,y,z,...] array; the kernel's
        // `src.points` already matches that shape, no conversion needed.
        geo.setPositions(src.points);
        this._geoCache.set(`e:${key}`, geo);
        return geo;
    }

    _disposeOverlay(mesh) {
        // Geometries are cached and disposed in setGeometry/dispose — don't
        // dispose them here. Materials are shared; don't dispose either.
        if (!mesh) return;
        mesh.material = null;
        mesh.geometry = null;
    }
}
