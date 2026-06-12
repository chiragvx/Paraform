/**
 * Sketch operations — the convenience layer that lets users build sketches,
 * solve them, and consume them with Extrude / Revolve from a single import.
 *
 * Two interfaces:
 *   1. Quick helpers — one-call ops for the most common sketch shapes
 *        rectangleSketch, circleSketch, polygonSketch, slotSketch
 *   2. SketchBuilder — fluent API for building general sketches programmatically
 *
 * Both flow through the singleton DocumentStore the same way `addBox()` does.
 * Every sketch commits as a v4 `Sketch` feature whose `params.sketch` carries
 * the full SketchData payload, so it round-trips through the executor and the
 * kernel unchanged.
 *
 * No DOM — these are pure data operations. The visual sketch editor (when
 * built) calls into these same operations.
 */

import { getDocumentStore } from './store.js';
import {
    makeSketchData, stockPlane, facePlane, constructionPlane,
    addEntity, addConstraint, entityCount,
} from '../sketch/sketch_data.js';
import {
    makePoint, makeLine, makeCircle, makeArc, makeRectangle,
    makePolygon, makeSpline, makeSlotLinear, makeEllipse,
} from '../sketch/entities.js';
import {
    coincident, horizontal, vertical, parallel, perpendicular, tangent,
    equalLength, equalRadius, midpoint, symmetric,
    pointOnLine, pointOnCircle,
    fixedDistance, fixedAngle, fixedRadius, fixedPoint,
    horizontalDist, verticalDist,
} from '../sketch/constraints.js';
import { makeSketchFeature } from '../sketch/feature.js';
import { addFeatureChange } from './changelog.js';
import { solve as solveSketch } from '../sketch/solver/index.js';

// ── Plane resolution ──────────────────────────────────────────────────────────

/**
 * Convert a flexible plane argument into a SketchData planeRef. Accepts:
 *   - 'XY' / 'XZ' / 'YZ'                          → stockPlane(name)
 *   - { kind: 'stock'|'construction'|'face', ... } → returned as-is
 *   - a Descriptor                                → facePlane(descriptor)
 *   - a construction-feature id                   → constructionPlane(id)
 */
function resolvePlane(arg) {
    if (!arg) return stockPlane('XY');
    if (typeof arg === 'string') {
        if (['XY', 'XZ', 'YZ'].includes(arg)) return stockPlane(arg);
        return constructionPlane(arg);  // treat unknown string as a construction id
    }
    if (arg.kind === 'stock' || arg.kind === 'construction' || arg.kind === 'face') return arg;
    if (arg.kind === 'face' && arg.feature) return facePlane(arg);   // raw descriptor
    return stockPlane('XY');
}

// ── Quick helpers — one shot common shapes ──────────────────────────────────

/**
 * Build a centered rectangular sketch (width × height) on `plane` and commit
 * it as a Document feature. Returns the committed feature.
 */
export function rectangleSketch(plane, width, height, opts = {}) {
    const data = makeSketchData(resolvePlane(plane), { name: opts.name || 'Rectangle' });
    const w = +width / 2, h = +height / 2;
    const a = makePoint(-w, -h);  addEntity(data, a);
    const b = makePoint(+w, +h);  addEntity(data, b);
    addEntity(data, makeRectangle(a.id, b.id));
    return _commitSketch(data);
}

/** Centered circular sketch of `radius` on `plane`. */
export function circleSketch(plane, radius, opts = {}) {
    const data = makeSketchData(resolvePlane(plane), { name: opts.name || 'Circle' });
    const c = makePoint(opts.cx || 0, opts.cy || 0);
    addEntity(data, c);
    addEntity(data, makeCircle(c.id, +radius));
    return _commitSketch(data);
}

/** Regular N-gon sketch centered at origin. */
export function polygonSketch(plane, sides, radius, opts = {}) {
    const data = makeSketchData(resolvePlane(plane), { name: opts.name || `Polygon-${sides}` });
    const c = makePoint(0, 0);   addEntity(data, c);
    addEntity(data, makePolygon(c.id, +radius, sides|0,
        { inscribed: !!opts.inscribed, rotation: opts.rotation || 0 }));
    return _commitSketch(data);
}

/** Linear slot of `length × width` centered at origin, along the +X axis. */
export function slotSketch(plane, length, width, opts = {}) {
    const data = makeSketchData(resolvePlane(plane), { name: opts.name || 'Slot' });
    const half = +length / 2;
    const a = makePoint(-half, 0); addEntity(data, a);
    const b = makePoint(+half, 0); addEntity(data, b);
    addEntity(data, makeSlotLinear(a.id, b.id, +width / 2));
    return _commitSketch(data);
}

/** Ellipse sketch (major/minor radii) on `plane`. */
export function ellipseSketch(plane, majorRadius, minorRadius, opts = {}) {
    const data = makeSketchData(resolvePlane(plane), { name: opts.name || 'Ellipse' });
    const c = makePoint(0, 0); addEntity(data, c);
    addEntity(data, makeEllipse(c.id, +majorRadius, +minorRadius, opts.rotation || 0));
    return _commitSketch(data);
}

// ── SketchBuilder — fluent API for arbitrary sketches ───────────────────────

/**
 * Fluent builder for hand-authored sketches. Coordinates are in millimetres.
 *
 * Usage:
 *   const b = newSketch('XY');
 *   b.line(0, 0, 10, 0).line(10, 0, 10, 5).line(10, 5, 0, 5).line(0, 5, 0, 0);
 *   b.solve();
 *   const feature = b.commit();
 *
 * Every adder returns the SketchBuilder so calls can chain; each adder also
 * remembers the most-recent entity in `b.last`, so subsequent constraints
 * can reference it without the caller naming the id.
 */
export function newSketch(plane = 'XY', opts = {}) {
    return new SketchBuilder(plane, opts);
}

export class SketchBuilder {
    constructor(plane = 'XY', opts = {}) {
        this.data = makeSketchData(resolvePlane(plane), { name: opts.name || 'Sketch' });
        this.last = null;
        this._committed = false;
    }

    // ── Entity adders ──────────────────────────────────────────────────────────
    point(x, y, { construction = false } = {}) {
        const e = makePoint(+x, +y, { construction });
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    line(x1OrIdA, y1OrIdB, x2, y2, opts = {}) {
        // Two call shapes: line(idA, idB) or line(x1, y1, x2, y2)
        let aId, bId;
        if (typeof x1OrIdA === 'string' && typeof y1OrIdB === 'string') {
            aId = x1OrIdA; bId = y1OrIdB;
        } else {
            aId = this.point(+x1OrIdA, +y1OrIdB);
            bId = this.point(+x2, +y2);
        }
        const e = makeLine(aId, bId, opts);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    circle(cxOrCenterId, cyOrRadius, radius, opts = {}) {
        let cId, r;
        if (typeof cxOrCenterId === 'string') { cId = cxOrCenterId; r = +cyOrRadius; }
        else { cId = this.point(+cxOrCenterId, +cyOrRadius); r = +radius; }
        const e = makeCircle(cId, r, opts);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    arc(cxOrCenterId, cyOrRadius, radius, startAngle, sweepAngle, opts = {}) {
        let cId, r, sa, sw;
        if (typeof cxOrCenterId === 'string') {
            cId = cxOrCenterId; r = +cyOrRadius; sa = +radius; sw = +startAngle;
        } else {
            cId = this.point(+cxOrCenterId, +cyOrRadius); r = +radius; sa = +startAngle; sw = +sweepAngle;
        }
        const e = makeArc(cId, r, sa, sw, opts);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    rect(x1OrIdA, y1OrIdB, x2, y2, opts = {}) {
        let aId, bId;
        if (typeof x1OrIdA === 'string' && typeof y1OrIdB === 'string') {
            aId = x1OrIdA; bId = y1OrIdB;
        } else {
            aId = this.point(+x1OrIdA, +y1OrIdB);
            bId = this.point(+x2, +y2);
        }
        const e = makeRectangle(aId, bId, opts);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    polygon(cxOrCenterId, cyOrRadius, radiusOrSides, sides, opts = {}) {
        let cId, r, n;
        if (typeof cxOrCenterId === 'string') {
            cId = cxOrCenterId; r = +cyOrRadius; n = radiusOrSides|0;
        } else {
            cId = this.point(+cxOrCenterId, +cyOrRadius); r = +radiusOrSides; n = sides|0;
        }
        const e = makePolygon(cId, r, n, opts);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    spline(points, opts = {}) {
        // points: array of [x, y]
        const ids = points.map(([x, y]) => this.point(+x, +y));
        const e = makeSpline(ids, opts);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    slot(startId, endId, width, opts = {}) {
        let aId, bId;
        if (typeof startId === 'string') {
            aId = startId; bId = endId;
        } else {
            // slot(x1, y1, x2, y2, width)
            aId = this.point(+startId, +endId);
            bId = this.point(+width, +opts);   // shifted arg slots
            // Fall back: treat as (id, id, width)
        }
        const e = makeSlotLinear(aId, bId, +width);
        addEntity(this.data, e);
        this.last = e;
        return e.id;
    }

    // ── Constraints (geometric) ────────────────────────────────────────────────
    coincident(a, b)        { addConstraint(this.data, coincident(a, b)); return this; }
    horizontal(lineId)      { addConstraint(this.data, horizontal(lineId)); return this; }
    vertical(lineId)        { addConstraint(this.data, vertical(lineId)); return this; }
    parallel(l1, l2)        { addConstraint(this.data, parallel(l1, l2)); return this; }
    perpendicular(l1, l2)   { addConstraint(this.data, perpendicular(l1, l2)); return this; }
    tangent(a, b)           { addConstraint(this.data, tangent(a, b)); return this; }
    equalLength(l1, l2)     { addConstraint(this.data, equalLength(l1, l2)); return this; }
    equalRadius(c1, c2)     { addConstraint(this.data, equalRadius(c1, c2)); return this; }
    midpoint(p, l)          { addConstraint(this.data, midpoint(p, l)); return this; }
    symmetric(a, b, l)      { addConstraint(this.data, symmetric(a, b, l)); return this; }
    onLine(p, l)            { addConstraint(this.data, pointOnLine(p, l)); return this; }
    onCircle(p, c)          { addConstraint(this.data, pointOnCircle(p, c)); return this; }

    // ── Constraints (dimensional) ──────────────────────────────────────────────
    /** Distance between two entities (line length if `a` is a Line). */
    dim(a, b, value)        { addConstraint(this.data, fixedDistance(a, b, value)); return this; }
    angle(l1, l2, degrees)  { addConstraint(this.data, fixedAngle(l1, l2, degrees)); return this; }
    radius(circleId, r)     { addConstraint(this.data, fixedRadius(circleId, r)); return this; }
    lockPoint(pId, x, y)    { addConstraint(this.data, fixedPoint(pId, x, y)); return this; }
    hDim(a, b, value)       { addConstraint(this.data, horizontalDist(a, b, value)); return this; }
    vDim(a, b, value)       { addConstraint(this.data, verticalDist(a, b, value)); return this; }

    // ── Lifecycle ──────────────────────────────────────────────────────────────
    /** Run the active solver against this sketch (mutates entity coords). */
    solve(opts = {}) {
        return solveSketch(this.data, opts);
    }

    /** Commit the (current) sketch state as a v4 Document feature. */
    commit() {
        if (this._committed) throw new Error('SketchBuilder.commit: already committed');
        const feat = _commitSketch(this.data);
        this._committed = true;
        return feat;
    }

    /** Number of entities currently in the sketch. */
    get entityCount() { return entityCount(this.data); }
}

// ── Internal commit helper ─────────────────────────────────────────────────

function _commitSketch(sketchData) {
    const feature = makeSketchFeature(sketchData);
    getDocumentStore().commit(addFeatureChange(feature));
    return feature;
}
