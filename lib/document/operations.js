/**
 * Operations — high-level commands that build features and commit them to
 * the singleton DocumentStore in one call. These are the convenience layer
 * the UI hooks call into ("v4: Add Box" → `addBox()`).
 *
 * Each operation returns the created feature so the caller can immediately
 * select it, follow up with constraints, or chain another op.
 *
 * Wrap every call in the store's commit pipeline — that's where undo, redo,
 * the changelog, and the executor's autorun all live. Calling makeFeature()
 * directly would bypass all of that.
 */

import { getDocumentStore, resetDocumentStore, componentDescendants } from './store.js';
import { makeFeature, makeParameter, makeComponent, makeAssumption, makeJoint, makeConnector, makeMate, newChangeId, bodyRef, sketchRef, planeRef, axisRef } from './types.js';
import {
    addFeatureChange, removeFeatureChange,
    setEnabledChange, setParamsChange, renameFeatureChange,
    addParameterChange, updateParameterChange, removeParameterChange,
    addComponentChange, removeComponentChange, renameComponentChange,
    setFeatureComponentChange, setComponentParentChange, setComponentOriginChange,
    addAssumptionChange, acknowledgeAssumptionChange,
    removeAssumptionChange, clearAssumptionsChange,
    addJointChange, updateJointChange, removeJointChange,
    addConnectorChange, updateConnectorChange, removeConnectorChange,
    addMateChange, updateMateChange, removeMateChange,
} from './changelog.js';

// ── Active component provider (Foundation 6 / commit 2) ──────────────────────
/**
 * The studio runtime installs a getter at boot via `setActiveComponentProvider`
 * so feature-creation calls in here can stamp the new feature with the active
 * componentId without operations.js importing runtime.svelte.js (which would
 * create a circular dep: runtime → operations → store → runtime).
 *
 * Default (no provider installed yet — startup, headless tests, scripted
 * console use): falls back to `'root'`. That preserves every existing call
 * site's behaviour bit-for-bit.
 */
let _activeComponentProvider = null;

/**
 * @param {() => string} fn — returns the active componentId, e.g. `'root'`.
 *                            Pass `null` to clear.
 */
export function setActiveComponentProvider(fn) {
    _activeComponentProvider = (typeof fn === 'function') ? fn : null;
}

/** Resolve the componentId for a new feature: explicit param > provider > 'root'. */
function _resolveComponentId(explicit) {
    if (explicit) return explicit;
    if (_activeComponentProvider) {
        try {
            const v = _activeComponentProvider();
            if (v) return v;
        } catch (_) { /* fall through to 'root' */ }
    }
    return 'root';
}

/**
 * Internal feature factory used by every concrete add* below. Pulls
 * `componentId` from the caller's params (if any) or the active-component
 * provider. Returns a feature whose `componentId` is always set.
 */
function _mkFeature(type, params, inputs, { componentId } = {}) {
    const f = makeFeature(type, params, inputs, { componentId: _resolveComponentId(componentId) });
    f.name = _autoNumberedName(type, f.name);
    return f;
}

/**
 * Disambiguate the default feature label by appending an incrementing suffix
 * when a feature with that base name already exists ("Box", "Box 2", "Box 3").
 * Only touches the type's default label — a user-renamed feature is never
 * considered the base, and renaming later is unaffected. Walks the current
 * document so the count reflects the live tree, not a per-session counter.
 */
function _autoNumberedName(type, baseName) {
    if (!baseName) return baseName;
    let doc;
    try { doc = getDocumentStore().doc; } catch { return baseName; }
    const features = doc?.features;
    if (!features) return baseName;
    const taken = new Set();
    for (const id of Object.keys(features)) {
        const n = features[id]?.name;
        if (typeof n === 'string') taken.add(n);
    }
    if (!taken.has(baseName)) return baseName;
    for (let i = 2; i < 10000; i++) {
        const candidate = `${baseName} ${i}`;
        if (!taken.has(candidate)) return candidate;
    }
    return baseName;
}

// ── Primitive features ────────────────────────────────────────────────────────

export function addBox({ length = 10, width = 10, height = 10, centered = true, componentId } = {}) {
    const f = _mkFeature('Box', { length, width, height, centered }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addCylinder({ radius = 5, height = 10, centered = true, componentId } = {}) {
    const f = _mkFeature('Cylinder', { radius, height, centered }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addSphere({ radius = 5, componentId } = {}) {
    const f = _mkFeature('Sphere', { radius }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addTorus({ majorRadius = 10, minorRadius = 2, componentId } = {}) {
    const f = _mkFeature('Torus', { majorRadius, minorRadius }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── BuildScript (raw build123d Python user code) ─────────────────────────────

/**
 * Default snippet emitted when a new BuildScript is created without explicit
 * code. A complete, runnable example so the user sees a working compile right
 * away rather than an empty editor.
 *
 * The kernel namespace already has build123d's public API in scope at runtime,
 * but we keep the explicit `from build123d import *` so the script remains
 * portable when copied into a standalone Python file.
 */
const DEFAULT_BUILD_SCRIPT = `# Write build123d Python here, then assign your final body to a
# variable named \`result\` — that is what gets rendered. A script
# that assigns no \`result\` just defines helpers and renders nothing.
#
# Runs sandboxed: build123d, math and numpy are available; the
# filesystem, network and os/subprocess are not.
#
# build123d 0.10's public API ('Box', 'Cylinder', 'BuildPart',
# 'Locations', 'Mode', ...) is already in scope, but the explicit
# import keeps your script portable.

from build123d import *

with BuildPart() as part:
    Box(40, 40, 20)
    with Locations((0, 0, 20)):
        Cylinder(5, 20, mode=Mode.SUBTRACT)

result = part.part
`;

/**
 * Add a BuildScript feature carrying raw Python `code`. The emitter (see
 * emit.js BuildScript handler) drops the code straight into the kernel
 * namespace at top level, so any name assigned in the script is visible to
 * later features.
 *
 * `name` is applied after construction because makeFeature's params slot
 * doesn't honour name — it pulls the default label from FEATURE_TYPES.
 */
export function addBuildScript({ code, name = 'Script', componentId } = {}) {
    const initial = (typeof code === 'string' && code.length > 0) ? code : DEFAULT_BUILD_SCRIPT;
    const f = _mkFeature('BuildScript', { code: initial }, {}, { componentId });
    if (name) f.name = name;
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Update an existing BuildScript feature's `code` and/or `name`. Goes through
 * the existing setParamsChange / renameFeatureChange so undo/redo and the
 * changelog stay coherent — no bespoke change kind required.
 *
 * Returns the updated feature, or null if the id doesn't resolve to a
 * BuildScript feature.
 */
export function updateBuildScript(featureId, { code, name } = {}) {
    const store = getDocumentStore();
    const f = store.doc.features[featureId];
    if (!f || f.type !== 'BuildScript') return null;
    if (typeof code === 'string' && code !== f.params?.code) {
        const nextParams = { ...f.params, code };
        store.commit(setParamsChange(featureId, nextParams));
    }
    if (typeof name === 'string' && name.length > 0 && name !== f.name) {
        store.commit(renameFeatureChange(featureId, name));
    }
    return store.doc.features[featureId] || null;
}

// ── Standard parts (catalog-backed bodies) ───────────────────────────────────

/**
 * Insert a catalog-resolved standard part into the document. The kernel side
 * (sibling agent) exposes `standard_parts.build_from_id(entryId)` so the
 * emitted Python is a single call — the JS side only stores the entry id and
 * an optional placement transform.
 *
 * @param {string} entryId  e.g. "iso4762-m3-16"
 * @param {{ transform?: object|null, name?: string|null, componentId?: string }} [opts]
 */
export function addStandardPart(entryId, { transform = null, name = null, componentId } = {}) {
    if (!entryId) throw new Error('addStandardPart: entryId required');
    const params = { entryId };
    if (transform) params.transform = transform;
    const f = _mkFeature('StandardPart', params, {}, { componentId });
    if (name) f.name = name;
    getDocumentStore().commit(addFeatureChange(f));
    // Surface any default-grade assumptions the catalog picked. Deferred to
    // runtime so test/headless paths can drive it explicitly without import
    // order issues.
    try { recordStandardPartGradeDefaults(f); } catch (_) { /* never blocks the add */ }
    return f;
}

/**
 * Update an existing StandardPart feature's transform and/or name. Goes
 * through setParamsChange / renameFeatureChange so undo/redo stays coherent.
 *
 * Returns the updated feature, or null if the id doesn't resolve.
 */
export function updateStandardPart(featureId, { transform = null, name = null } = {}) {
    const store = getDocumentStore();
    const f = store.doc.features[featureId];
    if (!f || f.type !== 'StandardPart') return null;
    if (transform) {
        const nextParams = { ...f.params, transform };
        store.commit(setParamsChange(featureId, nextParams));
    }
    if (typeof name === 'string' && name.length > 0 && name !== f.name) {
        store.commit(renameFeatureChange(featureId, name));
    }
    return store.doc.features[featureId] || null;
}

// ── Imported mesh (E5.3 — STEP / GLB browser-import wrapper) ─────────────────
/**
 * Wrap a browser-imported mesh (STEP via occt-import-js → GLB, or .glb
 * directly) as a persistent feature on the timeline. The kernel does not
 * participate — the GLB payload rides as base64 on the feature so the
 * mesh survives serialize / reload without re-asking the user to pick
 * the file again (see bridge.js for the re-attach hook).
 *
 * v1 boundary:
 *   - Feature metadata always survives reload (the timeline is intact).
 *   - The mesh re-attaches on reload via GLTFLoader decoding glbBase64
 *     when the bridge wires it; without that path, the user re-imports.
 *   - Practical size cap: ~10–20 MB GLB before localStorage autosave
 *     starts feeling slow / hitting the ~5 MB quota on some browsers.
 *     Very large STEP assemblies should be flagged to the user.
 *
 * @param {{ name?: string, format?: string, glbBase64?: string,
 *           transform?: object, componentId?: string }} [opts]
 */
export function addImportedMesh({ name, format = 'glb', glbBase64, transform, componentId } = {}) {
    if (!name || typeof name !== 'string') {
        throw new Error('addImportedMesh: name required');
    }
    if (!glbBase64 || typeof glbBase64 !== 'string') {
        throw new Error('addImportedMesh: glbBase64 required');
    }
    const params = { name, format, glbBase64 };
    if (transform) params.transform = transform;
    const f = _mkFeature('ImportedMesh', params, {}, { componentId });
    f.name = name;
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Phase A1 — Reference-image canvas. A `ReferenceImage` is a *scene-only*
 * feature (like ImportedMesh): it carries a base64 data-URL image plus a Z-up
 * placement, a calibrated real-world size, and display options. The kernel
 * never sees it — emit produces only a comment and the feature is excluded
 * from the leaf-body set (see emit.js). The viewport mounts it as a textured
 * plane through `lib/viewport/conventions.js` `createReferenceImagePlane`.
 *
 * Placement is part-local mm, **Z-up** (CLAUDE.md). Default = lying on the
 * world XY plane (origin [0,0,0], normal +Z), so a freshly dropped image sits
 * on the ground grid ready to be traced. `width_mm`/`height_mm` are set by the
 * two-point calibration UX; `opacity`/`displayThrough` are live-tweakable in
 * the Inspector via `updateReferenceImage`.
 *
 * @param {object}   opts
 * @param {string}   opts.dataUrl        — `data:image/png;base64,...`
 * @param {string}  [opts.name]
 * @param {string}  [opts.mime]
 * @param {number}  [opts.width_mm]
 * @param {number}  [opts.height_mm]
 * @param {number[]}[opts.origin]        — [x,y,z] mm, Z-up
 * @param {number[]}[opts.normal]        — outward normal, Z-up
 * @param {number[]}[opts.up]            — in-plane "up" for image orientation
 * @param {number}  [opts.opacity]       — 0..1
 * @param {boolean} [opts.displayThrough]— render in front of geometry (no depth test)
 */
export function addReferenceImage({
    name = 'Reference Image',
    dataUrl,
    mime = 'image/png',
    width_mm = 100,
    height_mm = 100,
    origin = [0, 0, 0],
    normal = [0, 0, 1],
    up = [0, 1, 0],
    opacity = 0.65,
    displayThrough = false,
    componentId,
    insertAt = null,
} = {}) {
    if (!dataUrl || typeof dataUrl !== 'string') {
        throw new Error('addReferenceImage: dataUrl required');
    }
    const params = {
        name, dataUrl, mime,
        width_mm, height_mm,
        origin, normal, up,
        opacity, displayThrough,
    };
    const f = _mkFeature('ReferenceImage', params, {}, { componentId });
    f.name = name;
    getDocumentStore().commit(addFeatureChange(f, insertAt));
    return f;
}

/**
 * Patch a reference image's display / placement params (opacity, size from
 * calibration, origin/normal when re-placed). Thin wrapper over setParamsChange
 * so the Inspector sliders and the calibration tool share one commit path.
 */
export function updateReferenceImage(featureId, patch = {}) {
    if (!featureId) throw new Error('updateReferenceImage: featureId required');
    getDocumentStore().commit(setParamsChange(featureId, patch));
}

// ── Modify features ───────────────────────────────────────────────────────────

/**
 * Round every edge of `targetFeatureId` with the given radius. The simplest
 * possible Fillet — equivalent to `body.edges() | fillet(radius=...)` in
 * build123d.
 */
export function addFillet(targetFeatureId, { radius = 1, edges = [], componentId } = {}) {
    const f = _mkFeature('Fillet', { radius, edges }, { body: bodyRef(targetFeatureId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addChamfer(targetFeatureId, { length = 1, length2 = null, edges = [], componentId } = {}) {
    const params = { length, edges };
    if (length2 != null) params.length2 = length2;
    const f = _mkFeature('Chamfer', params, { body: bodyRef(targetFeatureId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addShell(targetFeatureId, { thickness = 1, openFaces = [], componentId } = {}) {
    const f = _mkFeature('Shell', { thickness, openFaces }, { body: bodyRef(targetFeatureId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Sketch-based features ─────────────────────────────────────────────────────

export function addExtrude(sketchFeatureId, { amount = 10, both = false, taper = 0, componentId } = {}) {
    const f = _mkFeature('Extrude', { amount, both, taper }, { sketch: sketchRef(sketchFeatureId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addRevolve(sketchFeatureId, { angle = 360, axis = 'Z', componentId } = {}) {
    const f = _mkFeature('Revolve', { angle }, { sketch: sketchRef(sketchFeatureId), axis: axisRef(axis) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Sweep a profile sketch along a path feature. The profile is always a
 * Sketch; the path can be either a Sketch (planar curve) or a body-shaped
 * feature like Helix that produces a 3D wire. Emits as build123d's
 * `sweep(profile, path=...)`.
 */
export function addSweep(profileSketchId, pathFeatureId, { componentId } = {}) {
    if (!profileSketchId || !pathFeatureId) throw new Error('addSweep: profile and path feature ids required');
    const store = getDocumentStore();
    const pathFeat = store.doc.features[pathFeatureId];
    // Sketches use sketchRef; anything else (Helix, imported wire, etc.) uses bodyRef.
    const path = pathFeat && (pathFeat.type === 'Sketch' || pathFeat.type === 'SketchOnFace')
        ? sketchRef(pathFeatureId)
        : bodyRef(pathFeatureId);
    const f = _mkFeature('Sweep', {}, {
        sketch: sketchRef(profileSketchId),
        path,
    }, { componentId });
    store.commit(addFeatureChange(f));
    return f;
}

/**
 * Create a helical curve. Useful both as a standalone reference geometry
 * (visualise a spring path) and as the `path` argument to `addSweep` —
 * sweeping a profile along a Helix produces threads, coil springs,
 * spiral ramps, etc.
 *
 * Defaults match build123d's `Helix(pitch, height, radius, ...)`:
 *   pitch     = axial distance between consecutive turns
 *   height    = total axial length
 *   radius    = nominal radius (constant for cylindrical helices)
 *   coneAngle = degrees; non-zero gives a conical helix
 *   lefthand  = true for left-handed (CCW from +Z) winding
 */
export function addHelix({ pitch = 5, height = 20, radius = 5, coneAngle = 0, lefthand = false, componentId } = {}) {
    const f = _mkFeature('Helix', { pitch, height, radius, coneAngle, lefthand }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Loft between two or more sketches. Order matters — the loft surface
 * follows the order of the input list. `ruled=true` makes a ruled (linear)
 * surface; default is smooth.
 */
export function addLoft(sketchIds, { ruled = false, componentId } = {}) {
    if (!Array.isArray(sketchIds) || sketchIds.length < 2) {
        throw new Error('addLoft: need at least 2 sketch ids');
    }
    const f = _mkFeature('Loft', { ruled }, {
        sketches: sketchIds.map(id => sketchRef(id)),
    }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Drill a cylindrical hole into `targetBodyId`. Supports the three
 * standard variants:
 *   - 'simple'      — straight cylindrical hole
 *   - 'counterbore' — needs `counterDia` + `counterDepth`
 *   - 'countersink' — needs `counterDia` (angle defaults to 82° in kernel)
 *
 * `through=true` ignores `depth` and cuts all the way through. `face` is
 * optional — when omitted the hole drills along +Z at the origin. When
 * provided it should be a face fingerprint produced by the v3 resolver
 * (Phase 1B descriptors will land later).
 */
export function addHole(targetBodyId, {
    diameter = 3.2, depth = 10, through = false,
    type = 'simple', counterDia = null, counterDepth = null,
    face = null, componentId,
} = {}) {
    if (!targetBodyId) throw new Error('addHole: missing target body id');
    const params = { diameter, depth, through, type };
    if (face != null)         params.face         = face;
    if (counterDia != null)   params.counterDia   = counterDia;
    if (counterDepth != null) params.counterDepth = counterDepth;
    const f = _mkFeature('Hole', params, { body: bodyRef(targetBodyId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Accept a sketch feature OR a feature id and route to addExtrude. */
export function extrudeSketch(sketchOrId, opts = {}) {
    const id = typeof sketchOrId === 'string' ? sketchOrId : sketchOrId.id;
    return addExtrude(id, opts);
}

export function revolveSketch(sketchOrId, opts = {}) {
    const id = typeof sketchOrId === 'string' ? sketchOrId : sketchOrId.id;
    return addRevolve(id, opts);
}

// ── Boolean features ──────────────────────────────────────────────────────────

// ── Boolean (Union / Cut / Intersect) with optional keepTools (E3.3) ─────────
// `keepTools=true` instructs the emitter to *not* consume the tool bodies, so
// they remain on the leaf set and stay renderable. Default `false` preserves
// the legacy "tools are consumed" behaviour.
export function addUnion(featureIds, { keepTools = false, componentId } = {}) {
    if (!Array.isArray(featureIds) || featureIds.length < 2) {
        throw new Error('addUnion: need at least 2 feature ids');
    }
    const f = _mkFeature('Union', { keepTools: !!keepTools }, { bodies: featureIds.map(id => bodyRef(id)) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addCut(targetId, toolIds, { keepTools = false, componentId } = {}) {
    if (!targetId) throw new Error('addCut: missing target');
    const tools = Array.isArray(toolIds) ? toolIds : [toolIds];
    const f = _mkFeature('Cut', { keepTools: !!keepTools }, { target: bodyRef(targetId), tools: tools.map(id => bodyRef(id)) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addIntersect(featureIds, { keepTools = false, componentId } = {}) {
    if (!Array.isArray(featureIds) || featureIds.length < 2) {
        throw new Error('addIntersect: need at least 2 feature ids');
    }
    const f = _mkFeature('Intersect', { keepTools: !!keepTools }, { bodies: featureIds.map(id => bodyRef(id)) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Split (E3.3) ─────────────────────────────────────────────────────────────
/**
 * Split a target body by one or more tool bodies. Emits as build123d's
 * `split(target, by=tool)` per the existing Split emitter in emit.js. For
 * multiple tools we cascade splits (first tool, then re-split each piece by
 * the next). v1 stores the first tool only on `inputs.tool`; remaining tool
 * ids ride on `params.extraTools` for the kernel to consume.
 */
export function addSplit(targetId, toolIds, { componentId } = {}) {
    if (!targetId) throw new Error('addSplit: missing target id');
    const tools = Array.isArray(toolIds) ? toolIds : [toolIds];
    if (tools.length === 0) throw new Error('addSplit: at least one tool id required');
    const [firstTool, ...rest] = tools;
    const params = rest.length ? { extraTools: rest } : {};
    const f = _mkFeature('Split', params, {
        target: bodyRef(targetId),
        tool:   bodyRef(firstTool),
    }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Split a face along a curve. v1 is JS-side only — the kernel returns the
 * body unchanged with a warning comment in the emitted Python. The feature
 * records the face descriptor + the curve spec so a future kernel impl can
 * pick up exactly where we left off.
 *
 * `curveSpec` shape (loose, v1):
 *   { kind: 'sketch', sketchId }    — split the face by projecting a sketch
 *   { kind: 'plane',  planeId }     — split where the face intersects a plane
 *   { kind: 'edges',  edgeIds: [] } — split along existing model edges
 */
export function addSplitFace(faceDescriptor, curveSpec = {}, { componentId } = {}) {
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addSplitFace: faceDescriptor required');
    }
    const f = _mkFeature('SplitFace', { face: faceDescriptor, curve: curveSpec }, {}, { componentId });
    f.warnings = [...(f.warnings || []), 'Split Face: kernel impl pending; body passes through unchanged.'];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Casing / cover generator (Phase 5 — the differentiator) ──────────────────
/**
 * Wrap a set of components (or features) in a fitted, manufacturable
 * enclosure whose bosses/cutouts are DERIVED from the assembly's semantic
 * connectors. When a part is swapped (Phase 2 `replaceComponent`) the casing's
 * holes/cutouts move automatically — because the emitter reads `doc.connectors`
 * + `composeComponentTransform` fresh on every compile, nothing here caches a
 * stale connector position.
 *
 * `targets` is a list of componentIds (preferred) or featureIds to enclose.
 * The list is stored on `params.targets` (NOT `inputs`) so the enclosed parts
 * stay on the leaf set and remain visible inside the shell; the emitter still
 * references their world-placed body vars to union them.
 *
 * Geometry pipeline (see emit.js `emitCasingPython`):
 *   1. union placed bodies → enclosed
 *   2. offset(enclosed, clearance) = inner void; offset(enclosed, clearance+wall)
 *      = outer skin; casing = outer - inner (uniform-thickness shell).
 *   3. connector-driven bosses (fastener/thread) + cutouts (shaft/port/switch).
 *   4. optional split into `<id>__top` / `<id>__bottom` with a lip/groove rabbet.
 *
 * Defensive: emitted Python wraps every fragile step (offset/split) in
 * try/except, degrading to a passthrough union + (here) a warning chip rather
 * than breaking the document compile. JS-side sanity: wall>0, clearance>=0.
 *
 * @param {object} opts
 * @param {string[]} opts.targets       componentIds / featureIds to enclose
 * @param {number}   [opts.wall=2]      shell wall thickness (mm, must be > 0)
 * @param {number}   [opts.clearance=1] gap between parts and inner wall (mm, >= 0)
 * @param {'XY'|'XZ'|'YZ'|null} [opts.splitPlane=null]
 * @param {number|null} [opts.splitAt=null]  split position (default mid-bbox)
 * @param {boolean}  [opts.lip=true]    add a lip/groove rabbet at the split
 * @param {boolean}  [opts.bosses=true] add screw bosses at fastener connectors
 * @param {boolean}  [opts.cutouts=true] cut holes where connectors pierce the wall
 * @param {string}   [opts.componentId] owning component for the casing feature
 * @returns {Feature}
 */
export function addCasing({
    targets,
    wall = 2,
    clearance = 1,
    splitPlane = null,
    splitAt = null,
    lip = true,
    bosses = true,
    cutouts = true,
    componentId,
} = {}) {
    const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
    if (!list.length) throw new Error('addCasing: targets (componentIds/featureIds) required');
    // JS-side sanity guard — never emit a non-manufacturable casing silently.
    const safeWall = (typeof wall === 'number' && wall > 0) ? wall : 2;
    const safeClearance = (typeof clearance === 'number' && clearance >= 0) ? clearance : 1;
    const safeSplit = (splitPlane === 'XY' || splitPlane === 'XZ' || splitPlane === 'YZ')
        ? splitPlane : null;
    const params = {
        targets: list.slice(),
        wall: safeWall,
        clearance: safeClearance,
        splitPlane: safeSplit,
        splitAt: (typeof splitAt === 'number') ? splitAt : null,
        lip: !!lip,
        bosses: !!bosses,
        cutouts: !!cutouts,
        // DFM hint: the casing's intended min wall. The DFM pass (runner.js)
        // can read this to compare against the measured min wall.
        dfm: { minWallMm: safeWall },
    };
    const f = _mkFeature('Casing', params, {}, { componentId });
    const warnings = [];
    if (wall !== safeWall) warnings.push(`Casing: wall must be > 0 — coerced to ${safeWall}mm.`);
    if (clearance !== safeClearance) warnings.push(`Casing: clearance must be >= 0 — coerced to ${safeClearance}mm.`);
    if (splitPlane && !safeSplit) warnings.push(`Casing: unknown splitPlane '${splitPlane}' — ignored (no split).`);
    if (warnings.length) f.warnings = [...(f.warnings || []), ...warnings];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Add a parametric spur gear: a toothed disk with an optional centre bore and
 * an optional bolt circle of holes, in ONE feature. Size by exactly one of
 * `module`, `outerDiameter` (tip), or `pitchDiameter` (priority in that order;
 * default module 2). The emitter (emit.js emitGearPython) builds tapered
 * straight-flank teeth and degrades to a bored disk if the kernel ever chokes,
 * so this never breaks the document compile.
 *
 * @param {object} o
 * @param {number} [o.teeth=12]
 * @param {number} [o.module]            mm per tooth (preferred sizing input)
 * @param {number} [o.outerDiameter]     tip diameter mm → module = OD/(teeth+2)
 * @param {number} [o.pitchDiameter]     pitch diameter mm → module = PD/teeth
 * @param {number} [o.thickness=10]      mm
 * @param {number} [o.bore=0]            centre hole DIAMETER mm (0 = none)
 * @param {number} [o.pressureAngle=20]  deg
 * @param {number} [o.boltCount=0]       screw holes around the centre (0 = none)
 * @param {number} [o.boltCircleDiameter] diameter of the bolt-hole circle mm
 * @param {number} [o.boltHoleDiameter=3] each screw hole diameter mm (M3 = 3)
 * @param {number} [o.toothFillet=0]     smooth-edge fillet radius mm (0 = sharp)
 * @param {string} [o.componentId]
 * @returns {Feature}
 */
export function addGear({
    teeth = 12,
    module,
    outerDiameter,
    pitchDiameter,
    thickness = 10,
    bore = 0,
    pressureAngle = 20,
    boltCount = 0,
    boltCircleDiameter,
    boltHoleDiameter = 3,
    toothFillet = 0,
    componentId,
} = {}) {
    const z = Math.max(3, Math.round(Number(teeth) || 12));
    // Resolve module (mm/tooth): module > outer(tip) dia > pitch dia > default 2.
    let mod;
    if (Number(module) > 0) mod = Number(module);
    else if (Number(outerDiameter) > 0) mod = Number(outerDiameter) / (z + 2);
    else if (Number(pitchDiameter) > 0) mod = Number(pitchDiameter) / z;
    else mod = 2;
    const th = (Number(thickness) > 0) ? Number(thickness) : 10;
    const boreD = (Number(bore) > 0) ? Number(bore) : 0;
    const pa = (Number(pressureAngle) > 0 && Number(pressureAngle) < 45) ? Number(pressureAngle) : 20;
    const bc = Math.max(0, Math.round(Number(boltCount) || 0));
    const bcd = (Number(boltCircleDiameter) > 0) ? Number(boltCircleDiameter) : 0;
    const bhd = (Number(boltHoleDiameter) > 0) ? Number(boltHoleDiameter) : 3;
    const tf = (Number(toothFillet) >= 0 && Number.isFinite(Number(toothFillet))) ? Number(toothFillet) : 0;

    const params = {
        teeth: z, module: mod, thickness: th, bore: boreD, pressureAngle: pa,
        boltCount: bc, boltCircleDiameter: bcd, boltHoleDiameter: bhd, toothFillet: tf,
    };
    const f = _mkFeature('Gear', params, {}, { componentId });

    // JS-side sanity warnings (surface to the user, don't block the build).
    const rootD = mod * z - 2.5 * mod;   // ≈ root diameter
    const warnings = [];
    if (boreD > 0 && boreD >= rootD) warnings.push(`Gear: bore Ø${boreD}mm ≥ the root diameter (~${rootD.toFixed(1)}mm) — the centre hole would erase the teeth; reduce the bore.`);
    if (bc > 0 && bcd <= 0) warnings.push('Gear: boltCount set but boltCircleDiameter missing — bolt holes skipped.');
    if (bc > 0 && bcd > 0 && (bcd / 2 - bhd / 2) <= boreD / 2) warnings.push('Gear: the bolt circle overlaps the centre bore — increase boltCircleDiameter.');
    if (bc > 0 && bcd > 0 && (bcd / 2 + bhd / 2) >= rootD / 2) warnings.push('Gear: the bolt circle reaches into the teeth — reduce boltCircleDiameter.');
    if (warnings.length) f.warnings = [...(f.warnings || []), ...warnings];

    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Parametric domain generators ───────────────────────────────────────────────
// Each mirrors addGear: clamp/normalise params JS-side, build a feature of the
// registered type, surface non-blocking warnings, commit. Geometry is produced
// by the matching emitter in ./generators.js (fail-safe → degrades to a
// primitive so the document always compiles).

/** Belt pulley (flat / V-belt / round) with optional flanges + set screw. */
export function addPulley({
    diameter = 30, width = 10, bore = 0, pulleyType = 'flat',
    flange, flangeDiameter, flangeThickness, setScrew = 0, componentId,
} = {}) {
    const D = Number(diameter) > 0 ? Number(diameter) : 30;
    const W = Number(width) > 0 ? Number(width) : 10;
    const type = ['flat', 'vbelt', 'round'].includes(pulleyType) ? pulleyType : 'flat';
    const params = {
        diameter: D, width: W, bore: Number(bore) > 0 ? Number(bore) : 0, pulleyType: type,
        flange: flange === true ? true : (flange === false ? false : undefined),
        flangeDiameter: Number(flangeDiameter) > 0 ? Number(flangeDiameter) : undefined,
        flangeThickness: Number(flangeThickness) > 0 ? Number(flangeThickness) : undefined,
        setScrew: Number(setScrew) > 0 ? Number(setScrew) : 0,
    };
    const f = _mkFeature('Pulley', params, {}, { componentId });
    const warnings = [];
    if (params.bore > 0 && params.bore >= D) warnings.push(`Pulley: bore Ø${params.bore}mm ≥ the pulley Ø${D}mm — nothing left; reduce the bore.`);
    if (params.setScrew > 0 && params.bore <= 0) warnings.push('Pulley: setScrew set but no bore — the grub screw has no shaft to clamp.');
    if (warnings.length) f.warnings = [...(f.warnings || []), ...warnings];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Roller-chain sprocket sized by tooth count, chain pitch and roller diameter. */
export function addSprocket({
    teeth = 16, chainPitch = 12.7, rollerDiameter, thickness = 5, bore = 0,
    boltCount = 0, boltCircleDiameter, boltHoleDiameter = 3, componentId,
} = {}) {
    const N = Math.max(6, Math.round(Number(teeth) || 16));
    const P = Number(chainPitch) > 0 ? Number(chainPitch) : 12.7;
    const Dr = Number(rollerDiameter) > 0 ? Number(rollerDiameter) : P * 0.6;
    const params = {
        teeth: N, chainPitch: P, rollerDiameter: Dr,
        thickness: Number(thickness) > 0 ? Number(thickness) : 5,
        bore: Number(bore) > 0 ? Number(bore) : 0,
        boltCount: Math.max(0, Math.round(Number(boltCount) || 0)),
        boltCircleDiameter: Number(boltCircleDiameter) > 0 ? Number(boltCircleDiameter) : 0,
        boltHoleDiameter: Number(boltHoleDiameter) > 0 ? Number(boltHoleDiameter) : 3,
    };
    const f = _mkFeature('Sprocket', params, {}, { componentId });
    const pitchR = P / (2 * Math.sin(Math.PI / N));
    const warnings = [];
    if (params.bore > 0 && params.bore / 2 >= pitchR) warnings.push(`Sprocket: bore Ø${params.bore}mm reaches past the pitch circle (~Ø${(2 * pitchR).toFixed(1)}mm) — the teeth would vanish; reduce the bore.`);
    if (Dr >= P) warnings.push(`Sprocket: rollerDiameter ${Dr}mm ≥ chainPitch ${P}mm — rollers can't seat; check the chain spec.`);
    if (warnings.length) f.warnings = [...(f.warnings || []), ...warnings];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Aluminium T-slot framing extrusion (2020 / 3030 / 4040-style profile). */
export function addTSlotExtrusion({
    size = 20, length = 100, slotWidth, bore, slots = true, componentId,
} = {}) {
    const S = Number(size) > 0 ? Number(size) : 20;
    const params = {
        size: S,
        length: Number(length) > 0 ? Number(length) : 100,
        slotWidth: Number(slotWidth) > 0 ? Number(slotWidth) : Math.max(4, S * 0.3),
        bore: Number(bore) >= 0 ? Number(bore) : Math.max(4, S * 0.25),
        slots: slots !== false,
    };
    const f = _mkFeature('TSlotExtrusion', params, {}, { componentId });
    if (params.slotWidth >= S) {
        f.warnings = [...(f.warnings || []), `T-slot: slotWidth ${params.slotWidth}mm ≥ profile ${S}mm — the slots would sever the bar; reduce slotWidth.`];
    }
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Self-tapping screw boss/post with optional support ribs + base fillet. */
export function addScrewBoss({
    screwSize = 'M3', height = 8, outerDiameter, pilotDiameter, pilotDepth,
    ribs = 0, ribThickness, baseFillet = 0, componentId,
} = {}) {
    const params = {
        screwSize: typeof screwSize === 'string' ? screwSize : 'M3',
        height: Number(height) > 0 ? Number(height) : 8,
        outerDiameter: Number(outerDiameter) > 0 ? Number(outerDiameter) : undefined,
        pilotDiameter: Number(pilotDiameter) > 0 ? Number(pilotDiameter) : undefined,
        pilotDepth: Number(pilotDepth) > 0 ? Number(pilotDepth) : undefined,
        ribs: Math.max(0, Math.round(Number(ribs) || 0)),
        ribThickness: Number(ribThickness) > 0 ? Number(ribThickness) : undefined,
        baseFillet: Number(baseFillet) > 0 ? Number(baseFillet) : 0,
    };
    const f = _mkFeature('ScrewBoss', params, {}, { componentId });
    if (params.outerDiameter && params.pilotDiameter && params.pilotDiameter >= params.outerDiameter) {
        f.warnings = [...(f.warnings || []), `Screw boss: pilot Ø${params.pilotDiameter}mm ≥ outer Ø${params.outerDiameter}mm — no wall left; increase outerDiameter.`];
    }
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Hex or round PCB/panel standoff (spacer) with a through bore. */
export function addStandoff({
    shape = 'hex', size = 6, height = 10, bore, componentId,
} = {}) {
    const params = {
        shape: shape === 'round' ? 'round' : 'hex',
        size: Number(size) > 0 ? Number(size) : 6,
        height: Number(height) > 0 ? Number(height) : 10,
        bore: Number(bore) > 0 ? Number(bore) : Math.max(1.5, (Number(size) > 0 ? Number(size) : 6) * 0.4),
    };
    const f = _mkFeature('Standoff', params, {}, { componentId });
    if (params.bore >= params.size) {
        f.warnings = [...(f.warnings || []), `Standoff: bore Ø${params.bore}mm ≥ size ${params.size}mm — wall too thin/none; reduce the bore.`];
    }
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Parse an `airfoil` spec into NACA 4-digit { m, p, t } fractions-of-chord.
 * Accepts a 4-digit code ("4412", "0012"), or the presets "flat" / "cambered".
 * Falls back to a mild cambered section. Pure + total (never throws).
 */
export function parseAirfoil(spec) {
    const s = String(spec == null ? '' : spec).trim().toLowerCase();
    if (/^\d{4}$/.test(s)) {
        const m = Number(s[0]) / 100;          // max camber (frac of chord)
        const p = Number(s[1]) / 10;           // position of max camber (frac of chord)
        const t = Number(s.slice(2)) / 100;    // max thickness (frac of chord)
        return { m, p, t: t > 0 ? t : 0.1, code: s };
    }
    if (s === 'flat') return { m: 0, p: 0, t: 0.06, code: 'flat' };        // thin symmetric
    if (s === 'cambered') return { m: 0.04, p: 0.4, t: 0.10, code: 'cambered' };
    return { m: 0.04, p: 0.4, t: 0.12, code: '4412' };                     // sensible default
}

/**
 * Parametric fan / propeller / EDF rotor: a central hub with a ring of
 * `bladeCount` TWISTED AIRFOIL blades, lofted from a configurable cross-section
 * (NACA 4-digit, or flat/cambered presets) with a real geometric `pitch`
 * (mm/rev) setting the twist distribution. Optional bore, radial set-screw, and
 * an outer shroud/duct ring (for ducted EDF fans). The geometry is produced by
 * emitFanPython (fail-safe → degrades to untwisted blades → tapered-box blades,
 * so the document always compiles). This exists so the AI never hand-builds fan
 * blades out of boxes — a twisted airfoil loft is not expressible by hand.
 */
export function addFan({
    diameter = 80, bladeCount = 5, hubDiameter, hubHeight, bore = 0, setScrew = 0,
    airfoil = '4412', pitch, pitchAngleDeg, rootChord, tipChord, thicknessScale = 1,
    handed = 'ccw', shroud = false, shroudThickness, tipGap, componentId,
} = {}) {
    const D = Number(diameter) > 0 ? Number(diameter) : 80;
    const af = parseAirfoil(airfoil);
    const hubD = Number(hubDiameter) > 0 ? Number(hubDiameter) : Math.max(8, D * 0.35);
    const rootC = Number(rootChord) > 0 ? Number(rootChord) : Math.max(4, D * 0.18);
    const tipC = Number(tipChord) > 0 ? Number(tipChord) : Math.max(2, rootC * 0.6);
    // Geometric pitch (mm/rev). If an explicit blade angle is given, back out the
    // equivalent pitch at the 75%-radius reference station: P = 2π·r75·tan(angle).
    let P;
    if (Number(pitchAngleDeg) > 0 && Number(pitchAngleDeg) < 89) {
        const r75 = 0.75 * D / 2;
        P = 2 * Math.PI * r75 * Math.tan(Number(pitchAngleDeg) * Math.PI / 180);
    } else {
        P = Number(pitch) > 0 ? Number(pitch) : D;   // default ~1:1 pitch ratio
    }
    const params = {
        diameter: D,
        bladeCount: Math.max(1, Math.round(Number(bladeCount) || 5)),
        hubDiameter: hubD,
        hubHeight: Number(hubHeight) > 0 ? Number(hubHeight) : Math.max(6, rootC * 0.8),
        bore: Number(bore) > 0 ? Number(bore) : 0,
        setScrew: Number(setScrew) > 0 ? Number(setScrew) : 0,
        airfoil: af.code, camber: af.m, camberPos: af.p, thickness: af.t,
        pitch: P,
        rootChord: rootC, tipChord: tipC,
        thicknessScale: Number(thicknessScale) > 0 ? Number(thicknessScale) : 1,
        handed: handed === 'cw' ? 'cw' : 'ccw',
        shroud: shroud === true,
        shroudThickness: Number(shroudThickness) > 0 ? Number(shroudThickness) : 3,
        tipGap: Number(tipGap) >= 0 ? Number(tipGap) : 1,
    };
    const f = _mkFeature('Fan', params, {}, { componentId });
    const warnings = [];
    if (params.hubDiameter >= D) warnings.push(`Fan: hubDiameter Ø${params.hubDiameter}mm ≥ fan Ø${D}mm — no room for blades; reduce hubDiameter.`);
    if (params.bore > 0 && params.bore >= params.hubDiameter) warnings.push(`Fan: bore Ø${params.bore}mm ≥ hub Ø${params.hubDiameter}mm — the hub would vanish; reduce the bore.`);
    if (params.bladeCount < 2) warnings.push('Fan: bladeCount < 2 — a single blade is unbalanced; most fans use 3+.');
    if (params.setScrew > 0 && params.bore <= 0) warnings.push('Fan: setScrew set but no bore — the grub screw has no shaft to clamp.');
    if (warnings.length) f.warnings = [...(f.warnings || []), ...warnings];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── P0 foundation generators (structural / joining / drivetrain / enclosure) ────
// Each mirrors the family above: clamp JS-side, build a typed feature, surface
// non-blocking warnings, commit. Geometry is the matching fail-safe emitter in
// ./generators.js. See PLAN-parametric-generators-checklist.md.

const _num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const _int = (v, d) => Math.max(0, Math.round(Number(v) || d));

/** Flat plate with a centred hole grid (the foundational host part). */
export function addMountingPlate(i = {}) {
    const params = {
        length: _num(i.length, 60), width: _num(i.width, 40), thickness: _num(i.thickness, 4),
        holeDia: _num(i.holeDia, 0), rows: _int(i.rows, 1), cols: _int(i.cols, 1),
        pitchX: _num(i.pitchX, 10), pitchY: _num(i.pitchY, 10),
        cornerRadius: _num(i.cornerRadius, 0),
        countersinkDia: _num(i.countersinkDia, 0), countersinkDepth: _num(i.countersinkDepth, 0),
    };
    const f = _mkFeature('MountingPlate', params, {}, { componentId: i.componentId });
    const w = [];
    if (params.holeDia > 0 && (params.cols - 1) * params.pitchX > params.length) w.push('Mounting plate: hole grid is wider than the plate — increase length or reduce cols/pitchX.');
    if (params.holeDia > 0 && (params.rows - 1) * params.pitchY > params.width) w.push('Mounting plate: hole grid is taller than the plate — increase width or reduce rows/pitchY.');
    if (w.length) f.warnings = [...(f.warnings || []), ...w];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Right-angle / angled L-bracket with bolt holes + optional gusset. */
export function addBracket(i = {}) {
    const params = {
        armA: _num(i.armA, 40), armB: _num(i.armB, 40), width: _num(i.width, 30),
        thickness: _num(i.thickness, 4), holeDia: _num(i.holeDia, 4),
        holesPerArm: _int(i.holesPerArm, 1), angle: _num(i.angle, 90), gusset: i.gusset === true,
    };
    const f = _mkFeature('Bracket', params, {}, { componentId: i.componentId });
    if (params.holeDia >= params.width) f.warnings = [...(f.warnings || []), `Bracket: holeDia Ø${params.holeDia} ≥ width ${params.width} — no material around the hole.`];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Heat-set threaded-insert boss. */
export function addThreadedInsertBoss(i = {}) {
    const params = {
        insertSize: typeof i.insertSize === 'string' ? i.insertSize : 'M3',
        height: _num(i.height, 8),
        outerDiameter: _num(i.outerDiameter, 0), holeDiameter: _num(i.holeDiameter, 0),
        holeDepth: _num(i.holeDepth, 0), ribs: _int(i.ribs, 0),
        ribThickness: _num(i.ribThickness, 0), baseFillet: _num(i.baseFillet, 0),
    };
    const f = _mkFeature('ThreadedInsertBoss', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Captive hex-nut trap (bottom or side entry). */
export function addNutTrap(i = {}) {
    const params = {
        nutSize: typeof i.nutSize === 'string' ? i.nutSize : 'M3',
        entry: i.entry === 'side' ? 'side' : 'bottom',
        block: _num(i.block, 0), height: _num(i.height, 0), boltClear: _num(i.boltClear, 0),
    };
    const f = _mkFeature('NutTrap', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Cantilever snap-fit hook. */
export function addSnapHook(i = {}) {
    const params = {
        armLength: _num(i.armLength, 16), armThickness: _num(i.armThickness, 2),
        width: _num(i.width, 8), hookDepth: _num(i.hookDepth, 1.5), leadAngle: _num(i.leadAngle, 45),
    };
    const f = _mkFeature('SnapHook', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Press-fit pocket/housing for a standard bearing. */
export function addBearingPocket(i = {}) {
    const params = {
        bearing: typeof i.bearing === 'string' ? i.bearing : '',
        od: _num(i.od, 0), id: _num(i.id, 0), width: _num(i.width, 0),
        wall: _num(i.wall, 0), shoulder: _num(i.shoulder, 0), throughHole: _num(i.throughHole, 0),
    };
    const f = _mkFeature('BearingPocket', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Faceplate motor mount (NEMA / gearmotor / brushless). */
export function addMotorMount(i = {}) {
    const params = {
        motorType: typeof i.motorType === 'string' ? i.motorType : '',
        body: _num(i.body, 0), boltPattern: _num(i.boltPattern, 0), screw: _num(i.screw, 0),
        shaft: _num(i.shaft, 0), pilot: _num(i.pilot, 0),
        kind: typeof i.kind === 'string' ? i.kind : '', thickness: _num(i.thickness, 4), plate: _num(i.plate, 0),
    };
    const f = _mkFeature('MotorMount', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Rigid two-bore shaft coupler. */
export function addShaftCoupler(i = {}) {
    const params = {
        bore1: _num(i.bore1, 5), bore2: _num(i.bore2, 0), outerDiameter: _num(i.outerDiameter, 0),
        length: _num(i.length, 0), setScrew: _num(i.setScrew, 0), screwsPerSide: _int(i.screwsPerSide, 1),
    };
    if (!(params.bore2 > 0)) params.bore2 = params.bore1;
    const f = _mkFeature('ShaftCoupler', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Wheel with shaft bore + optional tire groove / spokes / set-screw. */
export function addWheel(i = {}) {
    const params = {
        diameter: _num(i.diameter, 60), width: _num(i.width, 10), bore: _num(i.bore, 5),
        shaftType: ['round', 'D', 'hex'].includes(i.shaftType) ? i.shaftType : 'round',
        setScrew: _num(i.setScrew, 0), spokes: _int(i.spokes, 0), tireGroove: i.tireGroove !== false,
    };
    const f = _mkFeature('Wheel', params, {}, { componentId: i.componentId });
    if (params.bore >= params.diameter) f.warnings = [...(f.warnings || []), `Wheel: bore Ø${params.bore} ≥ wheel Ø${params.diameter}.`];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Toothed timing-belt pulley (GT2 / GT3 / HTD). */
export function addTimingPulley(i = {}) {
    const params = {
        teeth: Math.max(8, Math.round(Number(i.teeth) || 20)),
        beltType: typeof i.beltType === 'string' ? i.beltType : 'GT2',
        width: _num(i.width, 7), bore: _num(i.bore, 5), flanges: i.flanges !== false, setScrew: _num(i.setScrew, 0),
    };
    const f = _mkFeature('TimingPulley', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Knuckle / pinned hinge. */
export function addHinge(i = {}) {
    const params = {
        length: _num(i.length, 40), leafWidth: _num(i.leafWidth, 20), thickness: _num(i.thickness, 3),
        knuckles: Math.max(3, Math.round(Number(i.knuckles) || 5)), pinDia: _num(i.pinDia, 3), gap: _num(i.gap, 0.4),
    };
    const f = _mkFeature('Hinge', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Enclosure base box (open-top cavity + optional bosses/lip). */
export function addProjectBox(i = {}) {
    const params = {
        innerLength: _num(i.innerLength, 60), innerWidth: _num(i.innerWidth, 40), innerHeight: _num(i.innerHeight, 25),
        wall: _num(i.wall, 2), bosses: i.bosses === true,
        screwSize: typeof i.screwSize === 'string' ? i.screwSize : 'M3', lip: i.lip === true,
    };
    const f = _mkFeature('ProjectBox', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Base plate with standoff posts at a PCB hole pattern. */
export function addPCBTray(i = {}) {
    const params = {
        pcbLength: _num(i.pcbLength, 50), pcbWidth: _num(i.pcbWidth, 30), holeInset: _num(i.holeInset, 3.5),
        standoffHeight: _num(i.standoffHeight, 6), standoffDia: _num(i.standoffDia, 0),
        screwDia: _num(i.screwDia, 2.5), margin: _num(i.margin, 4), baseThickness: _num(i.baseThickness, 3),
    };
    const f = _mkFeature('PCBTray', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/** Control knob (knurled / fluted) with shaft bore + set-screw. */
export function addKnob(i = {}) {
    const params = {
        diameter: _num(i.diameter, 24), height: _num(i.height, 16),
        gripType: ['knurl', 'flute', 'smooth'].includes(i.gripType) ? i.gripType : 'knurl',
        flutes: _int(i.flutes, 0), shaftBore: _num(i.shaftBore, 6),
        shaftType: i.shaftType === 'D' ? 'D' : 'round', setScrew: _num(i.setScrew, 0), pointer: i.pointer === true,
    };
    const f = _mkFeature('Knob', params, {}, { componentId: i.componentId });
    if (params.shaftBore >= params.diameter) f.warnings = [...(f.warnings || []), `Knob: shaftBore Ø${params.shaftBore} ≥ knob Ø${params.diameter}.`];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── P1 generators (structural extras / motion / electronics / storage) ──────────

/** Leveling foot / bumper pad. */
export function addFoot(i = {}) {
    const params = { diameter: _num(i.diameter, 20), height: _num(i.height, 8), screw: _num(i.screw, 4), recessDia: _num(i.recessDia, 0), recessDepth: _num(i.recessDepth, 0) };
    const f = _mkFeature('Foot', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Standalone triangular gusset brace. */
export function addGusset(i = {}) {
    const params = { legA: _num(i.legA, 30), legB: _num(i.legB, 30), thickness: _num(i.thickness, 4), holeDia: _num(i.holeDia, 4) };
    const f = _mkFeature('Gusset', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Pull handle (two posts + grip bar). */
export function addHandle(i = {}) {
    const params = { span: _num(i.span, 80), height: _num(i.height, 30), gripDia: _num(i.gripDia, 12), postDia: _num(i.postDia, 0), screw: _num(i.screw, 4) };
    const f = _mkFeature('Handle', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Shaft → bolt-circle hub adapter. */
export function addShaftHub(i = {}) {
    const params = {
        bore: _num(i.bore, 5), shaftType: ['round', 'D', 'hex'].includes(i.shaftType) ? i.shaftType : 'round',
        flangeDiameter: _num(i.flangeDiameter, 0), hubDiameter: _num(i.hubDiameter, 0), hubHeight: _num(i.hubHeight, 0),
        boltCount: _int(i.boltCount, 4), boltCircle: _num(i.boltCircle, 0), boltHole: _num(i.boltHole, 3), setScrew: _num(i.setScrew, 3),
    };
    const f = _mkFeature('ShaftHub', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Lid / cover for a box opening. */
export function addLid(i = {}) {
    const params = { length: _num(i.length, 64), width: _num(i.width, 44), thickness: _num(i.thickness, 2), wall: _num(i.wall, 2), lipDepth: _num(i.lipDepth, 4), screw: _num(i.screw, 0) };
    const f = _mkFeature('Lid', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Linear gear rack. */
export function addRackGear(i = {}) {
    const params = { length: _num(i.length, 60), module: _num(i.module, 2), width: _num(i.width, 8), baseHeight: _num(i.baseHeight, 0), pressureAngle: _num(i.pressureAngle, 20) };
    const f = _mkFeature('RackGear', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Cylindrical-cell battery cradle. */
export function addBatteryHolder(i = {}) {
    const params = { cellType: typeof i.cellType === 'string' ? i.cellType : '18650', cellCount: _int(i.cellCount, 1), wall: _num(i.wall, 2) };
    const f = _mkFeature('BatteryHolder', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** 35mm DIN-rail mounting clip. */
export function addDINRailClip(i = {}) {
    const params = { width: _num(i.width, 20), platform: _num(i.platform, 45), screw: _num(i.screw, 3.4) };
    const f = _mkFeature('DINRailClip', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Saddle cable clip. */
export function addCableClip(i = {}) {
    const params = { cableDia: _num(i.cableDia, 6), wall: _num(i.wall, 2), screw: _num(i.screw, 3), width: _num(i.width, 8) };
    const f = _mkFeature('CableClip', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Gridfinity-compatible storage bin (42mm grid). */
export function addGridfinityBin(i = {}) {
    const params = { gridX: _int(i.gridX, 1), gridY: _int(i.gridY, 1), heightUnits: _int(i.heightUnits, 3), wall: _num(i.wall, 1.2) };
    const f = _mkFeature('GridfinityBin', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}
/** Inside-corner bracket for joining T-slot extrusions. */
export function addTSlotBracket(i = {}) {
    const params = { size: _num(i.size, 20), thickness: _num(i.thickness, 0), armLength: _num(i.armLength, 0), holeDia: _num(i.holeDia, 0) };
    const f = _mkFeature('TSlotBracket', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}

// ── Rotor / fluid-mover family (the addFan family — radial / helical / cross-flow) ─

/** Centrifugal/radial impeller (pump / blower). */
export function addImpeller(i = {}) {
    const params = {
        outerDiameter: _num(i.outerDiameter, 80), eyeDiameter: _num(i.eyeDiameter, 0),
        bladeCount: Math.max(2, Math.round(Number(i.bladeCount) || 7)),
        bladeHeight: _num(i.bladeHeight, 0), backplate: _num(i.backplate, 0), bladeThickness: _num(i.bladeThickness, 0),
        curve: ['backward', 'radial', 'forward'].includes(i.curve) ? i.curve : 'backward',
        wrapAngle: Number.isFinite(Number(i.wrapAngle)) ? Number(i.wrapAngle) : 0,
        shroud: ['open', 'semi', 'closed'].includes(i.shroud) ? i.shroud : 'open',
        bore: _num(i.bore, 0), setScrew: _num(i.setScrew, 0), hubHeight: _num(i.hubHeight, 0),
    };
    const f = _mkFeature('Impeller', params, {}, { componentId: i.componentId });
    const w = [];
    if (params.eyeDiameter > 0 && params.eyeDiameter >= params.outerDiameter) w.push(`Impeller: eyeDiameter Ø${params.eyeDiameter} ≥ outer Ø${params.outerDiameter} — no room for vanes.`);
    if (params.bore > 0 && params.bore >= (params.eyeDiameter || params.outerDiameter * 0.35)) w.push('Impeller: bore is wider than the eye — reduce the bore.');
    if (w.length) f.warnings = [...(f.warnings || []), ...w];
    getDocumentStore().commit(addFeatureChange(f)); return f;
}

/** Auger / Archimedes screw / screw conveyor. */
export function addAuger(i = {}) {
    const params = {
        shaftDiameter: _num(i.shaftDiameter, 10), flightDiameter: _num(i.flightDiameter, 30),
        length: _num(i.length, 80), pitch: _num(i.pitch, 0), flightThickness: _num(i.flightThickness, 0),
        bore: _num(i.bore, 0), handed: i.handed === 'left' ? 'left' : 'right',
    };
    const f = _mkFeature('Auger', params, {}, { componentId: i.componentId });
    if (params.flightDiameter <= params.shaftDiameter) f.warnings = [...(f.warnings || []), `Auger: flightDiameter Ø${params.flightDiameter} ≤ shaft Ø${params.shaftDiameter} — no flight.`];
    getDocumentStore().commit(addFeatureChange(f)); return f;
}

/** Cross-flow / squirrel-cage blower wheel. */
export function addBlowerWheel(i = {}) {
    const params = {
        diameter: _num(i.diameter, 50), length: _num(i.length, 40),
        bladeCount: Math.max(6, Math.round(Number(i.bladeCount) || 24)),
        bladeThickness: _num(i.bladeThickness, 0), bore: _num(i.bore, 5),
        curve: Number.isFinite(Number(i.curve)) ? Number(i.curve) : 30, ringWidth: _num(i.ringWidth, 0),
    };
    const f = _mkFeature('BlowerWheel', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}

/** Paddle / water wheel. */
export function addPaddleWheel(i = {}) {
    const params = {
        diameter: _num(i.diameter, 60), width: _num(i.width, 20),
        paddleCount: Math.max(3, Math.round(Number(i.paddleCount) || 8)),
        paddleThickness: _num(i.paddleThickness, 0), hubDiameter: _num(i.hubDiameter, 0), bore: _num(i.bore, 6),
    };
    const f = _mkFeature('PaddleWheel', params, {}, { componentId: i.componentId });
    getDocumentStore().commit(addFeatureChange(f)); return f;
}

// ── Transform features ────────────────────────────────────────────────────────

export function addMove(featureId, vector = [0, 0, 0], { componentId } = {}) {
    const f = _mkFeature('Move', { vector }, { body: bodyRef(featureId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addRotate(featureId, axis = 'Z', angle = 90, { componentId } = {}) {
    const f = _mkFeature('Rotate', { angle }, { body: bodyRef(featureId), axis: axisRef(axis) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addScale(featureId, factor = 1, { componentId } = {}) {
    const f = _mkFeature('Scale', { factor }, { body: bodyRef(featureId) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Align (E3.4) ─────────────────────────────────────────────────────────────
/**
 * Align a source body to a target body by named datums. The kernel-side
 * resolution of `qDatum` vocabulary (spec 14) is still pending; until that
 * ships the emitter falls back to translate-by-offset only (composes Move
 * but no Rotate). The feature records both datums + the offset so when the
 * kernel datum resolver lands no JS-side change is needed.
 *
 * Datum strings follow the spec 14 vocabulary:
 *   'corner-min-min-min', 'corner-max-max-min', …
 *   'face-center-+Z', 'face-center-−X', …
 *   'edge-mid-…', 'vertex-…' (future).
 *
 * @param {string} sourceId
 * @param {string} targetId
 * @param {{ sourceDatum?: string, targetDatum?: string, offset?: [number,number,number], componentId?: string }} [opts]
 */
export function addAlign(sourceId, targetId, {
    sourceDatum = 'corner-min-min-min',
    targetDatum = 'corner-min-min-min',
    offset = [0, 0, 0],
    componentId,
} = {}) {
    if (!sourceId || !targetId) throw new Error('addAlign: sourceId and targetId required');
    const f = _mkFeature('Align',
        { sourceDatum, targetDatum, offset },
        { source: bodyRef(sourceId), target: bodyRef(targetId) },
        { componentId });
    f.warnings = [...(f.warnings || []),
        'Align: kernel datum vocabulary (spec 14) pending — translate-only fallback in effect.'];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Cosmetic Thread (E3.5) ───────────────────────────────────────────────────
/**
 * Stamp a face as "cosmetically threaded" (M3 × 0.5, …). No geometry change —
 * the spec is metadata for downstream BOM / DFM. The viewport renders a
 * hatched overlay on the tagged face.
 *
 * `spec` shape:
 *   { standard: 'M3 × 0.5', pitch: 0.5, nominalDiameter: 3,
 *     length: 10, direction: 'right-hand' | 'left-hand' }
 *
 * Defaults map to "M3 × 0.5 right-hand, 10mm" — the most common case.
 */
export function addCosmeticThread(faceDescriptor, {
    standard = 'M3 × 0.5',
    pitch = 0.5,
    nominalDiameter = 3,
    length = 10,
    direction = 'right-hand',
    componentId,
} = {}) {
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addCosmeticThread: faceDescriptor required');
    }
    const f = _mkFeature('CosmeticThread', {
        face: faceDescriptor, standard, pitch, nominalDiameter, length, direction,
    }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Pattern features ──────────────────────────────────────────────────────────

export function addLinearPattern(featureId, { direction = 'X', count = 2, spacing = 10, componentId } = {}) {
    const f = _mkFeature('LinearPattern',
        { count, spacing },
        { body: bodyRef(featureId), direction: axisRef(direction) },
        { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addCircularPattern(featureId, { axis = 'Z', count = 4, angle = 360, componentId } = {}) {
    const f = _mkFeature('CircularPattern',
        { count, angle },
        { body: bodyRef(featureId), axis: axisRef(axis) },
        { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Distribute `count` copies of a body along a path sketch. The path is
 * any sketch whose primary entity is an open curve (line / arc / spline).
 * Emits as `pattern_path(body, path=..., count=...)`.
 */
export function addPathPattern(bodyFeatureId, pathSketchId, { count = 5, componentId } = {}) {
    if (!bodyFeatureId || !pathSketchId) throw new Error('addPathPattern: body + path required');
    const f = _mkFeature('PathPattern', { count }, {
        body: bodyRef(bodyFeatureId),
        path: sketchRef(pathSketchId),
    }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addMirror(featureId, plane = 'XY', { componentId } = {}) {
    const f = _mkFeature('Mirror', {}, { body: bodyRef(featureId), plane: planeRef(plane) }, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Modifier: Draft ───────────────────────────────────────────────────────────
// Kernel-side draft is a stub for now (no-op on body) — wire the JS surface
// anyway so the palette + ribbon are consistent. When the kernel ships the
// real op the params shape here is what it'll consume.
export function addDraft(targetBodyId, { angle = 3, pullDirection = '+Z', faces = [], componentId } = {}) {
    if (!targetBodyId) throw new Error('addDraft: missing target body id');
    const f = _mkFeature('Draft',
        { angle, pullDirection, faces },
        { body: bodyRef(targetBodyId) },
        { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Reference geometry: Plane / Axis / Point ─────────────────────────────────
// Feature types declared in types.js with category REFERENCE; no body output.
// First-pass Plane supports only `offset` mode; other modes commit a placeholder
// feature with a warning chip so the surface is consistent.
export function addPlane({ type = 'offset', basePlane = 'XY', offset = 10, componentId } = {}) {
    const params = { type, basePlane, offset };
    const f = _mkFeature('Plane', params, {}, { componentId });
    if (type !== 'offset') {
        f.warnings = [...(f.warnings || []), `Plane mode '${type}' — coming soon (currently treated as offset)`];
    }
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addAxis({ origin = [0, 0, 0], direction = '+Z', componentId } = {}) {
    const f = _mkFeature('Axis', { origin, direction }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

export function addPoint({ position = [0, 0, 0], componentId } = {}) {
    const f = _mkFeature('Point', { position }, {}, { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Direct edit: Press-Pull Face (E3.1) ──────────────────────────────────────
/**
 * Translate a picked face along its outward normal by `distance` mm,
 * healing the body. `distance > 0` extrudes outward; `distance < 0`
 * pushes the face inward (cuts a slab).
 *
 * The face descriptor must carry the producing feature id (either as
 * `descriptor.feature` or `descriptor.featureId`) — that's how the op
 * roots its body input and how the kernel re-locates the face at
 * execution time. The kernel-side `push_pull_face` is defensive on any
 * resolution failure (non-planar face, unresolvable descriptor): it
 * returns the body unchanged so downstream features keep resolving.
 *
 * @param {object} faceDescriptor   — kind='face' descriptor with .feature / .featureId
 * @param {number} distance         — mm (signed)
 * @param {{ componentId?: string }} [opts]
 * @returns {Feature}
 */
export function addPushPullFace(faceDescriptor, distance, { componentId } = {}) {
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addPushPullFace: faceDescriptor required');
    }
    if (typeof distance !== 'number' || !Number.isFinite(distance)) {
        throw new Error('addPushPullFace: numeric distance required');
    }
    const targetFid = faceDescriptor.feature || faceDescriptor.featureId
        || (faceDescriptor.payload && faceDescriptor.payload.featureId);
    if (!targetFid) {
        throw new Error('addPushPullFace: face descriptor missing source feature id');
    }
    const f = _mkFeature('PushPullFace',
        { face: faceDescriptor, distance },
        { body: bodyRef(targetFid) },
        { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Direct edit: Move / Delete / Offset Face (E3.2) ──────────────────────────
/**
 * Translate a picked face along an arbitrary `[vx, vy, vz]` mm vector;
 * body re-heals. v1 honours only the normal component of the vector
 * (projects onto face normal → Press-Pull); the tangent component is
 * dropped silently — the JS feature stamps a warning chip so the user
 * knows.
 *
 * Defensive on every step. The kernel-side `move_face` returns the body
 * unchanged on any resolution / planarity failure so downstream features
 * keep resolving.
 *
 * @param {object} faceDescriptor  — kind='face' descriptor with .feature / .featureId
 * @param {[number, number, number]} vector
 * @param {{ componentId?: string }} [opts]
 */
export function addMoveFace(faceDescriptor, vector, opts = {}) {
    const { componentId, tangent } = opts || {};
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addMoveFace: faceDescriptor required');
    }
    if (!Array.isArray(vector) || vector.length !== 3
        || !vector.every(v => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error('addMoveFace: [vx, vy, vz] numeric vector required');
    }
    if (tangent !== undefined && tangent !== null) {
        if (!Array.isArray(tangent) || tangent.length !== 3
            || !tangent.every(v => typeof v === 'number' && Number.isFinite(v))) {
            throw new Error('addMoveFace: tangent (if provided) must be [tx, ty, tz] numeric vector');
        }
    }
    const targetFid = faceDescriptor.feature || faceDescriptor.featureId
        || (faceDescriptor.payload && faceDescriptor.payload.featureId);
    if (!targetFid) {
        throw new Error('addMoveFace: face descriptor missing source feature id');
    }
    const params = { face: faceDescriptor, vector: vector.slice() };
    if (tangent && tangent.some(v => Math.abs(v) > 1e-12)) {
        params.tangent = tangent.slice();
    }
    const f = _mkFeature('MoveFace',
        params,
        { body: bodyRef(targetFid) },
        { componentId });
    if (!params.tangent) {
        f.warnings = [...(f.warnings || []),
            'Move Face: v1 honours the normal component only — tangent slide is not yet supported.'];
    }
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Remove a face and heal the body. v1 kernel attempts OCCT's
 * ShapeUpgrade_RemoveInternalWires; on failure the body passes through
 * unchanged with a warning chip so the user knows to specify a
 * replacement surface manually.
 *
 * @param {object} faceDescriptor
 * @param {{ componentId?: string }} [opts]
 */
export function addDeleteFace(faceDescriptor, { componentId } = {}) {
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addDeleteFace: faceDescriptor required');
    }
    const targetFid = faceDescriptor.feature || faceDescriptor.featureId
        || (faceDescriptor.payload && faceDescriptor.payload.featureId);
    if (!targetFid) {
        throw new Error('addDeleteFace: face descriptor missing source feature id');
    }
    const f = _mkFeature('DeleteFace',
        { face: faceDescriptor },
        { body: bodyRef(targetFid) },
        { componentId });
    f.warnings = [...(f.warnings || []),
        'Delete Face: kernel heal is best-effort; open boundaries may pass through unchanged.'];
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

/**
 * Single-face thicken/thin along the face's outward normal. v1 is
 * semantically distinct from Press-Pull (parametric vs direct-edit) but
 * geometrically identical at the kernel layer — both route through
 * `push_pull_face` for planar faces. A future v2 specialises this to
 * OCCT's BRepOffsetAPI_MakeOffset for non-planar faces.
 *
 * @param {object} faceDescriptor
 * @param {number} distance  — signed mm
 * @param {{ componentId?: string }} [opts]
 */
export function addOffsetFace(faceDescriptor, distance, { componentId } = {}) {
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addOffsetFace: faceDescriptor required');
    }
    if (typeof distance !== 'number' || !Number.isFinite(distance)) {
        throw new Error('addOffsetFace: numeric distance required');
    }
    const targetFid = faceDescriptor.feature || faceDescriptor.featureId
        || (faceDescriptor.payload && faceDescriptor.payload.featureId);
    if (!targetFid) {
        throw new Error('addOffsetFace: face descriptor missing source feature id');
    }
    const f = _mkFeature('OffsetFace',
        { face: faceDescriptor, distance },
        { body: bodyRef(targetFid) },
        { componentId });
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Sketch on face (E2.1) ────────────────────────────────────────────────────
/**
 * Create a SketchOnFace feature whose sketch plane is resolved from a picked
 * face descriptor. Stores the descriptor itself so re-resolution survives
 * downstream edits via the topological-naming pipeline; if the face is later
 * consumed, the emit/resolver layer surfaces a "missing face" warning.
 *
 * The viewport face-pick UX (Viewport.svelte → studio.startFacePick) creates
 * the descriptor and hands it here; the sketcher (src/lib/sketch/boot.js)
 * resolves it to a centroid+normal via the measure API when entering.
 */
export function addSketchOnFace(faceDescriptor, { componentId, name } = {}) {
    if (!faceDescriptor || typeof faceDescriptor !== 'object') {
        throw new Error('addSketchOnFace: faceDescriptor required');
    }
    const f = _mkFeature('SketchOnFace', { face: faceDescriptor }, {}, { componentId });
    if (name) f.name = name;
    getDocumentStore().commit(addFeatureChange(f));
    return f;
}

// ── Parameters ────────────────────────────────────────────────────────────────

export function addDocumentParameter(name, value = 0, unit = 'mm', equation = null) {
    const p = makeParameter(name, value, unit, equation);
    getDocumentStore().commit(addParameterChange(p));
    return p;
}

export function setDocumentParameter(paramIdOrName, patch) {
    const store = getDocumentStore();
    // Allow callers to pass either the id or the name (convenience for UI).
    let paramId = paramIdOrName;
    if (!store.doc.parameters[paramIdOrName]) {
        for (const p of Object.values(store.doc.parameters)) {
            if (p.name === paramIdOrName) { paramId = p.id; break; }
        }
    }
    store.commit(updateParameterChange(paramId, patch));
}

/**
 * Delete a Document parameter by id or name. Silently no-ops if the
 * parameter doesn't exist.
 */
export function removeDocumentParameter(paramIdOrName) {
    const store = getDocumentStore();
    let paramId = paramIdOrName;
    if (!store.doc.parameters[paramIdOrName]) {
        for (const p of Object.values(store.doc.parameters)) {
            if (p.name === paramIdOrName) { paramId = p.id; break; }
        }
    }
    if (!store.doc.parameters[paramId]) return false;
    store.commit(removeParameterChange(paramId));
    return true;
}

// ── Generic edit / delete ─────────────────────────────────────────────────────

export function deleteFeature(featureId) {
    getDocumentStore().commit(removeFeatureChange(featureId));
}

export function setFeatureEnabled(featureId, enabled) {
    getDocumentStore().commit(setEnabledChange(featureId, enabled));
}

export function setFeatureParams(featureId, paramsPatch) {
    getDocumentStore().commit(setParamsChange(featureId, paramsPatch));
}

// ── Component-tree operations (Foundation 6 / commit 3) ──────────────────────
// Empty-component CRUD plus feature-move between components. Inserting an
// external STEP file as a component is a separate feature (out of scope here).

/**
 * Create a new (empty) component under `parentId`.
 * @returns {Component} the created component (also committed to the store)
 */
export function addComponent({ name = 'Component', parentId = 'root', origin, componentId, kind } = {}) {
    const id = componentId || newChangeId('cmp');
    const comp = makeComponent({ id, name, parentId, origin, kind });
    getDocumentStore().commit(addComponentChange(comp));
    return comp;
}

/**
 * Remove a component. Refuses to remove 'root'.
 *
 * Most features inside the removed subtree are re-parented to the removed
 * component's parent (organisational deletes preserve manual work like
 * sketches/extrudes).
 *
 * Exception: `StandardPart` features are *deleted* — those are typically
 * library placements (`placeLibraryPart` creates a Component whose only
 * payload is one StandardPart body). Re-parenting them would leave the
 * body rendering in the viewport after the user trashed the component,
 * which contradicts the user's "delete this thing" intent.
 */
export function removeComponent(componentId) {
    if (componentId === 'root') return null;
    const store = getDocumentStore();
    const doc = store.doc;
    // Build the set of component ids that are about to disappear (target +
    // every transitive descendant). Cycle-safe: componentDescendants does
    // its own seen-tracking.
    const condemnedIds = new Set([componentId]);
    try {
        const descendants = componentDescendants(doc, componentId);
        for (const c of descendants) condemnedIds.add(c.id);
    } catch (_) { /* defensive — fall back to single-id cascade */ }
    // Delete every StandardPart feature directly under the doomed subtree
    // BEFORE removing the components, so the removeComponentChange has
    // nothing to reassign for those.
    for (const f of Object.values(doc.features || {})) {
        if (f.type === 'StandardPart' && condemnedIds.has(f.componentId)) {
            store.commit(removeFeatureChange(f.id));
        }
    }
    store.commit(removeComponentChange(componentId));
    return componentId;
}

/**
 * Remove a component but KEEP its child components: children are orphaned
 * out of the doomed node first, with the FIRST child promoted into the
 * removed component's place and the remaining children re-parented under
 * that heir. Only the removed component's own StandardPart body is deleted
 * (via removeComponent on the then-childless node); everything below the
 * heir survives untouched.
 *
 * This is the default delete for parts and plain components in the tree —
 * the full-subtree cascade (removeComponent) is reserved for groups and
 * library part swaps.
 */
export function removeComponentPromote(componentId) {
    if (!componentId || componentId === 'root') return null;
    const store = getDocumentStore();
    const doc = store.doc;
    const removed = doc.components?.[componentId];
    if (!removed) return null;
    const newParent = (removed.parentId && doc.components[removed.parentId])
        ? removed.parentId
        : 'root';
    const kids = Object.values(doc.components).filter((c) => c.parentId === componentId);
    if (kids.length > 0) {
        const heir = kids[0];
        setComponentParent(heir.id, newParent);
        for (const k of kids.slice(1)) setComponentParent(k.id, heir.id);
    }
    return removeComponent(componentId);
}

/**
 * Dissolve a group (or any non-root component) in place: every child
 * component moves up to the dissolved node's parent (flat — no heir
 * promotion), then the node itself is removed. The UI gates this behind a
 * confirm dialog on the group's context menu.
 */
export function ungroupComponent(componentId) {
    if (!componentId || componentId === 'root') return null;
    const store = getDocumentStore();
    const doc = store.doc;
    const removed = doc.components?.[componentId];
    if (!removed) return null;
    const newParent = (removed.parentId && doc.components[removed.parentId])
        ? removed.parentId
        : 'root';
    const kids = Object.values(doc.components).filter((c) => c.parentId === componentId);
    for (const k of kids) setComponentParent(k.id, newParent);
    return removeComponent(componentId);
}

/**
 * First parent-child link between two raw components: wrap them in a new
 * group. The group is created where the target lived; target becomes the
 * group's first member (the "parent role"), the dropped child its second.
 * Returns the created group component, or null when either id is invalid.
 *
 * Caller is expected to have validated the move with canReparentComponent
 * (cycle / self / root guards) — setComponentParent re-checks defensively.
 */
export function groupComponents(targetId, childId) {
    if (!targetId || !childId || targetId === childId) return null;
    if (targetId === 'root' || childId === 'root') return null;
    const store = getDocumentStore();
    const doc = store.doc;
    const target = doc.components?.[targetId];
    const child = doc.components?.[childId];
    if (!target || !child) return null;
    const group = addComponent({
        name: `${target.name || 'Component'} group`,
        parentId: (target.parentId && doc.components[target.parentId]) ? target.parentId : 'root',
        kind: 'group',
    });
    setComponentParent(targetId, group.id);
    setComponentParent(childId, group.id);
    return group;
}

/**
 * Delete a feature, cascading the wrapping component when the feature is a
 * library part body and the component holds nothing else. Without this, the
 * Delete key on a placed part removes the body but leaves an empty
 * component husk in the tree. Child components survive via
 * removeComponentPromote.
 */
export function deleteFeatureCascade(featureId) {
    const store = getDocumentStore();
    const f = store.doc.features?.[featureId];
    if (!f) return;
    const cid = f.componentId;
    const comp = (cid && cid !== 'root') ? store.doc.components?.[cid] : null;
    if (comp && comp.kind !== 'group' && f.type === 'StandardPart') {
        const others = Object.values(store.doc.features)
            .filter((x) => x.componentId === cid && x.id !== featureId);
        if (others.length === 0) {
            removeComponentPromote(cid);
            return;
        }
    }
    deleteFeature(featureId);
}

/** Rename a component. No-op for 'root'. */
export function renameComponent(componentId, name) {
    if (componentId === 'root') return;
    getDocumentStore().commit(renameComponentChange(componentId, name));
}

/**
 * Move a feature into a different component. Missing target falls back to
 * 'root' (handled in fold.js).
 */
export function setFeatureComponent(featureId, componentId) {
    getDocumentStore().commit(setFeatureComponentChange(featureId, componentId));
}

/**
 * E6 v2 — reparent component `componentId` under `newParentId`. Guards
 * (self / root / cycle / no-op / missing-target) live in
 * src/lib/document/reparent.js#canReparentComponent; the fold handler
 * re-validates defensively. Returns true on commit, false when rejected.
 */
export function setComponentParent(componentId, newParentId) {
    if (!componentId || componentId === 'root') return false;
    if (componentId === newParentId) return false;
    const store = getDocumentStore();
    const doc = store.doc;
    const src = doc.components?.[componentId];
    if (!src) return false;
    // 'root' is always a valid target. Anything else must exist.
    if (newParentId !== 'root' && !doc.components?.[newParentId]) return false;
    if (src.parentId === newParentId) return false;
    // Walk target's ancestor chain; if we encounter componentId, it would
    // create a cycle. Mirrors canReparentComponent without importing the
    // svelte-side module from lib/.
    let cur = newParentId;
    const seen = new Set();
    while (cur && !seen.has(cur) && cur !== 'root') {
        if (cur === componentId) return false;
        seen.add(cur);
        const node = doc.components?.[cur];
        if (!node) break;
        cur = node.parentId || null;
    }
    store.commit(setComponentParentChange(componentId, newParentId));
    return true;
}

/**
 * Spec 18 v2 — write a placement transform onto a component. Used by the
 * snap-drag UX (app/viewport/snap_drag.js). `originPatch` is a partial
 * { position?, rotation?, scale? }; omitted fields are preserved.
 * Refuses on 'root' or missing components.
 *
 * @returns {boolean} true if the change was committed.
 */
export function setComponentOrigin(componentId, originPatch) {
    if (!componentId || componentId === 'root') return false;
    const store = getDocumentStore();
    const c = store.doc.components?.[componentId];
    if (!c) return false;
    store.commit(setComponentOriginChange(componentId, originPatch || {}));
    return true;
}

// ── Assumptions manifest (spec 09) ───────────────────────────────────────────

/**
 * Add an assumption to `doc.assumptions`. Accepts either a fully-formed
 * AssumptionRecord (with `id`) or a fields object that the factory will
 * fill in. Returns the created record (with id stamped).
 *
 * @param {object} fields  see makeAssumption()
 * @returns {object|null}  the persisted assumption, or null if duplicate.
 */
export function addAssumption(fields = {}) {
    const store = getDocumentStore();
    const rec = (fields && fields.id && fields.source) ? fields : makeAssumption(fields);
    // De-dup by (source, kind, detail, relatedFeatureId) — repeat imports
    // from the extractor shouldn't spam the manifest.
    const existing = (store.doc.assumptions || []).find(a =>
        a && a.source === rec.source && a.kind === rec.kind
        && a.detail === rec.detail
        && (a.relatedFeatureId || null) === (rec.relatedFeatureId || null));
    if (existing) return null;
    store.commit(addAssumptionChange(rec));
    return rec;
}

/** Mark an assumption acknowledged (or un-acknowledged). */
export function acknowledgeAssumption(assumptionId, acknowledged = true) {
    getDocumentStore().commit(acknowledgeAssumptionChange(assumptionId, acknowledged));
}

/** Remove a single assumption by id. */
export function removeAssumption(assumptionId) {
    getDocumentStore().commit(removeAssumptionChange(assumptionId));
}

/**
 * Clear all assumptions, or just the ones matching `{ source }`.
 * Pass `{ source: 'extractor' }` to drop only extractor entries.
 */
export function clearAssumptions(filter = null) {
    getDocumentStore().commit(clearAssumptionsChange(filter));
}

/**
 * Bridge an ExtractResult into AssumptionRecords. Called by the import
 * path that runs the deterministic extractor (spec 15) — each
 * AmbiguityNote becomes one record stamped source='extractor'.
 *
 * @param {{ ambiguities?: object[] }} extractResult
 * @param {{ relatedFeatureId?: string|null, severity?: string }} [opts]
 * @returns {object[]}  the records that were appended (skipped dupes excluded)
 */
export function ingestExtractorAmbiguities(extractResult, { relatedFeatureId = null, severity = 'info' } = {}) {
    const out = [];
    if (!extractResult || !Array.isArray(extractResult.ambiguities)) return out;
    for (const note of extractResult.ambiguities) {
        if (!note) continue;
        const rec = addAssumption({
            source: 'extractor',
            kind:   note.kind || 'extractor-ambiguity',
            detail: note.detail || '',
            defaultUsed: note.defaultUsed != null ? note.defaultUsed : null,
            alternatives: Array.isArray(note.alternatives) ? note.alternatives : null,
            citation: note.field || null,
            severity,
            relatedFeatureId,
        });
        if (rec) out.push(rec);
    }
    return out;
}

/**
 * Standard-parts hook (spec 09 #4 + spec 10).
 *
 * Inspect a feature for under-specified material/grade choices the catalog
 * had to default. v1 detects the bare-family case the extractor surfaces
 * (e.g. `entryId` starting with `aluminum-` but no grade segment, or a
 * `partRef` with `materialFamily` set without `grade`). For each match it
 * adds a source='standard-parts' assumption recording the default the
 * emitter picked.
 *
 * The caller (kernel integration / addStandardPart helper) decides when to
 * run this — it's a pure read off the feature record so it's safe to call
 * after every commit. Idempotent via the dedup in `addAssumption`.
 *
 * @param {object} feature
 * @returns {object[]}  the assumption records appended (may be empty)
 */
export function recordStandardPartGradeDefaults(feature) {
    if (!feature || !feature.params) return [];
    const out = [];
    const partRef = feature.params.partRef || null;
    const entryId = feature.params.entryId || (partRef && partRef.entryId) || null;
    // Heuristic 1: explicit materialFamily, no grade.
    if (partRef && partRef.materialFamily && !partRef.grade) {
        const family = String(partRef.materialFamily).toLowerCase();
        const defaultGrade = STANDARD_PART_DEFAULT_GRADES[family];
        if (defaultGrade) {
            const rec = addAssumption({
                source: 'standard-parts',
                kind:   'material-grade',
                detail: `${family} grade unspecified — defaulted to ${defaultGrade}`,
                defaultUsed: defaultGrade,
                alternatives: STANDARD_PART_ALTERNATIVES[family] || null,
                severity: 'info',
                citation: 'standard-parts catalog default',
                relatedFeatureId: feature.id || null,
            });
            if (rec) out.push(rec);
        }
    }
    // Heuristic 2: entryId hints at a family (aluminum-…, steel-…) without
    // an explicit grade in the suffix.
    if (entryId && typeof entryId === 'string') {
        const lower = entryId.toLowerCase();
        for (const family of Object.keys(STANDARD_PART_DEFAULT_GRADES)) {
            if (!lower.startsWith(`${family}-`)) continue;
            const tail = lower.slice(family.length + 1);
            // If the tail doesn't contain digits (a grade like "6061") the
            // entry is family-only and we record a default.
            if (!/\d/.test(tail)) {
                const defaultGrade = STANDARD_PART_DEFAULT_GRADES[family];
                const rec = addAssumption({
                    source: 'standard-parts',
                    kind:   'material-grade',
                    detail: `Standard part ${entryId} grade unspecified — defaulted to ${defaultGrade}`,
                    defaultUsed: defaultGrade,
                    alternatives: STANDARD_PART_ALTERNATIVES[family] || null,
                    severity: 'info',
                    citation: 'standard-parts catalog default',
                    relatedFeatureId: feature.id || null,
                });
                if (rec) out.push(rec);
            }
            break;
        }
    }
    return out;
}

/** Default grade picked when only a material family is specified. */
export const STANDARD_PART_DEFAULT_GRADES = Object.freeze({
    aluminum: '6061',
    steel:    '1018',
    stainless:'304',
    brass:    'C360',
    plastic:  'ABS',
});
export const STANDARD_PART_ALTERNATIVES = Object.freeze({
    aluminum: ['6061', '7075', '2024', '5052'],
    steel:    ['1018', '1045', '4140'],
    stainless:['304', '316', '17-4PH'],
    brass:    ['C360', 'C260'],
    plastic:  ['ABS', 'PLA', 'PETG', 'nylon'],
});

/**
 * Walk the live document and run `recordStandardPartGradeDefaults` over
 * every StandardPart feature. Convenience for boot / kernel post-emit.
 */
export function auditDocumentForAssumptions() {
    const store = getDocumentStore();
    const out = [];
    for (const fid of store.doc.featureOrder || []) {
        const f = store.doc.features[fid];
        if (!f || f.type !== 'StandardPart') continue;
        const added = recordStandardPartGradeDefaults(f);
        for (const a of added) out.push(a);
    }
    return out;
}

// ── Joints (spec 17 v1 — kinematics oracle) ──────────────────────────────────
/**
 * Create a Joint between two components.
 *
 * @param {object} fields  — see makeJoint().
 * @returns {object} the persisted Joint record.
 */
export function addJoint(fields = {}) {
    const j = makeJoint(fields);
    getDocumentStore().commit(addJointChange(j));
    return j;
}

/** Patch fields on an existing joint (kind/origin/axis/limits/drive). */
export function updateJoint(jointId, patch) {
    getDocumentStore().commit(updateJointChange(jointId, patch || {}));
}

/** Delete a joint by id. Idempotent. */
export function removeJoint(jointId) {
    getDocumentStore().commit(removeJointChange(jointId));
}

// ── Connectors (spec 18 v1 — component library / KSP-style mates) ───────────
/**
 * Create a Connector on a part / component. Connectors live independently
 * of features: they tag a parent (componentId or feature-owned partId) with
 * a typed mate site.
 *
 * @param {object} fields  — see makeConnector().
 * @returns {Connector}
 */
export function addConnector(fields = {}) {
    const c = makeConnector(fields);
    getDocumentStore().commit(addConnectorChange(c));
    return c;
}

/**
 * Patch fields on an existing connector (kind/origin/axis/size/mates_with/inducedJoint).
 *
 * Connectors are immutable by contract (see CLAUDE.md "The connector contract"):
 * if the record carries `locked: true` this op refuses the patch unless the
 * caller explicitly passes `{ force: true }`. Reserved for system-internal
 * cleanup (replaceComponent, cascade-on-remove); never use `force` in feature
 * code. To "change" a locked connector, delete (with force) and re-add.
 */
export function updateConnector(connectorId, patch, opts = {}) {
    const store = getDocumentStore();
    const existing = store.doc && store.doc.connectors && store.doc.connectors[connectorId];
    if (existing && existing.locked === true && opts.force !== true) {
        console.warn(`[connectors] updateConnector refused — ${connectorId} is locked. Pass { force: true } from system-internal paths only.`);
        return;
    }
    store.commit(updateConnectorChange(connectorId, patch || {}));
}

/**
 * Delete a connector by id. Idempotent.
 *
 * Same immutability check as updateConnector — locked records require
 * `{ force: true }`. Legitimate `force` callers: replaceComponent (clearing
 * the old part's connectors), component-removal cascade.
 */
export function removeConnector(connectorId, opts = {}) {
    const store = getDocumentStore();
    const existing = store.doc && store.doc.connectors && store.doc.connectors[connectorId];
    if (existing && existing.locked === true && opts.force !== true) {
        console.warn(`[connectors] removeConnector refused — ${connectorId} is locked. Pass { force: true } from system-internal paths only.`);
        return;
    }
    store.commit(removeConnectorChange(connectorId));
}

// ── Mates (Phase 2 — persistent mate records / swap-with-rebind) ─────────────
/**
 * Create a persistent Mate record. A Mate captures *why* a part is placed
 * (which host connector + which part connector → which placed component),
 * making the placement re-solvable when the part is swapped.
 *
 * Accepts either a fully-formed Mate (with `id`) or a fields object that the
 * factory fills in.
 *
 * @param {object} fields  — see makeMate().
 * @returns {Mate} the persisted Mate record.
 */
export function addMate(fields = {}) {
    const m = (fields && fields.id && fields.hostConnectorRef !== undefined) ? fields : makeMate(fields);
    getDocumentStore().commit(addMateChange(m));
    return m;
}

/** Patch fields on an existing mate. */
export function updateMate(mateId, patch) {
    getDocumentStore().commit(updateMateChange(mateId, patch || {}));
}

/** Delete a mate by id. Idempotent. */
export function removeMate(mateId) {
    getDocumentStore().commit(removeMateChange(mateId));
}

/**
 * Query helper — every Mate whose placed component is `componentId`.
 * Pure read off the live document.
 *
 * @param {string} componentId
 * @returns {Mate[]}
 */
export function matesForComponent(componentId) {
    if (!componentId) return [];
    const doc = getDocumentStore().doc;
    if (!doc || !doc.mates) return [];
    return Object.values(doc.mates).filter((m) => m && m.componentId === componentId);
}

// ── Bulk helpers — useful when scripting the document from the console ────────

/**
 * Empty the document. Cheap because we just hand the store a fresh DocumentStore.
 * Returns the new singleton.
 */
export function resetDocument() {
    // The previous lazy import was a leftover from a transient circular dep
    // that no longer exists — every other file in lib/document/ now imports
    // store.js statically. Vite was already pulling store.js into the main
    // chunk via those imports, so the dynamic wrapper here did nothing except
    // emit an INEFFECTIVE_DYNAMIC_IMPORT warning at build time.
    return Promise.resolve(resetDocumentStore());
}
