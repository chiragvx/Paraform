/**
 * Viewport-grounded (deixis) tools — let the assistant act on whatever the user
 * has PICKED in the 3D viewport when they say "fillet this edge", "put a hole
 * here", "push this face out". The picking layer (lib/picking/selection.js) is a
 * shared singleton, so the tool layer can read the live selection directly.
 *
 * Selection descriptors are the project's regen-safe identity (descriptor.js).
 * The geometry ops want a query-bearing ref, so we wrap each picked descriptor
 * with qDescriptor: { ...descriptor, query: qDescriptor(descriptor) }. That
 * single object satisfies both the op (which reads `.feature` for the target
 * body) and emit.js (which reads `.query` to resolve the exact face/edge).
 *
 * Everything is defensive: an empty / wrong-kind selection returns a clear,
 * actionable message ("click the edge and I'll chamfer it") instead of failing.
 */

import { addFillet, addChamfer, addHole, addPushPullFace, addOffsetFace, addDeleteFace, addExtrude, addCut, qDescriptor } from '../../../lib/document/index.js';
import { facePlane } from '../../../lib/sketch/sketch_data.js';
import { buildSketch } from './tools_sketch.js';
import { N, S, B, feat, fail, num } from './tools_util.js';

/** Read the live viewport selection defensively. Returns [] if unavailable. */
function liveSelection() {
    try {
        // Lazy require so a headless/test context (no picking layer) degrades
        // to "nothing selected" rather than a module-load failure.
        const mod = _picking;
        if (!mod || !mod.getPickingSelection) return [];
        const sel = mod.getPickingSelection();
        return (sel && typeof sel.toArray === 'function') ? sel.toArray() : [];
    } catch { return []; }
}

// Bind the picking module once, guarded. Static import would couple the AI
// layer to the viewport; a dynamic import resolved at first use keeps the
// dependency soft so tests and the kernel-only path never trip on it.
let _picking = null;
let _pickingTried = false;
function ensurePicking() {
    if (_pickingTried) return;
    _pickingTried = true;
    import('../../../lib/picking/selection.js').then((m) => { _picking = m; }).catch(() => { _picking = null; });
}
ensurePicking();

/** Picked entries of a given kind, each with a query-bearing ref attached. */
function pickedOfKind(kind) {
    return liveSelection()
        .filter((e) => e && e.descriptor && e.descriptor.kind === kind)
        .map((e) => {
            let query = null;
            try { query = qDescriptor(e.descriptor); } catch { query = null; }
            return {
                descriptor: e.descriptor,
                featureId: e.descriptor.feature || null,
                center: (e.payload && e.payload.center) || null,
                normal: (e.payload && e.payload.normal) || null,
                ref: query ? { ...e.descriptor, query } : null,
            };
        })
        .filter((e) => e.ref);
}

export const SELECTION_TOOLS = [
    {
        name: 'get_selection',
        description: 'Read what the user has currently picked in the 3D viewport, so "this face", "that edge", "here" resolve to exact geometry. Call this first when the user uses a pointing word and you are not sure what is selected. Returns the picked faces/edges/vertices with their owning feature id and (when known) centre and normal.',
        input_schema: { type: 'object', properties: {} },
        handler: () => {
            const items = liveSelection().map((e) => ({
                kind: e.descriptor && e.descriptor.kind,
                key: e.key || null,
                featureId: (e.descriptor && e.descriptor.feature) || null,
                center: (e.payload && e.payload.center) || null,
                normal: (e.payload && e.payload.normal) || null,
            }));
            return { ok: true, count: items.length, items };
        },
    },
    {
        name: 'fillet_selected_edges',
        description: 'Round the edge(s) the user has picked in the viewport at the given radius (mm) — the "fillet THIS edge" verb. Only the picked edges are rounded, not the whole body. If nothing (or no edge) is selected, it says so.',
        input_schema: {
            type: 'object',
            properties: { radius: N('Fillet radius (mm)') },
            required: ['radius'],
        },
        handler: (i) => {
            const edges = pickedOfKind('edge');
            if (!edges.length) return { ok: false, error: 'No edge is selected in the viewport. Ask the user to click the edge(s) they mean, then try again.' };
            const targetFeatureId = edges[0].featureId;
            const refs = edges.filter((e) => e.featureId === targetFeatureId).map((e) => e.ref);
            try { return feat(addFillet(targetFeatureId, { radius: i.radius, edges: refs }), `Filleted ${refs.length} picked edge(s) r=${i.radius}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'chamfer_selected_edges',
        description: 'Bevel the edge(s) the user has picked in the viewport by the given length (mm) — the "chamfer THIS edge" verb. Only the picked edges are chamfered.',
        input_schema: {
            type: 'object',
            properties: { length: N('Chamfer length (mm)') },
            required: ['length'],
        },
        handler: (i) => {
            const edges = pickedOfKind('edge');
            if (!edges.length) return { ok: false, error: 'No edge is selected in the viewport. Ask the user to click the edge(s) they mean, then try again.' };
            const targetFeatureId = edges[0].featureId;
            const refs = edges.filter((e) => e.featureId === targetFeatureId).map((e) => e.ref);
            try { return feat(addChamfer(targetFeatureId, { length: i.length, edges: refs }), `Chamfered ${refs.length} picked edge(s) ${i.length}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'hole_on_selected_face',
        description: 'Drill a hole into the face the user picked in the viewport — the "put an M3 hole HERE" verb. The hole is located on the picked face and drilled along its normal. through:true cuts all the way through.',
        input_schema: {
            type: 'object',
            properties: {
                diameter: N('Hole diameter (mm)'),
                depth: N('Hole depth (mm) — ignored when through:true'),
                through: B('Cut all the way through'),
                type: S('Hole type', { enum: ['simple', 'counterbore', 'countersink'] }),
                counterDia: N('Counterbore/countersink diameter (mm)'),
                counterDepth: N('Counterbore depth (mm)'),
            },
            required: ['diameter'],
        },
        handler: (i) => {
            const faces = pickedOfKind('face');
            if (!faces.length) return { ok: false, error: 'No face is selected in the viewport. Ask the user to click the face where the hole goes, then try again.' };
            const face = faces[0];
            try {
                return feat(addHole(face.featureId, {
                    diameter: i.diameter, depth: i.depth ?? 10, through: !!i.through,
                    type: i.type || 'simple', counterDia: i.counterDia ?? null, counterDepth: i.counterDepth ?? null,
                    face: { query: face.ref.query },
                }), `Hole Ø${i.diameter}mm on picked face`);
            } catch (e) { return fail(e); }
        },
    },
    {
        name: 'sketch_on_selected_face',
        description: 'Start a 2D sketch ON the face the user picked in the viewport — the "sketch on THIS face" verb. The sketch is anchored to that face (its centre + outward normal), so coordinates are millimetres in the face\'s local 2D frame. Returns sketchFeatureId — pass it to addExtrude to grow a boss/rib out of the face, or to build a tool body for addCut. Entity kinds are the same as addSketch (circle / rect / polygon / slot / polyline / line / arc / spline). Use this instead of addSketch whenever the new geometry must sit on existing geometry the user is pointing at.',
        input_schema: {
            type: 'object',
            properties: {
                entities: {
                    type: 'array',
                    description: 'The 2D entities making up the profile (same kinds as addSketch). mm, in the face-local frame.',
                    items: { type: 'object', additionalProperties: true },
                },
                name: S('Optional sketch name'),
            },
            required: ['entities'],
        },
        handler: (i) => {
            const faces = pickedOfKind('face');
            if (!faces.length) return { ok: false, error: 'No face is selected in the viewport. Ask the user to click the face to sketch on, then try again.' };
            const face = faces[0];
            if (!Array.isArray(face.center) || !Array.isArray(face.normal)) {
                return { ok: false, error: 'The picked face has no cached centre/normal, so I cannot anchor a sketch to it. Re-pick the face and try again.' };
            }
            let planeRef;
            try { planeRef = facePlane(face.descriptor, face.center, face.normal); }
            catch (e) { return fail(e); }
            const res = buildSketch(planeRef, i.entities, i.name || 'Sketch on face');
            if (!res.ok) return fail(res.error);
            const r = feat(res.feature, `Sketch on picked face with ${res.added} entit${res.added === 1 ? 'y' : 'ies'}`);
            if (res.warnings.length) r.warnings = res.warnings;
            r.sketchFeatureId = res.feature.id;
            return r;
        },
    },
    {
        name: 'cut_pocket_on_selected_face',
        description: 'Carve a profile-shaped pocket INTO the body at the face the user picked — the "cut THIS shape into this face" verb. It sketches the profile on the picked face, extrudes it INTO the body by `depth` mm along the face normal, and boolean-subtracts it, all in one step. Entity kinds match addSketch; coordinates are mm in the face-local 2D frame. For a plain round hole prefer hole_on_selected_face; use this for slots, rectangular pockets, and custom recesses.',
        input_schema: {
            type: 'object',
            properties: {
                entities: {
                    type: 'array',
                    description: 'The 2D profile entities (same kinds as addSketch). mm, in the face-local frame.',
                    items: { type: 'object', additionalProperties: true },
                },
                depth: N('How deep to cut into the body along the face normal (mm)'),
                name: S('Optional name'),
            },
            required: ['entities', 'depth'],
        },
        handler: (i) => {
            const faces = pickedOfKind('face');
            if (!faces.length) return { ok: false, error: 'No face is selected in the viewport. Ask the user to click the face to cut into, then try again.' };
            const face = faces[0];
            const targetId = face.featureId;
            if (!targetId) return { ok: false, error: 'The picked face is not tied to a body I can cut. Re-pick a face on a solid body.' };
            if (!Array.isArray(face.center) || !Array.isArray(face.normal)) {
                return { ok: false, error: 'The picked face has no cached centre/normal, so I cannot anchor the pocket. Re-pick the face and try again.' };
            }
            const depth = num(i.depth, 0);
            if (!(depth > 0)) return fail('cut_pocket_on_selected_face needs depth > 0 (mm into the body)');
            let planeRef;
            try { planeRef = facePlane(face.descriptor, face.center, face.normal); }
            catch (e) { return fail(e); }
            const sk = buildSketch(planeRef, i.entities, i.name || 'Pocket profile');
            if (!sk.ok) return fail(sk.error);
            try {
                // The sketch plane's normal = the face's OUTWARD normal, so a
                // negative extrude drives the tool body INWARD to carve the pocket.
                const tool = addExtrude(sk.feature.id, { amount: -depth });
                const cut = addCut(targetId, [tool.id]);
                const r = feat(cut, `Cut a ${depth}mm pocket into the picked face of ${targetId}`);
                if (sk.warnings.length) r.warnings = sk.warnings;
                return r;
            } catch (e) { return fail(e); }
        },
    },
    {
        name: 'push_pull_selected_face',
        description: 'Push or pull the face the user picked in the viewport along its normal by a signed distance (mm) — positive grows the body, negative shrinks it. The "make this wall thicker / shove this face out" verb. The rest of the body stays put.',
        input_schema: {
            type: 'object',
            properties: { distance: N('Signed distance along the face normal (mm); + grows, - shrinks') },
            required: ['distance'],
        },
        handler: (i) => {
            const faces = pickedOfKind('face');
            if (!faces.length) return { ok: false, error: 'No face is selected in the viewport. Ask the user to click the face to push/pull, then try again.' };
            if (typeof i.distance !== 'number' || !Number.isFinite(i.distance)) return fail('push_pull_selected_face needs a numeric distance');
            try { return feat(addPushPullFace(faces[0].ref, i.distance), `Push/pulled picked face ${i.distance}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'offset_selected_face',
        description: 'Offset the face the user picked in the viewport outward (or inward, negative) by a distance (mm), thickening/thinning the local wall.',
        input_schema: {
            type: 'object',
            properties: { distance: N('Offset distance (mm); + outward, - inward') },
            required: ['distance'],
        },
        handler: (i) => {
            const faces = pickedOfKind('face');
            if (!faces.length) return { ok: false, error: 'No face is selected in the viewport. Ask the user to click the face, then try again.' };
            if (typeof i.distance !== 'number' || !Number.isFinite(i.distance)) return fail('offset_selected_face needs a numeric distance');
            try { return feat(addOffsetFace(faces[0].ref, i.distance), `Offset picked face ${i.distance}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'delete_selected_face',
        description: 'Remove the face the user picked in the viewport and heal the body — e.g. to delete a fillet face or a boss. Use sparingly; the body must remain valid after removal.',
        input_schema: { type: 'object', properties: {} },
        handler: () => {
            const faces = pickedOfKind('face');
            if (!faces.length) return { ok: false, error: 'No face is selected in the viewport. Ask the user to click the face to remove, then try again.' };
            try { return feat(addDeleteFace(faces[0].ref), 'Deleted picked face'); }
            catch (e) { return fail(e); }
        },
    },
];

export default SELECTION_TOOLS;
