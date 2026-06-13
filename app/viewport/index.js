/**
 * Viewport orchestrator — turns a `{ scene, camera, renderer, controls }`
 * object built by `createRenderer()` into a CAD-grade viewport with:
 *
 *   - CADCameraControls (SW defaults + ray-hit pivot + cursor-glued pan)
 *   - ViewCube widget anchored top-right
 *   - Standard view hotkeys (Ctrl+1..7, Ctrl+8, F = smart fit, V = hide)
 *   - Window/Crossing rubber-band selection
 *   - Tweened transitions through view_animator
 *
 * Usage from main.js:
 *
 *   const upgraded = upgradeViewport(viewport, {
 *     pickablesProvider: () => bridge.bodyTransform ? [bridge.bodyTransform] : [],
 *     selection,                   // PickingSelection from lib/picking
 *     bodyAabbProvider: () => aabbOf([bridge.bodyTransform]),
 *     preset: 'solidworks',
 *     onHide: (objs) => { ... },
 *     onIsolate: (objs) => { ... },
 *   });
 *
 *   // viewport.controls is now the CADCameraControls instance — same API
 *   // as OrbitControls so the rest of main.js + the sketcher Just Work.
 */

import * as THREE from 'three';
import { CADCameraControls, makeScenePickProvider } from '../../lib/viewport/camera_controls.js';
import { ViewCube } from './view_cube.js';
import { RubberBand } from './rubber_band.js';
import {
    standardView, frameBox, fitToSelection, aabbOf, normalToFace,
    STANDARD_DURATION_MS, tweenTo, cancelActiveTween,
} from '../../lib/viewport/view_animator.js';
import { TransformGizmo } from './transform_gizmo.js';
import { ConnectorOverlay } from './connector_overlay.js';
import { SnapDragController } from './snap_drag.js';
import { DEFAULT_PRESET } from '../../lib/viewport/presets.js';
import { ActionRegistry } from '../../lib/viewport/actions.js';
import { buildDefaultActions, defaultMarkingMenu } from '../../lib/viewport/default_actions.js';
import { CommandSearch } from './command_search.js';
import { MarkingMenu } from './marking_menu.js';
import { CommandRuntime } from './command_runtime.js';
import { BodyHighlightLayer, selectionToObjects } from '../picking/body_highlight.js';
import { FaceHighlightOverlay } from '../picking/face_overlay.js';
import { PickProxyLayer } from '../../lib/picking/pick_proxies.js';
import { stringify as descriptorKey } from '../../lib/document/descriptor.js';

/**
 * Replace the viewport's OrbitControls with a CADCameraControls instance,
 * attach a ViewCube + rubber-band + key hotkeys, and return a controller
 * the host can use to drive views programmatically.
 *
 * The function mutates `viewport.controls` in place so existing references
 * (the sketcher saves `controls.enableRotate` etc.) keep working.
 */
export function upgradeViewport(viewport, opts = {}) {
    if (!viewport || !viewport.scene || !viewport.camera || !viewport.renderer) {
        throw new Error('upgradeViewport: missing viewport fields');
    }
    const {
        pickablesProvider = () => [],
        bodyAabbProvider  = null,
        selection         = null,
        preset            = DEFAULT_PRESET,
        onHide            = null,
        onIsolate         = null,
        onShowAll         = null,
        onRequestRender   = null,
    } = opts;

    const { scene, camera, renderer } = viewport;
    const canvas = renderer.domElement;
    const container = canvas.parentElement;
    if (container) container.style.position = container.style.position || 'relative';

    // Dispose the old OrbitControls if one is hanging around.
    if (viewport.controls && typeof viewport.controls.dispose === 'function'
        && !(viewport.controls instanceof CADCameraControls)) {
        try { viewport.controls.dispose(); } catch {}
    }

    // ── 1. Camera controls ─────────────────────────────────────────────────
    // Wire BOTH the ray-cast pick provider AND the body-AABB fallback into
    // the controls so the orbit-pivot resolver (and pan-depth resolver) get
    // the full SolidWorks fallback chain: cursor-hit → body-AABB centre →
    // current target. Without bodyAabbProvider, orbiting in empty space
    // would fall straight to the current target (which can drift far off the
    // part after a few orbits).
    const pickProvider = makeScenePickProvider(camera, pickablesProvider);
    const aabbFallback = (typeof bodyAabbProvider === 'function')
        ? bodyAabbProvider
        : (() => aabbOf(pickablesProvider() || []));
    const controls = new CADCameraControls(camera, canvas, {
        preset,
        pickProvider,
        bodyAabbProvider: aabbFallback,
        // World Z-up matches the v4 kernel + the sketcher's plane math.
        worldUp: [0, 0, 1],
        // Horizon lock by default — Shift-drag temporarily lifts it for
        // free/trackball orbit.
        horizonLock: true,
    });
    // Preserve any previous target.
    if (viewport.controls && viewport.controls.target) {
        controls.target.copy(viewport.controls.target);
    }
    controls.saveState();
    viewport.controls = controls;

    // Notify the host so it can re-render on demand (some hosts already
    // animate every frame; for those, this is a no-op).
    const requestRender = () => { try { onRequestRender && onRequestRender(); } catch {} };
    controls.addEventListener('change', requestRender);

    // If a ViewCube / named-view tween is mid-flight and the user grabs the
    // camera, kill the tween — otherwise both write camera.position every
    // rAF and the result is visible jitter / a snap-back at tween end.
    const cancelTweenOnUserInput = () => { cancelActiveTween(camera); };
    controls.addEventListener('start', cancelTweenOnUserInput);
    // Wheel zoom is also a "user is driving" signal.
    canvas.addEventListener('wheel', cancelTweenOnUserInput, { passive: true });

    // ── 2. ViewCube ────────────────────────────────────────────────────────
    const cube = new ViewCube({
        renderer,
        mainCamera: camera,
        onCommand: (name) => handleViewCommand(name),
        // Drag-to-orbit / double-tap free-look — the cube steers the camera.
        onOrbit: (dx, dy) => { try { controls.orbitBy(dx, dy); } catch {} },
    });
    if (container) cube.mount(container);

    // ── 3a. Body-level highlight layer (used for body / multi-pick selects) ──
    const highlight = new BodyHighlightLayer();

    // ── 3a-bis. Face-conforming highlight overlay (Fusion-style) ──────────
    // Renders the picked face's actual triangulation (or edge polyline) as a
    // tinted overlay using per-element geometry shipped by the kernel.
    const faceOverlay = new FaceHighlightOverlay({
        scene,
        bodyGroup: opts.bridge && opts.bridge.bodyTransform,
        // Renderer powers the Line2 edge highlight's pixel-thickness shader.
        renderer,
    });
    // ── 3a-ter. Exact-geometry pick proxies ───────────────────────────────
    // Invisible per-face / per-edge meshes built from the same kernel
    // geometry the overlay tints. Raycast against THESE for picking — no
    // center-distance heuristic, no "small adjacent face wins by 2 mm"
    // failure mode. See lib/picking/pick_proxies.js.
    const pickProxies = new PickProxyLayer({ scene });
    // Push the latest face/edge geometry into both layers on every regen.
    if (opts.bridge && typeof opts.bridge.onRender === 'function') {
        opts.bridge.onRender(() => {
            faceOverlay.setBodyGroup(opts.bridge.bodyTransform);
            faceOverlay.setGeometry(opts.bridge.geometry);
            pickProxies.setGeometry(opts.bridge.geometry);
        });
    }

    /** Show a face-conforming hover overlay for a single pick.
     *  Pass null to clear. Accepts the picker's pick payload — picks with a
     *  descriptor render the face/edge tint, picks without one fall back to
     *  the whole-body tint (useful for legacy non-v4 paths). */
    function setHoverFromPick(pick) {
        if (!pick || !pick.descriptor) {
            faceOverlay.clearHover();
            // Body-level fallback for picks that have a featureId but no
            // descriptor — keeps the soft tint working until the kernel
            // emits descriptors for every pick.
            setHoverByFeatureId(pick && pick.featureId);
            return;
        }
        const key = descriptorKey(pick.descriptor);
        const kind = pick.descriptor.kind === 'edge' ? 'edge' : 'face';
        // Clear the body-tint hover so we don't double-tint the same area.
        highlight.clearHover();
        faceOverlay.showHover(key, kind);
    }

    /** Look up the body wrap whose tagged featureId matches and tint it.
     *  Pass null to clear hover. Fallback used when no descriptor is
     *  available — the face overlay is preferred when one is. */
    function setHoverByFeatureId(featureId) {
        if (!featureId) { highlight.clearHover(); return; }
        const root = opts.bridge && opts.bridge.bodyTransform;
        if (!root) { highlight.clearHover(); return; }
        const targets = [];
        if (root.userData && root.userData.featureId === featureId) targets.push(root);
        root.traverse?.((node) => {
            if (node.isMesh && node.userData.featureId === featureId) {
                const wrap = node.parent && node.parent.name === '__v4_glb_wrap__'
                    ? node.parent
                    : root;
                if (!targets.includes(wrap)) targets.push(wrap);
            }
        });
        highlight.setHovered(targets);
    }

    // Selection store → face / edge / body tint. Recomputed on every selection
    // event, and re-applied after every bridge re-render (the bridge swaps
    // the body group on each kernel run, so cached material refs are stale).
    let _unsubHighlight    = null;
    let _unsubBridgeRender = null;
    if (selection) {
        const refresh = () => {
            const root = opts.bridge && opts.bridge.bodyTransform;
            if (!root) {
                highlight.clearSelection();
                faceOverlay.clearSelected();
                return;
            }
            // Split picks: face/edge descriptors render the conforming overlay;
            // body-kind descriptors (and legacy entries with no descriptor)
            // still pick up the whole-body tint.
            const overlayEntries = [];
            const bodyDescs      = [];
            for (const entry of selection.toArray()) {
                const d = entry && entry.descriptor;
                if (!d) continue;
                if (d.kind === 'face' || d.kind === 'edge') {
                    overlayEntries.push({ key: descriptorKey(d), kind: d.kind });
                } else {
                    bodyDescs.push(d);
                }
            }
            faceOverlay.setSelected(overlayEntries);
            highlight.setSelected(selectionToObjects(
                { descriptors: () => bodyDescs }, root,
            ));
        };
        refresh();
        _unsubHighlight = selection.subscribe(refresh);
        if (opts.bridge && typeof opts.bridge.onRender === 'function') {
            _unsubBridgeRender = opts.bridge.onRender(() => {
                highlight.clearHover();
                refresh();
            });
        }
    }

    // ── 3b. Rubber-band selection ─────────────────────────────────────────
    const rubber = new RubberBand({
        container: container || canvas.parentElement,
        canvas,
        camera,
        pickablesProvider,
        onCandidateChange: (objs /*, mode */) => {
            // Mid-drag — paint orange "would-be-selected" preview.
            highlight.setHovered(objs);
        },
        onCommit: (objs, mode, additive) => {
            if (!selection) return;
            if (!additive) selection.clear();
            // Map Object3D → descriptor when possible. The bridge tags every
            // mesh with userData.descriptor + userData.featureId at render.
            for (const o of objs) {
                const desc = o.userData && o.userData.descriptor;
                if (desc) selection.add(desc, o.userData.payload || null);
            }
            // The selection subscribe callback above will paint blue.
        },
        // Only run rubber-band when no nav drag is active. The controls
        // claim modifier-combinations they care about; LMB with no mod
        // is free for selection.
        isEnabled: () => controls.enabled,
    });

    // ── 4. Standard view + hotkey driver ───────────────────────────────────
    function home() {
        controls.reset();
        requestRender();
    }
    function goView(name) {
        standardView(camera, controls, name);
    }
    function smartFit() {
        // F: fit to selection if any, else fit to all bodies.
        // For a selection fit we resolve each selected descriptor back to its
        // owning Object3D under the bridge wrap so the AABB tracks the real
        // mesh extents (not the whole-body AABB).
        if (selection && selection.size > 0) {
            const handle = fitToSelection(selection, camera, controls, {
                fillFactor: 0.7,
                durationMs: 550,
                resolveObjects: (sel) => {
                    const root = opts.bridge && opts.bridge.bodyTransform;
                    if (!root) return [];
                    return selectionToObjects(sel, root);
                },
            });
            if (handle) return handle;
            // Fall through to fit-all when the selection has nothing
            // resolvable (e.g. only face descriptors with no payload.object).
        }
        const box = bodyAabbProvider ? bodyAabbProvider() : aabbOf(pickablesProvider());
        // Elegant fit: distance ≈ 2× the geometric "edge-to-edge" fit so
        // the body sits centred with generous breathing room. `dist` in
        // `frameBox` is inversely proportional to `fillFactor`, so halving
        // the fill (0.55 → 0.28) doubles the camera distance.
        frameBox(camera, controls, box, { fillFactor: 0.28, durationMs: 550 });
    }
    function normalTo() {
        if (!selection || selection.size === 0) return;
        const entry = selection.toArray()[0];
        const p = entry && entry.payload;
        if (!p || !p.normal || !p.center) return;
        normalToFace(camera, controls, p.center, p.normal);
    }

    function handleViewCommand(name) {
        if (name === 'home')       return home();
        if (name === 'front')      return goView('front');
        if (name === 'back')       return goView('back');
        if (name === 'left')       return goView('left');
        if (name === 'right')      return goView('right');
        if (name === 'top')        return goView('top');
        if (name === 'bottom')     return goView('bottom');
        if (name === 'iso')        return goView('iso');
        if (name.startsWith('edge:') || name.startsWith('corner:')) {
            return goCubeDirection(name);
        }
    }

    // Tween to an arbitrary direction (used by edge + corner cells of the cube).
    function goCubeDirection(commandName) {
        const dir = cube.directionFor(commandName);
        if (!dir) return;
        const target = controls.target.clone();
        const curDist = camera.position.distanceTo(target) || 200;
        const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
        const pos = target.clone().add(d.multiplyScalar(curDist));
        const up = (Math.abs(d.z) > 0.95) ? [0, 1, 0] : [0, 0, 1];
        tweenTo({
            camera, controls,
            toPosition: pos.toArray(),
            toTarget:   target.toArray(),
            toUp:       up,
            durationMs: STANDARD_DURATION_MS,
        });
    }

    // Keyboard
    const onKey = (e) => {
        // Skip when the user is typing into an input.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const k = e.key.toLowerCase();
        if (e.ctrlKey && !e.shiftKey && !e.altKey) {
            switch (e.key) {
                case '1': e.preventDefault(); return goView('front');
                case '2': e.preventDefault(); return goView('back');
                case '3': e.preventDefault(); return goView('left');
                case '4': e.preventDefault(); return goView('right');
                case '5': e.preventDefault(); return goView('top');
                case '6': e.preventDefault(); return goView('bottom');
                case '7': e.preventDefault(); return goView('iso');
                case '8': e.preventDefault(); return normalTo();
            }
        }
        if (!e.ctrlKey && !e.shiftKey && !e.altKey) {
            if (k === 'f') { e.preventDefault(); return smartFit(); }
            if (k === 'h') {
                if (onIsolate && selection && selection.size > 0) {
                    e.preventDefault();
                    return onIsolate(selection.toArray());
                }
            }
            if (k === 'v') {
                if (onHide && selection && selection.size > 0) {
                    e.preventDefault();
                    return onHide(selection.toArray());
                }
            }
        }
        if (e.shiftKey && k === 'h' && onShowAll) {
            e.preventDefault();
            return onShowAll();
        }
    };
    window.addEventListener('keydown', onKey);

    // ── 5. Render hook so the cube draws over the main pass ────────────────
    // We piggy-back on the renderer's render() so callers don't have to
    // change their animation loops.
    const origRender = renderer.render.bind(renderer);
    let inside = false;
    renderer.render = function patchedRender(s, c) {
        const out = origRender(s, c);
        // Only draw the cube when the main scene was rendered (not when
        // some overlay renders to a different camera; recursion guard).
        if (!inside && s === scene) {
            inside = true;
            try { cube.render(); } catch (err) { /* don't break the host loop */ console.warn('[ViewCube] render error:', err); }
            // Keep connector attach-nodes a constant on-screen size.
            if (connectorOverlay && connectorOverlay.isVisible()) {
                try {
                    const h = renderer.domElement.clientHeight || renderer.domElement.height || 600;
                    connectorOverlay.updateScreenSpaceSize(h);
                } catch {}
            }
            inside = false;
        }
        return out;
    };

    // ── 6. Action registry + Command Search + Marking Menu ────────────────
    const registry = opts.registry || new ActionRegistry();
    registry.registerAll(buildDefaultActions());

    // ViewportController exposed to actions via the ctx the host builds.
    const viewportCtl = {
        home, goView, smartFit, normalTo, controls,
        hide:    (entries) => { if (opts.onHide)    opts.onHide(entries); },
        showAll: ()        => { if (opts.onShowAll) opts.onShowAll(); },
    };

    // ── Command runtime — opens the CommandDialog + drives yellow preview.
    // The host MUST pass bridge + store + kernelClient via getActionContext
    // for the runtime to be useful; otherwise commands fall back to
    // immediate-run defaults.
    let commandRuntime = null;
    if (opts.bridge && opts.store && opts.kernelClient) {
        commandRuntime = new CommandRuntime({
            scene,
            bridge:       opts.bridge,
            store:        opts.store,
            kernelClient: opts.kernelClient,
            selection,
            toast:        opts.toast || null,
        });
    }

    const getActionContext = () => {
        const base = {
            selection,
            viewportCtl,
            openCommand: commandRuntime ? (spec) => commandRuntime.openCommand(spec) : null,
        };
        if (typeof opts.getActionContext === 'function') {
            const extra = opts.getActionContext() || {};
            return { ...base, ...extra };
        }
        return base;
    };

    const palette = new CommandSearch({
        registry,
        getContext: getActionContext,
        triggerKey: opts.commandSearchKey || 's',
        fallbackTriggerKey: '/',
        toast: opts.toast || null,
    });

    const marking = new MarkingMenu({
        canvas,
        registry,
        getContext: getActionContext,
        getActions: opts.getMarkingMenuActions || defaultMarkingMenu,
        toast: opts.toast || null,
    });

    // ── Transform gizmo (W/E/R translate/rotate/scale, Q toggle) ──────────
    // Lives at scene identity. Reads the current selection; attaches to the
    // owning body wrap when a body is selected, detaches otherwise. The
    // drag temporarily disables `controls.enabled` so camera moves don't
    // fight the manipulator.
    const transformGizmo = new TransformGizmo({
        camera,
        renderer,
        scene,
        cameraControls: controls,
        selection,
        bodyRoot: () => (opts.bridge && opts.bridge.bodyTransform) || null,
        onChange: requestRender,
        initialMode: 'translate',
        installHotkeys: true,
    });

    // ── Snap-drag stack (Spec 18 v2 — assembly snap on translate drag) ────
    // The overlay renders glyphs for every Connector record on the doc and
    // exposes invisible pick spheres; SnapDragController hooks the gizmo's
    // drag events, raycasts against those spheres, and clamps the dragged
    // body onto a compatible host connector via the mate solver. Both pieces
    // are no-ops until a translate drag begins, so the rest of the viewport
    // pays nothing for them.
    let connectorOverlay = null;
    let snapDrag = null;
    let _unsubConnectorRebuild = null;
    if (opts.store) {
        connectorOverlay = new ConnectorOverlay({
            scene,
            camera,
            docProvider: () => opts.store.doc,
        });
        // Rebuild whenever the doc changes (new placement, gizmo commit, …).
        // Skip selection-only events — they don't move any connector but the
        // rebuild reallocates every node in the scene. Hidden overlays mark
        // themselves dirty so `setVisible(true)` catches up.
        _unsubConnectorRebuild = opts.store.subscribe((_doc, eventLabel) => {
            if (eventLabel === 'select' || eventLabel === 'refs') return;
            if (!connectorOverlay.isVisible()) {
                connectorOverlay.markDirty?.();
                return;
            }
            connectorOverlay.rebuild();
        });
        snapDrag = new SnapDragController({
            transformGizmo,
            connectorOverlay,
            camera,
            renderer,
            docProvider: () => opts.store.doc,
            commitMove: (componentId, originPatch) => {
                if (!opts.commitComponentMove) return;
                try { opts.commitComponentMove(componentId, originPatch); }
                catch (err) { console.warn('[snap_drag] commitMove failed:', err); }
            },
            onChange: requestRender,
        });
    }

    // ── Returned controller ────────────────────────────────────────────────
    return {
        controls,
        cube,
        rubber,
        registry,
        palette,
        marking,
        commandRuntime,
        highlight,
        faceOverlay,
        pickProxies,
        transformGizmo,
        connectorOverlay,
        snapDrag,
        setHoverByFeatureId,
        setHoverFromPick,
        home,
        goView,
        smartFit,
        normalTo,
        openCommandSearch: () => palette.open(),
        dispose() {
            window.removeEventListener('keydown', onKey);
            canvas.removeEventListener('wheel', cancelTweenOnUserInput);
            cancelActiveTween(camera);
            renderer.render = origRender;
            palette.dispose();
            marking.dispose();
            if (commandRuntime) commandRuntime.dispose();
            rubber.dispose();
            cube.dispose();
            controls.dispose();
            if (_unsubHighlight)    _unsubHighlight();
            if (_unsubBridgeRender) _unsubBridgeRender();
            highlight.dispose();
            faceOverlay.dispose();
            pickProxies.dispose();
            transformGizmo.dispose();
            if (_unsubConnectorRebuild) { try { _unsubConnectorRebuild(); } catch {} }
            if (snapDrag)          { try { snapDrag.dispose(); }          catch {} }
            if (connectorOverlay)  { try { connectorOverlay.dispose(); }  catch {} }
        },
    };
}

export { CADCameraControls } from '../../lib/viewport/camera_controls.js';
export { ViewCube } from './view_cube.js';
export { RubberBand } from './rubber_band.js';
export { standardView, frameBox, fitToSelection, aabbOf, normalToFace, cancelActiveTween } from '../../lib/viewport/view_animator.js';
export { TransformGizmo } from './transform_gizmo.js';
export { ActionRegistry, fuzzyMatch, scoreAction } from '../../lib/viewport/actions.js';
export { buildDefaultActions, defaultMarkingMenu } from '../../lib/viewport/default_actions.js';
export { CommandSearch } from './command_search.js';
export { MarkingMenu, sectorFor } from './marking_menu.js';
