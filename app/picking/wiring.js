/**
 * attachPicking — glue between viewport pointer events and the face picker.
 *
 *   pointermove on the viewport canvas
 *     → bridge.pickFaceAt(camera, raycaster, ndc)
 *       → overlay.updateHover(result)
 *
 *   pointerdown (left-click without shift)
 *     → toggle the picked descriptor in `selection`
 *       (replacing the current selection if shift was NOT held;
 *        adding to it otherwise — Fusion-style)
 *
 *   pointerdown on empty space (left-click, no shift)
 *     → clears the selection
 *
 * The wiring also re-renders the selection halos whenever `selection`
 * fires (so external add/remove from a panel button reflects visually).
 * Returns a `detach()` function that unbinds everything.
 *
 * Skips wiring entirely if the active document is in the in-viewport
 * sketcher mode (we don't want body picking to swallow sketch clicks).
 */

import * as THREE from 'three';
import { getDocumentStore } from '../../lib/document/store.js';
import { componentPathFor } from '../../lib/document/types.js';

const VIEWPORT_PICK_OPTS = {
    button: 0,           // primary mouse button
    pixelTolerance: 4,   // pointer-move dead-zone before a "click" becomes a "drag"
};

// Legacy heuristic threshold — only used by the topology-center fallback
// path below. The PickProxyLayer prefers edges via fat tube geometry, so
// this constant is never consulted when proxies are live.
const EDGE_PREFERENCE_MM = 3.0;

/**
 * Resolve the descriptor under the cursor.
 *
 * Two paths, in order of preference:
 *
 *   1. **PickProxyLayer** (preferred — exact). The kernel ships per-face
 *      triangulation and per-edge polylines in `bridge.geometry`; the
 *      viewport controller builds invisible pick proxies from them. A
 *      single raycast against the proxy group returns the exact hit
 *      descriptor — no center-distance heuristic, no normal weighting,
 *      no "small adjacent face wins by 2 mm" failure mode. See
 *      `lib/picking/pick_proxies.js`.
 *
 *   2. **Topology-center heuristic** (fallback). Used only when no proxy
 *      layer is wired (early-init, tests, legacy callers). Iterates the
 *      topology face/edge centres and scores by distance + normal-misalignment.
 *      Ambiguous near small features; preserved for backwards compatibility.
 *
 * Both paths return the same payload shape: `{ descriptor, kind, featureId,
 * center, normal | tangent, worldHit, distance, score }`.
 */
function pickFaceOrEdge(bridge, camera, raycaster, ndc, pickProxies) {
    if (pickProxies && typeof pickProxies.pick === 'function') {
        const proxyHit = pickProxies.pick(camera, raycaster, ndc);
        if (proxyHit) return proxyHit;
        // Proxies exist but missed — the ray genuinely cleared the body.
        // Don't fall through to the heuristic; it would produce a phantom
        // pick on a far face the user never aimed at.
        return null;
    }
    // Fallback: legacy topology-center heuristic.
    const facePick = bridge.pickFaceAt(camera, raycaster, ndc);
    const edgePick = bridge.pickEdgeAt(camera, raycaster, ndc);
    if (edgePick && edgePick.distance <= EDGE_PREFERENCE_MM) return edgePick;
    return facePick;
}

/**
 * Same as `pickFaceOrEdge` but returns ALL hits in distance order so the
 * pick-cycle handler can step through stacked picks. Falls back to the
 * single-hit path when no proxy layer is wired — there's no stack to cycle
 * through in the heuristic mode.
 */
function pickAllFaceOrEdge(bridge, camera, raycaster, ndc, pickProxies) {
    if (pickProxies && typeof pickProxies.pickAll === 'function') {
        return pickProxies.pickAll(camera, raycaster, ndc) || [];
    }
    const single = pickFaceOrEdge(bridge, camera, raycaster, ndc, pickProxies);
    return single ? [single] : [];
}

// Pick-cycle thresholds. A repeat click within both windows is treated as
// "step through stacked picks", matching Fusion's Alt+click cycling but
// without the modifier — same screen position is the only ambiguity signal
// the user can produce naturally.
const CYCLE_PIXEL_RADIUS = 3;     // ±3 px counts as "same screen point"
const CYCLE_TIME_MS      = 500;   // re-click within 500 ms advances

/**
 * @param {object} args
 * @param {object} args.viewport     - { renderer, camera, scene, controls }
 * @param {object} args.bridge       - DocumentViewportBridge instance
 * @param {object} args.selection    - PickingSelection instance
 * @param {object} args.overlay      - PickingOverlay instance
 * @param {() => boolean} [args.isPickingActive] - return false to suppress picking (e.g. during sketch mode)
 */
export function attachPicking({ viewport, bridge, selection, overlay, isPickingActive = () => true, onHoverChange = null, pickProxies = null } = {}) {
    if (!viewport || !viewport.renderer || !viewport.camera) throw new Error('attachPicking: missing viewport');
    if (!bridge)    throw new Error('attachPicking: missing bridge');
    if (!selection) throw new Error('attachPicking: missing selection');
    if (!overlay)   throw new Error('attachPicking: missing overlay');

    const canvas    = viewport.renderer.domElement;
    const camera    = viewport.camera;
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line  = { threshold: 0.5 };
    raycaster.params.Points = { threshold: 1.0 };

    /** Last successful pick — used so click after move replays the same target. */
    let lastPick = null;
    /** Once-per-session DevTools diagnostics so silent failures show up. */
    let loggedFirstMove = false;
    let loggedFirstRaycast = false;
    let loggedFirstPick = false;

    /** Pointerdown bookkeeping — promote to click if the pointer stays still. */
    let downAt = null;

    /**
     * Pick-cycle state. When the user clicks repeatedly at the same screen
     * position the wiring steps through stacked hits instead of always
     * resolving to the closest. Resets when the pointer moves outside
     * `CYCLE_PIXEL_RADIUS` or `CYCLE_TIME_MS` elapses without a click.
     *
     *   stack:       last raycast's filtered hits (closest → farthest)
     *   index:       which one will be selected by the NEXT click
     *   screen:      anchor point — distance to here is the "same spot?" test
     *   lastClickTs: monotonic ms of the most recent committed click
     *   hoverNdc:    last cursor NDC, so Tab can re-resolve the stack on demand
     */
    let cycle = { stack: [], index: 0, screen: null, lastClickTs: 0 };
    let hoverNdc = null;

    /** Apply the active kind-filter to a list of hits. */
    const filterStack = (hits) => {
        if (!Array.isArray(hits)) return [];
        if (typeof selection.acceptsKind !== 'function') return hits;
        return hits.filter((p) => p && p.descriptor && selection.acceptsKind(p.descriptor.kind));
    };

    const cursorToNDC = (ev) => {
        const rect = canvas.getBoundingClientRect();
        return {
            x:  ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
            y: -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
        };
    };

    const onMove = (ev) => {
        if (!loggedFirstMove) {
            loggedFirstMove = true;
            console.info('[picker] first pointermove — picker is receiving events on the canvas.');
        }
        if (!isPickingActive()) {
            lastPick = null;
            overlay.updateHover(null);
            if (onHoverChange) try { onHoverChange(null); } catch {}
            return;
        }
        // Sync the overlay's transform every move so it tracks the body's
        // inner transform group (mm + Z-up) through any future repositioning.
        overlay.syncFromBodyGroup(bridge.bodyTransform);
        const ndc  = cursorToNDC(ev);
        hoverNdc = ndc;
        // If the pointer wandered outside the cycle anchor, drop the cycle —
        // the next click is "fresh" and starts at index 0 again.
        if (cycle.screen) {
            const dx = ev.clientX - cycle.screen.x;
            const dy = ev.clientY - cycle.screen.y;
            if (Math.hypot(dx, dy) > CYCLE_PIXEL_RADIUS) {
                cycle = { stack: [], index: 0, screen: { x: ev.clientX, y: ev.clientY }, lastClickTs: 0 };
            }
        } else {
            // First move — remember the cursor anchor so a Tab without prior
            // click still has a screen reference for the radius / cycle test.
            cycle.screen = { x: ev.clientX, y: ev.clientY };
        }

        // Diagnostic: separate raycast hit from topology match. If the
        // raycaster hits the body but no topology face matches, that's a
        // coordinate-frame mismatch; if it doesn't hit at all, the
        // raycaster isn't seeing the body group.
        if (!loggedFirstRaycast) {
            raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
            const hits = raycaster.intersectObject(bridge.bodyTransform || bridge.rootGroup, true);
            if (hits && hits.length) {
                loggedFirstRaycast = true;
                const p = hits[0].point;
                const n = hits[0].face?.normal;
                console.info('[picker] first raycast hit', {
                    worldPoint:  p ? `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})` : null,
                    faceNormal:  n ? `(${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)})` : null,
                    topologyOk:  !!(bridge.lastResult && bridge.lastResult.topology),
                    wrapScale:   bridge.bodyTransform && bridge.bodyTransform.scale && `(${bridge.bodyTransform.scale.x}, ${bridge.bodyTransform.scale.y}, ${bridge.bodyTransform.scale.z})`,
                    wrapRot:     bridge.bodyTransform && bridge.bodyTransform.rotation && `x=${bridge.bodyTransform.rotation.x.toFixed(3)} y=${bridge.bodyTransform.rotation.y.toFixed(3)} z=${bridge.bodyTransform.rotation.z.toFixed(3)}`,
                });
            }
        }

        let pick = pickFaceOrEdge(bridge, camera, raycaster, ndc, pickProxies);
        // Foundation 6 — stamp componentPath on the hover pick so anything
        // observing hovers (component-browser highlight, downstream
        // overlays) gets the owning subtree without a second lookup.
        if (pick && !Array.isArray(pick.componentPath)) {
            pick.componentPath = _componentPathForPick(pick);
        }
        // Honour the SelectionFilter kind gate. If the hovered descriptor's
        // kind isn't in the allowed set, treat the hover as a miss so the
        // user gets immediate visual feedback that the filter is suppressing
        // this kind (no orange tint, no pending click target).
        if (pick && pick.descriptor && typeof selection.acceptsKind === 'function'
            && !selection.acceptsKind(pick.descriptor.kind)) {
            pick = null;
        }
        // The legacy disc/bar overlay only fires for picks that don't carry
        // a descriptor — descriptor-bearing picks render through the
        // face-conforming overlay in app/picking/face_overlay.js so we don't
        // double-render. Pass null to hide the disc/bar in those cases.
        const overlayPick = pick && pick.descriptor ? null : pick;
        if (pick && !loggedFirstPick) {
            loggedFirstPick = true;
            const fmt = (v) => v ? `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})` : 'null';
            console.info('[picker] first topology match', {
                descriptor: pick.descriptor,
                kind:            pick.descriptor && pick.descriptor.kind,
                topology_center: fmt(pick.center),
                worldHit:        fmt(pick.worldHit),
                distance_mm:     pick.distance && pick.distance.toFixed(2),
            });
        }
        lastPick = pick;
        overlay.updateHover(overlayPick);
        if (onHoverChange) try { onHoverChange(pick); } catch {}
    };

    const onDown = (ev) => {
        if (!isPickingActive()) return;
        if (ev.button !== VIEWPORT_PICK_OPTS.button) return;
        downAt = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey };
    };

    const onUp = (ev) => {
        if (!isPickingActive()) return;
        if (ev.button !== VIEWPORT_PICK_OPTS.button) return;
        if (!downAt) return;
        const dx = ev.clientX - downAt.x;
        const dy = ev.clientY - downAt.y;
        const moved = Math.hypot(dx, dy) > VIEWPORT_PICK_OPTS.pixelTolerance;
        const shift = downAt.shift;
        downAt = null;
        if (moved) return;   // it was a drag (orbit/pan), not a click

        // Resolve at the current cursor — a click after a hover should select
        // exactly what's highlighted. Re-pick rather than trusting `lastPick`
        // in case the camera moved between move and up.
        overlay.syncFromBodyGroup(bridge.bodyTransform);
        const ndc  = cursorToNDC(ev);

        // Pick-cycle logic. If this click is a repeat of the previous one
        // (same spot, within the time window) and we have a multi-hit stack,
        // advance the index. Otherwise rebuild the stack from the current
        // raycast and start at index 0.
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const sameSpot = cycle.screen
            && Math.hypot(ev.clientX - cycle.screen.x, ev.clientY - cycle.screen.y) <= CYCLE_PIXEL_RADIUS
            && (now - cycle.lastClickTs) <= CYCLE_TIME_MS;

        let pick = null;
        if (sameSpot && cycle.stack.length > 1) {
            cycle.index = (cycle.index + 1) % cycle.stack.length;
            pick = cycle.stack[cycle.index];
        } else {
            const all = filterStack(pickAllFaceOrEdge(bridge, camera, raycaster, ndc, pickProxies));
            cycle = {
                stack: all,
                index: 0,
                screen: { x: ev.clientX, y: ev.clientY },
                lastClickTs: now,
            };
            pick = all.length ? all[0] : null;
        }
        cycle.lastClickTs = now;

        if (pick && !Array.isArray(pick.componentPath)) {
            pick.componentPath = _componentPathForPick(pick);
        }
        if (!pick || !pick.descriptor) {
            if (!shift) selection.clear();
            return;
        }
        // Edges expose `tangent`, faces expose `normal`. Both go in payload
        // so the overlay can render either with whatever orientation hint
        // the entry provides. `componentPath` rides along so refs.js can
        // surface it without a second store lookup.
        const payload = {
            center:        pick.center,
            normal:        pick.normal  || null,
            tangent:       pick.tangent || null,
            worldHit:      pick.worldHit || null,
            featureId:     pick.featureId,
            componentPath: pick.componentPath || _componentPathForPick(pick),
        };
        if (shift) {
            selection.toggle(pick.descriptor, payload);
        } else {
            // Replace: clear then add. (Two events to subscribers — fine.)
            selection.clear();
            selection.add(pick.descriptor, payload);
        }
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup',   onUp);

    // Mirror the selection set into halos whenever it changes. Only entries
    // WITHOUT a descriptor draw via the disc/bar overlay; descriptor-bearing
    // entries flow through the face-conforming overlay in the orchestrator.
    const repaint = () => overlay.updateSelection(
        selection.toArray().filter(e => !(e && e.descriptor)),
    );
    repaint();
    const unsubSel = selection.subscribe(repaint);

    // Whenever the bridge produces a new topology, the body group's
    // transform may have been refreshed. Keep the overlay's anchor in sync
    // and clear the hover (it's stale until the next pointer-move).
    const unsubRender = bridge.onRender(() => {
        overlay.syncFromBodyGroup(bridge.bodyTransform);
        overlay.updateHover(null);
    });

    // Tab while hovering: preview the next stacked pick without committing
    // to the selection. Builds the stack on first Tab so the user doesn't
    // have to click first; advances the hover-highlight on each subsequent
    // Tab. Released or pointer-move outside the cycle radius resets things.
    const onKey = (ev) => {
        if (ev.key !== 'Tab') return;
        if (!isPickingActive()) return;
        // Only swallow Tab when the canvas is the source of the hover.
        // Without this we'd break Tab-to-focus across the whole app.
        if (!hoverNdc) return;
        ev.preventDefault();

        if (cycle.stack.length === 0) {
            const all = filterStack(pickAllFaceOrEdge(bridge, camera, raycaster, hoverNdc, pickProxies));
            if (all.length === 0) return;
            cycle = {
                stack: all,
                index: 0,
                // Anchor at canvas-relative coords matching the cursor — use
                // a synthesised clientXY from the last move so the radius
                // test still works for the follow-up click.
                screen: cycle.screen || { x: 0, y: 0 },
                lastClickTs: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            };
        } else if (cycle.stack.length > 1) {
            cycle.index = (cycle.index + 1) % cycle.stack.length;
        }
        const preview = cycle.stack[cycle.index];
        if (!preview) return;
        // Show preview through the disc/bar overlay for non-descriptor picks;
        // descriptor picks rely on the orchestrator's face-conforming overlay
        // which subscribes to onHoverChange.
        const overlayPick = preview.descriptor ? null : preview;
        overlay.updateHover(overlayPick);
        if (onHoverChange) try { onHoverChange(preview); } catch {}
    };
    window.addEventListener('keydown', onKey);

    return function detach() {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup',   onUp);
        window.removeEventListener('keydown',    onKey);
        unsubSel();
        if (typeof unsubRender === 'function') unsubRender();
    };
}

/**
 * Foundation 6 — resolve `componentPath` for a pick payload by looking the
 * descriptor's owning feature up in the live document. Honours any path
 * already on the pick (the proxy layer stamps one at build time). Falls
 * back to `['root']` when the store / doc / feature is unavailable, so
 * every payload downstream sees a stable, non-null path.
 */
function _componentPathForPick(pick) {
    if (!pick) return ['root'];
    if (Array.isArray(pick.componentPath) && pick.componentPath.length > 0) {
        return pick.componentPath.slice();
    }
    const featureId = pick.featureId || (pick.descriptor && pick.descriptor.feature) || null;
    if (!featureId) return ['root'];
    let store;
    try { store = getDocumentStore(); } catch { return ['root']; }
    const doc = store && store.doc;
    if (!doc || !doc.features) return ['root'];
    const feat = doc.features[featureId];
    const componentId = (feat && feat.componentId) || 'root';
    return componentPathFor(doc, componentId);
}
