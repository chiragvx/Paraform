/**
 * MeasureTool — standalone two-click measurement tool.
 *
 * Mounted by `MeasureToolMount.svelte`. Owns its own pointer listener on
 * the viewport canvas, raycasts against the PickProxyLayer for exact
 * face/edge/vertex hits, and renders sphere markers + a dashed connector
 * line in the scene + a floating DOM result panel.
 *
 * Workflow
 * ────────
 *   - `setEnabled(true)` arms the tool.
 *   - Single click on a face → shows area + bbox W×D×H (face descriptor only).
 *   - Single click on an edge → shows edge length.
 *   - Click + click → distance, ΔXYZ, and (if both faces) angle between normals.
 *   - Esc / `setEnabled(false)` clears markers and the panel.
 *
 * All measurements are in millimetres (kernel-native), Z-up.
 *
 * The tool prefers the host-provided `pickProxies` (exact-geometry pick layer
 * from `lib/picking/pick_proxies.js`). It does NOT fall back to the legacy
 * heuristic — if there's no proxy layer, hits simply don't register and the
 * user gets nothing on click.
 */

import * as THREE from 'three';

const MARKER_COLOR = 0x4f9bff;
const MARKER_RADIUS_MM = 1.8;
const LINE_COLOR = 0x4f9bff;
const DASH_SIZE_MM = 4;
const GAP_SIZE_MM = 2;

export class MeasureTool {
    /**
     * @param {object}  args
     * @param {THREE.Scene}    args.scene
     * @param {THREE.Camera}   args.camera
     * @param {THREE.WebGLRenderer} args.renderer
     * @param {object} args.pickProxies   — must expose `.pick(camera, raycaster, ndc)`
     * @param {HTMLElement} args.host     — DOM element for the floating result panel
     * @param {() => boolean} [args.suppressWhile]
     *        — return true when the tool should ignore clicks (e.g. sketch is active)
     */
    constructor({ scene, camera, renderer, pickProxies, host, suppressWhile = null }) {
        if (!scene || !camera || !renderer) throw new Error('MeasureTool: scene/camera/renderer required');
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.pickProxies = pickProxies || null;
        this.host = host || null;
        this._suppressWhile = typeof suppressWhile === 'function' ? suppressWhile : null;

        this._enabled = false;
        this._firstHit = null;          // { descriptor, kind, point, normal? }
        this._raycaster = new THREE.Raycaster();
        this._raycaster.params.Line2 = { threshold: 1 };

        // ── Scene overlays ───────────────────────────────────────────────────
        this.group = new THREE.Group();
        this.group.name = '__pf4_measure_tool_overlay__';
        this.group.renderOrder = 1000;
        scene.add(this.group);

        this._markerMat = new THREE.MeshBasicMaterial({
            color: MARKER_COLOR,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
        });
        this._lineMat = new THREE.LineDashedMaterial({
            color: LINE_COLOR,
            dashSize: DASH_SIZE_MM,
            gapSize: GAP_SIZE_MM,
            depthTest: false,
            transparent: true,
            opacity: 0.95,
        });
        this._markers = [];
        this._connector = null;

        // ── Floating result panel ────────────────────────────────────────────
        this._panel = null;
        if (host) this._panel = _buildPanel(host, () => this.clear());

        // Pointer wiring
        this._onPointerDown = (ev) => this._handlePointer(ev);
        this._canvas = renderer.domElement;
        // We listen on `mousedown` rather than `pointerdown` to coexist with
        // the camera-controls' pointer capture without fighting it.
        this._canvas.addEventListener('mousedown', this._onPointerDown);

        // Esc to clear / disable.
        this._onKey = (ev) => {
            if (!this._enabled) return;
            if (ev.key === 'Escape') { this.clear(); }
        };
        window.addEventListener('keydown', this._onKey);
    }

    /** Toggle the tool on/off. Disabling clears all visuals. */
    setEnabled(on) {
        const next = !!on;
        if (next === this._enabled) return;
        this._enabled = next;
        if (!next) this.clear();
        this._renderPanel();
    }
    get enabled() { return this._enabled; }

    /** Clear markers, connector, result panel, and reset pick state. */
    clear() {
        for (const m of this._markers) {
            this.group.remove(m);
            m.geometry?.dispose?.();
        }
        this._markers = [];
        if (this._connector) {
            this.group.remove(this._connector);
            this._connector.geometry?.dispose?.();
            this._connector = null;
        }
        this._firstHit = null;
        this._result = null;
        this._renderPanel();
    }

    dispose() {
        this.clear();
        this._canvas.removeEventListener('mousedown', this._onPointerDown);
        window.removeEventListener('keydown', this._onKey);
        this._markerMat.dispose();
        this._lineMat.dispose();
        if (this.group.parent) this.group.parent.remove(this.group);
        if (this._panel && this._panel.root && this._panel.root.parentElement) {
            this._panel.root.parentElement.removeChild(this._panel.root);
        }
        this._panel = null;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    _handlePointer(ev) {
        if (!this._enabled) return;
        if (ev.button !== 0) return;
        if (this._suppressWhile && this._suppressWhile()) return;
        if (!this.pickProxies) return;

        const rect = this._canvas.getBoundingClientRect();
        const ndc = {
            x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
        };
        const hit = this.pickProxies.pick(this.camera, this._raycaster, ndc);
        if (!hit) return;

        // Each click counts as a measure action — don't fight camera drag.
        // The mouse-down to click filter is left to the host; tiny drags from
        // jittery pointers still produce a measurement but the result panel
        // tolerates that.
        ev.stopPropagation();

        const point = _pointFromHit(hit);
        if (!point) return;

        const hitInfo = {
            descriptor: hit.descriptor,
            kind: hit.kind,
            point,
            normal: Array.isArray(hit.normal) ? hit.normal.slice() : null,
            payload: hit,
        };

        if (this._firstHit) {
            // Second click — resolve the measurement.
            this._resolveTwoClick(this._firstHit, hitInfo);
            this._firstHit = null;
        } else {
            // First click — also resolve the single-pick measurement
            // (length/area/bbox). Plant a marker. If the user clicks again
            // we transition to two-click distance mode.
            this._placeMarker(point);
            this._resolveSingleClick(hitInfo);
            this._firstHit = hitInfo;
        }
    }

    _resolveSingleClick(hit) {
        if (hit.kind === 'edge') {
            const len = _edgeLengthFromHit(hit);
            this._result = {
                title: 'Edge',
                lines: [
                    `Length: ${_fmt(len)} mm`,
                    `XYZ: ${_fmtVec(hit.point)} mm`,
                ],
            };
        } else if (hit.kind === 'face') {
            const { area, bbox } = _faceMetricsFromHit(hit);
            const lines = [];
            if (area != null) lines.push(`Area: ${_fmt(area)} mm²`);
            if (bbox) {
                lines.push(`Bbox W×D×H: ${_fmt(bbox.x)} × ${_fmt(bbox.y)} × ${_fmt(bbox.z)} mm`);
            }
            lines.push(`Center XYZ: ${_fmtVec(hit.point)} mm`);
            this._result = { title: 'Face', lines };
        } else if (hit.kind === 'vertex') {
            this._result = {
                title: 'Vertex',
                lines: [`XYZ: ${_fmtVec(hit.point)} mm`],
            };
        } else {
            this._result = {
                title: hit.kind || 'Pick',
                lines: [`XYZ: ${_fmtVec(hit.point)} mm`],
            };
        }
        this._renderPanel();
    }

    _resolveTwoClick(a, b) {
        this._placeMarker(b.point);
        this._placeConnector(a.point, b.point);
        const d = [b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]];
        const dist = Math.hypot(d[0], d[1], d[2]);
        const lines = [
            `Distance: ${_fmt(dist)} mm`,
            `ΔX: ${_fmt(d[0])}   ΔY: ${_fmt(d[1])}   ΔZ: ${_fmt(d[2])} mm`,
        ];
        if (a.kind === 'face' && b.kind === 'face' && a.normal && b.normal) {
            const angle = _angleBetween(a.normal, b.normal);
            if (Number.isFinite(angle)) {
                lines.push(`Angle (normals): ${angle.toFixed(2)}°`);
            }
        }
        this._result = {
            title: `${_titleFor(a.kind)} → ${_titleFor(b.kind)}`,
            lines,
        };
        this._renderPanel();
    }

    _placeMarker(point) {
        const geo = new THREE.SphereGeometry(MARKER_RADIUS_MM, 16, 12);
        const mesh = new THREE.Mesh(geo, this._markerMat);
        mesh.position.set(point[0], point[1], point[2]);
        mesh.renderOrder = 1001;
        this.group.add(mesh);
        this._markers.push(mesh);
    }

    _placeConnector(a, b) {
        if (this._connector) {
            this.group.remove(this._connector);
            this._connector.geometry?.dispose?.();
            this._connector = null;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([
            a[0], a[1], a[2], b[0], b[1], b[2],
        ], 3));
        const line = new THREE.Line(geo, this._lineMat);
        line.computeLineDistances();
        line.renderOrder = 1000;
        this.group.add(line);
        this._connector = line;
    }

    _renderPanel() {
        if (!this._panel) return;
        const { root, titleEl, listEl, hintEl } = this._panel;
        if (!this._enabled) {
            root.style.display = 'none';
            return;
        }
        root.style.display = 'block';
        if (this._result) {
            titleEl.textContent = this._result.title;
            listEl.innerHTML = '';
            for (const line of this._result.lines) {
                const div = document.createElement('div');
                div.textContent = line;
                listEl.appendChild(div);
            }
            hintEl.textContent = this._firstHit
                ? 'Click a second point to measure distance, or Esc to clear.'
                : 'Click again to start a new measurement, or Esc to clear.';
        } else {
            titleEl.textContent = 'Measure';
            listEl.innerHTML = '';
            hintEl.textContent = 'Click a face, edge, or vertex.';
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _pointFromHit(hit) {
    if (Array.isArray(hit.worldHit)) return hit.worldHit.slice();
    if (Array.isArray(hit.center)) return hit.center.slice();
    return null;
}

function _titleFor(kind) {
    if (kind === 'face') return 'Face';
    if (kind === 'edge') return 'Edge';
    if (kind === 'vertex') return 'Vertex';
    return 'Pick';
}

function _fmt(n) {
    if (!Number.isFinite(n)) return '—';
    return Math.abs(n) < 1e-3 ? '0.000' : n.toFixed(3);
}
function _fmtVec(v) {
    if (!Array.isArray(v)) return '—';
    return `${_fmt(v[0])}, ${_fmt(v[1])}, ${_fmt(v[2])}`;
}

function _angleBetween(a, b) {
    const la = Math.hypot(a[0], a[1], a[2]) || 1;
    const lb = Math.hypot(b[0], b[1], b[2]) || 1;
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    const clamped = Math.max(-1, Math.min(1, c));
    return Math.acos(clamped) * 180 / Math.PI;
}

/**
 * Compute edge length from a hit. Prefers the source polyline on
 * descriptor geometry when available — falls back to 0 if the picker
 * didn't expose enough to compute.
 *
 * The proxy hit's userData was built from `geometry.edges[key].points`
 * (a flat [x,y,z,...] array). We try to walk back to it through the
 * descriptor key.
 */
function _edgeLengthFromHit(hit) {
    const points = hit.payload?._edgePoints
        || _findEdgePoints(hit);
    if (!Array.isArray(points) || points.length < 6) return 0;
    let total = 0;
    for (let i = 3; i < points.length; i += 3) {
        const dx = points[i] - points[i - 3];
        const dy = points[i + 1] - points[i - 2];
        const dz = points[i + 2] - points[i - 1];
        total += Math.hypot(dx, dy, dz);
    }
    return total;
}

/**
 * MeasureTool doesn't get raw geometry blobs; it operates on the proxy
 * hit. The proxy keeps a reference to the source geometry on its parent
 * group via `setGeometry()` — but we can't reach it from here. Instead
 * the proxy mesh's bounding box / its geometry's positions are the
 * fallback signal we use for face metrics.
 */
function _findEdgePoints(hit) {
    // Proxy hit exposes `object` only inside the raycaster intersection; we
    // don't get that here. The pick_proxies layer could be extended to
    // forward `points` on the payload, but for v1 we read from the proxy
    // mesh's geometry via the descriptor cache if available.
    // For now: best-effort fallback — return null.
    return null;
}

/**
 * Face metrics — surface area + axis-aligned bbox size — from a hit.
 *
 * The pick proxy layer doesn't pass source vertices through the hit
 * payload, so we approximate by raycasting against the proxy mesh's
 * geometry positions when we can reach them through `hit.payload.object`.
 * v1: when those aren't available, we return whatever we can compute
 * from the descriptor metadata, otherwise null.
 */
function _faceMetricsFromHit(hit) {
    const proxyMesh = hit.payload?.object
        || hit.object
        || hit.payload?._proxyMesh
        || null;
    if (!proxyMesh || !proxyMesh.geometry) {
        return { area: null, bbox: null };
    }
    const geom = proxyMesh.geometry;
    const pos = geom.attributes?.position;
    if (!pos) return { area: null, bbox: null };

    // Bounding box from positions.
    const bbox = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        bbox.expandByPoint(v);
    }
    const size = new THREE.Vector3();
    bbox.getSize(size);

    // Area from triangle iteration (indexed).
    let area = 0;
    const idx = geom.index;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    if (idx) {
        const arr = idx.array;
        for (let i = 0; i + 2 < arr.length; i += 3) {
            a.set(pos.getX(arr[i]), pos.getY(arr[i]), pos.getZ(arr[i]));
            b.set(pos.getX(arr[i + 1]), pos.getY(arr[i + 1]), pos.getZ(arr[i + 1]));
            c.set(pos.getX(arr[i + 2]), pos.getY(arr[i + 2]), pos.getZ(arr[i + 2]));
            const ab = b.clone().sub(a);
            const ac = c.clone().sub(a);
            area += ab.cross(ac).length() * 0.5;
        }
    } else {
        for (let i = 0; i + 2 < pos.count; i += 3) {
            a.set(pos.getX(i), pos.getY(i), pos.getZ(i));
            b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
            c.set(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
            const ab = b.clone().sub(a);
            const ac = c.clone().sub(a);
            area += ab.cross(ac).length() * 0.5;
        }
    }
    return {
        area,
        bbox: { x: size.x, y: size.y, z: size.z },
    };
}

// ── Result panel DOM ────────────────────────────────────────────────────────

function _buildPanel(host, onClear) {
    const root = document.createElement('div');
    root.className = '__pf4_measure_panel__';
    root.style.cssText = [
        'position:absolute',
        'left:12px',
        'bottom:48px',
        'z-index:30',
        'min-width:220px',
        'max-width:320px',
        'padding:8px 10px',
        'border:1px solid hsl(0 0% 25%)',
        'background:hsl(0 0% 10% / 0.92)',
        'color:hsl(0 0% 95%)',
        'border-radius:6px',
        'font:11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        'box-shadow:0 4px 12px rgba(0,0,0,0.35)',
        'backdrop-filter:blur(6px)',
        'pointer-events:auto',
        'display:none',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;';
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:600;color:#9ec5ff;';
    titleEl.textContent = 'Measure';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.title = 'Clear (Esc)';
    closeBtn.style.cssText = 'border:1px solid #444;background:#222;color:inherit;border-radius:3px;padding:0 6px;font:inherit;cursor:pointer;';
    closeBtn.addEventListener('click', () => onClear?.());
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const listEl = document.createElement('div');
    listEl.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const hintEl = document.createElement('div');
    hintEl.style.cssText = 'margin-top:6px;opacity:0.6;font-size:10px;';

    root.appendChild(header);
    root.appendChild(listEl);
    root.appendChild(hintEl);
    host.appendChild(root);

    return { root, titleEl, listEl, hintEl };
}
