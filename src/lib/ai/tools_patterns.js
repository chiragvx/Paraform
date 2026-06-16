/**
 * Pattern tools — expand the patterning surface beyond single-axis linear /
 * radial (Phase 6 of PLAN-deterministic-design.md).
 *
 * Built WITHOUT new kernel primitives: a grid is composed from the existing,
 * fully-tested linear-pattern op (one pass along X, then that result along Y),
 * and the path pattern wires the already-emittable-but-previously-unexposed
 * `addPathPattern` op. Both reuse proven emit paths, so they ship safely.
 *
 * Shape matches the other tool modules: { name, description, input_schema, handler }.
 */

import { addLinearPattern, addPathPattern } from '../../../lib/document/index.js';

const N = (description, opts = {}) => ({ type: 'number', description, ...opts });
const S = (description, opts = {}) => ({ type: 'string', description, ...opts });

export const PATTERN_TOOLS = [
    {
        name: 'addGridPattern',
        description: 'Repeat a body in a 2D GRID — countX copies spaced spacingX along one axis, ×countY copies spaced spacingY along a second axis (e.g. a bolt grid, a vent array, a button matrix). Composed from two linear passes; the result is a single patterned body you can reference downstream. Dimensions in mm.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the body to pattern'),
                countX: N('Copies along the first axis (incl. original)'),
                spacingX: N('Spacing along the first axis (mm)'),
                countY: N('Copies along the second axis (incl. original)'),
                spacingY: N('Spacing along the second axis (mm)'),
                axisX: S('First axis (default X)', { enum: ['X', 'Y', 'Z'] }),
                axisY: S('Second axis (default Y)', { enum: ['X', 'Y', 'Z'] }),
                componentId: S('Target component id'),
            },
            required: ['featureId', 'countX', 'spacingX', 'countY', 'spacingY'],
        },
        handler: (i) => {
            const axisX = i.axisX || 'X';
            const axisY = i.axisY || 'Y';
            if (axisX === axisY) return { ok: false, error: 'addGridPattern: axisX and axisY must differ' };
            try {
                const rowF = addLinearPattern(i.featureId, { direction: axisX, count: i.countX, spacing: i.spacingX, componentId: i.componentId });
                if (!rowF || !rowF.id) return { ok: false, error: 'grid: first pass failed' };
                const gridF = addLinearPattern(rowF.id, { direction: axisY, count: i.countY, spacing: i.spacingY, componentId: i.componentId });
                if (!gridF || !gridF.id) return { ok: false, error: 'grid: second pass failed' };
                return { ok: true, featureId: gridF.id, rowFeatureId: rowF.id, summary: `Grid ${i.countX}×${i.countY} (${axisX}/${axisY})` };
            } catch (e) {
                return { ok: false, error: `addGridPattern threw: ${(e && e.message) || e}` };
            }
        },
    },
    {
        name: 'addPathPattern',
        description: 'Distribute count copies of a body EVENLY ALONG A PATH sketch (a curve / arc / spline / polyline) — for parts that follow a non-linear track (lights along a curve, treads, beads on a contour). First create the path with addSketch (an OPEN curve), then call this with the body id and the path sketch id.',
        input_schema: {
            type: 'object',
            properties: {
                bodyFeatureId: S('Id of the body to repeat'),
                pathSketchId: S('Id of the sketch whose curve is the path'),
                count: N('Number of copies along the path'),
                componentId: S('Target component id'),
            },
            required: ['bodyFeatureId', 'pathSketchId', 'count'],
        },
        handler: (i) => {
            try {
                const f = addPathPattern(i.bodyFeatureId, i.pathSketchId, { count: i.count, componentId: i.componentId });
                if (!f || !f.id) return { ok: false, error: 'addPathPattern failed' };
                return { ok: true, featureId: f.id, summary: `PathPattern ×${i.count}` };
            } catch (e) {
                return { ok: false, error: `addPathPattern threw: ${(e && e.message) || e}` };
            }
        },
    },
];

export default PATTERN_TOOLS;
