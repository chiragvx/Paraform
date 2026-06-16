/**
 * Tool layer — maps the typed document operations onto Anthropic tool
 * definitions and dispatches tool calls.
 *
 *   AGENT_TOOLS              — array of { name, description, input_schema }
 *   dispatchTool(name, input) — validate + invoke + return JSON-serialisable result
 *
 * Design contract (PLAN.md Gap 1): the model is an agent with tools over the
 * ~70 typed ops in lib/document/operations.js. It NEVER emits raw Python — the
 * typed-op layer is the safety rail. We import only the public surface from
 * lib/document/index.js (and library/place.js, library/index.js, measure,
 * invariants) — never the internal change/fold machinery, and never touch
 * operations.js / index.js themselves (other agents own those).
 *
 * dispatchTool NEVER throws: it catches and returns { ok:false, error }. Write
 * ops return { ok:true, featureId, summary } so the agent can chain on the id.
 * Read/observe ops return their JSON payload directly.
 */

import {
    addBox, addCylinder, addSphere,
    addExtrude, addRevolve,
    addFillet, addChamfer, addShell, addHole,
    addUnion, addCut, addIntersect,
    addCasing,
    addGear,
    addLinearPattern, addCircularPattern, addMirror,
    addStandardPart,
    addDocumentParameter, setDocumentParameter,
    setFeatureParams, deleteFeature,
    addComponent,
    addMate,
    getDocumentStore,
} from '../../../lib/document/index.js';
import { placeLibraryPart } from '../library/place.js';
import { findPart, loadLibrary, replaceComponent, isVerifiedPart } from '../library/index.js';
import { measure as measureKernel } from '../measure/api.js';
import { runAllInvariants } from '../invariants/runner.js';
import { getAIContext } from './context.js';

// Extended capability modules. Each exports an array of { name, description,
// input_schema, handler } in the same shape as the core TOOLS below. They are
// kept in separate files so each capability group is independently sound and a
// broken module can be left un-wired without taking down the whole surface.
import { GEOMETRY_EXT_TOOLS } from './tools_geometry_ext.js';
import { SKETCH_TOOLS } from './tools_sketch.js';
import { SELECTION_TOOLS } from './tools_selection.js';
import { CONTEXT_TOOLS } from './tools_context.js';
import { VALIDATION_TOOLS } from './tools_validation.js';
import { DFM_TOOLS } from './tools_dfm.js';
import { ASSEMBLY_TOOLS } from './tools_assembly.js';
import { ASSEMBLY_CHECK_TOOLS } from './tools_assembly_check.js';
import { PLANNER_TOOLS } from './tools_planner.js';
import { VISION_TOOLS } from './tools_vision.js';
import { WEB_TOOLS } from './tools_web.js';
import { CODE_TOOLS } from './tools_code.js';
import { MECHANISM_TOOLS } from './tools_mechanism.js';
import { RECIPE_TOOLS } from './tools_recipes.js';
import { PLAN_TOOLS } from './tools_plan.js';
import { PATTERN_TOOLS } from './tools_patterns.js';

// ── Tool definitions ─────────────────────────────────────────────────────────
//
// Each entry: { name, description, input_schema, handler }. `handler` is the
// runtime that executes the op; it's stripped from what we ship to the model
// (only name/description/input_schema cross the wire). Schemas are JSON Schema
// objects: { type:'object', properties:{…}, required:[…] }.

const N = (desc, opts = {}) => ({ type: 'number', description: desc, ...opts });
const S = (desc, opts = {}) => ({ type: 'string', description: desc, ...opts });
const B = (desc) => ({ type: 'boolean', description: desc });

/** Wrap a created feature into the standard write-op result. */
function feat(f, summary) {
    if (!f || !f.id) return { ok: false, error: 'operation did not return a feature' };
    return { ok: true, featureId: f.id, name: f.name || f.type, summary: summary || `${f.type} ${f.id}` };
}

/**
 * Guard a pattern/transform whose source must be an EXISTING body. A dangling
 * featureId (a mistyped / hallucinated id, e.g. the model passing hole_…dd5 when
 * it created hole_…dd6) used to be accepted and then emit `n_<missing>` →
 * kernel "name not defined" compile crash. Returns an error string if the
 * feature is missing, plus a hint when the source is a Hole/cut (patterning a
 * hole replicates the whole bored body, not the hole — for a ring of holes use
 * addGear's bolt circle, or pattern the cutting TOOL before the cut). null = OK.
 */
function patternSourceError(featureId, op) {
    let f;
    try { f = getDocumentStore().doc.features[featureId]; } catch { return null; }
    if (!f) return { ok: false, error: `${op}: no feature with id '${featureId}'. Pass the id the creating op returned (check get_document_summary). A pattern repeats an existing BODY.` };
    if (f.type === 'Hole') return { ok: false, error: `${op}: '${featureId}' is a Hole (a subtractive cut, not a body) — patterning it repeats the whole bored body, not the hole. For a ring of screw holes use addGear's bolt circle, or place a cylinder tool, pattern THAT, then addCut.` };
    return null;
}

const TOOLS = [
    // ── Primitives ───────────────────────────────────────────────────────────
    {
        name: 'addBox',
        description: 'Create a rectangular box primitive. Sits on the Z=0 plane (Align.MIN on Z); "centered" centres it in XY only. Dimensions in mm.',
        input_schema: {
            type: 'object',
            properties: {
                length: N('Size along X (mm)'),
                width: N('Size along Y (mm)'),
                height: N('Size along Z (mm)'),
                centered: B('Centre in XY (default true)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['length', 'width', 'height'],
        },
        handler: (i) => feat(addBox(i), `Box ${i.length}×${i.width}×${i.height}mm`),
    },
    {
        name: 'addCylinder',
        description: 'Create a cylinder primitive on the Z=0 plane. radius and height in mm.',
        input_schema: {
            type: 'object',
            properties: {
                radius: N('Radius (mm)'),
                height: N('Height along Z (mm)'),
                centered: B('Centre in XY (default true)'),
                componentId: S('Target component id'),
            },
            required: ['radius', 'height'],
        },
        handler: (i) => feat(addCylinder(i), `Cylinder r=${i.radius} h=${i.height}mm`),
    },
    {
        name: 'addSphere',
        description: 'Create a sphere primitive. radius in mm.',
        input_schema: {
            type: 'object',
            properties: {
                radius: N('Radius (mm)'),
                componentId: S('Target component id'),
            },
            required: ['radius'],
        },
        handler: (i) => feat(addSphere(i), `Sphere r=${i.radius}mm`),
    },

    // ── Sketch-based ───────────────────────────────────────────────────────────
    {
        name: 'addExtrude',
        description: 'Extrude an existing sketch feature into a solid. Pass the sketch feature id.',
        input_schema: {
            type: 'object',
            properties: {
                sketchFeatureId: S('Id of the sketch feature to extrude'),
                amount: N('Extrude distance (mm)'),
                both: B('Extrude symmetrically both directions'),
                taper: N('Draft taper angle (degrees)'),
                componentId: S('Target component id'),
            },
            required: ['sketchFeatureId', 'amount'],
        },
        handler: (i) => {
            const { sketchFeatureId, ...rest } = i;
            return feat(addExtrude(sketchFeatureId, rest), `Extrude ${i.amount}mm`);
        },
    },
    {
        name: 'addRevolve',
        description: 'Revolve a sketch feature around an axis to make a solid of revolution.',
        input_schema: {
            type: 'object',
            properties: {
                sketchFeatureId: S('Id of the sketch feature to revolve'),
                angle: N('Revolve angle in degrees (default 360)'),
                axis: S('Axis to revolve about: X, Y, or Z', { enum: ['X', 'Y', 'Z'] }),
                componentId: S('Target component id'),
            },
            required: ['sketchFeatureId'],
        },
        handler: (i) => {
            const { sketchFeatureId, ...rest } = i;
            return feat(addRevolve(sketchFeatureId, rest), `Revolve ${i.angle ?? 360}°`);
        },
    },

    // ── Modify ─────────────────────────────────────────────────────────────────
    {
        name: 'addFillet',
        description: 'Round the edges of a target body with a radius (mm). With no edge list, rounds all edges.',
        input_schema: {
            type: 'object',
            properties: {
                targetFeatureId: S('Id of the body feature to fillet'),
                radius: N('Fillet radius (mm)'),
                componentId: S('Target component id'),
            },
            required: ['targetFeatureId', 'radius'],
        },
        handler: (i) => feat(addFillet(i.targetFeatureId, { radius: i.radius, componentId: i.componentId }), `Fillet r=${i.radius}mm`),
    },
    {
        name: 'addChamfer',
        description: 'Bevel the edges of a target body by a length (mm). With no edge list, chamfers all edges.',
        input_schema: {
            type: 'object',
            properties: {
                targetFeatureId: S('Id of the body feature to chamfer'),
                length: N('Chamfer length (mm)'),
                length2: N('Optional second length for asymmetric chamfer (mm)'),
                componentId: S('Target component id'),
            },
            required: ['targetFeatureId', 'length'],
        },
        handler: (i) => feat(addChamfer(i.targetFeatureId, { length: i.length, length2: i.length2 ?? null, componentId: i.componentId }), `Chamfer ${i.length}mm`),
    },
    {
        name: 'addShell',
        description: 'Hollow out a body to a wall thickness (mm), producing a shell.',
        input_schema: {
            type: 'object',
            properties: {
                targetFeatureId: S('Id of the body feature to shell'),
                thickness: N('Wall thickness (mm)'),
                componentId: S('Target component id'),
            },
            required: ['targetFeatureId', 'thickness'],
        },
        handler: (i) => feat(addShell(i.targetFeatureId, { thickness: i.thickness, componentId: i.componentId }), `Shell ${i.thickness}mm`),
    },
    {
        name: 'addHole',
        description: 'Drill a cylindrical hole into a target body. Defaults drill along +Z at the origin; pass through:true to cut all the way through.',
        input_schema: {
            type: 'object',
            properties: {
                targetBodyId: S('Id of the body feature to drill'),
                diameter: N('Hole diameter (mm)'),
                depth: N('Hole depth (mm) — ignored when through:true'),
                through: B('Cut all the way through'),
                type: S('Hole type', { enum: ['simple', 'counterbore', 'countersink'] }),
                counterDia: N('Counterbore/countersink diameter (mm)'),
                counterDepth: N('Counterbore depth (mm)'),
                componentId: S('Target component id'),
            },
            required: ['targetBodyId', 'diameter'],
        },
        handler: (i) => {
            const { targetBodyId, ...rest } = i;
            return feat(addHole(targetBodyId, rest), `Hole Ø${i.diameter}mm`);
        },
    },

    // ── Booleans ─────────────────────────────────────────────────────────────
    {
        name: 'addUnion',
        description: 'Boolean-union two or more body features into one solid.',
        input_schema: {
            type: 'object',
            properties: {
                featureIds: { type: 'array', items: { type: 'string' }, description: 'Ids of the bodies to union (>= 2)' },
                keepTools: B('Keep the input bodies renderable instead of consuming them'),
                componentId: S('Target component id'),
            },
            required: ['featureIds'],
        },
        handler: (i) => feat(addUnion(i.featureIds, { keepTools: i.keepTools, componentId: i.componentId }), `Union of ${i.featureIds.length}`),
    },
    {
        name: 'addCut',
        description: 'Boolean-subtract one or more tool bodies from a target body.',
        input_schema: {
            type: 'object',
            properties: {
                targetId: S('Id of the body to cut from'),
                toolIds: { type: 'array', items: { type: 'string' }, description: 'Ids of the tool bodies to subtract' },
                keepTools: B('Keep the tool bodies renderable'),
                componentId: S('Target component id'),
            },
            required: ['targetId', 'toolIds'],
        },
        handler: (i) => feat(addCut(i.targetId, i.toolIds, { keepTools: i.keepTools, componentId: i.componentId }), `Cut`),
    },
    {
        name: 'addIntersect',
        description: 'Boolean-intersect two or more bodies, keeping only their overlapping volume.',
        input_schema: {
            type: 'object',
            properties: {
                featureIds: { type: 'array', items: { type: 'string' }, description: 'Ids of the bodies to intersect (>= 2)' },
                keepTools: B('Keep the input bodies renderable'),
                componentId: S('Target component id'),
            },
            required: ['featureIds'],
        },
        handler: (i) => feat(addIntersect(i.featureIds, { keepTools: i.keepTools, componentId: i.componentId }), `Intersect of ${i.featureIds.length}`),
    },

    // ── Casing / cover generator (Phase 5) ────────────────────────────────────
    {
        name: 'add_casing',
        description: 'Generate a fitted, manufacturable enclosure around a set of components. The casing is DERIVED from the assembly\'s semantic connectors: screw bosses appear at fastener/thread connectors, and cutouts are cut where shafts/ports/switches pierce the wall. Because it reads connectors at compile time, swapping a part (replace_component) automatically relocates the casing\'s bosses/cutouts. Optionally split into top/bottom halves with a lip/groove. Dimensions in mm.',
        input_schema: {
            type: 'object',
            properties: {
                targets: { type: 'array', items: { type: 'string' }, description: 'Component ids (or feature ids) to enclose' },
                wall: N('Shell wall thickness (mm, default 2)'),
                clearance: N('Gap between parts and inner wall (mm, default 1)'),
                splitPlane: S('Split into halves along this plane', { enum: ['XY', 'XZ', 'YZ'] }),
                splitAt: N('Split position along the plane normal (mm; default mid-bbox)'),
                lip: B('Add a lip/groove rabbet at the split (default true)'),
                bosses: B('Add screw bosses at fastener/thread connectors (default true)'),
                cutouts: B('Cut holes where connectors pierce the wall (default true)'),
                componentId: S('Owning component for the casing feature'),
            },
            required: ['targets'],
        },
        handler: (i) => feat(addCasing(i), `Casing around ${Array.isArray(i.targets) ? i.targets.length : 0} component(s), wall=${i.wall ?? 2}mm${i.splitPlane ? `, split ${i.splitPlane}` : ''}`),
    },

    // ── Gear generator ────────────────────────────────────────────────────────
    {
        name: 'addGear',
        description: 'Create a parametric spur gear in ONE call: a toothed disk with an optional centre bore and an optional ring of screw holes (bolt circle). Do NOT try to build a gear from primitives + circular-pattern — use this. Size it by exactly one of module, outerDiameter (the overall/tip diameter), or pitchDiameter. For a ring of screw holes around the centre, set boltCount + boltCircleDiameter + boltHoleDiameter (an M3 screw clearance ≈ 3.4mm; tap ≈ 2.5mm). toothFillet rounds the tooth edges ("smooth teeth"). Sits on Z=0, spanning 0..thickness. Dimensions mm. Verify with measure {type:"bbox"} after.',
        input_schema: {
            type: 'object',
            properties: {
                teeth: N('Number of teeth (>= 3, default 12)'),
                module: N('Module = mm of pitch diameter per tooth (preferred sizing). Pitch dia = module×teeth; outer dia = module×(teeth+2).'),
                outerDiameter: N('Overall / tip diameter (mm). Sets module = outerDiameter/(teeth+2). Use when the user gives the gear\'s outside diameter.'),
                pitchDiameter: N('Pitch diameter (mm). Sets module = pitchDiameter/teeth.'),
                thickness: N('Gear thickness / face width (mm, default 10)'),
                bore: N('Centre hole DIAMETER (mm, default 0 = no bore)'),
                pressureAngle: N('Pressure angle (deg, default 20)'),
                boltCount: N('Number of screw holes evenly spaced around the centre (0 = none)'),
                boltCircleDiameter: N('Diameter of the circle the screw holes sit on (mm)'),
                boltHoleDiameter: N('Each screw-hole diameter (mm, default 3 for M3)'),
                toothFillet: N('Fillet radius for smooth tooth/edge rounding (mm, default 0 = sharp)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['teeth'],
        },
        handler: (i) => feat(addGear(i), `Gear ${i.teeth}T${i.outerDiameter ? ` OD${i.outerDiameter}` : i.module ? ` m${i.module}` : ''}×${i.thickness ?? 10}mm${i.bore ? ` bore Ø${i.bore}` : ''}${i.boltCount ? `, ${i.boltCount}× Ø${i.boltHoleDiameter ?? 3} bolts` : ''}`),
    },

    // ── Patterns ─────────────────────────────────────────────────────────────
    {
        name: 'addLinearPattern',
        description: 'Repeat a body in a line along an axis: count copies, spacing mm apart.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body to pattern'),
                direction: S('Axis: X, Y, or Z', { enum: ['X', 'Y', 'Z'] }),
                count: N('Number of copies including the original'),
                spacing: N('Spacing between copies (mm)'),
                componentId: S('Target component id'),
            },
            required: ['featureId', 'count', 'spacing'],
        },
        handler: (i) => patternSourceError(i.featureId, 'addLinearPattern')
            || feat(addLinearPattern(i.featureId, { direction: i.direction, count: i.count, spacing: i.spacing, componentId: i.componentId }), `LinearPattern ×${i.count}`),
    },
    {
        name: 'addCircularPattern',
        description: 'Repeat a body around an axis: count copies spread over an angle (degrees).',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body to pattern'),
                axis: S('Axis to rotate about: X, Y, or Z', { enum: ['X', 'Y', 'Z'] }),
                count: N('Number of copies including the original'),
                angle: N('Total spread angle in degrees (default 360)'),
                componentId: S('Target component id'),
            },
            required: ['featureId', 'count'],
        },
        handler: (i) => patternSourceError(i.featureId, 'addCircularPattern')
            || feat(addCircularPattern(i.featureId, { axis: i.axis, count: i.count, angle: i.angle, componentId: i.componentId }), `CircularPattern ×${i.count}`),
    },
    {
        name: 'addMirror',
        description: 'Mirror a body across a principal plane (XY, YZ, or XZ).',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body to mirror'),
                plane: S('Mirror plane', { enum: ['XY', 'YZ', 'XZ'] }),
                componentId: S('Target component id'),
            },
            required: ['featureId', 'plane'],
        },
        handler: (i) => patternSourceError(i.featureId, 'addMirror')
            || feat(addMirror(i.featureId, i.plane, { componentId: i.componentId }), `Mirror across ${i.plane}`),
    },

    // ── Library / standard parts ───────────────────────────────────────────────
    {
        name: 'addStandardPart',
        description: 'Insert a catalog-resolved standard part by its entry id (e.g. "iso4762-m3-16"). Use search_library first to find the id.',
        input_schema: {
            type: 'object',
            properties: {
                entryId: S('Catalog entry id'),
                name: S('Optional display name'),
                componentId: S('Target component id'),
            },
            required: ['entryId'],
        },
        handler: (i) => feat(addStandardPart(i.entryId, { name: i.name ?? null, componentId: i.componentId }), `StandardPart ${i.entryId}`),
    },
    {
        name: 'placeLibraryPart',
        description: 'Place a component-library part (fastener, servo, bearing, bracket, …) as a new component, optionally mated to a host connector. Prefer this over modelling parts from primitives. Use search_library to find partId.',
        input_schema: {
            type: 'object',
            properties: {
                partId: S('Library part id'),
                hostConnectorId: S('Id of an existing connector on the host to mate against (optional — free placement if omitted)'),
                partConnectorId: S('Which connector on the part to mate (optional — first compatible used)'),
                parentComponentId: S('Parent component for the placement (default root)'),
                name: S('Optional display name'),
            },
            required: ['partId'],
        },
        handler: (i) => {
            const mate = {};
            if (i.hostConnectorId) mate.hostConnectorRef = { connectorId: i.hostConnectorId };
            if (i.partConnectorId) mate.partConnectorId = i.partConnectorId;
            const r = placeLibraryPart({
                partId: i.partId,
                mate,
                parentComponentId: i.parentComponentId || 'root',
                name: i.name,
            });
            if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'placeLibraryPart failed' };
            return { ok: true, componentId: r.componentId, jointId: r.jointId || null, members: r.members || null, summary: `Placed ${i.partId}` };
        },
    },
    {
        name: 'replace_component',
        description: 'Swap a placed component for a different library part, re-binding every mate that positioned it. The new part\'s connectors are matched to the old mates by role, then interfaceId, then kind/size, so e.g. swapping an SG90 servo for an MG90S keeps the mounts aligned. Returns rebound mates and any that could not be matched (unresolved) — review unresolved as warnings. Use list_components to find oldComponentId and search_library to find newPartId.',
        input_schema: {
            type: 'object',
            properties: {
                oldComponentId: S('Id of the placed component to replace (from list_components)'),
                newPartId: S('Library part id of the replacement (from search_library)'),
                name: S('Optional display name for the new component'),
            },
            required: ['oldComponentId', 'newPartId'],
        },
        handler: (i) => {
            const r = replaceComponent(i.oldComponentId, i.newPartId, { name: i.name });
            if (!r || r.ok === false) {
                return { ok: false, error: (r && r.error) || 'replaceComponent failed', unresolved: (r && r.unresolved) || undefined };
            }
            return {
                ok: true,
                newComponentId: r.newComponentId,
                rebound: r.rebound || [],
                unresolved: r.unresolved || [],
                summary: `Replaced ${i.oldComponentId} with ${i.newPartId}` +
                    ((r.unresolved && r.unresolved.length) ? ` (${r.unresolved.length} unresolved mate(s))` : ''),
            };
        },
    },
    {
        name: 'add_mate',
        description: 'Record a persistent mate between a host connector and a placed component\'s connector. Mates survive regeneration and are what replace_component re-solves against. Usually placeLibraryPart already records a mate for you; use this to add an extra constraint (e.g. a second mount hole) so a later swap rebinds it too.',
        input_schema: {
            type: 'object',
            properties: {
                componentId: S('The placed component this mate positions'),
                hostConnectorId: S('Id of the host connector being mated against'),
                partConnectorId: S('Id of the connector on the placed component'),
                inducedJoint: S('Optional joint kind the mate induces', { enum: ['fixed', 'revolute', 'prismatic'] }),
            },
            required: ['componentId', 'hostConnectorId', 'partConnectorId'],
        },
        handler: (i) => {
            const m = addMate({
                componentId: i.componentId,
                hostConnectorRef: { connectorId: i.hostConnectorId },
                partConnectorRef: { connectorId: i.partConnectorId },
                inducedJoint: i.inducedJoint || null,
            });
            return { ok: true, mateId: m.id, summary: `Mated ${i.partConnectorId} → ${i.hostConnectorId}` };
        },
    },

    // ── Parameters ─────────────────────────────────────────────────────────────
    {
        name: 'addDocumentParameter',
        description: 'Define a named document parameter (e.g. "wall=3"). Other features can reference it.',
        input_schema: {
            type: 'object',
            properties: {
                name: S('Parameter name (identifier)'),
                value: N('Numeric value'),
                unit: S('Unit (default mm)'),
                equation: S('Optional expression string'),
            },
            required: ['name', 'value'],
        },
        handler: (i) => {
            const p = addDocumentParameter(i.name, i.value, i.unit || 'mm', i.equation ?? null);
            return { ok: true, parameterId: p.id, summary: `Parameter ${i.name}=${i.value}` };
        },
    },
    {
        name: 'setDocumentParameter',
        description: 'Update an existing document parameter by id or name.',
        input_schema: {
            type: 'object',
            properties: {
                paramIdOrName: S('Parameter id or name'),
                value: N('New numeric value'),
                equation: S('New expression string'),
            },
            required: ['paramIdOrName'],
        },
        handler: (i) => {
            const patch = {};
            if (i.value !== undefined) patch.value = i.value;
            if (i.equation !== undefined) patch.equation = i.equation;
            setDocumentParameter(i.paramIdOrName, patch);
            return { ok: true, summary: `Updated parameter ${i.paramIdOrName}` };
        },
    },

    // ── Generic edit / delete ───────────────────────────────────────────────────
    {
        name: 'setFeatureParams',
        description: 'Patch the params of an existing feature (e.g. change a box height, a fillet radius). paramsPatch is merged onto the feature.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Feature id to edit'),
                paramsPatch: { type: 'object', description: 'Partial params object to merge', additionalProperties: true },
            },
            required: ['featureId', 'paramsPatch'],
        },
        handler: (i) => {
            setFeatureParams(i.featureId, i.paramsPatch);
            return { ok: true, featureId: i.featureId, summary: `Edited ${i.featureId}` };
        },
    },
    {
        name: 'deleteFeature',
        description: 'Delete a feature from the document by id.',
        input_schema: {
            type: 'object',
            properties: { featureId: S('Feature id to delete') },
            required: ['featureId'],
        },
        handler: (i) => {
            deleteFeature(i.featureId);
            return { ok: true, summary: `Deleted ${i.featureId}` };
        },
    },
    {
        name: 'addComponent',
        description: 'Create a new (empty) component/sub-assembly under a parent. Use to group related parts.',
        input_schema: {
            type: 'object',
            properties: {
                name: S('Component name'),
                parentId: S('Parent component id (default root)'),
            },
            required: ['name'],
        },
        handler: (i) => {
            const c = addComponent({ name: i.name, parentId: i.parentId || 'root' });
            return { ok: true, componentId: c.id, summary: `Component ${i.name}` };
        },
    },

    // ── Read / observe ───────────────────────────────────────────────────────
    {
        name: 'get_document_summary',
        description: 'Return a compact JSON snapshot of the current document: features (id, type, name, params), parameters, components, and body-emitting feature ids. Call this to see current state before editing.',
        input_schema: { type: 'object', properties: {} },
        handler: () => documentSummary(),
    },
    {
        name: 'get_timeline',
        description: 'Return the feature history as an ordered build timeline (each step: index, id, type, name, enabled, params). Use this to find which EARLIER step controls an attribute the user wants changed, then patch that step with setFeatureParams — downstream steps regenerate automatically. Prefer editing the responsible step over appending a new feature.',
        input_schema: { type: 'object', properties: {} },
        handler: () => timelineSummary(),
    },
    {
        name: 'list_components',
        description: 'List the components (sub-assemblies) in the document with their parent and origin.',
        input_schema: { type: 'object', properties: {} },
        handler: () => listComponentsResult(),
    },
    {
        name: 'search_library',
        description: 'Search the component library by keywords (e.g. "M3 cap screw", "SG90 servo", "608 bearing"). Returns ranked part hits with id, name, category, and connectors. Use the returned partId/entryId with placeLibraryPart or addStandardPart.',
        input_schema: {
            type: 'object',
            properties: {
                query: S('Free-text search query'),
                limit: N('Max hits to return (default 8)'),
            },
            required: ['query'],
        },
        handler: async (i) => {
            await loadLibrary();
            // Only surface parts that build to real geometry — skip placeholder
            // records so the agent never assembles from a stubbed box.
            const hits = (findPart(i.query) || []).filter((h) => isVerifiedPart(h.part));
            const limit = Math.max(1, Math.min(25, i.limit || 8));
            return {
                ok: true,
                count: hits.length,
                hits: hits.slice(0, limit).map((h) => ({
                    partId: h.part.id,
                    name: h.part.name,
                    category: h.part.category,
                    score: h.score,
                    connectors: (h.part.connectors || []).map((c) => ({ id: c.id, kind: c.kind, size: c.size ?? null })),
                })),
            };
        },
    },
    {
        name: 'measure',
        description: 'Run a geometric query against the freshly compiled geometry. The kernel is the arbiter — use this to verify dimensions, fit, and interference rather than asserting them. Supported types: bbox, volume, mass, surfaceArea, distance, holes, manifold, selfIntersection, interference, centroid, normal. Pass the query exactly as the kernel expects (type + its args, e.g. {type:"bbox", featureId:"box_x"}).',
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'object',
                    description: 'A single measure query: { type, ...args }. featureId fields reference feature ids from get_document_summary.',
                    additionalProperties: true,
                    properties: {
                        type: S('Query type', { enum: ['bbox', 'volume', 'mass', 'surfaceArea', 'distance', 'holes', 'manifold', 'selfIntersection', 'interference', 'centroid', 'normal'] }),
                    },
                    required: ['type'],
                },
            },
            required: ['query'],
        },
        handler: async (i) => {
            try {
                const r = await measureKernel(i.query);
                return { ok: true, result: r };
            } catch (e) {
                return { ok: false, error: `measure failed: ${(e && e.message) || e}` };
            }
        },
    },
    {
        name: 'run_invariants',
        description: 'Run the document-wide correctness checks (manifoldness, material assigned, fastener clearance, …). Returns pass/fail plus the failing warnings and errors. Use to confirm your work is valid before declaring success.',
        input_schema: { type: 'object', properties: {} },
        handler: async () => {
            try {
                const agg = await runAllInvariants({ measure: measureKernel });
                return {
                    ok: true,
                    pass: !!agg.pass,
                    warnings: (agg.warnings || []).map(_compactEntry),
                    errors: (agg.errors || []).map(_compactEntry),
                };
            } catch (e) {
                return { ok: false, error: `run_invariants failed: ${(e && e.message) || e}` };
            }
        },
    },
];

function _compactEntry(e) {
    return {
        id: e.id,
        scope: e.scope,
        category: e.category,
        targetId: e.targetId || null,
        message: e.result && e.result.message,
        suggestedFix: e.result && e.result.suggestedFix,
    };
}

// ── Document summary helpers ─────────────────────────────────────────────────

const BODY_EMITTING = new Set([
    'Box', 'Cylinder', 'Sphere', 'Torus', 'Extrude', 'Revolve', 'Sweep', 'Loft',
    'Fillet', 'Chamfer', 'Shell', 'Hole', 'Union', 'Cut', 'Intersect', 'Split',
    'Move', 'Rotate', 'Scale', 'Align', 'LinearPattern', 'CircularPattern',
    'PathPattern', 'Mirror', 'StandardPart', 'ImportedMesh',
    'PushPullFace', 'MoveFace', 'OffsetFace', 'DeleteFace', 'Draft',
    'Casing', 'Gear',
    // A BuildScript that assigns `result` renders a body (see emit.js _bs_run).
    // Helper-only scripts (no `result`) still list here harmlessly — the AI
    // verifies real geometry with measure.
    'BuildScript',
]);

/** Compact JSON view of the live document for the agent's eyes. */
export function documentSummary() {
    const doc = getDocumentStore().doc;
    const order = doc.featureOrder || Object.keys(doc.features || {});
    const features = order
        .map((id) => doc.features[id])
        .filter(Boolean)
        .map((f) => ({
            id: f.id,
            type: f.type,
            name: f.name || f.type,
            enabled: f.enabled !== false,
            componentId: f.componentId || 'root',
            params: _compactParams(f.params),
            warnings: (f.warnings && f.warnings.length) ? f.warnings : undefined,
        }));
    const parameters = Object.values(doc.parameters || {}).map((p) => ({
        id: p.id, name: p.name, value: p.value, unit: p.unit, equation: p.equation || null,
    }));
    const components = Object.values(doc.components || {}).map((c) => ({
        id: c.id, name: c.name, parentId: c.parentId || null,
    }));
    const bodies = features.filter((f) => BODY_EMITTING.has(f.type) && f.enabled).map((f) => f.id);
    return {
        ok: true,
        featureCount: features.length,
        features,
        parameters,
        components,
        bodies,
        connectors: Object.keys(doc.connectors || {}).length,
        joints: Object.keys(doc.joints || {}).length,
    };
}

/**
 * The document's feature history as an ordered timeline (Phase C3). Same data
 * as documentSummary but framed as a build sequence the agent can edit IN
 * PLACE: each step carries its position so the model can target an EARLIER step
 * by id and patch it with setFeatureParams — downstream steps regenerate
 * deterministically (the whole doc re-emits), so it must NOT append a duplicate
 * to "fix" something an earlier step already controls.
 */
export function timelineSummary() {
    const doc = getDocumentStore().doc;
    const order = doc.featureOrder || Object.keys(doc.features || {});
    const steps = order
        .map((id, index) => {
            const f = doc.features[id];
            if (!f) return null;
            return {
                index,
                id: f.id,
                type: f.type,
                name: f.name || f.type,
                enabled: f.enabled !== false,
                isBody: BODY_EMITTING.has(f.type),
                params: _compactParams(f.params),
            };
        })
        .filter(Boolean);
    return {
        ok: true,
        count: steps.length,
        steps,
        note: 'Steps are in build order. To change an EARLIER step, call setFeatureParams on its id — downstream steps regenerate automatically. Do NOT append a duplicate feature to fix what an earlier step controls.',
    };
}

/**
 * A compact, SYNCHRONOUS spatial digest of the current bodies, injected into
 * the system prompt each turn (see agent.js buildSystem). It tells the model
 * what exists and roughly WHERE in world space — so before it sketches a boss
 * or a pocket it knows "box_1's top face is at Z=20" instead of dropping the
 * profile at the origin. Extents are derived from feature params (primitives
 * sit Align.MIN on Z per the Z-up convention); exact bounds for derived bodies
 * still come from measure {type:"bbox"}.
 */
export function sceneDigest() {
    let doc;
    try { doc = getDocumentStore().doc; } catch { return ''; }
    const order = doc.featureOrder || Object.keys(doc.features || {});
    const bodies = order
        .map((id) => doc.features[id])
        .filter((f) => f && f.enabled !== false && BODY_EMITTING.has(f.type));
    if (!bodies.length) return '';
    const CAP = 24;
    const lines = bodies.slice(0, CAP).map((f) => {
        const label = f.name && f.name !== f.type ? `${f.type} "${f.name}"` : f.type;
        return `- ${f.id} (${label}): ${_extentHint(f)}`;
    });
    if (bodies.length > CAP) lines.push(`- …and ${bodies.length - CAP} more`);
    return `# Current bodies (Z-up, mm — exact bounds via measure {type:"bbox", featureId})\n${lines.join('\n')}`;
}

/** One-line spatial hint for a body-emitting feature, from its params. */
function _extentHint(f) {
    const p = f.params || {};
    const n = (v, d) => (Number.isFinite(+v) ? +v : d);
    switch (f.type) {
        case 'Box': {
            const L = n(p.length, 10), W = n(p.width, 10), H = n(p.height, 10);
            const xy = p.centered === false ? `X 0..${L}, Y 0..${W}` : `X ±${L / 2}, Y ±${W / 2}`;
            return `box ${L}×${W}×${H} — sits Z 0..${H} (top face Z=${H}), ${xy}`;
        }
        case 'Cylinder': {
            const R = n(p.radius, 5), H = n(p.height, 10);
            return `cylinder r=${R} h=${H} — axis +Z, sits Z 0..${H} (top face Z=${H})`;
        }
        case 'Sphere': {
            const R = n(p.radius, 5);
            return `sphere r=${R} — centred at origin (Z ${-R}..${R})`;
        }
        case 'Torus': {
            const mr = n(p.minorRadius, 2);
            return `torus — centred at origin (Z ${-mr}..${mr})`;
        }
        case 'Extrude': {
            const a = Math.abs(n(p.amount, 10));
            return `extruded profile, ${a}mm tall — measure bbox for exact placement`;
        }
        default:
            return 'measure bbox for exact placement';
    }
}

/** Keep params small — drop big base64/glb blobs the model can't use. */
function _compactParams(params) {
    if (!params || typeof params !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        if (k === 'glbBase64' || k === 'code') {
            out[k] = typeof v === 'string' ? `<${v.length} chars omitted>` : v;
        } else if (typeof v === 'string' && v.length > 200) {
            out[k] = v.slice(0, 200) + '…';
        } else {
            out[k] = v;
        }
    }
    return out;
}

function listComponentsResult() {
    const doc = getDocumentStore().doc;
    return {
        ok: true,
        components: Object.values(doc.components || {}).map((c) => ({
            id: c.id,
            name: c.name,
            parentId: c.parentId || null,
            origin: c.origin || null,
        })),
    };
}

// ── Aggregate every module's tools into one surface ──────────────────────────
//
// Combine the core TOOLS with the extended-capability modules, then defensively
// filter malformed entries and dedupe by name (first definition wins). A module
// that exported garbage can't poison the surface — its bad entries are dropped
// and the rest of the assistant keeps working.

function _collectTools() {
    const groups = [
        TOOLS, GEOMETRY_EXT_TOOLS, SKETCH_TOOLS, SELECTION_TOOLS,
        CONTEXT_TOOLS, VALIDATION_TOOLS, DFM_TOOLS, ASSEMBLY_TOOLS,
        ASSEMBLY_CHECK_TOOLS, PLANNER_TOOLS,
        VISION_TOOLS, WEB_TOOLS, CODE_TOOLS,
        MECHANISM_TOOLS, RECIPE_TOOLS, PLAN_TOOLS, PATTERN_TOOLS,
    ];
    const out = [];
    const seen = new Set();
    for (const g of groups) {
        if (!Array.isArray(g)) continue;
        for (const t of g) {
            if (!t || typeof t.name !== 'string' || !t.name) continue;
            if (typeof t.handler !== 'function') continue;
            if (!t.input_schema || typeof t.input_schema !== 'object') continue;
            if (seen.has(t.name)) continue;
            seen.add(t.name);
            out.push(t);
        }
    }
    return out;
}

const ALL_TOOLS = _collectTools();

// ── Public surface ───────────────────────────────────────────────────────────

/** Tool definitions sent to the model (no handlers). */
export const AGENT_TOOLS = ALL_TOOLS.map(({ name, description, input_schema }) => ({
    name, description, input_schema,
}));

const _byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// Id-bearing fields whose string value may be a human alias ("the bracket")
// rather than a literal id; resolved through the design context before
// dispatch. Array fields hold lists of ids.
const _ID_FIELDS = new Set([
    'featureId', 'targetFeatureId', 'targetBodyId', 'targetId', 'sketchFeatureId',
    'profileSketchId', 'pathFeatureId', 'sourceId', 'oldComponentId',
    'parentComponentId', 'componentId',
]);
const _ID_ARRAY_FIELDS = new Set(['featureIds', 'toolIds', 'sketchIds']);

/** Map alias names → ids on id-bearing fields. Never throws; echoes on failure. */
function resolveAliases(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    let ctx;
    try { ctx = getAIContext(); } catch { return input; }
    const out = { ...input };
    for (const [k, v] of Object.entries(out)) {
        if (_ID_FIELDS.has(k) && typeof v === 'string') {
            out[k] = ctx.resolveRef(v);
        } else if (_ID_ARRAY_FIELDS.has(k) && Array.isArray(v)) {
            out[k] = v.map((x) => (typeof x === 'string' ? ctx.resolveRef(x) : x));
        }
    }
    return out;
}

/**
 * Lightweight runtime validation of `input` against a tool's input_schema:
 * required fields present + basic type checks. Returns null if valid, or an
 * error string describing the first problem.
 */
function validateInput(schema, input) {
    if (!schema || schema.type !== 'object') return null;
    const obj = input || {};
    for (const req of schema.required || []) {
        if (obj[req] === undefined || obj[req] === null) {
            return `missing required field '${req}'`;
        }
    }
    const props = schema.properties || {};
    for (const [key, val] of Object.entries(obj)) {
        const spec = props[key];
        if (!spec || !spec.type) continue; // unknown / open field — allow
        // An explicit null/undefined on a NON-required field means "not provided"
        // — weak models routinely pass `componentId: null` for "use the default".
        // (Required fields are already enforced above.) Treat it as omitted, not
        // a type error, so a sane optional default doesn't get rejected.
        if (val === undefined || val === null) continue;
        const t = spec.type;
        if (t === 'number' && typeof val !== 'number') return `field '${key}' must be a number`;
        if (t === 'string' && typeof val !== 'string') return `field '${key}' must be a string`;
        if (t === 'boolean' && typeof val !== 'boolean') return `field '${key}' must be a boolean`;
        if (t === 'array' && !Array.isArray(val)) return `field '${key}' must be an array`;
        if (t === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `field '${key}' must be an object`;
        if (spec.enum && !spec.enum.includes(val)) return `field '${key}' must be one of ${spec.enum.join(', ')}`;
    }
    return null;
}

/**
 * Dispatch a tool call. NEVER throws — catches everything and returns a
 * JSON-serialisable result. The returned object is what gets sent back to
 * the model as the tool_result content.
 *
 * @param {string} name
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function dispatchTool(name, input) {
    const tool = _byName.get(name);
    if (!tool) return { ok: false, error: `unknown tool '${name}'` };
    // Resolve English aliases ("the bracket" → box_3) on id-bearing fields so
    // the user can talk in names while tools still receive ids.
    const resolved = resolveAliases(input);
    const validationError = validateInput(tool.input_schema, resolved);
    if (validationError) return { ok: false, error: `invalid input for ${name}: ${validationError}` };
    try {
        const r = await tool.handler(resolved || {});
        // Normalise: handlers always return an object; guarantee `ok` is set.
        if (r && typeof r === 'object' && r.ok === undefined) return { ok: true, ...r };
        return r;
    } catch (e) {
        return { ok: false, error: `${name} threw: ${(e && e.message) || String(e)}` };
    }
}
