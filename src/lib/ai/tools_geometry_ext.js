/**
 * Extended geometry tools — exposes operations that already exist in
 * lib/document/operations.js but were never surfaced to the AI: sweep, loft,
 * helix, the rigid transforms (move / rotate / scale / align), torus, and
 * feature suppression. All take feature ids + scalars (no topology
 * descriptors), so they're robust for weak models to drive.
 *
 * Face-targeted direct edits (push/pull/move/offset/delete face) and
 * descriptor-driven fillet/chamfer/hole live in tools_selection.js because they
 * resolve against the live viewport selection.
 *
 * Every handler returns { ok, ... } and never throws — the document ops can
 * throw on bad input, so each call is wrapped.
 */

import {
    addSweep, addLoft, addHelix,
    addMove, addRotate, addScale, addAlign,
    addTorus, setFeatureEnabled, getDocumentStore,
} from '../../../lib/document/index.js';
import { N, S, B, feat, fail, vec3 } from './tools_util.js';

export const GEOMETRY_EXT_TOOLS = [
    {
        name: 'addSweep',
        description: 'Sweep a profile sketch along a path (a sketch or a curve/helix feature) to make a solid. Create the profile and path sketches first (addSketch), then pass their ids.',
        input_schema: {
            type: 'object',
            properties: {
                profileSketchId: S('Id of the sketch feature to sweep (the cross-section)'),
                pathFeatureId: S('Id of the path feature to sweep along (a sketch or helix)'),
                componentId: S('Target component id'),
            },
            required: ['profileSketchId', 'pathFeatureId'],
        },
        handler: (i) => {
            try { return feat(addSweep(i.profileSketchId, i.pathFeatureId, { componentId: i.componentId }), 'Swept profile along path'); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addLoft',
        description: 'Loft (blend) through two or more profile sketches in order to make a solid. Pass the sketch ids in the order they should blend.',
        input_schema: {
            type: 'object',
            properties: {
                sketchIds: { type: 'array', items: { type: 'string' }, description: 'Ordered sketch feature ids to loft through (>= 2)' },
                ruled: B('Straight (ruled) sections instead of a smooth blend'),
                componentId: S('Target component id'),
            },
            required: ['sketchIds'],
        },
        handler: (i) => {
            if (!Array.isArray(i.sketchIds) || i.sketchIds.length < 2) return fail('addLoft needs at least 2 sketch ids');
            try { return feat(addLoft(i.sketchIds, { ruled: !!i.ruled, componentId: i.componentId }), `Loft through ${i.sketchIds.length} sections`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addHelix',
        description: 'Create a helical curve (e.g. as a sweep path for a spring or thread). pitch = rise per turn (mm), height = total height (mm), radius = mm.',
        input_schema: {
            type: 'object',
            properties: {
                pitch: N('Rise per full turn (mm)'),
                height: N('Total height along the axis (mm)'),
                radius: N('Helix radius (mm)'),
                coneAngle: N('Cone half-angle for a tapered helix (degrees, default 0)'),
                lefthand: B('Left-handed instead of right-handed'),
                componentId: S('Target component id'),
            },
            required: ['pitch', 'height', 'radius'],
        },
        handler: (i) => {
            try {
                return feat(addHelix({
                    pitch: i.pitch, height: i.height, radius: i.radius,
                    coneAngle: i.coneAngle ?? 0, lefthand: !!i.lefthand, componentId: i.componentId,
                }), `Helix pitch=${i.pitch} h=${i.height} r=${i.radius}mm`);
            } catch (e) { return fail(e); }
        },
    },
    {
        name: 'addTorus',
        description: 'Create a torus (ring/donut) primitive: majorRadius is the ring radius, minorRadius is the tube radius. mm.',
        input_schema: {
            type: 'object',
            properties: {
                majorRadius: N('Ring (centre-line) radius (mm)'),
                minorRadius: N('Tube radius (mm)'),
                componentId: S('Target component id'),
            },
            required: ['majorRadius', 'minorRadius'],
        },
        handler: (i) => {
            try { return feat(addTorus({ majorRadius: i.majorRadius, minorRadius: i.minorRadius, componentId: i.componentId }), `Torus R=${i.majorRadius} r=${i.minorRadius}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addMove',
        description: 'Translate a body feature by a vector [dx, dy, dz] in mm (Z-up). Recorded as a feature so the move stays in the editable history.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body feature to move'),
                vector: { type: 'array', items: { type: 'number' }, description: '[dx, dy, dz] translation in mm' },
                componentId: S('Target component id'),
            },
            required: ['featureId', 'vector'],
        },
        handler: (i) => {
            const v = vec3(i.vector);
            if (!v) return fail('addMove needs vector [dx, dy, dz] of three numbers');
            try { return feat(addMove(i.featureId, v, { componentId: i.componentId }), `Move [${v.join(', ')}]mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addRotate',
        description: 'Rotate a body feature about a principal axis (X, Y, or Z) by an angle in degrees. Rotation follows the project\'s THREE XYZ convention.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body feature to rotate'),
                axis: S('Axis to rotate about', { enum: ['X', 'Y', 'Z'] }),
                angle: N('Rotation angle in degrees'),
                componentId: S('Target component id'),
            },
            required: ['featureId', 'axis', 'angle'],
        },
        handler: (i) => {
            try { return feat(addRotate(i.featureId, i.axis, i.angle, { componentId: i.componentId }), `Rotate ${i.angle}° about ${i.axis}`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addScale',
        description: 'Uniformly scale a body feature by a factor (1 = unchanged, 2 = double size).',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body feature to scale'),
                factor: N('Uniform scale factor (> 0)'),
                componentId: S('Target component id'),
            },
            required: ['featureId', 'factor'],
        },
        handler: (i) => {
            if (!(Number(i.factor) > 0)) return fail('addScale factor must be > 0');
            try { return feat(addScale(i.featureId, i.factor, { componentId: i.componentId }), `Scale ×${i.factor}`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addAlign',
        description: 'Align one body to another by a datum (default: min-corner to min-corner) plus an optional [dx,dy,dz] mm offset. Use to seat one part against another without computing coordinates by hand.',
        input_schema: {
            type: 'object',
            properties: {
                sourceId: S('Id of the body to move'),
                targetId: S('Id of the body to align against'),
                sourceDatum: S('Datum on the source (default corner-min-min-min)'),
                targetDatum: S('Datum on the target (default corner-min-min-min)'),
                offset: { type: 'array', items: { type: 'number' }, description: 'Optional [dx, dy, dz] mm offset after aligning' },
                componentId: S('Target component id'),
            },
            required: ['sourceId', 'targetId'],
        },
        handler: (i) => {
            const offset = i.offset ? (vec3(i.offset) || [0, 0, 0]) : [0, 0, 0];
            try {
                return feat(addAlign(i.sourceId, i.targetId, {
                    sourceDatum: i.sourceDatum || 'corner-min-min-min',
                    targetDatum: i.targetDatum || 'corner-min-min-min',
                    offset, componentId: i.componentId,
                }), `Aligned ${i.sourceId} to ${i.targetId}`);
            } catch (e) { return fail(e); }
        },
    },
    {
        name: 'undo',
        description: 'Revert the most recent change to the document — the "undo that" verb. Reverts ONE change (like Ctrl+Z); call it again to step further back. Prefer deleteFeature/setFeatureParams when you know exactly which feature to change; use undo when the user just says "undo" / "go back".',
        input_schema: { type: 'object', properties: {} },
        handler: () => {
            try {
                const store = getDocumentStore();
                if (!store || typeof store.undo !== 'function') return fail('undo unavailable');
                if (typeof store.canUndo === 'function' && !store.canUndo()) {
                    return { ok: true, undone: false, summary: 'Nothing to undo.' };
                }
                const done = store.undo();
                return { ok: true, undone: !!done, summary: done ? 'Reverted the last change.' : 'Nothing to undo.' };
            } catch (e) { return fail(e); }
        },
    },
    {
        name: 'suppressFeature',
        description: 'Enable or disable (suppress) a feature without deleting it — a non-destructive way to try the model with/without a feature. enabled:false removes it from the build; enabled:true brings it back.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Feature id to suppress/unsuppress'),
                enabled: B('true = active in the build, false = suppressed'),
            },
            required: ['featureId', 'enabled'],
        },
        handler: (i) => {
            try {
                setFeatureEnabled(i.featureId, !!i.enabled);
                return { ok: true, featureId: i.featureId, summary: `${i.enabled ? 'Enabled' : 'Suppressed'} ${i.featureId}` };
            } catch (e) { return fail(e); }
        },
    },
];

export default GEOMETRY_EXT_TOOLS;
