/**
 * Sketch tools (3D edition).
 *
 * Same conceptual shape as `app/sketch_editor/tools.js` but pointer coords
 * arrive pre-resolved to sketch-local 2D (the controller raycasts the
 * cursor against the sketch plane). Previews and snap markers are emitted
 * to the Sketch3DRenderer rather than an SVG canvas.
 *
 * Tools also receive a `snapResult` so they can:
 *   1. Use the snapped point for placement
 *   2. Auto-add constraints inferred from the snap kind (Phase 1C goal)
 */

import {
    makePoint, makeLine, makeCircle, makeArc, makeRectangle, makePolygon, makeSlotLinear,
    makeSpline, makeText,
    ENTITY_KIND,
} from '../../lib/sketch/entities.js';
import {
    addEntity, addConstraint, removeEntity, patchEntity, setConstraintDriven,
} from '../../lib/sketch/sketch_data.js';
import { solve as solveSketch } from '../../lib/sketch/solver/index.js';
import {
    coincident, horizontal, vertical, midpoint as midpointC, pointOnLine,
    fixedDistance, fixedRadius, fixedAngle, tangent,
    parallel, perpendicular, equalLength,
} from '../../lib/sketch/constraints.js';
import { SNAP_KINDS, inferDrawHints } from './snap_3d.js';
import { pickEntity } from './hit_test_entities.js';
import {
    filletTwoLines, chamferTwoLines, offsetEntity, offsetSideFromCursor,
    toggleEntityConstruction, trimEntity, trimSegments, extendEntity,
} from '../../lib/sketch/sketch_edits.js';
import { mirrorEntities } from '../../lib/sketch/sketch_mirror.js';
import { linearPattern, circularPattern } from '../../lib/sketch/sketch_pattern.js';

// ── Helper: ensure a Point at `pt`, reusing if a snap target points at one ──

function ensurePoint(sketch, pt, snap) {
    // Vertex snap → reuse the existing Point id (no duplicate).
    if (snap && snap.kind === SNAP_KINDS.VERTEX && snap.extra && snap.extra.entityId) {
        return snap.extra.entityId;
    }
    const p = addEntity(sketch, makePoint(pt.x, pt.y));
    // Midpoint snap → coincident-on-midpoint constraint
    if (snap && snap.kind === SNAP_KINDS.MIDPOINT && snap.extra && snap.extra.lineId) {
        addConstraint(sketch, midpointC(p.id, snap.extra.lineId));
    }
    // On-line snap → point-on-line
    if (snap && snap.kind === SNAP_KINDS.ON_LINE && snap.extra && snap.extra.lineId) {
        addConstraint(sketch, pointOnLine(p.id, snap.extra.lineId));
    }
    return p.id;
}

/** Auto-add H/V constraints when ortho snap fired during a line draw. */
function applyOrthoConstraint(sketch, lineId, snap) {
    if (!snap || snap.kind !== SNAP_KINDS.ORTHO) return;
    const ax = snap.extra && snap.extra.axis;
    if (ax === 'h') addConstraint(sketch, horizontal(lineId));
    if (ax === 'v') addConstraint(sketch, vertical(lineId));
}

/**
 * Auto-add a tangent constraint when a line endpoint was placed on a circle
 * via the tangent snap. The user-facing result: drag a line until it kisses
 * the circle rim → tangency is enforced by the solver from then on.
 */
function applyTangentConstraint(sketch, lineId, snap) {
    if (!snap || snap.kind !== SNAP_KINDS.TANGENT) return;
    const circleId = snap.extra && snap.extra.circleId;
    if (!circleId || !sketch.entities[circleId]) return;
    addConstraint(sketch, tangent(lineId, circleId));
}

/**
 * Apply every constraint inferred at draw-time onto `lineId`. `hints` comes
 * from `inferDrawHints(...)`. Skips hints already covered by snap-derived
 * constraints (e.g. ortho → horizontal/vertical is added by
 * `applyOrthoConstraint`). Silently swallows constraint-validation errors so
 * a single bad hint can't abort the click.
 */
function applyInferredHints(sketch, lineId, hints) {
    if (!hints || !hints.length) return;
    const have = new Set();
    for (const h of hints) {
        if (have.has(h.kind)) continue;     // dedupe
        try {
            switch (h.kind) {
                case 'horizontal':
                    addConstraint(sketch, horizontal(lineId)); have.add(h.kind); break;
                case 'vertical':
                    addConstraint(sketch, vertical(lineId));   have.add(h.kind); break;
                case 'parallel':
                    if (h.refId && sketch.entities[h.refId])
                        addConstraint(sketch, parallel(lineId, h.refId));
                    have.add(h.kind); break;
                case 'perpendicular':
                    if (h.refId && sketch.entities[h.refId])
                        addConstraint(sketch, perpendicular(lineId, h.refId));
                    have.add(h.kind); break;
                case 'equal-length':
                    if (h.refId && sketch.entities[h.refId])
                        addConstraint(sketch, equalLength(lineId, h.refId));
                    have.add(h.kind); break;
                default: break;             // others come from snap path
            }
        } catch (err) {
            // Inferred constraints are best-effort — never break the click.
            console.warn('[sk3d infer]', h.kind, err.message);
        }
    }
}

// ── Select tool ─────────────────────────────────────────────────────────────
// Hover  → highlights the entity under the cursor.
// Click  → toggles selection (Shift-click for multi).
// Drag   → grabs the entity under the pointer and slides it. For Points the
//          drag updates the point directly; for higher-level entities
//          (Circle, Rectangle, Polygon) the drag cascades through their
//          referenced point ids so the whole shape follows.
//          The solver re-runs every frame so any active constraints lock
//          the drag (e.g. a horizontal-constrained line stays horizontal).
// Delete → removes every selected entity (cascades via removeEntity).

const DRAG_THRESHOLD_PX = 4;

export function selectTool3D() {
    /** Drag state — null when not dragging. */
    let drag = null;

    return {
        kind: 'select',
        cursor: 'default',
        activate() {
            this._editor.renderer.setHover(null);
            drag = null;
        },
        deactivate() {
            this._editor.renderer.setHover(null);
            drag = null;
        },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, { tolerance: tol });

            if (!hit) {
                if (!event.shiftKey) renderer.setSelection([]);
                drag = null;
                return;
            }

            // Capture potential drag — we only *start* moving after the
            // pointer leaves a small dead-zone so single-clicks stay clicks.
            const moveable = movePointIdsFor(sketch, hit.id);
            if (moveable.length) {
                drag = {
                    hitId:        hit.id,
                    moveablePts:  moveable,
                    startLocal:   { x: local.x, y: local.y },
                    startCoords:  moveable.map(pid => {
                        const p = sketch.entities[pid];
                        return [pid, { x: p.params.x, y: p.params.y }];
                    }),
                    dragging:     false,    // promoted to true after threshold
                    shiftKey:     event.shiftKey,
                };
            } else {
                drag = null;
            }

            // Click semantics on press (toggle selection). If the user drags,
            // the same selection stands so they see what they're moving.
            const sel = new Set(renderer.getSelection());
            if (event.shiftKey) {
                if (sel.has(hit.id)) sel.delete(hit.id); else sel.add(hit.id);
            } else {
                sel.clear();
                sel.add(hit.id);
            }
            renderer.setSelection([...sel]);
        },

        onPointerMove({ local, event, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            if (drag) {
                // Promote to active drag once we leave the dead-zone
                const dx = local.x - drag.startLocal.x;
                const dy = local.y - drag.startLocal.y;
                const px = this._editor._worldToScreenDist(Math.sqrt(dx * dx + dy * dy));
                if (!drag.dragging && px < DRAG_THRESHOLD_PX) return;
                drag.dragging = true;

                // Snap the *cursor* so vertex/midpoint/etc. snaps can guide
                // the drag (Fusion-style). We pass the dragged entity as
                // exclude so the cursor doesn't snap to its own points.
                const snap = this._editor._snapCursor(local, drag.hitId);
                const target = snap ? snap.point : local;
                const ddx = target.x - drag.startLocal.x;
                const ddy = target.y - drag.startLocal.y;
                for (const [pid, start] of drag.startCoords) {
                    patchEntity(sketch, pid, { x: start.x + ddx, y: start.y + ddy });
                }
                // Live solver re-run so constrained edges follow the drag.
                try { solveSketch(sketch); } catch {}
                renderer.render();
                this._editor._refreshBadges?.();
                renderer.setSnap(snap);
                return;
            }
            const hit = pickEntity(local, sketch, { tolerance: tol });
            renderer.setHover(hit ? hit.id : null);
        },

        onPointerUp({ renderer }) {
            if (drag) {
                if (drag.dragging) {
                    // Marking the sketch dirty triggers a solver re-run + counts refresh.
                    this._editor.commitDirty(true);
                    renderer.setSnap(null);
                }
                drag = null;
            }
        },

        onKeyDown(ev) {
            if (ev.key === 'Delete' || ev.key === 'Backspace') {
                const sel = this._editor.renderer.getSelection();
                if (!sel.length) return false;
                for (const id of sel) removeEntity(this._editor.sketchData, id);
                this._editor.renderer.setSelection([]);
                this._editor.commitDirty();
                return true;
            }
            if (ev.key === 'Escape') {
                this._editor.renderer.setSelection([]);
                this._editor.renderer.setHover(null);
                drag = null;
                return true;
            }
            return false;
        },
    };
}

/**
 * For a given hit entity id, return the list of *Point* ids that need to
 * move to translate the whole entity. Free Points are themselves the only
 * moveable. Lines move both endpoints. Circles/Arcs move their centre.
 * Rectangles move both corners. Polygons move their centre.
 *
 * If the entity has no underlying points we can't drag it (e.g. a Spline
 * with all-fixed control points) — return [].
 */
function movePointIdsFor(sketch, entityId) {
    const e = sketch.entities[entityId];
    if (!e) return [];
    switch (e.kind) {
        case ENTITY_KIND.POINT:     return [e.id];
        case ENTITY_KIND.LINE:      return [e.params.startId, e.params.endId];
        case ENTITY_KIND.CIRCLE:    return [e.params.centerId];
        case ENTITY_KIND.ARC:       return [e.params.centerId];
        case ENTITY_KIND.RECTANGLE: return [e.params.cornerStartId, e.params.cornerEndId];
        case ENTITY_KIND.POLYGON:   return [e.params.centerId];
        case ENTITY_KIND.SLOT_LINEAR: return [e.params.centerStartId, e.params.centerEndId];
        case ENTITY_KIND.SPLINE:    return (e.params.controlPointIds || []).slice();
        default: return [];
    }
}

// ── Line tool ───────────────────────────────────────────────────────────────

export function lineTool3D() {
    let anchor    = null;
    let anchorId  = null;
    let prevSnap  = null;
    /** The most recent set of inferred hints for the in-progress edge.
     *  Cached at onPointerMove and applied verbatim at onPointerDown so
     *  the click commits exactly what the user saw on screen. */
    let pendingHints = [];

    const LINE_DIM_DESCRIPTOR = [
        { key: 'length', label: 'L', unit: 'mm', step: 0.1 },
        { key: 'angle',  label: '∠', unit: '°',  step: 1   },
    ];

    return {
        kind: 'line',
        cursor: 'crosshair',
        activate()   { anchor = null; anchorId = null; pendingHints = []; },
        deactivate() {
            anchor = null; anchorId = null; pendingHints = [];
            const ed = this._editor;
            ed.setInferredGlyphs?.([]);
            ed.closeDynamicDim?.();
        },

        onPointerDown({ local, snap, sketch, renderer, event }) {
            const ed = this._editor;
            if (!anchor) {
                anchorId = ensurePoint(sketch, snap.point, snap);
                anchor   = { x: snap.point.x, y: snap.point.y };
                prevSnap = snap;
                renderer.setPreview(null);
                return;
            }
            // Determine the *effective* end point + angle for this click.
            // If the dynamic-dim input has locked values, they override the
            // free-cursor snap point (driving dimensions).
            const locks = ed._dynamicDim ? ed._dynamicDim.getLocks() : {};
            const useLockedLen   = Number.isFinite(locks.length) && locks.length > 0;
            const useLockedAngle = Number.isFinite(locks.angle);
            let endPt = snap.point;
            if (useLockedLen || useLockedAngle) {
                const dx = snap.point.x - anchor.x;
                const dy = snap.point.y - anchor.y;
                const freeLen = Math.max(1e-6, Math.hypot(dx, dy));
                const freeAng = Math.atan2(dy, dx);
                const len = useLockedLen   ? locks.length        : freeLen;
                const ang = useLockedAngle ? (locks.angle * Math.PI / 180) : freeAng;
                endPt = { x: anchor.x + len * Math.cos(ang), y: anchor.y + len * Math.sin(ang) };
            }
            const endId   = ensurePoint(sketch, endPt, snap);
            const newLine = addEntity(sketch, makeLine(anchorId, endId));
            // Snap-derived constraints first (ortho / tangent) — these win
            // over inferred parallel/perpendicular if both fire.
            applyOrthoConstraint(sketch, newLine.id, snap);
            applyTangentConstraint(sketch, newLine.id, snap);
            // Inferred relational constraints — unless Shift suppressed them.
            if (!event?.shiftKey && !ed.isInferenceSuppressed?.()) {
                applyInferredHints(sketch, newLine.id, pendingHints);
            }
            // Locked dimensional values become DRIVING constraints.
            if (useLockedLen) {
                try { addConstraint(sketch, fixedDistance(anchorId, endId, locks.length)); }
                catch (err) { console.warn('[sk3d line len]', err.message); }
            }
            if (useLockedAngle) {
                // Encode the angle as a horizontal/vertical when it's a
                // perfect ortho, otherwise leave it free — fixedAngle would
                // need a reference line. The driving length plus the snapped
                // direction usually pins it adequately.
                const deg = ((locks.angle % 360) + 360) % 360;
                if (Math.abs(deg) < 1e-3 || Math.abs(deg - 180) < 1e-3) {
                    try { addConstraint(sketch, horizontal(newLine.id)); } catch {}
                } else if (Math.abs(deg - 90) < 1e-3 || Math.abs(deg - 270) < 1e-3) {
                    try { addConstraint(sketch, vertical(newLine.id)); } catch {}
                }
            }
            // Chain: end becomes new anchor; clear locks so the next segment
            // starts fresh.
            anchor   = { x: endPt.x, y: endPt.y };
            anchorId = endId;
            pendingHints = [];
            if (ed._dynamicDim) ed._dynamicDim.clearLocks();
            ed.setInferredGlyphs?.([]);
            ed.commitDirty();
        },

        onPointerMove({ local, snap, renderer, sketch }) {
            const ed = this._editor;
            if (anchor) {
                renderer.setPreview(renderer.previewLine(anchor, snap.point));
                const length = Math.hypot(snap.point.x - anchor.x, snap.point.y - anchor.y);
                const angleDeg = Math.atan2(snap.point.y - anchor.y, snap.point.x - anchor.x) * 180 / Math.PI;
                ed.setDimReadout({
                    kind: 'line',
                    anchor, cursor: snap.point,
                    length, angleDeg,
                });
                // Live inference: combine snap + geometric comparison
                pendingHints = inferDrawHints(snap, anchor, snap.point, sketch, {
                    angleTolDeg: 3, lengthRelTol: 0.02,
                });
                ed.setInferredGlyphs?.(pendingHints, snap.point);
                // Dynamic dimension input — open it lazily after the first
                // click so it can't intercept the first point's pointer
                // events. Updates live but never steals focus from typing.
                if (ed.openDynamicDim) {
                    const screen = ed._localToScreen ? ed._localToScreen(snap.point) : { x: 0, y: 0 };
                    ed.openDynamicDim(
                        LINE_DIM_DESCRIPTOR,
                        { length, angle: ((angleDeg % 360) + 360) % 360 },
                        screen,
                        ({ locks }) => {
                            // Commit-on-Enter from the input row: synthesize
                            // a click at the locked endpoint.
                            const useLen = Number.isFinite(locks.length) && locks.length > 0;
                            const useAng = Number.isFinite(locks.angle);
                            const a   = useAng ? (locks.angle * Math.PI / 180)
                                               : Math.atan2(snap.point.y - anchor.y, snap.point.x - anchor.x);
                            const len = useLen ? locks.length
                                               : Math.hypot(snap.point.x - anchor.x, snap.point.y - anchor.y);
                            const synth = {
                                x: anchor.x + len * Math.cos(a),
                                y: anchor.y + len * Math.sin(a),
                            };
                            // Reuse the pointer-down path for consistency.
                            this.onPointerDown({
                                local: synth, snap: { kind: SNAP_KINDS.GRID, point: synth },
                                sketch, renderer, event: { button: 0 },
                            });
                        },
                    );
                }
            } else {
                renderer.setPreview(null);
                ed.setDimReadout(null);
                // Even without an anchor, surface snap-based inferences
                // (vertex / midpoint / tangent) for the first click target.
                const hints = inferDrawHints(snap, null, snap.point, sketch);
                ed.setInferredGlyphs?.(hints, snap.point);
            }
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                anchor = null; anchorId = null; pendingHints = [];
                const ed = this._editor;
                ed.renderer.setPreview(null);
                ed.setDimReadout(null);
                ed.setInferredGlyphs?.([]);
                ed.closeDynamicDim?.();
                return true;
            }
            return false;
        },
    };
}

// ── Rectangle tool ──────────────────────────────────────────────────────────

export function rectTool3D() {
    let cornerA   = null;
    let cornerAId = null;

    const RECT_DIM_DESCRIPTOR = [
        { key: 'width',  label: 'W', unit: 'mm' },
        { key: 'height', label: 'H', unit: 'mm' },
    ];

    return {
        kind: 'rect',
        cursor: 'crosshair',
        activate() { cornerA = null; cornerAId = null; },
        deactivate() {
            cornerA = null; cornerAId = null;
            const ed = this._editor;
            ed.closeDynamicDim?.();
            ed.setInferredGlyphs?.([]);
        },

        onPointerDown({ snap, sketch }) {
            const ed = this._editor;
            if (!cornerA) {
                cornerAId = ensurePoint(sketch, snap.point, snap);
                cornerA   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            // Honor locked w/h from the dynamic dim input.
            const locks = ed._dynamicDim ? ed._dynamicDim.getLocks() : {};
            let endPt = snap.point;
            if (Number.isFinite(locks.width) || Number.isFinite(locks.height)) {
                const sx = Math.sign(snap.point.x - cornerA.x) || 1;
                const sy = Math.sign(snap.point.y - cornerA.y) || 1;
                const w = Number.isFinite(locks.width)  ? locks.width  : Math.abs(snap.point.x - cornerA.x);
                const h = Number.isFinite(locks.height) ? locks.height : Math.abs(snap.point.y - cornerA.y);
                endPt = { x: cornerA.x + sx * w, y: cornerA.y + sy * h };
            }
            const cornerBId = ensurePoint(sketch, endPt, snap);
            addEntity(sketch, makeRectangle(cornerAId, cornerBId));
            ed.commitDirty();
            cornerA = null; cornerAId = null;
            ed.renderer.setPreview(null);
            ed.setDimReadout(null);
            ed.closeDynamicDim?.();
            ed.setInferredGlyphs?.([]);
        },

        onPointerMove({ snap, renderer, sketch }) {
            const ed = this._editor;
            if (cornerA) {
                renderer.setPreview(renderer.previewRect(cornerA, snap.point));
                const w = Math.abs(snap.point.x - cornerA.x);
                const h = Math.abs(snap.point.y - cornerA.y);
                ed.setDimReadout({ kind: 'rect', anchor: cornerA, cursor: snap.point, width: w, height: h });
                if (ed.openDynamicDim) {
                    const screen = ed._localToScreen ? ed._localToScreen(snap.point) : { x: 0, y: 0 };
                    ed.openDynamicDim(RECT_DIM_DESCRIPTOR, { width: w, height: h }, screen, () => {
                        // Synthesize a click using locked dims.
                        this.onPointerDown({ snap, sketch, renderer, event: { button: 0 }, local: snap.point });
                    });
                }
                // Snap-based glyphs (vertex/midpoint of existing geometry).
                const hints = inferDrawHints(snap, null, snap.point, sketch);
                ed.setInferredGlyphs?.(hints, snap.point);
            }
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                cornerA = null; cornerAId = null;
                const ed = this._editor;
                ed.renderer.setPreview(null);
                ed.setDimReadout(null);
                ed.closeDynamicDim?.();
                ed.setInferredGlyphs?.([]);
                return true;
            }
            return false;
        },
    };
}

// ── Circle tool ─────────────────────────────────────────────────────────────

export function circleTool3D() {
    let center   = null;
    let centerId = null;

    const CIRCLE_DIM_DESCRIPTOR = [
        { key: 'radius', label: 'R', unit: 'mm' },
    ];

    return {
        kind: 'circle',
        cursor: 'crosshair',
        activate() { center = null; centerId = null; },
        deactivate() {
            center = null; centerId = null;
            const ed = this._editor;
            ed.closeDynamicDim?.();
            ed.setInferredGlyphs?.([]);
        },

        onPointerDown({ snap, sketch }) {
            const ed = this._editor;
            if (!center) {
                centerId = ensurePoint(sketch, snap.point, snap);
                center   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            const locks = ed._dynamicDim ? ed._dynamicDim.getLocks() : {};
            const dx = snap.point.x - center.x, dy = snap.point.y - center.y;
            let r = Math.max(0.01, Math.sqrt(dx*dx + dy*dy));
            let lockedRadius = null;
            if (Number.isFinite(locks.radius) && locks.radius > 0) {
                lockedRadius = locks.radius;
                r = locks.radius;
            }
            const newCircle = addEntity(sketch, makeCircle(centerId, r));
            if (lockedRadius != null) {
                try { addConstraint(sketch, fixedRadius(newCircle.id, lockedRadius)); }
                catch (err) { console.warn('[sk3d circle radius]', err.message); }
            }
            ed.commitDirty();
            center = null; centerId = null;
            ed.renderer.setPreview(null);
            ed.setDimReadout(null);
            ed.closeDynamicDim?.();
            ed.setInferredGlyphs?.([]);
        },

        onPointerMove({ snap, renderer, sketch }) {
            const ed = this._editor;
            if (center) {
                const dx = snap.point.x - center.x, dy = snap.point.y - center.y;
                const r  = Math.sqrt(dx*dx + dy*dy);
                renderer.setPreview(renderer.previewCircle(center, r));
                ed.setDimReadout({ kind: 'circle', anchor: center, cursor: snap.point, radius: r });
                if (ed.openDynamicDim) {
                    const screen = ed._localToScreen ? ed._localToScreen(snap.point) : { x: 0, y: 0 };
                    ed.openDynamicDim(CIRCLE_DIM_DESCRIPTOR, { radius: r }, screen, () => {
                        this.onPointerDown({ snap, sketch, renderer, event: { button: 0 }, local: snap.point });
                    });
                }
                const hints = inferDrawHints(snap, null, snap.point, sketch);
                ed.setInferredGlyphs?.(hints, snap.point);
            }
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                center = null; centerId = null;
                const ed = this._editor;
                ed.renderer.setPreview(null);
                ed.setDimReadout(null);
                ed.closeDynamicDim?.();
                ed.setInferredGlyphs?.([]);
                return true;
            }
            return false;
        },
    };
}

// ── Polygon tool ────────────────────────────────────────────────────────────

export function polygonTool3D() {
    let center   = null;
    let centerId = null;

    return {
        kind: 'polygon',
        cursor: 'crosshair',
        activate() { center = null; centerId = null; },
        deactivate() { center = null; centerId = null; },

        onPointerDown({ snap, sketch }) {
            const ed = this._editor;
            if (!center) {
                centerId = ensurePoint(sketch, snap.point, snap);
                center   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            const dx = snap.point.x - center.x, dy = snap.point.y - center.y;
            const r  = Math.max(0.01, Math.sqrt(dx*dx + dy*dy));
            const rotation = Math.atan2(dy, dx);
            const sides = ed.polygonSides || 6;
            addEntity(sketch, makePolygon(centerId, r, sides, { rotation }));
            ed.commitDirty();
            center = null; centerId = null;
            ed.renderer.setPreview(null);
            ed.setDimReadout(null);
        },

        onPointerMove({ snap, renderer }) {
            if (center) {
                const dx = snap.point.x - center.x, dy = snap.point.y - center.y;
                const r  = Math.sqrt(dx*dx + dy*dy);
                const rot = Math.atan2(dy, dx);
                const n   = this._editor.polygonSides || 6;
                renderer.setPreview(renderer.previewPolygon(center, r, n, rot));
                this._editor.setDimReadout({
                    kind: 'polygon',
                    anchor: center,
                    cursor: snap.point,
                    radius: r,
                    sides:  n,
                });
            }
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                center = null; centerId = null;
                this._editor.renderer.setPreview(null);
                this._editor.setDimReadout(null);
                return true;
            }
            return false;
        },
    };
}

// ── Slot tool (linear, centre-to-centre) ───────────────────────────────────
// Three clicks:
//   1. first centre  (A)
//   2. second centre (B)            → preview a slot that follows the cursor
//   3. width point                   → commits the slot at the cursor's
//                                       perpendicular distance from AB
// Dimension readout shows the live length and width during steps 2 + 3.

export function slotTool3D() {
    let centerA   = null, centerAId = null;
    let centerB   = null, centerBId = null;

    return {
        kind: 'slot',
        cursor: 'crosshair',
        activate()   { centerA = centerAId = centerB = centerBId = null; },
        deactivate() {
            centerA = centerAId = centerB = centerBId = null;
            this._editor.renderer.setPreview(null);
            this._editor.setDimReadout(null);
        },

        onPointerDown({ snap, sketch, renderer }) {
            const ed = this._editor;
            if (!centerAId) {
                centerAId = ensurePoint(sketch, snap.point, snap);
                centerA   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            if (!centerBId) {
                centerBId = ensurePoint(sketch, snap.point, snap);
                centerB   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            // Third click — derive the slot half-width from cursor perpendicular distance
            const r = perpDistance(centerA, centerB, snap.point);
            if (!Number.isFinite(r) || r < 0.01) {
                ed.toast && ed.toast('Slot width too small — move cursor away from the centreline.', 'error');
                return;
            }
            addEntity(sketch, makeSlotLinear(centerAId, centerBId, r));
            ed.commitDirty();
            centerA = centerAId = centerB = centerBId = null;
            renderer.setPreview(null);
            ed.setDimReadout(null);
        },

        onPointerMove({ snap, renderer }) {
            const ed = this._editor;
            if (centerA && !centerBId) {
                // Step 2 preview — centreline only (no slot body yet)
                renderer.setPreview(renderer.previewLine(centerA, snap.point));
                ed.setDimReadout({
                    kind: 'line',
                    anchor: centerA, cursor: snap.point,
                    length: Math.hypot(snap.point.x - centerA.x, snap.point.y - centerA.y),
                    angleDeg: Math.atan2(snap.point.y - centerA.y, snap.point.x - centerA.x) * 180 / Math.PI,
                });
                return;
            }
            if (centerA && centerB) {
                const r = Math.max(0.01, perpDistance(centerA, centerB, snap.point));
                renderer.setPreview(renderer.previewSlotLinear(centerA, centerB, r));
                ed.setDimReadout({
                    kind: 'slot',
                    anchor: centerB, cursor: snap.point,
                    length: Math.hypot(centerB.x - centerA.x, centerB.y - centerA.y),
                    width:  2 * r,
                });
                return;
            }
            renderer.setPreview(null);
            ed.setDimReadout(null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                centerA = centerAId = centerB = centerBId = null;
                this._editor.renderer.setPreview(null);
                this._editor.setDimReadout(null);
                return true;
            }
            return false;
        },
    };
}

/** Perpendicular distance from `p` to the (extended) line through (a, b). */
function perpDistance(a, b, p) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
}

// ── Spline tool ─────────────────────────────────────────────────────────────
// Click to drop control points one at a time. Each click adds a Point to
// the sketch and the live preview redraws the spline through the running
// list of control points plus the cursor as the (provisional) next point.
// Press Enter (or double-click) to commit once at least 2 control points
// are placed; Escape discards the in-progress curve and its dropped Points.

export function splineTool3D() {
    let ids = [];          // committed control-point ids in the sketch
    let lastClickAt = 0;
    let lastClickPt = null;

    return {
        kind: 'spline',
        cursor: 'crosshair',
        activate()   { ids = []; lastClickAt = 0; lastClickPt = null; },
        deactivate() {
            ids = [];
            this._editor.renderer.setPreview(null);
            this._editor.setDimReadout(null);
        },

        onPointerDown({ snap, sketch, event }) {
            const ed = this._editor;
            const now = (event && event.timeStamp) || Date.now();
            const dt  = now - lastClickAt;
            const pt  = snap.point;
            const tol = ed._screenToWorldDist(4);
            const dist = lastClickPt
                ? Math.hypot(pt.x - lastClickPt.x, pt.y - lastClickPt.y)
                : Infinity;

            // Double-click — same position within 300 ms — commits the spline
            // (need at least 2 control points). The repeat click is consumed,
            // not added.
            if (dt > 0 && dt < 300 && dist < tol && ids.length >= 2) {
                this._commit();
                lastClickAt = 0; lastClickPt = null;
                return;
            }

            lastClickAt = now;
            lastClickPt = { x: pt.x, y: pt.y };

            const p = addEntity(sketch, makePoint(pt.x, pt.y));
            ids.push(p.id);
            // After dropping a control point we re-render so the user sees
            // the dropped points immediately.
            if (this._editor.renderer) this._editor.renderer.render();
            this._refreshPreview(pt);
            ed.setDimReadout({ kind: 'spline', anchor: pt, cursor: pt, count: ids.length });
        },

        onPointerMove({ snap }) {
            this._refreshPreview(snap.point);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            const ed = this._editor;
            if (ev.key === 'Enter') {
                if (ids.length >= 2) {
                    this._commit();
                    return true;
                }
                ed.toast && ed.toast('Spline: drop at least 2 control points first.', 'error');
                return true;
            }
            if (ev.key === 'Escape') {
                // Roll back the unfinished control points
                for (const id of ids) removeEntity(this._editor.sketchData, id);
                ids = [];
                this._editor.renderer.setPreview(null);
                this._editor.setDimReadout(null);
                this._editor.commitDirty();
                return true;
            }
            return false;
        },

        _refreshPreview(cursor) {
            const ed = this._editor;
            const ctrl = ids
                .map(id => ed.sketchData.entities[id])
                .filter(Boolean)
                .map(e => ({ x: e.params.x, y: e.params.y }));
            if (cursor) ctrl.push({ x: cursor.x, y: cursor.y });
            if (ctrl.length < 2) {
                ed.renderer.setPreview(null);
                return;
            }
            const ghost = ed.renderer.previewSpline(ctrl);
            ed.renderer.setPreview(ghost);
        },

        _commit() {
            const ed = this._editor;
            if (ids.length < 2) return;
            // For the curve degree, clamp to count - 1 so we don't violate
            // makeSpline's minimum (degree + 1 control points) rule for short
            // splines. Cubic is the standard for 4+ points.
            const degree = Math.min(3, ids.length - 1);
            addEntity(ed.sketchData, makeSpline(ids.slice(), { degree }));
            ids = [];
            ed.renderer.setPreview(null);
            ed.setDimReadout(null);
            ed.commitDirty();
        },
    };
}

// ── Dim tool ────────────────────────────────────────────────────────────────
// Click one or two entities → an HTML input appears between them → typed
// value commits a fixedRadius (circle/arc) or fixedDistance (two points or
// the endpoints of a line) constraint. Solver re-runs and geometry snaps.

export function dimTool3D() {
    let picks = [];   // Array of { kind, id, point2D }

    return {
        kind: 'dim',
        cursor: 'crosshair',
        activate() { picks = []; this._editor.closeDimInput(); },
        deactivate() { picks = []; this._editor.closeDimInput(); },

        onPointerDown({ local, snap, sketch, renderer, event }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);

            // Prefer vertex snap (precise) — else pick whatever entity is under cursor
            let pick;
            if (snap && snap.kind === SNAP_KINDS.VERTEX && snap.extra && snap.extra.entityId) {
                const p = sketch.entities[snap.extra.entityId];
                pick = { kind: 'point', id: p.id, point2D: { x: p.params.x, y: p.params.y } };
            } else {
                const hit = pickEntity(local, sketch, { tolerance: tol });
                if (!hit) return;
                const e = sketch.entities[hit.id];
                if (!e) return;
                if (e.kind === ENTITY_KIND.POINT) {
                    pick = { kind: 'point', id: e.id, point2D: { x: e.params.x, y: e.params.y } };
                } else if (e.kind === ENTITY_KIND.CIRCLE || e.kind === ENTITY_KIND.ARC) {
                    const c = sketch.entities[e.params.centerId];
                    if (!c) return;
                    pick = {
                        kind: 'circle', id: e.id,
                        // Anchor the input near the rim closest to the cursor
                        point2D: { x: c.params.x + e.params.radius, y: c.params.y },
                    };
                } else if (e.kind === ENTITY_KIND.LINE) {
                    // Treat a Line click as "two-point distance" by grabbing its endpoints.
                    const a = sketch.entities[e.params.startId];
                    const b = sketch.entities[e.params.endId];
                    if (!a || !b) return;
                    const mid = { x: 0.5 * (a.params.x + b.params.x), y: 0.5 * (a.params.y + b.params.y) };
                    const cur = Math.hypot(b.params.x - a.params.x, b.params.y - a.params.y);
                    ed.openDimInput({
                        anchor: mid, current: cur, unit: 'mm',
                        onCommit: (value) => {
                            const c = addConstraint(sketch, fixedDistance(a.id, b.id, +value));
                            if (ed._drivenDimMode) setConstraintDriven(sketch, c.id, true);
                            ed.commitDirty(true);
                        },
                    });
                    return;
                } else {
                    return;
                }
            }

            // Circle: immediate radius input
            if (pick.kind === 'circle') {
                const e = sketch.entities[pick.id];
                ed.openDimInput({
                    anchor: pick.point2D, current: e.params.radius, unit: 'mm',
                    onCommit: (value) => {
                        const c = addConstraint(sketch, fixedRadius(pick.id, +value));
                        if (ed._drivenDimMode) setConstraintDriven(sketch, c.id, true);
                        ed.commitDirty(true);
                    },
                });
                return;
            }

            // Two points → distance dim
            picks.push(pick);
            if (picks.length === 2) {
                const [p1, p2] = picks;
                picks = [];
                const cur = Math.hypot(p2.point2D.x - p1.point2D.x, p2.point2D.y - p1.point2D.y);
                if (cur < 1e-9) { ed.toast && ed.toast('Points coincide.', 'error'); return; }
                const mid = { x: 0.5 * (p1.point2D.x + p2.point2D.x), y: 0.5 * (p1.point2D.y + p2.point2D.y) };
                ed.openDimInput({
                    anchor: mid, current: cur, unit: 'mm',
                    onCommit: (value) => {
                        const c = addConstraint(sketch, fixedDistance(p1.id, p2.id, +value));
                        if (ed._drivenDimMode) setConstraintDriven(sketch, c.id, true);
                        ed.commitDirty(true);
                    },
                });
            }
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, { tolerance: tol });
            renderer.setHover(hit ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                picks = [];
                this._editor.closeDimInput();
                this._editor.renderer.setHover(null);
                return true;
            }
            return false;
        },
    };
}

// ── Fillet tool ─────────────────────────────────────────────────────────────
// Click two lines (in any order). A radius input appears at their corner;
// pressing Enter commits a tangent arc and trims both lines to the tangent
// points. The radius defaults to the last value used (per session).

export function filletTool3D() {
    let firstId = null;

    return {
        kind: 'fillet',
        cursor: 'crosshair',
        activate() { firstId = null; },
        deactivate() { firstId = null; this._editor.closeDimInput(); },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            if (!hit) {
                ed.toast && ed.toast('Click a line.', 'error');
                return;
            }
            if (!firstId) {
                firstId = hit.id;
                renderer.setSelection([firstId]);
                return;
            }
            if (hit.id === firstId) return;   // need two distinct lines

            const l1Id = firstId, l2Id = hit.id;
            firstId = null;

            // Anchor the input at the midpoint between the two lines' midpoints
            const L1 = sketch.entities[l1Id], L2 = sketch.entities[l2Id];
            const A1 = sketch.entities[L1.params.startId], B1 = sketch.entities[L1.params.endId];
            const A2 = sketch.entities[L2.params.startId], B2 = sketch.entities[L2.params.endId];
            const mid = {
                x: 0.25 * (A1.params.x + B1.params.x + A2.params.x + B2.params.x),
                y: 0.25 * (A1.params.y + B1.params.y + A2.params.y + B2.params.y),
            };
            ed.openDimInput({
                anchor: mid,
                current: ed._lastFilletRadius || 1,
                unit: 'mm',
                onCommit: (value) => {
                    ed._lastFilletRadius = +value;
                    const arcId = filletTwoLines(sketch, l1Id, l2Id, +value);
                    renderer.setSelection([]);
                    if (!arcId) { ed.toast && ed.toast('Fillet failed (parallel lines or radius too large).', 'error'); return; }
                    ed.commitDirty(true);
                },
            });
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            renderer.setHover(hit && hit.id !== firstId ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                firstId = null;
                this._editor.closeDimInput();
                this._editor.renderer.setSelection([]);
                this._editor.renderer.setHover(null);
                return true;
            }
            return false;
        },
    };
}

// ── Chamfer tool ────────────────────────────────────────────────────────────
// Identical UX to Fillet: click two lines, a distance input appears at the
// corner, Enter commits a straight bevel. Last-used distance persists per
// session (separate from the fillet radius cache).

export function chamferTool3D() {
    let firstId = null;

    return {
        kind: 'chamfer',
        cursor: 'crosshair',
        activate() { firstId = null; },
        deactivate() { firstId = null; this._editor.closeDimInput(); },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            if (!hit) {
                ed.toast && ed.toast('Click a line.', 'error');
                return;
            }
            if (!firstId) {
                firstId = hit.id;
                renderer.setSelection([firstId]);
                return;
            }
            if (hit.id === firstId) return;

            const l1Id = firstId, l2Id = hit.id;
            firstId = null;

            const L1 = sketch.entities[l1Id], L2 = sketch.entities[l2Id];
            const A1 = sketch.entities[L1.params.startId], B1 = sketch.entities[L1.params.endId];
            const A2 = sketch.entities[L2.params.startId], B2 = sketch.entities[L2.params.endId];
            const mid = {
                x: 0.25 * (A1.params.x + B1.params.x + A2.params.x + B2.params.x),
                y: 0.25 * (A1.params.y + B1.params.y + A2.params.y + B2.params.y),
            };
            ed.openDimInput({
                anchor: mid,
                current: ed._lastChamferDist || 1,
                unit: 'mm',
                onCommit: (value) => {
                    ed._lastChamferDist = +value;
                    const bevelId = chamferTwoLines(sketch, l1Id, l2Id, +value);
                    renderer.setSelection([]);
                    if (!bevelId) { ed.toast && ed.toast('Chamfer failed (parallel lines or distance too large).', 'error'); return; }
                    ed.commitDirty(true);
                },
            });
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            renderer.setHover(hit && hit.id !== firstId ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                firstId = null;
                this._editor.closeDimInput();
                this._editor.renderer.setSelection([]);
                this._editor.renderer.setHover(null);
                return true;
            }
            return false;
        },
    };
}

// ── Offset tool ─────────────────────────────────────────────────────────────
// Click an entity → a preview offset line/circle follows the cursor on the
// side closest to it. Click again to anchor the distance + open an input
// for fine-tuning. Enter commits.

export function offsetTool3D() {
    let pickedId = null;
    let sideSign = 1;

    return {
        kind: 'offset',
        cursor: 'crosshair',
        activate() { pickedId = null; sideSign = 1; },
        deactivate() {
            pickedId = null; sideSign = 1;
            this._editor.renderer.setPreview(null);
            this._editor.closeDimInput();
        },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            if (!pickedId) {
                const hit = pickEntity(local, sketch, {
                    tolerance: tol,
                    filter: (e) => e.kind === ENTITY_KIND.LINE || e.kind === ENTITY_KIND.CIRCLE,
                });
                if (!hit) {
                    ed.toast && ed.toast('Click a line or circle to offset.', 'error');
                    return;
                }
                pickedId = hit.id;
                renderer.setSelection([pickedId]);
                return;
            }
            // Second click: commit at the cursor-determined side+distance
            const e = sketch.entities[pickedId];
            if (!e) { pickedId = null; return; }
            sideSign = offsetSideFromCursor(sketch, pickedId, local);
            const initial = currentOffsetDistance(sketch, pickedId, local);

            // Anchor the input at the cursor
            const ed2 = this._editor;
            ed2.openDimInput({
                anchor: local,
                current: Math.max(0.1, initial),
                unit: 'mm',
                onCommit: (value) => {
                    const id = offsetEntity(sketch, pickedId, +value, sideSign);
                    pickedId = null;
                    renderer.setSelection([]);
                    if (!id) { ed2.toast && ed2.toast('Offset failed.', 'error'); return; }
                    ed2.commitDirty(true);
                },
            });
        },

        onPointerMove({ local, sketch, renderer }) {
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            if (!pickedId) {
                const hit = pickEntity(local, sketch, {
                    tolerance: tol,
                    filter: (e) => e.kind === ENTITY_KIND.LINE || e.kind === ENTITY_KIND.CIRCLE,
                });
                renderer.setHover(hit ? hit.id : null);
                return;
            }
            // Live preview at the cursor's current side / distance
            const e = sketch.entities[pickedId];
            if (!e) { pickedId = null; renderer.setPreview(null); return; }
            const sign = offsetSideFromCursor(sketch, pickedId, local);
            const dist = Math.max(0.01, currentOffsetDistance(sketch, pickedId, local));
            const preview = buildOffsetPreview(sketch, pickedId, dist, sign, renderer);
            renderer.setPreview(preview);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                pickedId = null;
                this._editor.renderer.setPreview(null);
                this._editor.renderer.setSelection([]);
                this._editor.renderer.setHover(null);
                return true;
            }
            return false;
        },
    };
}

/**
 * Distance from cursor to the picked entity — used as the default offset value.
 */
function currentOffsetDistance(sketch, entityId, cursor) {
    const e = sketch.entities[entityId];
    if (!e) return 0;
    if (e.kind === ENTITY_KIND.LINE) {
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) return 0;
        const dx = b.params.x - a.params.x, dy = b.params.y - a.params.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return 0;
        // Perpendicular distance from cursor to the line
        return Math.abs(dx * (a.params.y - cursor.y) - dy * (a.params.x - cursor.x)) / len;
    }
    if (e.kind === ENTITY_KIND.CIRCLE) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return 0;
        return Math.abs(Math.hypot(cursor.x - c.params.x, cursor.y - c.params.y) - e.params.radius);
    }
    return 0;
}

/** Build a Three.js preview Line/Arc for the offset preview. */
function buildOffsetPreview(sketch, entityId, distance, sideSign, renderer) {
    const e = sketch.entities[entityId];
    if (!e) return null;
    if (e.kind === ENTITY_KIND.LINE) {
        const a = sketch.entities[e.params.startId];
        const b = sketch.entities[e.params.endId];
        if (!a || !b) return null;
        const dx = b.params.x - a.params.x, dy = b.params.y - a.params.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return null;
        const nx = -dy / len * distance * sideSign;
        const ny =  dx / len * distance * sideSign;
        return renderer.previewLine(
            { x: a.params.x + nx, y: a.params.y + ny },
            { x: b.params.x + nx, y: b.params.y + ny },
        );
    }
    if (e.kind === ENTITY_KIND.CIRCLE) {
        const c = sketch.entities[e.params.centerId];
        if (!c) return null;
        const newR = e.params.radius + sideSign * distance;
        if (newR <= 0) return null;
        return renderer.previewCircle({ x: c.params.x, y: c.params.y }, newR);
    }
    return null;
}

// ── Trim tool ───────────────────────────────────────────────────────────────
// Hover an entity → the segment that *would* be deleted highlights in the
// hover halo. Click commits the trim. If the clicked entity has no
// intersections, the whole entity is removed.

export function trimTool3D() {
    return {
        kind: 'trim',
        cursor: 'crosshair',
        activate() {
            this._editor.renderer.setHover(null);
        },
        deactivate() {
            this._editor.renderer.setHover(null);
            this._editor.renderer.setPreview(null);
        },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, { tolerance: tol });
            if (!hit) return;
            const ids = trimEntity(sketch, hit.id, local, { tol });
            if (ids == null) {
                ed.toast && ed.toast('Trim: click on a line / circle / arc.', 'error');
                return;
            }
            renderer.setHover(null);
            renderer.setPreview(null);
            renderer.setSelection([]);
            ed.commitDirty(true);
        },

        onPointerMove({ local, sketch, renderer }) {
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, { tolerance: tol });
            renderer.setHover(hit ? hit.id : null);
            renderer.setPreview(null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                this._editor.renderer.setHover(null);
                this._editor.renderer.setPreview(null);
                return true;
            }
            return false;
        },
    };
}

// ── Extend tool ─────────────────────────────────────────────────────────────
// Click a Line or Arc near the endpoint you want to extend. The endpoint
// slides along the entity's natural extrapolation until it hits the next
// piece of geometry in the sketch. No-op (with a toast) if there's nothing
// to extend to.

export function extendTool3D() {
    return {
        kind: 'extend',
        cursor: 'crosshair',
        activate()   { this._editor.renderer.setHover(null); },
        deactivate() { this._editor.renderer.setHover(null); },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE || e.kind === ENTITY_KIND.ARC,
            });
            if (!hit) {
                ed.toast && ed.toast('Extend: click a Line or Arc near the endpoint to extend.', 'error');
                return;
            }
            const ok = extendEntity(sketch, hit.id, local);
            if (ok === null) {
                ed.toast && ed.toast('Extend: unsupported entity kind.', 'error');
                return;
            }
            if (ok === false) {
                ed.toast && ed.toast('Extend: nothing to extend to.', 'info');
                return;
            }
            renderer.setHover(null);
            ed.commitDirty(true);
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE || e.kind === ENTITY_KIND.ARC,
            });
            renderer.setHover(hit ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                this._editor.renderer.setHover(null);
                return true;
            }
            return false;
        },
    };
}

// ── Mirror tool ─────────────────────────────────────────────────────────────
// Workflow: pre-select entities (in Select tool) → press M → click any Line
// to use as the mirror axis. Each selected entity is reflected across the
// axis; shared points are mirrored once so chains stay joined. The axis
// line itself is silently skipped if it happens to be in the selection.

export function mirrorTool3D() {
    return {
        kind: 'mirror',
        cursor: 'crosshair',
        activate() {
            const ed = this._editor;
            const sel = ed.renderer ? ed.renderer.getSelection() : [];
            if (!sel.length) {
                ed.toast && ed.toast('Mirror: select entities first, then click an axis line.', 'info');
            } else {
                ed.toast && ed.toast(`Mirror: ${sel.length} selected. Click an axis line.`, 'info');
            }
        },
        deactivate() {
            this._editor.renderer.setHover(null);
        },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            if (!hit) {
                ed.toast && ed.toast('Click a Line to use as the mirror axis.', 'error');
                return;
            }
            const sel = renderer.getSelection().filter(id => id !== hit.id);
            if (!sel.length) {
                ed.toast && ed.toast('Select entities to mirror first.', 'error');
                return;
            }
            const result = mirrorEntities(sketch, sel, hit.id);
            if (!result) {
                ed.toast && ed.toast('Mirror failed (axis must be a non-degenerate line).', 'error');
                return;
            }
            renderer.setSelection(result.newIds);
            renderer.setHover(null);
            if (result.skipped.length) {
                ed.toast && ed.toast(
                    `Mirrored ${result.newIds.length} · ${result.skipped.length} skipped (unsupported kind).`, 'info');
            } else {
                ed.toast && ed.toast(`Mirrored ${result.newIds.length} entit${result.newIds.length === 1 ? 'y' : 'ies'}.`, 'success');
            }
            ed.commitDirty(true);
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            renderer.setHover(hit ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                this._editor.renderer.setHover(null);
                return true;
            }
            return false;
        },
    };
}

// ── Linear pattern tool ────────────────────────────────────────────────────
// Pre-select entities → press A → click a Line for the direction → enter
// count → enter spacing. Original stays; (count - 1) copies are translated
// along the direction's start→end unit vector by `i * spacing`.

export function linearPatternTool3D() {
    /** Cached selection captured on activate so user clicks don't lose it. */
    let entityIds = null;

    return {
        kind: 'pattern-linear',
        cursor: 'crosshair',
        activate() {
            const ed = this._editor;
            const sel = ed.renderer ? ed.renderer.getSelection() : [];
            entityIds = sel.length ? sel.slice() : null;
            if (!entityIds) {
                ed.toast && ed.toast('Linear pattern: select entities first, then click a direction line.', 'info');
            } else {
                ed.toast && ed.toast(`Linear pattern: ${entityIds.length} selected. Click a line for the direction.`, 'info');
            }
        },
        deactivate() {
            entityIds = null;
            this._editor.renderer.setHover(null);
            this._editor.closeDimInput();
        },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            if (!hit) {
                ed.toast && ed.toast('Click a Line to use as the pattern direction.', 'error');
                return;
            }
            const sel = (entityIds || renderer.getSelection()).filter(id => id !== hit.id);
            if (!sel.length) {
                ed.toast && ed.toast('Select entities to pattern first.', 'error');
                return;
            }
            const L = sketch.entities[hit.id];
            const A = sketch.entities[L.params.startId];
            const B = sketch.entities[L.params.endId];
            const direction = { x: B.params.x - A.params.x, y: B.params.y - A.params.y };

            // Open a count input next to the line midpoint.
            const mid = { x: 0.5 * (A.params.x + B.params.x), y: 0.5 * (A.params.y + B.params.y) };
            const defaultCount   = ed._lastPatternCount   || 4;
            const defaultSpacing = ed._lastPatternSpacing || 10;
            ed.openDimInput({
                anchor: mid,
                current: defaultCount,
                unit: 'count',
                onCommit: (rawCount) => {
                    const count = Math.max(2, Math.round(+rawCount));
                    ed._lastPatternCount = count;
                    // Stage 2: ask for spacing
                    ed.openDimInput({
                        anchor: mid,
                        current: defaultSpacing,
                        unit: 'mm',
                        onCommit: (spacing) => {
                            ed._lastPatternSpacing = +spacing;
                            const result = linearPattern(sketch, sel, {
                                direction, count, spacing: +spacing,
                            });
                            if (!result) {
                                ed.toast && ed.toast('Linear pattern failed.', 'error');
                                return;
                            }
                            renderer.setSelection(result.newIds);
                            if (result.skipped.length) {
                                ed.toast && ed.toast(
                                    `Patterned ${result.newIds.length} · ${result.skipped.length} skipped.`, 'info');
                            } else {
                                ed.toast && ed.toast(
                                    `Patterned ${count - 1} copy/copies of ${sel.length} entit${sel.length === 1 ? 'y' : 'ies'}.`,
                                    'success');
                            }
                            ed.commitDirty(true);
                        },
                    });
                },
            });
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) => e.kind === ENTITY_KIND.LINE,
            });
            renderer.setHover(hit ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                this._editor.renderer.setHover(null);
                this._editor.closeDimInput();
                entityIds = null;
                return true;
            }
            return false;
        },
    };
}

// ── Circular pattern tool ──────────────────────────────────────────────────
// Pre-select entities → press X → click a Point (or the centre of a Circle/
// Arc) → enter count → enter step angle in degrees. Original stays;
// (count - 1) copies are rotated around the centre by `i * stepAngle`.

export function circularPatternTool3D() {
    let entityIds = null;

    return {
        kind: 'pattern-circular',
        cursor: 'crosshair',
        activate() {
            const ed = this._editor;
            const sel = ed.renderer ? ed.renderer.getSelection() : [];
            entityIds = sel.length ? sel.slice() : null;
            if (!entityIds) {
                ed.toast && ed.toast('Circular pattern: select entities first, then click a centre point.', 'info');
            } else {
                ed.toast && ed.toast(`Circular pattern: ${entityIds.length} selected. Click a centre point.`, 'info');
            }
        },
        deactivate() {
            entityIds = null;
            this._editor.renderer.setHover(null);
            this._editor.closeDimInput();
        },

        onPointerDown({ local, event, sketch, renderer }) {
            if (event.button !== 0) return;
            const ed = this._editor;
            const tol = ed._screenToWorldDist(8);
            // Allow picking a Point directly OR the centre of a Circle / Arc.
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) =>
                    e.kind === ENTITY_KIND.POINT ||
                    e.kind === ENTITY_KIND.CIRCLE ||
                    e.kind === ENTITY_KIND.ARC,
            });
            if (!hit) {
                ed.toast && ed.toast('Click a Point, Circle, or Arc to use as the rotation centre.', 'error');
                return;
            }
            const sel = (entityIds || renderer.getSelection()).filter(id => id !== hit.id);
            if (!sel.length) {
                ed.toast && ed.toast('Select entities to pattern first.', 'error');
                return;
            }
            const e = sketch.entities[hit.id];
            let centre;
            if (e.kind === ENTITY_KIND.POINT) {
                centre = { x: e.params.x, y: e.params.y };
            } else {
                const c = sketch.entities[e.params.centerId];
                if (!c) {
                    ed.toast && ed.toast('Centre point missing on that entity.', 'error');
                    return;
                }
                centre = { x: c.params.x, y: c.params.y };
            }

            const defaultCount = ed._lastCircPatternCount || 6;
            const defaultAngle = ed._lastCircPatternAngleDeg || 60;
            ed.openDimInput({
                anchor: centre,
                current: defaultCount,
                unit: 'count',
                onCommit: (rawCount) => {
                    const count = Math.max(2, Math.round(+rawCount));
                    ed._lastCircPatternCount = count;
                    ed.openDimInput({
                        anchor: centre,
                        current: defaultAngle,
                        unit: 'deg',
                        onCommit: (deg) => {
                            ed._lastCircPatternAngleDeg = +deg;
                            const stepAngle = (+deg) * Math.PI / 180;
                            const result = circularPattern(sketch, sel, {
                                centre, count, stepAngle,
                            });
                            if (!result) {
                                ed.toast && ed.toast('Circular pattern failed.', 'error');
                                return;
                            }
                            renderer.setSelection(result.newIds);
                            if (result.skipped.length) {
                                ed.toast && ed.toast(
                                    `Patterned ${result.newIds.length} · ${result.skipped.length} skipped.`, 'info');
                            } else {
                                ed.toast && ed.toast(
                                    `Patterned ${count - 1} copy/copies of ${sel.length} entit${sel.length === 1 ? 'y' : 'ies'}.`,
                                    'success');
                            }
                            ed.commitDirty(true);
                        },
                    });
                },
            });
        },

        onPointerMove({ local, sketch, renderer }) {
            const tol = this._editor._screenToWorldDist(8);
            const hit = pickEntity(local, sketch, {
                tolerance: tol,
                filter: (e) =>
                    e.kind === ENTITY_KIND.POINT ||
                    e.kind === ENTITY_KIND.CIRCLE ||
                    e.kind === ENTITY_KIND.ARC,
            });
            renderer.setHover(hit ? hit.id : null);
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                this._editor.renderer.setHover(null);
                this._editor.closeDimInput();
                entityIds = null;
                return true;
            }
            return false;
        },
    };
}

// ── Construction toggle (Tab key) ──────────────────────────────────────────

/**
 * Flip every selected entity between solid and construction (dashed).
 * Returns the count of entities toggled.
 */
export function toggleConstructionOnSelection(sketch, selectionIds) {
    let count = 0;
    for (const id of selectionIds) {
        if (toggleEntityConstruction(sketch, id)) count++;
    }
    return count;
}

// ── Arc math helpers ────────────────────────────────────────────────────────

/**
 * Circumcentre of the triangle (a, b, c) — i.e. the centre of the unique
 * circle through all three points. Returns `null` for collinear points.
 *
 * Public for testing.
 */
export function circumcenter(a, b, c) {
    const ax = a.x, ay = a.y;
    const bx = b.x, by = b.y;
    const cx = c.x, cy = c.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return null;
    const ax2 = ax * ax + ay * ay;
    const bx2 = bx * bx + by * by;
    const cx2 = cx * cx + cy * cy;
    const ux = (ax2 * (by - cy) + bx2 * (cy - ay) + cx2 * (ay - by)) / d;
    const uy = (ax2 * (cx - bx) + bx2 * (ax - cx) + cx2 * (bx - ax)) / d;
    return { x: ux, y: uy };
}

/**
 * Arc through three points (start, through, end). Returns
 * `{ center, radius, startAngle, sweepAngle }` (CCW positive) or null
 * if the points are collinear.
 *
 * Sweep direction is chosen so the arc passes through the `through` point.
 */
export function arcThroughThreePoints(start, through, end) {
    const c = circumcenter(start, through, end);
    if (!c) return null;
    const radius = Math.hypot(start.x - c.x, start.y - c.y);
    const a0 = Math.atan2(start.y - c.y, start.x - c.x);
    const a1 = Math.atan2(end.y   - c.y, end.x   - c.x);
    const am = Math.atan2(through.y - c.y, through.x - c.x);
    // Pick the sweep direction (CCW or CW) so that `am` falls between
    // `a0` and `a0 + sweep`.
    const norm = (x) => { let v = x % (2 * Math.PI); if (v < 0) v += 2 * Math.PI; return v; };
    const ccwSweep = norm(a1 - a0);
    const ccwToMid = norm(am - a0);
    const sweep   = ccwToMid > 0 && ccwToMid < ccwSweep ? ccwSweep : ccwSweep - 2 * Math.PI;
    return { center: c, radius, startAngle: a0, sweepAngle: sweep };
}

/**
 * Tangent direction at the end of the last drawn line / arc, picking the
 * endpoint nearest `pt`. Returns `{ end:{x,y}, dir:{x,y} }` (dir is a
 * unit vector pointing *outward* from the segment), or `null` if there
 * is no suitable previous entity.
 */
function tangentSeedFromLast(sketch, pt) {
    // Walk entityOrder in reverse for the most recently authored line or arc.
    for (let i = sketch.entityOrder.length - 1; i >= 0; i--) {
        const e = sketch.entities[sketch.entityOrder[i]];
        if (!e) continue;
        if (e.kind === ENTITY_KIND.LINE) {
            const a = sketch.entities[e.params.startId];
            const b = sketch.entities[e.params.endId];
            if (!a || !b) continue;
            // Pick endpoint closest to `pt` (we treat that as the open end).
            const da = (a.params.x - pt.x) ** 2 + (a.params.y - pt.y) ** 2;
            const db = (b.params.x - pt.x) ** 2 + (b.params.y - pt.y) ** 2;
            const tip = da < db ? a : b;
            const tail = da < db ? b : a;
            const dx = tip.params.x - tail.params.x;
            const dy = tip.params.y - tail.params.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue;
            return {
                end: { x: tip.params.x, y: tip.params.y },
                dir: { x: dx / len, y: dy / len },
            };
        }
        if (e.kind === ENTITY_KIND.ARC) {
            const c = sketch.entities[e.params.centerId];
            if (!c) continue;
            const a0 = e.params.startAngle;
            const a1 = e.params.startAngle + e.params.sweepAngle;
            const r  = e.params.radius;
            const p0 = { x: c.params.x + r * Math.cos(a0), y: c.params.y + r * Math.sin(a0) };
            const p1 = { x: c.params.x + r * Math.cos(a1), y: c.params.y + r * Math.sin(a1) };
            const d0 = (p0.x - pt.x) ** 2 + (p0.y - pt.y) ** 2;
            const d1 = (p1.x - pt.x) ** 2 + (p1.y - pt.y) ** 2;
            const useEnd = d1 < d0;
            const tipA = useEnd ? a1 : a0;
            const tip  = useEnd ? p1 : p0;
            // Outward tangent: ±90° rotation of the radial direction,
            // sign chosen by sweep direction.
            const sign = (useEnd ? 1 : -1) * Math.sign(e.params.sweepAngle || 1);
            const dir  = { x: -Math.sin(tipA) * sign, y: Math.cos(tipA) * sign };
            return { end: tip, dir };
        }
    }
    return null;
}

// ── Tangent-arc tool ────────────────────────────────────────────────────────
// Starts tangent to the previous line/arc's open endpoint. Single click
// places the arc endpoint; the arc is uniquely determined by tangency at the
// seed end + the clicked endpoint.

export function arcTangentTool3D() {
    let seed = null;      // { end, dir } — captured at first onPointerMove
    let startId = null;   // existing point id at seed.end (reused if present)

    function placeArc(sketch, end) {
        // Geometry: tangent at `seed.end` with direction `seed.dir`. The arc
        // centre lies on the line perpendicular to `dir` through `seed.end`.
        // Distance d from seed.end along that perpendicular sets radius;
        // the perpendicular bisector of (seed.end, end) intersects it at
        // a unique centre.
        const a = seed.end, b = end;
        const mx = 0.5 * (a.x + b.x), my = 0.5 * (a.y + b.y);
        const chordX = b.x - a.x, chordY = b.y - a.y;
        // Perpendicular at seed.end: param t along the normal (-dy, dx).
        const nx = -seed.dir.y, ny = seed.dir.x;
        // Solve for t: (a + t·n - mid) · chord = 0
        const denom = nx * chordX + ny * chordY;
        if (Math.abs(denom) < 1e-9) return null;
        const t = ((mx - a.x) * chordX + (my - a.y) * chordY) / denom;
        const center = { x: a.x + t * nx, y: a.y + t * ny };
        const radius = Math.hypot(a.x - center.x, a.y - center.y);
        if (!Number.isFinite(radius) || radius < 1e-6) return null;
        const startAngle = Math.atan2(a.y - center.y, a.x - center.x);
        const endAngle   = Math.atan2(b.y - center.y, b.x - center.x);
        // CCW positive sweep; flip if t < 0 (centre on the other side).
        let sweep = endAngle - startAngle;
        // Normalise to (-2π, 2π) preserving sign from t.
        if (t < 0) {
            if (sweep > 0) sweep -= 2 * Math.PI;
        } else {
            if (sweep < 0) sweep += 2 * Math.PI;
        }
        if (Math.abs(sweep) < 1e-6) return null;
        const centerEnt = addEntity(sketch, makePoint(center.x, center.y, { construction: true }));
        return addEntity(sketch, makeArc(centerEnt.id, radius, startAngle, sweep));
    }

    return {
        kind: 'arc-tangent',
        cursor: 'crosshair',
        activate() {
            seed = null; startId = null;
            const ed = this._editor;
            // Seed lookup at activation time so user knows immediately
            // whether the tool is usable.
            const last = ed.sketchData.entityOrder[ed.sketchData.entityOrder.length - 1];
            if (!last) {
                ed.toast && ed.toast('Tangent arc needs a previous Line or Arc.', 'error');
            }
        },
        deactivate() {
            seed = null; startId = null;
            this._editor.renderer.setPreview(null);
            this._editor.setDimReadout(null);
        },

        onPointerDown({ snap, sketch, renderer }) {
            const ed = this._editor;
            if (!seed) {
                seed = tangentSeedFromLast(sketch, snap.point);
                if (!seed) {
                    ed.toast && ed.toast('Tangent arc needs a previous Line or Arc.', 'error');
                    return;
                }
                startId = ensurePoint(sketch, seed.end, null);
                return;
            }
            const arc = placeArc(sketch, snap.point);
            if (!arc) {
                ed.toast && ed.toast('Tangent arc: degenerate (move cursor away from tangent line).', 'error');
                return;
            }
            renderer.setPreview(null);
            ed.commitDirty();
            seed = null; startId = null;
        },

        onPointerMove({ snap, renderer, sketch }) {
            const ed = this._editor;
            if (!seed) {
                // Refresh seed every move pre-click so the user sees the
                // tangent direction follow the most-recent line/arc.
                const trial = tangentSeedFromLast(sketch, snap.point);
                if (!trial) { renderer.setPreview(null); return; }
                renderer.setPreview(renderer.previewLine(trial.end, snap.point));
                ed.setDimReadout({
                    kind: 'line', anchor: trial.end, cursor: snap.point,
                    length: Math.hypot(snap.point.x - trial.end.x, snap.point.y - trial.end.y),
                    angleDeg: Math.atan2(snap.point.y - trial.end.y, snap.point.x - trial.end.x) * 180 / Math.PI,
                });
                return;
            }
            // Once anchored we know the seed; preview a chord as a cheap
            // proxy for the arc. Renderer doesn't have an arc preview helper
            // so we use a line approximation here; the committed arc is
            // exact.
            renderer.setPreview(renderer.previewLine(seed.end, snap.point));
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                seed = null; startId = null;
                this._editor.renderer.setPreview(null);
                this._editor.setDimReadout(null);
                return true;
            }
            return false;
        },
    };
}

// ── 3-point arc tool ────────────────────────────────────────────────────────
// Click start, through, end. Commit the unique arc through the three points.

export function arc3PointTool3D() {
    let p1 = null, p1Id = null;
    let p2 = null;

    return {
        kind: 'arc-3point',
        cursor: 'crosshair',
        activate() { p1 = p1Id = p2 = null; },
        deactivate() {
            p1 = p1Id = p2 = null;
            this._editor.renderer.setPreview(null);
            this._editor.setDimReadout(null);
        },

        onPointerDown({ snap, sketch, renderer }) {
            const ed = this._editor;
            if (!p1) {
                p1Id = ensurePoint(sketch, snap.point, snap);
                p1   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            if (!p2) {
                p2 = { x: snap.point.x, y: snap.point.y };
                return;
            }
            const geom = arcThroughThreePoints(p1, p2, snap.point);
            if (!geom) {
                ed.toast && ed.toast('3-point arc: points are collinear.', 'error');
                return;
            }
            const centerEnt = addEntity(sketch, makePoint(geom.center.x, geom.center.y, { construction: true }));
            addEntity(sketch, makeArc(centerEnt.id, geom.radius, geom.startAngle, geom.sweepAngle));
            p1 = p1Id = p2 = null;
            renderer.setPreview(null);
            ed.commitDirty();
        },

        onPointerMove({ snap, renderer }) {
            const ed = this._editor;
            if (p1 && p2) {
                const geom = arcThroughThreePoints(p1, p2, snap.point);
                if (geom) {
                    ed.setDimReadout({ kind: 'circle', anchor: geom.center, cursor: snap.point, radius: geom.radius });
                }
                renderer.setPreview(renderer.previewLine(p2, snap.point));
                return;
            }
            if (p1) {
                renderer.setPreview(renderer.previewLine(p1, snap.point));
            }
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                p1 = p1Id = p2 = null;
                this._editor.renderer.setPreview(null);
                this._editor.setDimReadout(null);
                return true;
            }
            return false;
        },
    };
}

// ── Centre-and-point arc tool ──────────────────────────────────────────────
// Click 1: centre. Click 2: start point (defines radius + start angle).
// Click 3: sweep endpoint.

export function arcCenterTool3D() {
    let center = null, centerId = null;
    let startPt = null;

    return {
        kind: 'arc-center',
        cursor: 'crosshair',
        activate() { center = centerId = startPt = null; },
        deactivate() {
            center = centerId = startPt = null;
            this._editor.renderer.setPreview(null);
            this._editor.setDimReadout(null);
        },

        onPointerDown({ snap, sketch, renderer }) {
            const ed = this._editor;
            if (!center) {
                centerId = ensurePoint(sketch, snap.point, snap);
                center   = { x: snap.point.x, y: snap.point.y };
                return;
            }
            if (!startPt) {
                startPt = { x: snap.point.x, y: snap.point.y };
                return;
            }
            const radius = Math.hypot(startPt.x - center.x, startPt.y - center.y);
            if (radius < 1e-6) {
                ed.toast && ed.toast('Centre arc: start coincides with centre.', 'error');
                center = centerId = startPt = null;
                return;
            }
            const a0 = Math.atan2(startPt.y - center.y, startPt.x - center.x);
            const a1 = Math.atan2(snap.point.y - center.y, snap.point.x - center.x);
            let sweep = a1 - a0;
            // Normalise to (-π, π] then pick CCW positive; the cursor side
            // wins so the user sees what they drew.
            if (sweep > Math.PI)  sweep -= 2 * Math.PI;
            if (sweep < -Math.PI) sweep += 2 * Math.PI;
            if (Math.abs(sweep) < 1e-6) {
                ed.toast && ed.toast('Centre arc: zero sweep.', 'error');
                return;
            }
            addEntity(sketch, makeArc(centerId, radius, a0, sweep));
            center = centerId = startPt = null;
            renderer.setPreview(null);
            ed.commitDirty();
        },

        onPointerMove({ snap, renderer }) {
            const ed = this._editor;
            if (center && startPt) {
                const radius = Math.hypot(startPt.x - center.x, startPt.y - center.y);
                ed.setDimReadout({ kind: 'circle', anchor: center, cursor: snap.point, radius });
                renderer.setPreview(renderer.previewLine(center, snap.point));
                return;
            }
            if (center) {
                const r = Math.hypot(snap.point.x - center.x, snap.point.y - center.y);
                renderer.setPreview(renderer.previewCircle(center, r));
                ed.setDimReadout({ kind: 'circle', anchor: center, cursor: snap.point, radius: r });
            }
        },

        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') {
                center = centerId = startPt = null;
                this._editor.renderer.setPreview(null);
                this._editor.setDimReadout(null);
                return true;
            }
            return false;
        },
    };
}

// ── Text tool ──────────────────────────────────────────────────────────────
// Click to place an anchor → prompt for the string + height → commit TEXT.

export function textTool3D() {
    return {
        kind: 'text',
        cursor: 'text',
        activate()   {},
        deactivate() {},

        onPointerDown({ snap, sketch }) {
            const ed = this._editor;
            // window.prompt is OK as a v1 UX — the same pattern is used by
            // other "ask for a value" flows (e.g. fillet radius via openDimInput).
            // For text we just need a string + a size.
            const win = (typeof window !== 'undefined') ? window : null;
            if (!win || typeof win.prompt !== 'function') {
                ed.toast && ed.toast('Text: prompt() unavailable in this environment.', 'error');
                return;
            }
            const text = win.prompt('Text content:', 'Text');
            if (text == null || text.length === 0) return;
            const hStr = win.prompt('Text height (mm):', String(ed._lastTextHeight || 5));
            if (hStr == null) return;
            const h = parseFloat(hStr);
            if (!Number.isFinite(h) || h <= 0) {
                ed.toast && ed.toast('Text: bad height.', 'error');
                return;
            }
            ed._lastTextHeight = h;
            const anchorId = ensurePoint(sketch, snap.point, snap);
            addEntity(sketch, makeText(anchorId, text, h));
            ed.commitDirty();
        },

        onPointerMove() {},
        onPointerUp() {},

        onKeyDown(ev) {
            if (ev.key === 'Escape') return true;
            return false;
        },
    };
}

export const TOOL_FACTORIES_3D = {
    select:  selectTool3D,
    line:    lineTool3D,
    rect:    rectTool3D,
    circle:  circleTool3D,
    polygon: polygonTool3D,
    slot:    slotTool3D,
    spline:  splineTool3D,
    dim:     dimTool3D,
    fillet:  filletTool3D,
    chamfer: chamferTool3D,
    offset:  offsetTool3D,
    trim:    trimTool3D,
    extend:  extendTool3D,
    mirror:  mirrorTool3D,
    'pattern-linear':   linearPatternTool3D,
    'pattern-circular': circularPatternTool3D,
    'arc-tangent':      arcTangentTool3D,
    'arc-3point':       arc3PointTool3D,
    'arc-center':       arcCenterTool3D,
    text:               textTool3D,
};
