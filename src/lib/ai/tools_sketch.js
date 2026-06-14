/**
 * Sketch authoring — the single biggest gap in the old tool surface. The kernel
 * has a full sketch/constraint engine and addExtrude/addRevolve, but there was
 * no way for the AI to CREATE the sketch it then extrudes.
 *
 * The SketchBuilder is a stateful object that cannot span discrete tool calls,
 * so we expose ONE declarative tool, addSketch, that takes a list of 2D
 * entities (in sketch-local mm) and builds + commits the whole profile in a
 * single atomic call — robust for weak models. The returned sketchFeatureId
 * feeds addExtrude / addRevolve / addSweep / addLoft.
 *
 * Entity kinds: point, line, polyline (the easy closed-profile path), circle,
 * arc, rect, polygon, slot, spline. Coordinates are millimetres on the chosen
 * principal plane (XY / XZ / YZ).
 */

import { newSketch } from '../../../lib/document/index.js';
import { stockPlane } from '../../../lib/sketch/sketch_data.js';
import { N, S, feat, fail, num } from './tools_util.js';

const PLANES = ['XY', 'XZ', 'YZ'];

/** Apply one declarative entity to a SketchBuilder. Returns null on success or an error string. */
export function applyEntity(b, e) {
    if (!e || typeof e !== 'object' || typeof e.kind !== 'string') return 'entity missing kind';
    const k = e.kind.toLowerCase();
    try {
        switch (k) {
            case 'point':
                b.point(num(e.x, 0), num(e.y, 0));
                return null;
            case 'line':
                b.line(num(e.x1, 0), num(e.y1, 0), num(e.x2, 0), num(e.y2, 0));
                return null;
            case 'polyline': {
                const pts = Array.isArray(e.points) ? e.points : [];
                if (pts.length < 2) return 'polyline needs >= 2 points';
                for (let j = 0; j < pts.length - 1; j++) {
                    b.line(num(pts[j][0], 0), num(pts[j][1], 0), num(pts[j + 1][0], 0), num(pts[j + 1][1], 0));
                }
                if (e.closed !== false) {
                    const a = pts[0], z = pts[pts.length - 1];
                    b.line(num(z[0], 0), num(z[1], 0), num(a[0], 0), num(a[1], 0));
                }
                return null;
            }
            case 'circle':
                if (!(num(e.radius, 0) > 0)) return 'circle needs radius > 0';
                b.circle(num(e.cx, 0), num(e.cy, 0), num(e.radius, 0));
                return null;
            case 'arc':
                if (!(num(e.radius, 0) > 0)) return 'arc needs radius > 0';
                b.arc(num(e.cx, 0), num(e.cy, 0), num(e.radius, 0), num(e.startAngle, 0), num(e.sweepAngle, 90));
                return null;
            case 'rect':
            case 'rectangle':
                b.rect(num(e.x1, 0), num(e.y1, 0), num(e.x2, 10), num(e.y2, 10));
                return null;
            case 'polygon': {
                const sides = (e.sides | 0);
                if (sides < 3) return 'polygon needs sides >= 3';
                if (!(num(e.radius, 0) > 0)) return 'polygon needs radius > 0';
                b.polygon(num(e.cx, 0), num(e.cy, 0), num(e.radius, 0), sides);
                return null;
            }
            case 'slot': {
                if (!(num(e.width, 0) > 0)) return 'slot needs width > 0';
                const aId = b.point(num(e.x1, 0), num(e.y1, 0));
                const bId = b.point(num(e.x2, 10), num(e.y2, 0));
                b.slot(aId, bId, num(e.width, 0));
                return null;
            }
            case 'spline': {
                const pts = Array.isArray(e.points) ? e.points.map((p) => [num(p[0], 0), num(p[1], 0)]) : [];
                if (pts.length < 2) return 'spline needs >= 2 points';
                b.spline(pts);
                return null;
            }
            default:
                return `unknown entity kind '${e.kind}'`;
        }
    } catch (err) {
        return `entity '${k}' failed: ${(err && err.message) || err}`;
    }
}

/**
 * Build + commit a sketch from declarative entities on an already-resolved
 * plane argument (a stock-plane string, a stockPlane/facePlane planeRef, etc.
 * — anything newSketch accepts). Shared by addSketch and the face-anchored
 * selection tools so the entity grammar and validation live in one place.
 *
 * Returns { ok:true, feature, added, warnings } or { ok:false, error }.
 */
export function buildSketch(planeArg, entities, name = 'Sketch') {
    const list = Array.isArray(entities) ? entities : [];
    if (!list.length) return { ok: false, error: 'sketch needs a non-empty entities array' };
    if (list.length > 80) return { ok: false, error: 'sketch: too many entities (max 80) — simplify the profile' };
    let b;
    try { b = newSketch(planeArg, { name }); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    const warnings = [];
    let added = 0;
    for (const e of list) {
        const err = applyEntity(b, e);
        if (err) warnings.push(err);
        else added++;
    }
    if (added === 0) return { ok: false, error: `sketch: no valid entities (${warnings.join('; ')})` };
    try { return { ok: true, feature: b.commit(), added, warnings }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

export const SKETCH_TOOLS = [
    {
        name: 'addSketch',
        description: [
            'Create a 2D sketch profile on a principal plane, then commit it as a sketch feature. Returns sketchFeatureId — pass that to addExtrude / addRevolve / addSweep / addLoft to make a solid.',
            'This is how you build any profile-driven part (brackets, gaskets, custom outlines) that primitives + booleans cannot express.',
            'PLACEMENT: a bare sketch sits at the WORLD ORIGIN on the chosen plane. To put a profile ON or RELATIVE TO an existing body, set `offset` (mm along the plane normal) to that body\'s face — e.g. to add a boss on top of a 20mm-tall box, sketch on XY with offset:20. Measure the body\'s bbox first (measure {type:"bbox", featureId}) so the offset is right. When the user has CLICKED a face, use sketch_on_selected_face instead to anchor to that exact face.',
            'entities is a list of 2D shapes in millimetres on the chosen plane. Supported kinds:',
            '  {kind:"circle", cx, cy, radius}',
            '  {kind:"rect", x1,y1, x2,y2}  (two opposite corners)',
            '  {kind:"polygon", cx, cy, radius, sides}',
            '  {kind:"slot", x1,y1, x2,y2, width}',
            '  {kind:"polyline", points:[[x,y],...], closed:true}  (EASIEST way to make a closed custom outline)',
            '  {kind:"line", x1,y1, x2,y2}   {kind:"arc", cx,cy,radius,startAngle,sweepAngle}   {kind:"spline", points:[[x,y],...]}   {kind:"point", x,y}',
            'For a solid profile use ONE closed shape (circle / rect / polygon / closed polyline), or a set of lines/arcs that form a single closed loop.',
        ].join('\n'),
        input_schema: {
            type: 'object',
            properties: {
                plane: S('Sketch plane', { enum: PLANES }),
                offset: N('Shift the plane along its normal by this many mm so the profile lands on/relative to an existing body (e.g. XY + offset 20 sits at Z=20, on top of a 20mm box). Default 0 = world origin.'),
                entities: {
                    type: 'array',
                    description: 'The 2D entities making up the profile (see description for kinds). mm, sketch-local.',
                    items: { type: 'object', additionalProperties: true },
                },
                name: S('Optional sketch name'),
            },
            required: ['entities'],
        },
        handler: (i) => {
            const planeName = PLANES.includes(i.plane) ? i.plane : 'XY';
            const offset = num(i.offset, 0);
            const res = buildSketch(stockPlane(planeName, offset), i.entities, i.name || 'Sketch');
            if (!res.ok) return fail(res.error);
            const where = offset ? `${planeName} (offset ${offset}mm)` : planeName;
            const r = feat(res.feature, `Sketch on ${where} with ${res.added} entit${res.added === 1 ? 'y' : 'ies'}`);
            if (res.warnings.length) r.warnings = res.warnings;
            r.sketchFeatureId = res.feature.id; // explicit alias so the model can chain into addExtrude
            return r;
        },
    },
];

export default SKETCH_TOOLS;
