/**
 * ReferencePlanes — Onshape-style interactive default sketch planes (XY/XZ/YZ).
 *
 * Replaces the static colored quads that previously lived inline in
 * Viewport.svelte. Each plane is a filled mesh + faint border `LineSegments`;
 * hovering bumps fill opacity, lights up the border, and shows a floating
 * DOM tooltip near the cursor ("Sketch on Top", etc). A left-click invokes
 * the host-supplied `onSketchOnPlane({planeId, planeName, normal, origin})`
 * callback — the caller wires this to `enterSketch('XY'|'XZ'|'YZ')`.
 *
 * Z-up convention (this project is Z-up — see CLAUDE.md):
 *   - XY plane (Top)   — normal = +Z   (PlaneGeometry's default normal)
 *   - XZ plane (Front) — normal = +Y   (rotate −π/2 about X)
 *   - YZ plane (Right) — normal = +X   (rotate +π/2 about Y)
 *
 * Color convention (Onshape-ish, adapted to Z-up axis colors):
 *   - XY / Top   → blue   (Z axis colour)
 *   - XZ / Front → green  (Y axis colour)
 *   - YZ / Right → red    (X axis colour)
 *
 * API:
 *   const refs = new ReferencePlanes({ scene, camera, renderer,
 *                                      onSketchOnPlane, container? });
 *   refs.setVisible(true|false);          // hard show/hide
 *   refs.setSceneBounds(box3 | null);     // resize planes to fit scene
 *   refs.dispose();
 *
 * The class owns its own pointermove/down listeners on the renderer's DOM
 * element so it can run a dedicated raycast BEFORE rubber-band / body
 * picking. When a hover hit lands on a plane, the click is consumed by
 * stopping propagation in the capture phase — but only on the actual
 * pointerdown that started over a plane (we do NOT block clicks that
 * miss the planes).
 */

import * as THREE from 'three';

const PLANE_SPECS = [
  // id, friendlyName, longName, color, rotation (euler XYZ)
  { id: 'XY', name: 'Top',   long: 'Top / XY',   color: 0x4f7cff, rot: [0, 0, 0],
    normal: [0, 0, 1], origin: [0, 0, 0] },
  { id: 'XZ', name: 'Front', long: 'Front / XZ', color: 0x4caf50, rot: [-Math.PI / 2, 0, 0],
    normal: [0, 1, 0], origin: [0, 0, 0] },
  { id: 'YZ', name: 'Right', long: 'Right / YZ', color: 0xff5252, rot: [0, Math.PI / 2, 0],
    normal: [1, 0, 0], origin: [0, 0, 0] },
];

const FILL_OPACITY_IDLE  = 0.06;
const FILL_OPACITY_HOVER = 0.22;
const BORDER_OPACITY_IDLE  = 0.25;
const BORDER_OPACITY_HOVER = 0.95;

const SIZE_MIN_MM     = 100;
const SIZE_MAX_MM     = 2000;
const SIZE_DEFAULT_MM = 400;
const SIZE_DIAG_MULT  = 2;

export class ReferencePlanes {
  /**
   * @param {object} args
   * @param {THREE.Scene}     args.scene
   * @param {THREE.Camera}    args.camera
   * @param {THREE.WebGLRenderer} args.renderer
   * @param {(spec:{planeId:string,planeName:string,normal:number[],origin:number[]})=>void} args.onSketchOnPlane
   * @param {boolean}         [args.startVisible=true]
   */
  constructor({ scene, camera, renderer, onSketchOnPlane, startVisible = true }) {
    if (!scene || !camera || !renderer) {
      throw new Error('ReferencePlanes: scene/camera/renderer required');
    }
    this._scene    = scene;
    this._camera   = camera;
    this._renderer = renderer;
    this._onSketchOnPlane = typeof onSketchOnPlane === 'function' ? onSketchOnPlane : null;

    this._visibleRequested = !!startVisible;
    // Per-plane visibility (independent toggles). Group `visible` still
    // gates everything (driven by setVisible); per-plane gates the
    // individual mesh/border/label.
    this._perPlaneVisible = { XY: true, XZ: true, YZ: true };
    this._size = SIZE_DEFAULT_MM;

    this.group = new THREE.Group();
    this.group.name = '__pf4_reference_planes__';
    // renderOrder negative — under the picking tints / connector overlays.
    this.group.renderOrder = -1;
    scene.add(this.group);

    /** @type {Array<{ spec, mesh:THREE.Mesh, border:THREE.LineSegments, fillMat:THREE.MeshBasicMaterial, borderMat:THREE.LineBasicMaterial }>} */
    this._entries = [];

    for (const spec of PLANE_SPECS) {
      const fillMat = new THREE.MeshBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: FILL_OPACITY_IDLE,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const borderMat = new THREE.LineBasicMaterial({
        color: spec.color,
        transparent: true,
        opacity: BORDER_OPACITY_IDLE,
        depthWrite: false,
      });

      const fillGeom = new THREE.PlaneGeometry(1, 1);
      const mesh = new THREE.Mesh(fillGeom, fillMat);
      mesh.name = `RefPlane_${spec.id}`;
      mesh.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      mesh.userData.__pf4_ref_plane__ = spec.id;

      const borderGeom = this._makeBorderGeom();
      const border = new THREE.LineSegments(borderGeom, borderMat);
      border.name = `RefPlaneBorder_${spec.id}`;
      border.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      // Border is non-pickable.
      border.userData.__pf4_ref_plane_border__ = true;

      // Corner label — flat textured quad parented to the GROUP (not the
      // plane mesh) so we can give it an explicit world rotation that keeps
      // the text reading upright when viewed from the plane's natural angle.
      // Each plane gets its own orientation (see LABEL_ORIENT table below).
      const labelTex = this._makeLabelTexture(spec.name, spec.color);
      const labelMat = new THREE.MeshBasicMaterial({
        map: labelTex,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
      });
      const labelGeom = new THREE.PlaneGeometry(1, 1);
      const label = new THREE.Mesh(labelGeom, labelMat);
      label.userData.__pf4_ref_plane_label__ = spec.id;
      label.renderOrder = 5;
      this.group.add(label);

      this.group.add(mesh);
      this.group.add(border);
      this._entries.push({ spec, mesh, border, fillMat, borderMat, label, labelTex, labelMat });
    }

    this._applySize(this._size);
    this._applyVisible();

    // ── Tooltip DOM (lazy-created) ────────────────────────────────────────
    this._tooltipEl = null;

    // ── Pointer wiring ────────────────────────────────────────────────────
    this._raycaster = new THREE.Raycaster();
    this._ndc       = new THREE.Vector2();
    this._hover     = null; // entry under cursor

    // Pointerdown captured target — if the press starts on a plane, we
    // consume the matching pointerup as a click and prevent it from
    // bleeding into rubber-band / picking. The capture-phase listener
    // is what wins over the bubble-phase rubber-band one.
    this._armedEntry = null;
    this._armedAt    = null; // { x, y }

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);

    const dom = this._renderer.domElement;
    dom.addEventListener('pointermove', this._onPointerMove);
    // Capture phase on pointerdown so we beat the rubber-band container
    // listener (which sits on the root host element).
    dom.addEventListener('pointerdown', this._onPointerDown, true);
    dom.addEventListener('pointerup',   this._onPointerUp,   true);
    dom.addEventListener('pointerleave', this._onPointerLeave);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setVisible(v) {
    this._visibleRequested = !!v;
    this._applyVisible();
    if (!this._visibleRequested) {
      this._setHover(null);
      this._hideTooltip();
    }
  }

  /** Toggle a single plane (id ∈ {'XY','XZ','YZ'}). */
  setPlaneVisible(id, v) {
    if (!this._perPlaneVisible.hasOwnProperty(id)) return;
    this._perPlaneVisible[id] = !!v;
    this._applyVisible();
  }

  isVisible() { return this.group.visible; }

  /**
   * Resize the planes to fit the scene. Pass a THREE.Box3 of the current
   * body bounds (or null/empty for the default size). Internally we use
   * 2× the box diagonal, clamped.
   */
  setSceneBounds(box) {
    let target = SIZE_DEFAULT_MM;
    if (box && !box.isEmpty?.()) {
      const size = new THREE.Vector3();
      box.getSize(size);
      const diag = size.length();
      if (Number.isFinite(diag) && diag > 0) {
        target = Math.max(SIZE_MIN_MM, Math.min(SIZE_MAX_MM, diag * SIZE_DIAG_MULT));
      }
    }
    if (Math.abs(target - this._size) < 1e-3) return;
    this._size = target;
    this._applySize(target);
  }

  /** Convenience: compute bounds from a Three Object3D root and apply. */
  setSceneBoundsFromObject(obj) {
    if (!obj) { this.setSceneBounds(null); return; }
    try {
      const box = new THREE.Box3().setFromObject(obj);
      this.setSceneBounds(box.isEmpty() ? null : box);
    } catch {
      this.setSceneBounds(null);
    }
  }

  dispose() {
    const dom = this._renderer?.domElement;
    if (dom) {
      dom.removeEventListener('pointermove', this._onPointerMove);
      dom.removeEventListener('pointerdown', this._onPointerDown, true);
      dom.removeEventListener('pointerup',   this._onPointerUp,   true);
      dom.removeEventListener('pointerleave', this._onPointerLeave);
    }
    for (const e of this._entries) {
      e.mesh.geometry?.dispose?.();
      e.fillMat?.dispose?.();
      e.border.geometry?.dispose?.();
      e.borderMat?.dispose?.();
      e.labelTex?.dispose?.();
      e.labelMat?.dispose?.();
    }
    try { this._scene.remove(this.group); } catch {}
    this._entries = [];
    this._hideTooltip();
    if (this._tooltipEl && this._tooltipEl.parentElement) {
      this._tooltipEl.parentElement.removeChild(this._tooltipEl);
    }
    this._tooltipEl = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  _applyVisible() {
    this.group.visible = !!this._visibleRequested;
    // Per-plane: gate each entry's mesh + border + label by both the
    // global toggle and that plane's individual toggle.
    for (const e of this._entries) {
      const v = !!this._perPlaneVisible[e.spec.id];
      e.mesh.visible   = v;
      e.border.visible = v;
      if (e.label) e.label.visible = v;
    }
  }

  _applySize(s) {
    const half = s / 2;
    // Label size scales with plane size but with sensible floor/ceiling.
    const labelSize = Math.max(20, Math.min(80, s * 0.10));
    const margin = labelSize * 0.6;
    const w = labelSize * 2.2;
    const h = labelSize;
    for (const e of this._entries) {
      // Replace fill geometry (PlaneGeometry sized to s×s).
      e.mesh.geometry.dispose();
      e.mesh.geometry = new THREE.PlaneGeometry(s, s);
      // Replace border geometry — 4 segments around the edge.
      const positions = new Float32Array([
        -half, -half, 0,   half, -half, 0,
         half, -half, 0,   half,  half, 0,
         half,  half, 0,  -half,  half, 0,
        -half,  half, 0,  -half, -half, 0,
      ]);
      e.border.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      e.border.geometry = g;
      // Label: place in world-space with explicit orientation per plane so
      // text reads upright from each plane's natural viewing angle.
      if (e.label) {
        this._placeLabel(e.label, e.spec.id, half, margin, w, h);
        e.label.scale.set(w, h, 1);
      }
    }
  }

  /**
   * Position + orient the label quad in WORLD space so text reads upright
   * when viewed from the plane's natural viewing camera. The "upper-left"
   * corner of each plane is identified per-plane:
   *
   *   - Top  (XY)   viewed from +Z, screen-right = +X, screen-up = +Y
   *                 upper-left world  = (-half + inset, +half - inset, 0)
   *                 label orient: +X_label → +X_world, +Y_label → +Y_world
   *
   *   - Front (XZ)  viewed from +Y, screen-right = +X, screen-up = +Z
   *                 upper-left world  = (-half + inset, 0, +half - inset)
   *                 label orient: +X_label → +X_world, +Y_label → +Z_world
   *
   *   - Right (YZ)  viewed from +X, screen-right = +Y, screen-up = +Z
   *                 upper-left world  = (0, -half + inset, +half - inset)
   *                 label orient: +X_label → +Y_world, +Y_label → +Z_world
   */
  _placeLabel(label, id, half, margin, w, h) {
    // Inset from corner so the label sits inside the upper-left, not on the
    // exact corner. Label is anchored at its CENTER, so account for w/2 and h/2.
    const ix = margin + w / 2;
    const iy = margin + h / 2;
    label.position.set(0, 0, 0);
    label.quaternion.identity();
    if (id === 'XY') {
      label.position.set(-half + ix, +half - iy, 0);
      // identity rotation — text already reads correctly when viewed from +Z
    } else if (id === 'XZ') {
      label.position.set(-half + ix, 0, +half - iy);
      // +X_label → +X_world (right), +Y_label → +Z_world (up), normal → +Y
      // That's R_x(+π/2) on the default PlaneGeometry whose normal is +Z.
      label.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    } else if (id === 'YZ') {
      label.position.set(0, -half + ix, +half - iy);
      // +X_label → +Y_world, +Y_label → +Z_world, normal → +X
      // Build from axes: m sends e_x→(0,1,0), e_y→(0,0,1), e_z→(1,0,0).
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0),
      );
      label.quaternion.setFromRotationMatrix(m);
    }
  }

  /**
   * Build a CanvasTexture with the plane's friendly name. The texture is
   * a wide rectangle (2:1) since plane names ("Front", "Right", "Top") read
   * well in landscape.
   */
  _makeLabelTexture(text, colorHex) {
    // Onshape-style: plain text in the plane's color, no pill background.
    // Left-aligned so the label visually anchors to the top-left corner.
    const W = 256, H = 128;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const hex = '#' + colorHex.toString(16).padStart(6, '0');
    ctx.fillStyle = hex;
    ctx.font = '600 56px "Inter", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, H / 2 + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  _makeBorderGeom() {
    const half = 0.5;
    const positions = new Float32Array([
      -half, -half, 0,   half, -half, 0,
       half, -half, 0,   half,  half, 0,
       half,  half, 0,  -half,  half, 0,
      -half,  half, 0,  -half, -half, 0,
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }

  _setHover(entry) {
    if (entry === this._hover) return;
    if (this._hover) {
      this._hover.fillMat.opacity   = FILL_OPACITY_IDLE;
      this._hover.borderMat.opacity = BORDER_OPACITY_IDLE;
    }
    this._hover = entry;
    if (entry) {
      entry.fillMat.opacity   = FILL_OPACITY_HOVER;
      entry.borderMat.opacity = BORDER_OPACITY_HOVER;
    }
  }

  _raycastEntry(clientX, clientY) {
    const dom = this._renderer.domElement;
    const rect = dom.getBoundingClientRect();
    this._ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this._ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this._camera);
    // Skip hidden planes so the raycast doesn't pick something the user
    // turned off (Three.Raycaster ignores `mesh.visible`, only `layers`).
    const meshes = this._entries
      .filter((e) => this._perPlaneVisible[e.spec.id] !== false)
      .map((e) => e.mesh);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    return this._entries.find((e) => e.mesh === hit.object) || null;
  }

  _onPointerMove(ev) {
    if (!this.group.visible) {
      if (this._hover) { this._setHover(null); this._hideTooltip(); }
      return;
    }
    // Ignore moves with a button held — likely an orbit/pan in flight.
    if (ev.buttons !== 0) {
      if (this._hover) { this._setHover(null); this._hideTooltip(); }
      return;
    }
    const entry = this._raycastEntry(ev.clientX, ev.clientY);
    this._setHover(entry);
    if (entry) {
      this._showTooltipAt(ev, entry);
    } else {
      this._hideTooltip();
    }
  }

  _onPointerLeave() {
    this._setHover(null);
    this._hideTooltip();
  }

  _onPointerDown(ev) {
    if (!this.group.visible) return;
    // Only react to primary (left) button.
    if (ev.button !== 0) return;
    const entry = this._raycastEntry(ev.clientX, ev.clientY);
    if (!entry) { this._armedEntry = null; return; }
    this._armedEntry = entry;
    this._armedAt = { x: ev.clientX, y: ev.clientY };
    // Consume — don't let rubber-band or picking grab this gesture.
    try { ev.stopPropagation(); } catch {}
    try { ev.preventDefault(); } catch {}
  }

  _onPointerUp(ev) {
    const armed = this._armedEntry;
    this._armedEntry = null;
    if (!armed) return;
    if (ev.button !== 0) return;
    // Treat anything within a small drag threshold as a click.
    const at = this._armedAt;
    const dx = at ? ev.clientX - at.x : 0;
    const dy = at ? ev.clientY - at.y : 0;
    const moved = Math.hypot(dx, dy);
    this._armedAt = null;
    try { ev.stopPropagation(); } catch {}
    if (moved > 5) return;
    // Fire the callback.
    const spec = armed.spec;
    if (this._onSketchOnPlane) {
      try {
        this._onSketchOnPlane({
          planeId: spec.id,
          planeName: spec.name,
          longName: spec.long,
          normal: spec.normal.slice(),
          origin: spec.origin.slice(),
        });
      } catch (err) {
        console.error('[reference_planes] onSketchOnPlane threw:', err);
      }
    }
    // Hide tooltip / clear hover after invoking — the sketcher will take
    // over the viewport.
    this._setHover(null);
    this._hideTooltip();
  }

  // ── Tooltip ─────────────────────────────────────────────────────────────

  _ensureTooltipEl() {
    if (this._tooltipEl) return this._tooltipEl;
    const el = document.createElement('div');
    el.className = '__pf4_ref_plane_tooltip__';
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

  _showTooltipAt(ev, entry) {
    const el = this._ensureTooltipEl();
    el.textContent = `Sketch on ${entry.spec.long}`;
    el.style.left = `${Math.round(ev.clientX + 14)}px`;
    el.style.top  = `${Math.round(ev.clientY + 14)}px`;
    el.style.display = 'block';
  }

  _hideTooltip() {
    if (this._tooltipEl) this._tooltipEl.style.display = 'none';
  }
}
