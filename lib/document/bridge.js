/**
 * DocumentViewportBridge — wires the v4 system to a live Three.js viewport.
 *
 * Subscribes to the singleton DocumentStore (debounced), runs the
 * DocumentExecutor against the configured kernel client, and renders the
 * returned GLB into a dedicated `THREE.Group` (`__v4_root__`) attached to
 * the host scene.
 *
 * The bridge is the *only* file in lib/document that knows about Three.js.
 * Keeping the dependency at the edges keeps the rest of the document model
 * unit-testable without a renderer.
 *
 *   Document edit → DocumentStore.commit
 *     → bridge debounce
 *       → DocumentExecutor.executeDocument
 *         → HttpKernelClient.executeCode → /execute → GLB
 *           → GLTFLoader.parse
 *             → mesh into `__v4_root__`
 */

import * as THREE from 'three';
// Explicit .js extension so this module loads under both Vite (bundler
// resolution) and raw Node (strict ESM resolution used by the test runner).
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getDocumentStore } from './store.js';
import { getDocumentExecutor } from './executor.js';
import { HttpKernelClient } from './kernel_client.js';
import { pickFaceFromCursor, pickEdgeFromCursor } from '../picking/face_picker.js';
import { bodyRef } from './types.js';
import { buildIndex } from './resolver.js';

const ROOT_NAME = '__v4_root__';

export class DocumentViewportBridge {
    /**
     * @param {object} [opts]
     * @param {THREE.Scene} [opts.scene]      — viewport scene to attach the root group to
     * @param {DocumentStore} [opts.store]    — defaults to the module singleton
     * @param {DocumentExecutor} [opts.executor]
     * @param {object} [opts.kernelClient]    — implements executeCode(code)
     * @param {number} [opts.debounceMs]      — coalesce rapid edits before kernel call
     */
    constructor({ scene = null, store = null, executor = null, kernelClient = null, debounceMs = 150 } = {}) {
        this.store        = store    || getDocumentStore();
        this.executor     = executor || getDocumentExecutor();
        this.kernelClient = kernelClient || new HttpKernelClient();
        this.executor.setClient(this.kernelClient);
        // Wire the executor's topology-index provider so emit.js can resolve
        // queries against the bridge's most recent TopologyIndex on every run.
        if (typeof this.executor.setTopologyIndexProvider === 'function') {
            this.executor.setTopologyIndexProvider(() => this.topologyIndex);
        }
        this.debounceMs   = debounceMs;

        this._loader = new GLTFLoader();
        this._root   = new THREE.Group();
        this._root.name = ROOT_NAME;

        // The "body transform" is the inner wrapper group that carries the
        // mm-as-meters scale + Y-up→Z-up rotation. Picking + overlays use
        // this for `worldToLocal` math so the rendered mesh and the kernel
        // topology share the same frame. Updated on every successful render.
        this._bodyTransform = null;

        // Foundation 6 — per-component subgroups nested under `_bodyTransform`.
        // Keyed by componentId. Re-built on every render (the wrap is fresh
        // each time). v0 docs only ever populate the `'root'` entry.
        /** @type {Map<string, THREE.Group>} */
        this._componentGroups = new Map();

        this._debounceTimer  = null;
        this._unsubStore     = null;
        this._unsubExecutor  = null;
        this._lastResult     = null;
        this._renderHooks    = new Set();
        this._errorHooks     = new Set();
        // Leading-edge run scheduling — see `scheduleRun` / `_runGuarded`.
        this._running          = false;
        this._dirtyDuringRun   = false;

        // Edge-overlay pass runs one rAF after the GLB parse. Bumping this
        // counter on every parse invalidates the pending batch so a fast
        // follow-up regen doesn't decorate disposed meshes.
        this._edgeOverlayGeneration = 0;

        // Diagnostics — wall times (ms) of the most recent kernel round-trip
        // and GLB→scene application. Read by PropertiesPanel / ViewportHud
        // from inside onRender callbacks. Plain numbers; not reactive — the
        // consumers re-read on each render event. `null` until first measured.
        this.lastCompileMs = null;
        this.lastRenderMs  = null;

        // Foundation 2 — kernel version block (build123d / OCCT versions,
        // wire format, naming contract, build hash, any mismatches) copied
        // from the kernel client after each successful response so consumers
        // can read it off the bridge directly. `null` until first response.
        this.lastKernelVersion = null;

        // Foundation 3/4 — TopologyIndex built from the most recent
        // successful render's `result.topology`. emit.js uses this to
        // client-side-resolve Query inputs before shipping Python to the
        // kernel. `null` until the first successful render, so feature inputs
        // that depend solely on queries fall back to their fingerprint (or
        // emit a `# Query unresolvable` comment) on the first emit.
        this.topologyIndex = null;

        this.setScene(scene);
        this._attachListeners();

        // If the document was already loaded (e.g. restoreDocument() called
        // store.fromJSON before this bridge subscribed) we need to kick off
        // an initial render — otherwise no commit ever fires and the
        // viewport stays empty until the user manually adds/edits/deletes
        // something. fromJSON DOES emit a 'load' notify, but that fires
        // before the bridge constructor runs in the typical boot sequence:
        //   main.js: restoreDocument() → store.fromJSON → _notify('load')   ← no subscribers yet
        //   App.svelte mounts
        //   Viewport.svelte onMount → bootDocument → new bridge → _attachListeners
        // So we self-trigger here: if the doc already has features, schedule
        // a run. Cheap; the debounce coalesces with any near-immediate edits.
        if (this.store && this.store.doc) {
            const featureCount = Object.keys(this.store.doc.features || {}).length;
            console.log('[bridge] constructed', { featureCount, kickInitialRender: featureCount > 0 });
            if (featureCount > 0) this.scheduleRun();
        }
    }

    /** Public root group — useful for tests that don't have a real Scene. */
    get rootGroup() { return this._root; }

    /**
     * The transform-bearing inner group that maps build123d-local coords to
     * world. Picking + overlay code compares against this; the root group
     * itself is at identity. Falls back to `_root` before the first render.
     */
    get bodyTransform() { return this._bodyTransform || this._root; }

    /**
     * Return the per-component THREE.Group nested under `bodyTransform` for
     * the given component id, creating it on demand. The subgroup carries
     * the component's `origin` transform (position / rotation / scale)
     * pulled from `doc.components[componentId]`; if the component is
     * unknown, the subgroup gets identity transform and is tagged with the
     * requested id so callers still get a stable parent. Always returns a
     * THREE.Group — never `null`.
     *
     * The grouping is the wiring required for Foundation 6: in v0 every
     * feature is in `'root'`, so `bodyTransform.children` collapses to a
     * single subgroup containing every mesh. Future multi-component docs
     * (sub-assemblies, inserts) will mount their meshes under their own
     * subgroup without further bridge changes.
     */
    componentSubgroup(componentId) {
        const id = componentId || 'root';
        const parent = this._bodyTransform || this._root;
        const cached = this._componentGroups.get(id);
        if (cached && cached.parent === parent) return cached;
        // (Re-)create the subgroup under the current bodyTransform. Cached
        // entries from a previous render are stale (their `parent` was the
        // old wrap) — drop them.
        const grp = new THREE.Group();
        grp.name = `__v4_component_${id}__`;
        grp.userData.componentId = id;
        this._applyComponentOrigin(grp, id);
        parent.add(grp);
        this._componentGroups.set(id, grp);
        return grp;
    }

    /**
     * Component-placement contract (Phase 3):
     *
     *   Component placement is **baked into the kernel geometry** as of Phase 3.
     *   `lib/document/emit.js` composes each leaf feature's world transform from
     *   its component chain (root → … → owner) and emits
     *   `body.moved(Location(...))` so the GLB the kernel returns already has
     *   every component sitting in its placed pose. The bridge therefore renders
     *   the GLB at **identity component transforms** — the per-component
     *   subgroups exist purely as a scene-graph grouping (for selection /
     *   isolation / interference grouping), NOT as a transform layer.
     *
     *   Applying the component origin here as well would double-transform the
     *   mesh (kernel pose × scene-graph pose). It would also be wrong-framed: the
     *   subgroup lives under `_bodyTransform` (the GLB wrap with its 1000× mm→m
     *   scale and +π/2 Y-up→Z-up rotation), so a Z-up mm origin applied here
     *   would be scaled 1000× and rotated into the wrong axis. Keep the subgroup
     *   at identity.
     */
    _applyComponentOrigin(grp, _id) {
        // Identity: kernel owns placement (see contract above).
        grp.position.set(0, 0, 0);
        grp.rotation.set(0, 0, 0);
        grp.scale.set(1, 1, 1);
        grp.updateMatrixWorld(true);
    }

    /** Last successful kernel result (or null). */
    get lastResult() { return this._lastResult; }

    /** Per-face / per-edge geometry from the kernel, keyed by descriptor
     *  canonical string. Used by viewport overlays to render face-conforming
     *  hover and selection highlights. `null` until the first successful
     *  render delivers a `geometry` field. */
    get geometry() {
        return (this._lastResult && this._lastResult.geometry) || null;
    }

    /**
     * Resolve the face under the cursor to a topology descriptor.
     *
     * Returns whatever `pickFaceFromCursor` produced — `null` if the ray
     * missed every body or the kernel hasn't produced a topology yet.
     * The result carries the descriptor (canonical identity), the
     * matching face's local center + normal, the world-space hit, and
     * the local-frame hit/normal so callers can render hover overlays.
     *
     * @param {object} camera     Three.js camera
     * @param {object} raycaster  Three.js Raycaster (reused across calls)
     * @param {{x:number, y:number}} ndc  Cursor in normalized device coords
     */
    pickFaceAt(camera, raycaster, ndc) {
        const topology = this._lastResult && this._lastResult.topology;
        if (!topology) return null;
        return pickFaceFromCursor({
            camera,
            raycaster,
            ndc,
            // Use the inner wrap (mm + Z-up) so the raycaster's world hit
            // gets transformed back into the same frame as the kernel's
            // topology centres.
            bodyGroup: this.bodyTransform,
            topology,
        });
    }

    /**
     * Same as `pickFaceAt` but resolves to the nearest *edge* descriptor.
     * Useful for Fillet / Chamfer selection where the user wants specific
     * edges, not the face the cursor is over.
     */
    pickEdgeAt(camera, raycaster, ndc) {
        const topology = this._lastResult && this._lastResult.topology;
        if (!topology) return null;
        return pickEdgeFromCursor({
            camera,
            raycaster,
            ndc,
            bodyGroup: this.bodyTransform,
            topology,
        });
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /** (Re-)attach the bridge's root group to a Three.js Scene. */
    setScene(scene) {
        if (this._root.parent) this._root.parent.remove(this._root);
        this.scene = scene || null;
        if (scene) scene.add(this._root);
    }

    /** Replace the kernel endpoint (e.g. when the user enters a remote URL). */
    setEndpoint(url) {
        if (this.kernelClient && typeof this.kernelClient.setEndpoint === 'function') {
            this.kernelClient.setEndpoint(url);
        }
    }

    /** Tear everything down. After calling this, the bridge is unusable. */
    dispose() {
        if (this._unsubStore)    this._unsubStore();
        if (this._unsubExecutor) this._unsubExecutor();
        clearTimeout(this._debounceTimer);
        this._clearRoot();
        if (this._root.parent) this._root.parent.remove(this._root);
        this._unsubStore = null;
        this._unsubExecutor = null;
    }

    // ── Run scheduling ─────────────────────────────────────────────────────────

    /**
     * Leading-edge debounce. The first edit after idle fires the kernel call
     * immediately — no perceived stall — and any further edits arriving while
     * the run is in flight, or within `debounceMs` of its completion, coalesce
     * into one trailing follow-up. Slider drags still coalesce; single
     * clicks/parameter tweaks land instantly.
     *
     * Previously a pure trailing debounce: every edit paid +150ms before the
     * kernel even saw the request. That dead time is the dominant cause of
     * the "any action feels laggy" report from the viewport.
     */
    scheduleRun() {
        if (this._running) {
            // Run in flight — mark dirty so the completion handler re-fires.
            this._dirtyDuringRun = true;
            return;
        }
        if (this._debounceTimer) {
            // Already coalescing follow-ups in the post-run quiet window —
            // restart the timer so a continuing burst keeps batching.
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this._debounceTimer = null;
                this._runGuarded();
            }, this.debounceMs);
            return;
        }
        // Idle — fire the kernel immediately. No leading wait.
        this._runGuarded();
    }

    /**
     * Wraps `runNow` with the in-flight + dirty tracking that `scheduleRun`
     * reads. External callers (`bridge.runNow()`) bypass this on purpose:
     * they want a synchronous-feeling "run right now" without the bookkeeping.
     */
    async _runGuarded() {
        this._running = true;
        try {
            await this.runNow();
        } catch (err) {
            // runNow already logs; swallow here so the dirty re-fire path
            // still runs and we don't leave `_running` stuck true.
            console.error('[bridge] _runGuarded: runNow threw:', err);
        } finally {
            this._running = false;
            if (this._dirtyDuringRun) {
                this._dirtyDuringRun = false;
                // Edits arrived during the run — trailing-debounce a single
                // follow-up so a slider drag mid-compile lands one final
                // kernel call at the user's stopping point.
                this._debounceTimer = setTimeout(() => {
                    this._debounceTimer = null;
                    this._runGuarded();
                }, this.debounceMs);
            }
        }
    }

    /** Run the executor immediately. Returns the executor result. */
    async runNow() {
        const doc = this.store.doc;
        const featureCount = doc ? Object.keys(doc.features || {}).length : 0;
        console.log('[bridge] runNow start', { featureCount });
        if (!doc || featureCount === 0) {
            this._clearRoot();
            // The doc is now empty (e.g. the last body was deleted). Drop the
            // cached kernel result so `bridge.geometry` reports null, then fire
            // the render hooks so downstream layers (pick proxies, face/edge
            // hover overlays) tear themselves down. Without this the proxies
            // built for the just-deleted body would linger forever — the
            // raycaster would keep "hovering" ghost faces because nothing told
            // it the geometry is gone (the empty path used to early-return
            // before notifying onRender).
            this._lastResult = null;
            this._notifyRender({ glb: null, empty: true });
            console.log('[bridge] runNow: empty doc, cleared root');
            return { ok: true, glb: null, empty: true };
        }
        // Time the kernel round-trip as close to the network boundary as we
        // can from here — the executor wraps cache lookup + HTTP POST + GLB
        // bytes parse-out. The GLB→three import happens later in `_render`
        // and is measured separately (lastRenderMs).
        //
        // NOTE: the executor dispatches its `executed` event synchronously
        // from inside `executeDocument`, so we can't measure the round-trip
        // by awaiting the returned promise — by the time it resolves,
        // `_render` has already fired `onRender` to consumers with stale
        // timing. Instead we stash t0 here and the `executed` handler in
        // `_attachListeners` computes the delta before invoking `_render`.
        this._compileStartedAt = performance.now();
        try {
            const result = await this.executor.executeDocument(doc);
            console.log('[bridge] runNow done', {
                ok: result?.ok,
                hasGlb: !!(result?.glb && result.glb.byteLength > 0),
                glbBytes: result?.glb?.byteLength ?? 0,
                error: result?.error || null,
            });
            return result;
        } catch (err) {
            console.error('[bridge] runNow threw:', err);
            throw err;
        }
    }

    // ── Render hooks ───────────────────────────────────────────────────────────

    /** Subscribe to render events: `({ result, group }) → void`. Returns unsubscribe. */
    onRender(fn) {
        this._renderHooks.add(fn);
        return () => this._renderHooks.delete(fn);
    }

    /** Subscribe to error events: `({ error, doc }) → void`. */
    onError(fn) {
        this._errorHooks.add(fn);
        return () => this._errorHooks.delete(fn);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _attachListeners() {
        // Document store → schedule a debounced run on every commit.
        // Selection-only events ('select', 'refs', '*-capsule') don't need a regen.
        this._unsubStore = this.store.subscribe((doc, eventLabel) => {
            console.log('[bridge] store change', { eventLabel, featureCount: Object.keys(doc?.features || {}).length });
            if (eventLabel === 'select' || eventLabel === 'refs') return;
            // Optimistic local prune — make deletes feel 1:1 with the doc
            // state. The kernel call still runs in the background (debounced
            // by `scheduleRun` below). Wrapped in try/catch so a prune bug
            // can NEVER stop the kernel from running — kernel-pipeline
            // liveness > optimistic UI.
            try { this._pruneOrphanMeshes(doc); }
            catch (err) { console.error('[bridge] _pruneOrphanMeshes threw:', err); }
            this.scheduleRun();
        });

        // Executor → render successful GLBs, surface failures.
        this._unsubExecutor = this.executor.subscribe((evt) => {
            if (evt.type === 'executed') {
                // Kernel responded — capture compile time before `_render`
                // runs so onRender callbacks see the fresh value. The
                // kernel_client never throws (network errors come back as
                // a not-ok result), so any time we see `executed` we can
                // also trust `_compileStartedAt` was set in `runNow`.
                if (typeof this._compileStartedAt === 'number') {
                    this.lastCompileMs = performance.now() - this._compileStartedAt;
                    this._compileStartedAt = null;
                }
                // Mirror the kernel client's just-updated version block so
                // `bridge.lastKernelVersion` and
                // `bridge.kernelClient.lastKernelVersion` stay in sync. Done
                // BEFORE `_render` (and therefore before onRender hooks
                // fire) so consumers reading from inside a render callback
                // see the fresh value, matching the lastCompileMs contract.
                if (this.kernelClient && 'lastKernelVersion' in this.kernelClient) {
                    this.lastKernelVersion = this.kernelClient.lastKernelVersion ?? null;
                }
                // Rebuild the TopologyIndex from the freshly returned
                // topology payload BEFORE `_render` fires. The next emit
                // (triggered by a later document edit) reads
                // `bridge.topologyIndex` to client-resolve query inputs.
                // We tolerate missing/empty topology — buildIndex returns
                // an empty Map in that case and emit.js falls back to
                // fingerprints.
                try {
                    const topology = evt.result && evt.result.topology;
                    this.topologyIndex = topology ? buildIndex(topology) : null;
                } catch (err) {
                    console.warn('[bridge] buildIndex failed:', err && err.message);
                    this.topologyIndex = null;
                }
                this._lastResult = evt.result;
                // Stamp kernel-emitted geometry onto the live doc as a
                // transient (non-changelog) field. Consumers like the
                // KinematicsPanel read `doc.geometry.componentMeshes` for
                // Spec 17 v2 mesh-interference; surfacing the kernel's
                // per-component triangle buffers here keeps that read path
                // synchronous with the rest of the doc state.
                try {
                    if (this.store && this.store.doc && evt.result && evt.result.geometry) {
                        this.store.doc.geometry = evt.result.geometry;
                    }
                } catch (err) {
                    console.warn('[bridge] stamp doc.geometry failed:', err && err.message);
                }
                this._render(evt.result);
            } else if (evt.type === 'failed') {
                // Kernel responded with an error (or kernel_client wrapped
                // a network failure as not-ok). Record compile time too —
                // the user still wants to see how long the failed call
                // took. lastRenderMs is left as-is because no scene swap
                // happens on the error path.
                if (typeof this._compileStartedAt === 'number') {
                    this.lastCompileMs = performance.now() - this._compileStartedAt;
                    this._compileStartedAt = null;
                }
                for (const fn of this._errorHooks) {
                    try { fn({ error: evt.error, doc: evt.doc }); }
                    catch (e) { console.error('[bridge.onError]', e); }
                }
            }
        });
    }

    _render(result) {
        console.log('[bridge] _render called', {
            hasResult: !!result,
            hasGlb: !!(result && result.glb && result.glb.byteLength > 0),
            glbBytes: result?.glb?.byteLength ?? 0,
        });
        // Empty result: clear and notify
        if (!result || !result.glb || (result.glb.byteLength === 0)) {
            this._clearRoot();
            this._notifyRender(result);
            return;
        }
        // Time the GLB → three scene application. GLTFLoader.parse with a
        // binary buffer calls its onLoad callback synchronously (no async
        // sub-resource fetches for an embedded GLB), so wrapping the parse
        // call in t1/now captures parse + clear + wrap + traverse + attach.
        // If a future kernel response ever embeds external URIs the parse
        // callback would become async and this measurement would collapse
        // to a tiny "kicked off the parse" delta — revisit then.
        const t1 = performance.now();
        try {
            this._loader.parse(result.glb, '', (gltf) => {
                this._clearRoot();
                // build123d / OCCT glTF export quirks:
                //   1. Mm-as-meters. Vertices for a 20 mm box land at ±0.01
                //      because OCCT treats mm-as-meters per the glTF spec.
                //      We render in a 1 unit = 1 mm world → scale by 1000.
                //   2. Y-up. The rest of ParaForm renders Z-up, matching CAD
                //      convention. Rotate +90° about X (right-hand rule:
                //      data's +Y maps to world +Z so "up" stays "up").
                //      Using −90° silently inverts the up axis — a build123d
                //      Box(…, align=MIN on Z) ends up entirely below the
                //      ground plane.
                // Done on the wrapper rather than `gltf.scene` directly so the
                // tessellation transforms aren't dirtied.
                const wrap = new THREE.Group();
                wrap.name = '__v4_glb_wrap__';
                wrap.scale.setScalar(1000);
                wrap.rotation.x = Math.PI / 2;
                wrap.add(gltf.scene);
                this._root.add(wrap);
                // ── Always-on edge overlay ───────────────────────────────
                // The build123d GLB output ships triangulated surfaces but
                // no edge lines, so a v4 body otherwise renders as a
                // featureless blob — users can't see what's selectable.
                // Walk every mesh and add a LineSegments child built from
                // EdgesGeometry at the standard CAD threshold (~20°).
                // PolygonOffset keeps them above the face without Z-fighting.
                // Pre-existing meshes also get `polygonOffset` so face
                // fragments don't pop through edges at glancing angles.
                // ── Two-pass traversal ────────────────────────────────────
                // Pass 1 (this tick): material massage + descriptors +
                // boundingBox. Cheap per-mesh, but the body needs all of
                // it to look right on first paint.
                //
                // Pass 2 (next animation frame): EdgesGeometry +
                // LineSegments. For a doc with several bodies at
                // medium-or-better tessellation this loop is the dominant
                // cost on the render hot path (EdgesGeometry walks every
                // triangle of every mesh and builds a fresh BufferGeometry
                // per body). Deferring it one rAF lets the body appear
                // immediately and pushes the edge cost off the GLB-parse
                // critical path — the user sees the new geometry before
                // the dihedral lines catch up, and the regen feels
                // responsive even on 8080×2000 extrusions.
                //
                // Edges are purely visual (picking uses pick_proxies, not
                // the edge overlay — see the `raycast = () => {}` line
                // below), so this deferral is safe with respect to
                // selection and hover.
                const meshesAwaitingEdges = [];
                gltf.scene.traverse((obj) => {
                    if (!obj.isMesh) return;
                    if (obj.userData.__v4_hasEdges) return;
                    try {
                        // Apply polygon offset so edges sit above the surface.
                        // Also force the material into a properly diffuse
                        // state — build123d's GLB export ships meshes with
                        // metalness=1/roughness=1 (a fully metallic surface
                        // that, without an environment map, samples flat
                        // grey from the scene). That kills directional
                        // shading and every face of a holed/shelled body
                        // looks identical. Bringing metalness down to 0 and
                        // roughness to a CAD-paint value restores the
                        // hemisphere + directional contrast we rely on to
                        // see hole rims, cavity walls, and concavities.
                        if (obj.material) {
                            if ('metalness' in obj.material) obj.material.metalness = 0;
                            if ('roughness' in obj.material) obj.material.roughness = 0.6;
                            obj.material.color && obj.material.color.setHex(0xc8ccd0);
                            // CSG subtractions leave inner cavity walls
                            // (hole cylinders, shell interiors) with
                            // normals pointing OUT of the body's missing
                            // volume — i.e. away from us when we look
                            // into a hole from above. With the default
                            // FrontSide those tris get culled and the
                            // hole appears invisible. DoubleSide renders
                            // both sides so cavities read correctly.
                            obj.material.side = THREE.DoubleSide;
                            // build123d's exported vertex normals collapse
                            // every face onto its own normal which doesn't
                            // give per-triangle contrast on curved
                            // surfaces. Force flat shading so each
                            // triangle picks its own normal from the
                            // triangle's geometry — cylinder walls, cone
                            // sides, and hole disc bottoms then shade
                            // correctly and stand out from the lit
                            // top/side faces.
                            obj.material.flatShading = true;
                            obj.material.polygonOffset = true;
                            obj.material.polygonOffsetFactor = 1;
                            obj.material.polygonOffsetUnits  = 1;
                            obj.material.needsUpdate = true;
                        }
                        // Recompute the geometry's bounding box so the
                        // body AABB used by the camera fit is correct.
                        if (obj.geometry && !obj.geometry.boundingBox) {
                            obj.geometry.computeBoundingBox();
                        }
                        // Cast onto the contact-shadow plane installed by main.js.
                        obj.castShadow = true;
                        // Queue this mesh for the deferred edge pass.
                        meshesAwaitingEdges.push(obj);
                    } catch (err) {
                        console.warn('[bridge] mesh prep failed for', obj.name, err && err.message);
                    }
                });

                // Pass 2 — schedule on next animation frame. Bump a generation
                // counter so a fast follow-up regen invalidates this batch
                // (the previous wrap is unparented in _clearRoot before the
                // rAF fires; checking `obj.parent` confirms the mesh is
                // still live before we mutate it).
                const edgeGen = ++this._edgeOverlayGeneration;
                requestAnimationFrame(() => {
                    if (edgeGen !== this._edgeOverlayGeneration) return;
                    for (const obj of meshesAwaitingEdges) {
                        if (!obj.parent) continue; // disposed by a fresher regen
                        if (obj.userData.__v4_hasEdges) continue;
                        try {
                            const edgesGeo = new THREE.EdgesGeometry(obj.geometry, 20);
                            const edgesMat = new THREE.LineBasicMaterial({
                                color:        0x1c1f24,
                                transparent:  true,
                                opacity:      0.85,
                                depthTest:    true,
                                linewidth:    1,
                            });
                            const edgeLines = new THREE.LineSegments(edgesGeo, edgesMat);
                            edgeLines.name = '__v4_body_edges__';
                            edgeLines.userData.__v4_overlay = true;
                            edgeLines.renderOrder = 1;
                            // Picker uses pick_proxies; this overlay must
                            // not absorb raycasts.
                            edgeLines.raycast = () => {};
                            obj.add(edgeLines);
                            obj.userData.__v4_hasEdges = true;
                        } catch (err) {
                            console.warn('[bridge] deferred edge overlay failed for mesh', obj.name, err && err.message);
                        }
                    }
                });
                // Tag every Mesh in the parsed scene with a body descriptor so
                // viewport-level selectors (rubber-band, click-to-select-body)
                // can map a hit Object3D back to a v4 feature without doing a
                // topology re-query.
                //
                // Per-body mapping: the kernel emits bodies to `bodies` dict in
                // topological order and `Compound(children=shapes)` exports each
                // child body as its own subtree in the glTF scene graph. OCCT's
                // RWGltf writer can split a single body into MULTIPLE isMesh
                // primitives (per-face shading, per-material grouping), so we
                // can't pair by flat `isMesh` count — we pair by SUBTREE.
                //
                // _findBodyRoots walks gltf.scene at depth-1, then depth-2,
                // looking for a level whose mesh-bearing child count equals
                // leafIds.length. Whatever it returns is the per-body root list
                // in emit order: bodyRoots[i] ←→ leafIds[i]. Every isMesh
                // descendant of bodyRoots[i] then inherits leafIds[i] as its
                // featureId. This was the root cause of two long-running bugs:
                //   - placed M5 nut + extrusion both highlighted on selecting
                //     either (every mesh wore the LAST leaf's id under the old
                //     count-match fallback),
                //   - the gizmo failed to appear on the nut because the
                //     extrusion's component subgroup ended up empty — every
                //     mesh was re-parented to the nut's subgroup.
                const leafIds = (result.topology && Array.isArray(result.topology.nodes))
                    ? result.topology.nodes.map(n => n && n.featureId).filter(Boolean)
                    : [];
                if (leafIds.length > 0) {
                    const lastId   = leafIds[leafIds.length - 1];
                    const wrapDesc = bodyRef(lastId);
                    wrap.userData.descriptor = wrapDesc;
                    wrap.userData.featureId  = lastId;
                    wrap.userData.leafFeatureIds = leafIds.slice();

                    const bodyRoots = _findBodyRoots(gltf.scene, leafIds.length);
                    if (bodyRoots) {
                        for (let i = 0; i < bodyRoots.length; i++) {
                            const fid = leafIds[i];
                            if (!fid) continue;
                            const desc = bodyRef(fid);
                            // Tag the subtree root so any future per-root pick
                            // also resolves correctly.
                            bodyRoots[i].userData.descriptor = desc;
                            bodyRoots[i].userData.featureId  = fid;
                            bodyRoots[i].traverse((obj) => {
                                if (obj.isMesh) {
                                    obj.userData.descriptor = desc;
                                    obj.userData.featureId  = fid;
                                }
                            });
                        }
                    } else {
                        // No depth matched leafIds.length — surface the
                        // mismatch loudly so this regresses visibly rather
                        // than silently mistagging meshes. Falling back to
                        // last-leaf-everywhere is strictly worse than leaving
                        // the meshes untagged (it actively causes wrong-body
                        // highlights), so we just warn and skip per-mesh
                        // featureIds. The wrap still carries `leafFeatureIds`
                        // so rubber-band selection has something to work with.
                        const allMeshCount = (() => {
                            let n = 0;
                            gltf.scene.traverse((o) => { if (o.isMesh) n++; });
                            return n;
                        })();
                        console.warn('[bridge] could not pair GLB body subtrees with leafIds', {
                            leafCount: leafIds.length,
                            depth1Children: gltf.scene.children.length,
                            totalMeshes: allMeshCount,
                        });
                    }
                }

                // Foundation 6 — per-component subgroup layer. The previous
                // render's groups belong to the (now-disposed) old wrap, so
                // wipe the cache before mounting fresh ones under the new
                // wrap. v0 docs have only `'root'`, so the loop creates a
                // single subgroup that holds every mesh — mechanically a
                // no-op for callers reading `bridge.bodyTransform`, but the
                // hierarchy is in place for multi-component docs.
                this._componentGroups = new Map();
                this._bodyTransform = wrap;
                // Mount the root subgroup eagerly so every doc has at least
                // one component group, even before any tagged mesh shows up.
                this.componentSubgroup('root');
                // Re-parent each tagged mesh into its owning component
                // subgroup. Lookup: mesh.userData.featureId →
                // doc.features[fid].componentId → componentSubgroup(cid).
                // Falls back to 'root' for every untagged or unknown
                // feature so we never lose meshes.
                const doc = this.store && this.store.doc;
                const features = (doc && doc.features) || {};
                // Capture meshes first; traversal + reparent in one pass
                // confuses the traversal order.
                const meshesToMove = [];
                gltf.scene.traverse((obj) => {
                    if (obj.isMesh) meshesToMove.push(obj);
                });
                for (const mesh of meshesToMove) {
                    const fid = mesh.userData && mesh.userData.featureId;
                    const feat = fid ? features[fid] : null;
                    const componentId = (feat && feat.componentId) || 'root';
                    const target = this.componentSubgroup(componentId);
                    // Preserve world transform across the reparent. As of
                    // Phase 3 every component subgroup is at identity (the
                    // kernel bakes component placement into the GLB — see
                    // `_applyComponentOrigin`), so `attach` is effectively a
                    // plain re-parent that leaves the already-posed geometry
                    // exactly where the kernel put it. `attach` (vs `add`) is
                    // retained so the grouping stays correct even if a future
                    // change reintroduces a non-identity subgroup transform.
                    target.attach(mesh);
                    mesh.userData.componentId = componentId;
                }

                // Force matrixWorld to be up-to-date now so the very first
                // pointermove after a render can use it without waiting for
                // the next render frame.
                wrap.updateMatrixWorld(true);
                // Stamp render time BEFORE the hooks fire so any consumer
                // reading bridge.lastRenderMs from onRender sees the fresh
                // value rather than the previous render's number.
                this.lastRenderMs = performance.now() - t1;
                this._notifyRender(result);
            }, (err) => {
                console.error('[DocumentViewportBridge] GLTF parse failed:', err);
                for (const fn of this._errorHooks) {
                    try { fn({ error: 'glb-parse-failed', doc: this.store.doc }); }
                    catch {}
                }
            });
        } catch (err) {
            console.error('[DocumentViewportBridge] _render threw:', err);
        }
    }

    _notifyRender(result) {
        for (const fn of this._renderHooks) {
            try { fn({ result, group: this._root }); }
            catch (e) { console.error('[bridge.onRender]', e); }
        }
    }

    _clearRoot() {
        while (this._root.children.length) {
            const child = this._root.children[0];
            this._root.remove(child);
            try {
                child.traverse?.((o) => {
                    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
                    if (o.material) {
                        const mats = Array.isArray(o.material) ? o.material : [o.material];
                        for (const m of mats) if (m && m.dispose) m.dispose();
                    }
                });
            } catch {}
        }
        this._bodyTransform = null;
        // Drop stale per-component subgroup references along with the wrap
        // they were parented to. Next render will create fresh groups.
        this._componentGroups = new Map();
    }

    /**
     * Optimistic "live delete" sweep — removes any mesh in the current
     * bodyTransform whose `userData.featureId` is no longer present in
     * the document. Called on every non-selection store change so the
     * viewport reflects deletions immediately, without waiting for the
     * 150 ms debounce + kernel round-trip in `runNow`.
     *
     * Also drops empty `__v4_component_<id>__` subgroups whose
     * `userData.componentId` was removed from `doc.components` — keeps
     * the gizmo / snap layers from holding stale references.
     *
     * Cheap: one traversal of bodyTransform per change. No-op when
     * nothing actually got removed from the doc.
     *
     * @private
     */
    _pruneOrphanMeshes(doc) {
        const root = this._bodyTransform;
        if (!root) return;
        const featureIds = new Set(Object.keys((doc && doc.features) || {}));
        const componentIds = new Set(Object.keys((doc && doc.components) || {}));
        // Collect first; mutating children mid-traversal trips three.js.
        const toRemove = [];
        root.traverse((node) => {
            const fid = node.userData && node.userData.featureId;
            if (fid && !featureIds.has(fid)) {
                toRemove.push(node);
                return;
            }
            // A `__v4_component_<id>__` subgroup whose component no longer
            // exists in the doc shouldn't keep rendering its children. We
            // identify component subgroups by their userData.componentId
            // tag rather than name parsing.
            const cid = node.userData && node.userData.componentId;
            if (cid && cid !== 'root' && !componentIds.has(cid)) {
                toRemove.push(node);
            }
        });
        for (const node of toRemove) {
            if (!node.parent) continue;
            node.parent.remove(node);
            try {
                node.traverse?.((o) => {
                    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
                    if (o.material) {
                        const mats = Array.isArray(o.material) ? o.material : [o.material];
                        for (const m of mats) if (m && m.dispose) m.dispose();
                    }
                });
            } catch {}
            // Drop any cached subgroup pointer for a deleted component so
            // `componentSubgroup()` recreates fresh next time.
            const cid = node.userData && node.userData.componentId;
            if (cid && this._componentGroups.has(cid)) {
                this._componentGroups.delete(cid);
            }
        }
    }
}

// ── GLB → leafIds pairing ────────────────────────────────────────────────────

/**
 * Find the per-body subtree roots in a parsed glTF scene. OCCT/build123d's
 * `Compound(children=shapes)` export typically lays the scene out as either:
 *
 *   gltf.scene                       (depth-0 root)
 *     ├── body0 (Object3D)           ← depth-1: one node per child body
 *     │     └── Mesh                       — may split into multiple meshes
 *     │     └── Mesh                       — for per-face / per-material splits
 *     ├── body1 (Object3D)
 *     └── …
 *
 * or, when the writer wraps the Compound in an outer node:
 *
 *   gltf.scene
 *     └── compoundWrapper             ← depth-1: a single carrier node
 *           ├── body0                 ← depth-2: one node per child body
 *           ├── body1
 *           └── …
 *
 * Pair leafIds with the level whose mesh-bearing child count matches. Returns
 * the matched roots, or `null` if neither depth lines up (the caller falls
 * back to a warning + skipped tagging).
 *
 * Filters out children whose subtree contains no `isMesh` — gltf can emit
 * empty transform-only nodes, lights, or cameras alongside the geometry,
 * and they'd otherwise throw the count off by one.
 */
function _findBodyRoots(scene, expectedCount) {
    if (!scene || !Array.isArray(scene.children) || expectedCount <= 0) return null;
    const depth1 = scene.children.filter(_subtreeHasMesh);
    if (depth1.length === expectedCount) return depth1;
    // A single depth-1 wrapper around a Compound child set — try depth-2.
    if (depth1.length === 1) {
        const depth2 = depth1[0].children.filter(_subtreeHasMesh);
        if (depth2.length === expectedCount) return depth2;
    }
    return null;
}

function _subtreeHasMesh(node) {
    if (!node) return false;
    let has = false;
    node.traverse((o) => { if (o.isMesh) has = true; });
    return has;
}

// ── Lazy module singleton ─────────────────────────────────────────────────────

let _bridge = null;

/**
 * Get (or create) the module singleton bridge. Pass `{ scene }` on the first
 * call to attach it to the live viewport; subsequent calls return the same
 * instance and ignore options.
 */
export function getViewportBridge(opts = {}) {
    if (!_bridge) _bridge = new DocumentViewportBridge(opts);
    else if (opts.scene && _bridge.scene !== opts.scene) _bridge.setScene(opts.scene);
    return _bridge;
}

export function disposeViewportBridge() {
    if (_bridge) { _bridge.dispose(); _bridge = null; }
}
