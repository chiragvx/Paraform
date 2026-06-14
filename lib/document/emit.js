/**
 * Document → build123d Python emitter (v4).
 *
 * Walks the document's DAG in topological order, emits one Python statement
 * per feature, and produces a single source string the kernel harness can
 * `exec()`. The shape mirrors the v3 emitter in [lib/tree/emit.js](../tree/emit.js)
 * so the existing `b123d_server/` backend accepts our output unchanged.
 *
 * Variable convention
 *   n_<featureId>   the body produced by feature <featureId>
 *   sk_<featureId>  the BuildSketch context for a Sketch feature
 *   p_<paramName>   a Document parameter
 *   ax_<featureId>  axis reference geometry
 *   pl_<featureId>  plane reference geometry
 *
 * Reference resolution
 *   v3 stored upstream refs inside params (e.g. `params.body.nodeId`).
 *   v4 stores them on `feature.inputs[role]` per the Document model. The
 *   emitter reads inputs directly — params carry scalar values only.
 *
 *   Boolean ops: `inputs.target` (single ref) + `inputs.tools` (array of refs)
 *                `inputs.bodies` (array of refs) for Union/Intersect.
 *   Pattern/Modify: `inputs.body` is the single upstream body.
 *   Sketch-based: `inputs.sketch` is the Sketch feature; downstream code
 *                 references its body variable `n_<sketchId>` (set to
 *                 `sk_<sketchId>.sketch` inside the Sketch emitter).
 */

import { topoOrder } from './dag.js';
import { emitSketchPython } from '../sketch/emit.js';
import { isQuery, describeQuery } from './queries.js';
import { resolve as resolveQuery } from './resolver.js';
import { stringify as stringifyDescriptor } from './descriptor.js';
import { componentPathFor } from './types.js';
import {
    resolveTargets, connectorsForTargets, geometryOpFor,
    cutoutDimsFor, bossDimsFor, applyTransform, cleanNum,
} from './casing.js';

/**
 * Module-private emit context. Threaded through every emitter via a closure
 * variable instead of plumbed as a per-call argument because the EMITTERS
 * table is closed over the function shape `(feature) → string`. emitDocument
 * sets this on entry and clears it on exit so callers that ignore the new
 * argument see the legacy fingerprint-only behaviour.
 */
let _emitCtx = { topologyIndex: null, unresolvedQueries: null, doc: null };

/** Record an unresolvable-query notice on the current emit context. */
function _noteUnresolved(q) {
    if (_emitCtx.unresolvedQueries) {
        try { _emitCtx.unresolvedQueries.push(describeQuery(q)); } catch {}
    }
}

// ── Value helpers ─────────────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Render a JS value as Python source. A string starting with `=` is treated
 * as a raw Python expression (used to reference Document parameters via
 * `=p_wall`), anything else is JSON-quoted.
 */
function py(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (typeof v === 'number')  return Number.isFinite(v) ? String(v) : '0';
    if (typeof v === 'string')  {
        if (v.startsWith('=')) return v.slice(1);
        return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
    if (typeof v === 'object') {
        return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`).join(', ')}}`;
    }
    return 'None';
}

// ── Component placement (Phase 3) ──────────────────────────────────────────────
//
// Each feature is owned by a component (feature.componentId, defaulting to
// 'root'). Components form a tree via `parentId`, each carrying an `origin`
// transform { position (mm), rotation (Euler XYZ radians), scale }. A
// feature's WORLD pose is the composition of every component origin from
// root down to its owner. Phase 3 bakes that world pose into the kernel
// geometry: after a leaf body is built we wrap it in `.moved(Location(...))`.
//
// Conventions (must stay in lock-step with the THREE scene graph the bridge
// used to apply — see bridge.js `_applyComponentOrigin`):
//   - position: millimetres, Z-up (matches the kernel's world frame).
//   - rotation: Euler **XYZ intrinsic** radians (THREE.Euler default order).
//   - build123d `Location((x,y,z), (rx,ry,rz))` takes rotation in **degrees**
//     with the same XYZ intrinsic order, so we compose in 4×4, decompose to a
//     position + XYZ-Euler triple, and convert radians → degrees on emit.
//   - scale is ignored for v1 (assemblies place by rigid transform); a
//     non-unit scale neither crashes nor is baked — it is silently dropped.
//
// Determinism: the path is derived deterministically via `componentPathFor`
// (root-first), and the maths is pure (no Date/random). Root-owned features
// compose to identity → no `.moved(...)` is emitted → byte-identical to the
// pre-Phase-3 output.

const _RAD2DEG = 180 / Math.PI;
/** Round a number to kill float dust (e.g. 1.9999999996 → 2), keeping emit deterministic & stable. */
function _clean(n) {
    if (!Number.isFinite(n)) return 0;
    const r = Math.round(n * 1e9) / 1e9;
    return Object.is(r, -0) ? 0 : r;
}

/**
 * Build a column-major 4×4 matrix (length-16 array) from a translation and an
 * Euler-XYZ-intrinsic rotation (radians). Mirrors THREE.Matrix4.compose with
 * a THREE.Euler order 'XYZ' and unit scale.
 *
 * @param {[number,number,number]} p  translation (mm)
 * @param {[number,number,number]} e  Euler XYZ radians
 * @returns {number[]} 16-element column-major matrix
 */
function _mat4FromPosEuler(p, e) {
    const [x, y, z] = p;
    const [rx, ry, rz] = e;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // THREE.Matrix4.makeRotationFromEuler, order 'XYZ':
    const ae = cx * cz, af = cx * sz, be = sx * cz, bf = sx * sz;
    const m11 = cy * cz;
    const m12 = -cy * sz;
    const m13 = sy;
    const m21 = af + be * sy;
    const m22 = ae - bf * sy;
    const m23 = -sx * cy;
    const m31 = bf - ae * sy;
    const m32 = be + af * sy;
    const m33 = cx * cy;
    // Column-major (te[col*4 + row]).
    return [
        m11, m21, m31, 0,
        m12, m22, m32, 0,
        m13, m23, m33, 0,
        x,   y,   z,   1,
    ];
}

/** Multiply two column-major 4×4 matrices: returns a · b. */
function _mat4Mul(a, b) {
    const out = new Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = s;
        }
    }
    return out;
}

/**
 * Decompose a column-major rigid 4×4 (no scale) into position + Euler XYZ
 * radians. Mirrors THREE.Euler.setFromRotationMatrix order 'XYZ'.
 *
 * @param {number[]} m
 * @returns {{ position:[number,number,number], euler:[number,number,number] }}
 */
function _decompose(m) {
    const m11 = m[0], m21 = m[1], m31 = m[2];
    const m12 = m[4], m22 = m[5], m32 = m[6];
    const m13 = m[8], m23 = m[9], m33 = m[10];
    const tx = m[12], ty = m[13], tz = m[14];
    // order 'XYZ'
    let rx, ry, rz;
    ry = Math.asin(Math.max(-1, Math.min(1, m13)));
    if (Math.abs(m13) < 0.9999999) {
        rx = Math.atan2(-m23, m33);
        rz = Math.atan2(-m12, m11);
    } else {
        rx = Math.atan2(m32, m22);
        rz = 0;
    }
    return { position: [tx, ty, tz], euler: [rx, ry, rz] };
}

/**
 * Compose the world transform for a feature's owning component by walking the
 * component tree root → … → owner and chaining each `origin` (position +
 * Euler XYZ rotation). Scale is intentionally ignored (v1 rigid placement).
 *
 * @param {Document} doc
 * @param {string} componentId
 * @returns {{ position:[number,number,number], rotationDeg:[number,number,number], identity:boolean }}
 */
export function composeComponentTransform(doc, componentId) {
    const path = componentPathFor(doc, componentId);   // root-first
    // Accumulate parent · child so children inherit the parent frame.
    let acc = null;
    for (const cid of path) {
        const comp = doc && doc.components && doc.components[cid];
        const origin = comp && comp.origin;
        const pos = (origin && Array.isArray(origin.position) && origin.position.length === 3)
            ? origin.position.map(num) : [0, 0, 0];
        const rot = (origin && Array.isArray(origin.rotation) && origin.rotation.length === 3)
            ? origin.rotation.map(num) : [0, 0, 0];
        const local = _mat4FromPosEuler(pos, rot);
        acc = acc ? _mat4Mul(acc, local) : local;
    }
    if (!acc) {
        return { position: [0, 0, 0], rotationDeg: [0, 0, 0], identity: true };
    }
    const { position, euler } = _decompose(acc);
    const pCl = position.map(_clean);
    const rCl = euler.map(v => _clean(v * _RAD2DEG));
    const identity = pCl.every(v => v === 0) && rCl.every(v => v === 0);
    return { position: pCl, rotationDeg: rCl, identity };
}

/**
 * Emit a build123d expression that places `bodyVar` at the feature's composed
 * world transform. Returns `bodyVar` unchanged when the transform is identity
 * (root-owned features stay byte-identical to the pre-Phase-3 emit).
 *
 * Idiom:  body.moved(Location((px, py, pz), (rx_deg, ry_deg, rz_deg)))
 *
 * @param {string} bodyVar  e.g. `n_<id>`
 * @param {Document} doc
 * @param {string} componentId
 * @returns {string}
 */
function placeBodyExpr(bodyVar, doc, componentId) {
    const t = composeComponentTransform(doc, componentId);
    if (t.identity) return bodyVar;
    const [tx, ty, tz] = t.position;
    const [rx, ry, rz] = t.rotationDeg;
    const rotZero = rx === 0 && ry === 0 && rz === 0;
    const loc = rotZero
        ? `Location((${py(tx)}, ${py(ty)}, ${py(tz)}))`
        : `Location((${py(tx)}, ${py(ty)}, ${py(tz)}), (${py(rx)}, ${py(ry)}, ${py(rz)}))`;
    return `${bodyVar}.moved(${loc})`;
}

// ── Reference resolution ──────────────────────────────────────────────────────

/**
 * Render a Ref as the Python variable that holds its value. Returns 'None'
 * if the ref is empty or unresolvable.
 *
 * @param {Ref|null|undefined} ref
 * @returns {string}
 */
function varForRef(ref) {
    if (!ref) return 'None';
    // Query-bearing body ref: resolve client-side against the most recent
    // topology and use the producing feature id of the first match as the
    // Python variable. Falls back to fingerprint / featureId on miss.
    if (ref.query && isQuery(ref.query)) {
        const resolved = _resolveQuerySafe(ref.query);
        if (resolved && resolved.length) {
            const featureId = resolved[0].descriptor && resolved[0].descriptor.feature;
            if (featureId) return `n_${featureId}`;
        }
    }
    if (ref.kind === 'body'   && ref.featureId) return `n_${ref.featureId}`;
    if (ref.kind === 'sketch' && ref.sketchId)  return `n_${ref.sketchId}`;
    // Construction plane/axis referenced by construction id:
    if (ref.kind === 'plane' && ref.ref && ref.ref.construction) return `pl_${ref.ref.construction}`;
    if (ref.kind === 'axis'  && ref.ref && ref.ref.construction) return `ax_${ref.ref.construction}`;
    return 'None';
}

/**
 * Resolve a Query against the current emit context's topology index. Returns
 * an array of TopologyEntry (possibly empty). Never throws — degraded calls
 * fall back to fingerprints.
 */
function _resolveQuerySafe(query) {
    const idx = _emitCtx.topologyIndex;
    if (!idx) return [];
    try {
        return resolveQuery(query, idx) || [];
    } catch (err) {
        // Malformed query or kind mismatch — log to the emitted comment
        // stream via the caller's fallback; never crash the whole emit.
        return [];
    }
}

/** Render a plane Ref as a build123d `Plane.<NAME>` or construction var. */
function planeExpr(ref) {
    if (!ref) return 'Plane.XY';
    if (ref.kind === 'plane') {
        if (typeof ref.ref === 'string' && ['XY','XZ','YZ'].includes(ref.ref)) return `Plane.${ref.ref}`;
        if (ref.ref && ref.ref.construction) return `pl_${ref.ref.construction}`;
    }
    if (typeof ref === 'string' && ['XY','XZ','YZ'].includes(ref)) return `Plane.${ref}`;
    return 'Plane.XY';
}

/** Render an axis Ref as build123d `Axis.<NAME>` or construction var. */
function axisExpr(ref) {
    if (!ref) return 'Axis.Z';
    if (ref.kind === 'axis') {
        if (typeof ref.ref === 'string' && ['X','Y','Z'].includes(ref.ref)) return `Axis.${ref.ref}`;
        if (ref.ref && ref.ref.construction) return `ax_${ref.ref.construction}`;
    }
    if (typeof ref === 'string' && ['X','Y','Z'].includes(ref)) return `Axis.${ref}`;
    return 'Axis.Z';
}

/**
 * Render a face Ref as a Python query dict the kernel's `resolve_faces`
 * helper understands. The v3 fingerprint shape is preserved here so the
 * legacy `b123d_server/harness.py` continues to work; the Phase 1B
 * descriptor-based path will eventually replace this.
 */
function faceQuery(ref) {
    if (!ref) return 'None';
    // Query path — resolve client-side, emit canonical descriptor strings
    // under `query_resolved` for the kernel's descriptor-driven resolver.
    // Fingerprint is included as a fallback if present.
    if (ref.query && isQuery(ref.query)) {
        const resolved = _resolveQuerySafe(ref.query);
        if (resolved && resolved.length) {
            const keys = resolved.map(e => stringifyDescriptor(e.descriptor));
            const parts = [`"query_resolved": ${py(keys)}`];
            if (ref.fingerprint) {
                const fp = ref.fingerprint;
                parts.push(`"face_fp": {"center": ${py(fp.centerRounded)}, "normal": ${py(fp.normalRounded)}, "area": ${py(fp.areaBucket)}, "source": ${py(fp.sourceNodeId)}}`);
            }
            return `{${parts.join(', ')}}`;
        }
        // Empty resolution — fall through to fingerprint if available; else
        // emit a marker dict the kernel will treat as unresolvable, with a
        // human-readable canonical for debug.
        if (!ref.fingerprint) {
            // No fingerprint to fall back to — emit a marker the kernel
            // can recognise as "client could not resolve this query." The
            // canonical form is carried for kernel-side debug logs. The
            // human-readable `# Query unresolvable: ...` line is emitted
            // separately by the top-level driver via `_noteUnresolved`.
            _noteUnresolved(ref.query);
            return `{"query_resolved": [], "_q_canonical": ${py(describeQuery(ref.query))}}`;
        }
    }
    if (!ref.fingerprint) return 'None';
    const fp = ref.fingerprint;
    return `{"face_fp": {"center": ${py(fp.centerRounded)}, "normal": ${py(fp.normalRounded)}, "area": ${py(fp.areaBucket)}, "source": ${py(fp.sourceNodeId)}}}`;
}
function edgeQuery(ref) {
    if (!ref) return 'None';
    if (ref.query && isQuery(ref.query)) {
        const resolved = _resolveQuerySafe(ref.query);
        if (resolved && resolved.length) {
            const keys = resolved.map(e => stringifyDescriptor(e.descriptor));
            const parts = [`"query_resolved": ${py(keys)}`];
            if (ref.fingerprint) {
                const fp = ref.fingerprint;
                parts.push(`"edge_fp": {"center": ${py(fp.centerRounded)}, "tangent": ${py(fp.normalRounded)}, "length": ${py(fp.areaBucket)}, "source": ${py(fp.sourceNodeId)}}`);
            }
            return `{${parts.join(', ')}}`;
        }
        if (!ref.fingerprint) {
            // No fingerprint to fall back to — emit a marker the kernel
            // can recognise as "client could not resolve this query." The
            // canonical form is carried for kernel-side debug logs. The
            // human-readable `# Query unresolvable: ...` line is emitted
            // separately by the top-level driver via `_noteUnresolved`.
            _noteUnresolved(ref.query);
            return `{"query_resolved": [], "_q_canonical": ${py(describeQuery(ref.query))}}`;
        }
    }
    if (!ref.fingerprint) return 'None';
    const fp = ref.fingerprint;
    return `{"edge_fp": {"center": ${py(fp.centerRounded)}, "tangent": ${py(fp.normalRounded)}, "length": ${py(fp.areaBucket)}, "source": ${py(fp.sourceNodeId)}}}`;
}

// ── Align helper (build123d) ──────────────────────────────────────────────────
const ALIGN_CENTER = '(Align.CENTER, Align.CENTER, Align.CENTER)';
const ALIGN_MIN    = '(Align.MIN, Align.MIN, Align.MIN)';
const ALIGN_BOTTOM = '(Align.CENTER, Align.CENTER, Align.MIN)';

// ── Per-feature emitters ─────────────────────────────────────────────────────
// Each returns the Python statement(s) for one feature. Reads `feature.inputs`
// for refs and `feature.params` for scalars. The result must assign a variable
// `n_<feature.id>` so downstream features can refer to it.

const EMITTERS = {

    // ── Primitives ─────────────────────────────────────────────────────────
    Box(f) {
        const { length = 10, width = 10, height = 10, centered = true } = f.params;
        // CAD convention: `centered` means centered in XY with the body
        // sitting on the world XY ground plane (Z=MIN). Using full
        // Align.CENTER on Z would bury half the box below the grid.
        const align = centered ? ALIGN_BOTTOM : ALIGN_MIN;
        return `n_${f.id} = Box(${py(length)}, ${py(width)}, ${py(height)}, align=${align})`;
    },

    Cylinder(f) {
        const { radius = 5, height = 10, centered = true } = f.params;
        // Same Z-up convention as Box: XY-centred, sitting on the Z=0 ground plane.
        // `centered=false` keeps everything Align.MIN (corner at origin).
        const align = centered ? ALIGN_BOTTOM : ALIGN_MIN;
        return `n_${f.id} = Cylinder(${py(radius)}, ${py(height)}, align=${align})`;
    },

    Sphere(f) {
        const { radius = 5 } = f.params;
        return `n_${f.id} = Sphere(${py(radius)})`;
    },

    Torus(f) {
        const { majorRadius = 10, minorRadius = 2 } = f.params;
        return `n_${f.id} = Torus(${py(majorRadius)}, ${py(minorRadius)})`;
    },

    // ── Sketch ─────────────────────────────────────────────────────────────
    /**
     * A Sketch feature carries SketchData on `params.sketch`. We delegate the
     * geometry to the Phase 1C emitter, then alias `n_<id>` to the resulting
     * Sketch object so downstream features (Extrude, Revolve, …) consume it
     * uniformly via `n_<id>`.
     */
    Sketch(f) {
        const sketchData = f.params && f.params.sketch;
        if (!sketchData) return `# Sketch ${f.id} missing sketch payload`;
        // The Phase 1C emitter writes `with BuildSketch(...) as sk_<sketchId>:`.
        // We force the variable to align with our feature id so refs resolve.
        const aligned = { ...sketchData, id: f.id };
        const py3 = emitSketchPython(aligned);
        return `${py3}\nn_${f.id} = sk_${f.id}.sketch`;
    },

    SketchOnFace(f) {
        // Same shape as Sketch but the planeRef is a face descriptor. The
        // sketch_data.planeRef carries the descriptor, so the existing emitter
        // handles it.
        return EMITTERS.Sketch(f);
    },

    ProjectEdges(f) {
        const body = varForRef(f.inputs.body);
        return `# ProjectEdges (${f.id}) — TODO Phase 1B-driven\nn_${f.id} = ${body}`;
    },

    // ── Sketch-based create ────────────────────────────────────────────────
    Extrude(f) {
        const sketchVar = varForRef(f.inputs.sketch);
        const { amount = 10, both = false, taper = 0 } = f.params;
        const taperArg = taper ? `, taper=${py(taper)}` : '';
        const bothArg  = both ? ', both=True' : '';
        return `n_${f.id} = extrude(${sketchVar}, amount=${py(amount)}${bothArg}${taperArg})`;
    },

    Revolve(f) {
        const sketchVar = varForRef(f.inputs.sketch);
        const { angle = 360 } = f.params;
        const ax = axisExpr(f.inputs.axis || f.params.axis);
        return `n_${f.id} = revolve(${sketchVar}, axis=${ax}, revolution_arc=${py(angle)})`;
    },

    Sweep(f) {
        const sketchVar = varForRef(f.inputs.sketch);
        const pathVar   = varForRef(f.inputs.path);
        return `n_${f.id} = sweep(${sketchVar}, path=${pathVar})`;
    },

    Loft(f) {
        // inputs.sketches is an array of sketch refs
        const refs = f.inputs.sketches || [];
        const vars = refs.map(varForRef).join(', ');
        const { ruled = false } = f.params;
        return `n_${f.id} = loft([${vars}], ruled=${py(ruled)})`;
    },

    Helix(f) {
        const { pitch = 5, height = 20, radius = 5, coneAngle = 0, lefthand = false } = f.params;
        return `n_${f.id} = Helix(${py(pitch)}, ${py(height)}, ${py(radius)}, ` +
               `cone_angle=${py(coneAngle)}, lefthand=${py(lefthand)})`;
    },

    ImportSTEP(f) {
        const { path = '' } = f.params;
        return `n_${f.id} = import_step(${py(path)})`;
    },

    // ── Modify ─────────────────────────────────────────────────────────────
    Fillet(f) {
        const body = varForRef(f.inputs.body);
        const { edges = [], radius = 1 } = f.params;
        const edgesPy = edges.length
            ? `resolve_edges(${body}, [${edges.map(edgeQuery).join(', ')}])`
            : `${body}.edges()`;
        return `n_${f.id} = fillet(${edgesPy}, radius=${py(radius)})`;
    },

    Chamfer(f) {
        const body = varForRef(f.inputs.body);
        const { edges = [], length = 1, length2 } = f.params;
        const edgesPy = edges.length
            ? `resolve_edges(${body}, [${edges.map(edgeQuery).join(', ')}])`
            : `${body}.edges()`;
        const length2Arg = length2 != null ? `, length2=${py(length2)}` : '';
        return `n_${f.id} = chamfer(${edgesPy}, length=${py(length)}${length2Arg})`;
    },

    Shell(f) {
        const body = varForRef(f.inputs.body);
        const { openFaces = [], thickness = 1 } = f.params;
        // `openings=[]` makes build123d's offset() leave the body solid; for
        // a closed shell we must pass `openings=None` so the shell actually
        // hollows out. Picked open faces resolve to a face list as before.
        const openPy = openFaces.length
            ? `resolve_faces(${body}, [${openFaces.map(faceQuery).join(', ')}])`
            : `None`;
        return `n_${f.id} = offset(${body}, amount=-${py(thickness)}, openings=${openPy})`;
    },

    Draft(f) {
        const body = varForRef(f.inputs.body);
        const { faces = [], angle = 1 } = f.params;
        const ax = axisExpr(f.inputs.pullDirection || f.params.pullDirection);
        const facesPy = `resolve_faces(${body}, [${faces.map(faceQuery).join(', ')}])`;
        return `n_${f.id} = draft(${body}, ${facesPy}, direction=${ax}, angle=${py(angle)})`;
    },

    Hole(f) {
        const body = varForRef(f.inputs.body);
        const { face, diameter = 3.2, depth = 10, through = false,
                type = 'simple', counterDia, counterDepth } = f.params;
        const depthArg = through ? 'None' : py(depth);
        let extra = '';
        if (type === 'counterbore' && counterDia && counterDepth) {
            extra = `, counter_bore_diameter=${py(counterDia)}, counter_bore_depth=${py(counterDepth)}`;
        } else if (type === 'countersink' && counterDia) {
            extra = `, counter_sink_diameter=${py(counterDia)}, counter_sink_angle=82`;
        }
        return `n_${f.id} = make_hole(${body}, location=${faceQuery(face)}, diameter=${py(diameter)}, depth=${depthArg}${extra})`;
    },

    Thread(f) {
        const body = varForRef(f.inputs.body);
        const { face, spec = 'M3', length = 10 } = f.params;
        return `n_${f.id} = add_thread(${body}, location=${faceQuery(face)}, spec=${py(spec)}, length=${py(length)})`;
    },

    Offset3D(f) {
        const body = varForRef(f.inputs.body);
        const { amount = 1 } = f.params;
        return `n_${f.id} = offset(${body}, amount=${py(amount)})`;
    },

    // ── Pattern / Mirror ───────────────────────────────────────────────────
    LinearPattern(f) {
        const body = varForRef(f.inputs.body);
        const { count = 2, spacing = 10 } = f.params;
        const dir = axisExpr(f.inputs.direction || f.params.direction);
        return `n_${f.id} = pattern_linear(${body}, axis=${dir}, count=${py(count)}, spacing=${py(spacing)})`;
    },

    CircularPattern(f) {
        const body = varForRef(f.inputs.body);
        const { count = 4, angle = 360 } = f.params;
        const ax = axisExpr(f.inputs.axis || f.params.axis);
        return `n_${f.id} = pattern_circular(${body}, axis=${ax}, count=${py(count)}, angle=${py(angle)})`;
    },

    PathPattern(f) {
        const body = varForRef(f.inputs.body);
        const path = varForRef(f.inputs.path);
        const { count = 5 } = f.params;
        return `n_${f.id} = pattern_path(${body}, path=${path}, count=${py(count)})`;
    },

    Mirror(f) {
        const body = varForRef(f.inputs.body);
        const pl = planeExpr(f.inputs.plane || f.params.plane);
        return `n_${f.id} = mirror(${body}, about=${pl})`;
    },

    // ── Boolean ────────────────────────────────────────────────────────────
    // `params.keepTools` (E3.3) flips the consumption rule: when true, the
    // leaf-set logic below treats the tool refs as NOT consumed so the
    // originals still render alongside the boolean result. The emitted
    // Python is identical — keep-tool is a render-side decision.
    Union(f) {
        const refs = f.inputs.bodies || [];
        const vars = refs.map(varForRef);
        const keep = f.params && f.params.keepTools;
        const comment = keep ? `# Union (${f.id}): keepTools=True — operands retained on leaf set\n` : '';
        return `${comment}n_${f.id} = ${vars.join(' + ') || 'None'}`;
    },

    Cut(f) {
        const target = varForRef(f.inputs.target);
        const tools = (f.inputs.tools || []).map(varForRef);
        const keep = f.params && f.params.keepTools;
        const comment = keep ? `# Cut (${f.id}): keepTools=True — tools retained on leaf set\n` : '';
        return `${comment}n_${f.id} = ${target}${tools.length ? ' - ' + tools.join(' - ') : ''}`;
    },

    Intersect(f) {
        const refs = f.inputs.bodies || [];
        const vars = refs.map(varForRef);
        const keep = f.params && f.params.keepTools;
        const comment = keep ? `# Intersect (${f.id}): keepTools=True — operands retained on leaf set\n` : '';
        return `${comment}n_${f.id} = ${vars.join(' & ') || 'None'}`;
    },

    Split(f) {
        const target = varForRef(f.inputs.target);
        const tool = varForRef(f.inputs.tool);
        return `n_${f.id} = split(${target}, by=${tool})`;
    },

    // E3.3 — Split Face. Kernel impl pending; pass body through unchanged
    // with a tracking comment so the timeline still shows the feature.
    SplitFace(f) {
        const face = f.params && f.params.face;
        return `# SplitFace (${f.id}) — kernel impl pending; face=${py(face ? (face.kind || 'face') : 'unknown')}\n` +
               `n_${f.id} = None`;
    },

    // ── Transform ──────────────────────────────────────────────────────────
    Move(f) {
        const body = varForRef(f.inputs.body);
        const { vector = [0, 0, 0] } = f.params;
        return `n_${f.id} = ${body}.translate(Vector(${py(vector[0])}, ${py(vector[1])}, ${py(vector[2])}))`;
    },

    Rotate(f) {
        const body = varForRef(f.inputs.body);
        const { angle = 90 } = f.params;
        const ax = axisExpr(f.inputs.axis || f.params.axis);
        return `n_${f.id} = ${body}.rotate(${ax}, ${py(angle)})`;
    },

    Scale(f) {
        const body = varForRef(f.inputs.body);
        const { factor = 1 } = f.params;
        return `n_${f.id} = scale(${body}, by=${py(factor)})`;
    },

    // E3.4 — Align source→target by named datums. The kernel-side qDatum
    // vocabulary (spec 14) isn't wired yet, so we emit the comment + a
    // translate-only fallback: Move the source by `offset`. When the datum
    // resolver lands the second statement is replaced with a real compose.
    Align(f) {
        const source = varForRef(f.inputs.source);
        const { sourceDatum = '?', targetDatum = '?', offset = [0, 0, 0] } = f.params || {};
        const [ox, oy, oz] = Array.isArray(offset) ? offset : [0, 0, 0];
        return `# Align (${f.id}): ${sourceDatum} -> ${targetDatum} (kernel datum vocab pending)\n` +
               `n_${f.id} = ${source}.translate(Vector(${py(ox)}, ${py(oy)}, ${py(oz)}))\n` +
               `# Align: rotate component pending qDatum kernel resolver`;
    },

    // E3.5 — Cosmetic thread is metadata-only: no geometry change. The body
    // is *not* re-bound (n_<id> is unused), and the leaf-set logic below
    // excludes CosmeticThread so it never escapes as a render target.
    CosmeticThread(f) {
        const { standard = '?', direction = 'right-hand', length = 0 } = f.params || {};
        return `# Cosmetic thread (${f.id}): ${standard} ${direction}, length=${py(length)}`;
    },

    // ── Direct edit (Phase 3E / E3.2) ──────────────────────────────────────
    // MoveFace: kernel decomposes the vector into normal + tangent components
    // and applies the normal component as a Press-Pull. Tangent is dropped
    // (v1 limitation flagged on the JS feature via a warning chip).
    MoveFace(f) {
        const body = varForRef(f.inputs.body);
        const { face, vector = [0, 0, 0], tangent } = f.params;
        const [vx, vy, vz] = Array.isArray(vector) ? vector : [0, 0, 0];
        let tangentArg = '';
        if (Array.isArray(tangent) && tangent.length === 3) {
            const [tx, ty, tz] = tangent;
            tangentArg = `, tangent=[${py(tx)}, ${py(ty)}, ${py(tz)}]`;
        }
        return `n_${f.id} = move_face(${body}, ${faceQuery(face)}, [${py(vx)}, ${py(vy)}, ${py(vz)}]${tangentArg})`;
    },
    PushPullFace(f) {
        const body = varForRef(f.inputs.body);
        const { face, distance = 1 } = f.params;
        return `n_${f.id} = push_pull_face(${body}, ${faceQuery(face)}, distance=${py(distance)})`;
    },
    // DeleteFace: kernel attempts ShapeUpgrade_RemoveInternalWires; falls
    // back to identity on failure. JS surface stamps a warning chip so the
    // user knows when the heal didn't take.
    DeleteFace(f) {
        const body = varForRef(f.inputs.body);
        const { face } = f.params;
        return `n_${f.id} = delete_face(${body}, ${faceQuery(face)})`;
    },
    // OffsetFace: v1 aliases to push_pull_face — same geometry op on a
    // planar face; differs from PressPull semantically (parametric vs
    // direct-edit) but not kernel-side. Future work specialises this to
    // OCCT's BRepOffsetAPI_MakeOffset for non-planar faces.
    OffsetFace(f) {
        const body = varForRef(f.inputs.body);
        const { face, distance = 1 } = f.params;
        return `n_${f.id} = offset_face(${body}, ${faceQuery(face)}, distance=${py(distance)})`;
    },
    ReplaceFace(f) { return `# ReplaceFace (${f.id}) — TODO Phase 3E\nn_${f.id} = ${varForRef(f.inputs.body)}`; },

    // ── Reference geometry ─────────────────────────────────────────────────
    Plane(f) {
        const { type = 'offset', basePlane = 'XY', offset = 0, origin, normal } = f.params;
        // A face-/explicitly-derived datum carries an origin + normal — honour it.
        if (Array.isArray(origin) && Array.isArray(normal)) {
            return `pl_${f.id} = Plane(origin=${py(origin)}, z_dir=${py(normal)})`;
        }
        // Offset datum (the op's actual shape: { type, basePlane, offset }): a
        // principal plane shifted along its own normal by `offset` mm. The old
        // code read origin/normal — keys addPlane never writes — so the offset
        // was silently dropped and the plane always landed at the world origin.
        const base = ['XY', 'XZ', 'YZ'].includes(basePlane) ? `Plane.${basePlane}` : 'Plane.XY';
        return `pl_${f.id} = ${base}.offset(${py(offset)})`;
    },
    Axis(f) {
        const { origin = [0, 0, 0], direction = [0, 0, 1] } = f.params;
        return `ax_${f.id} = Axis(origin=${py(origin)}, direction=${py(direction)})`;
    },
    Point(f) {
        const { position = [0, 0, 0] } = f.params;
        return `pt_${f.id} = Vector(${py(position[0])}, ${py(position[1])}, ${py(position[2])})`;
    },

    // ── Assembly placeholders (Phase 3B) ───────────────────────────────────
    InsertComponent(f) {
        const { path = '', position = [0, 0, 0] } = f.params;
        return `n_${f.id} = import_step(${py(path)}).translate(Vector(${py(position[0])}, ${py(position[1])}, ${py(position[2])}))`;
    },
    JointRigid(f)       { return `# JointRigid (${f.id}) — TODO Phase 3B`; },
    JointRevolute(f)    { return `# JointRevolute (${f.id}) — TODO Phase 3B`; },
    JointSlider(f)      { return `# JointSlider (${f.id}) — TODO Phase 3B`; },
    JointCylindrical(f) { return `# JointCylindrical (${f.id}) — TODO Phase 3B`; },
    JointPlanar(f)      { return `# JointPlanar (${f.id}) — TODO Phase 3B`; },

    // ── Variable / scripted ────────────────────────────────────────────────
    Parameter(f) {
        const { name, value = 0 } = f.params;
        return `p_${name} = ${py(value)}`;
    },
    Equation(f) {
        const { name, expression = '0' } = f.params;
        return `p_${name} = ${expression}`;
    },
    BuildScript(f) {
        const { code = 'pass' } = f.params;
        // Indent each line so the user code lives at the top level of the
        // harness namespace alongside the emitted feature statements.
        return code.toString();
    },

    // ── Standard parts (catalog-backed; kernel-resolved) ───────────────────
    /**
     * StandardPart pulls a fully-modelled body from the kernel's standard
     * parts catalog via `standard_parts.build_from_id(entryId)`. The JS side
     * only carries the catalog id (and an optional transform); the kernel
     * owns dimensions, threading, etc.
     */
    // ── Imported mesh (E5.3 / browser-side STEP / GLB import) ──────────────
    /**
     * ImportedMesh carries a base64-encoded GLB payload + metadata for a
     * file the user dragged in (STEP via occt-import-js, or .glb directly).
     * The kernel doesn't participate — the GLB is decoded client-side and
     * mounted into the scene directly. We emit only a comment so the
     * timeline + DAG stay coherent, and exclude the feature from the leaf
     * set below (no `n_<id>` is produced).
     */
    ImportedMesh(f) {
        const { name = '?', format = '?' } = f.params || {};
        return `# Imported mesh: ${name} (${format}) — JS-side, no kernel body`;
    },

    StandardPart(f) {
        const { entryId, transform } = f.params || {};
        if (!entryId) {
            return `# StandardPart (${f.id}): missing entryId\nn_${f.id} = None`;
        }
        const lines = [
            `n_${f.id} = standard_parts.build_from_id(${py(entryId)})`,
        ];
        // Placement: the part's world pose is baked ONCE, by the leaf-body
        // `placeBodyExpr` pass (composeComponentTransform of the owning
        // component). `placeLibraryPart` writes the solved pose into BOTH the
        // component origin AND this feature's `transform`, so applying the
        // self-transform here too would double it — the body flew off to ~2×
        // the mate point while the connector node (which reads the component
        // origin once) stayed put. So we self-place ONLY when the component
        // bake is identity (a root-owned standard part with no component of
        // its own); otherwise we defer to the bake. The two paths are mutually
        // exclusive, so a part is transformed exactly once either way.
        const bake = _emitCtx.doc
            ? composeComponentTransform(_emitCtx.doc, f.componentId)
            : { identity: true };
        if (bake.identity && transform) {
            // build123d composes a rigid pose as rotate-then-translate
            // (R·v + t). Emit rotation FIRST, then translation, so the body
            // lands at `position` — not at `R·position`. Use a single
            // Location to match `placeBodyExpr`'s convention exactly.
            const pos = Array.isArray(transform.position) ? transform.position : [0, 0, 0];
            const rotRad = Array.isArray(transform.rotation) ? transform.rotation : [0, 0, 0];
            const hasPos = pos.some((v) => v !== 0);
            const hasRot = rotRad.some((v) => v !== 0);
            if (hasPos || hasRot) {
                const [x, y, z] = pos;
                const rotDeg = rotRad.map((r) => r * _RAD2DEG);
                const loc = hasRot
                    ? `Location((${py(x)}, ${py(y)}, ${py(z)}), (${py(rotDeg[0])}, ${py(rotDeg[1])}, ${py(rotDeg[2])}))`
                    : `Location((${py(x)}, ${py(y)}, ${py(z)}))`;
                lines.push(`n_${f.id} = n_${f.id}.moved(${loc})`);
            }
        }
        return lines.join('\n');
    },

    // ── Casing / cover generator (Phase 5 — the differentiator) ─────────────
    /**
     * Wrap a set of components in a fitted, connector-driven enclosure.
     *
     * The geometry is generated by `emitCasingPython` (below), which reads
     * `_emitCtx.doc` so it can (a) union the placed bodies of the enclosed
     * features and (b) walk `doc.connectors` for the target components,
     * transforming each into world frame to place bosses / cutouts. Because
     * this happens on every emit, a Phase-2 component swap that changes the
     * connectors moves the casing's functional geometry automatically.
     *
     * Always assigns `n_<id>` (the casing body) and, when split, also
     * `n_<id>__top` / `n_<id>__bottom`. Degrades to a passthrough/None on any
     * failure rather than crashing the document compile.
     */
    Casing(f) {
        return emitCasingPython(f, _emitCtx.doc);
    },
};

/**
 * Generate the build123d Python for a Casing feature. Pure function of
 * `(feature, doc)` — no module state beyond the imported helpers.
 *
 * BUILD123D IDIOM (offset-shell):
 *   enclosed = body_a + body_b + ...            # union of placed bodies
 *   inner    = offset(enclosed, amount=clearance)        # void around parts
 *   outer    = offset(enclosed, amount=clearance + wall) # outer skin
 *   casing   = outer - inner                             # the wall
 * `offset(solid, amount=+x)` grows a solid outward by x mm (build123d 0.10).
 * Subtracting the smaller offset from the larger leaves a uniform-thickness
 * shell — robust across non-convex unions where a single `Shell`/openings
 * call would choke.
 *
 * BUILD123D IDIOM (split-with-lip):
 *   The casing is cut by a half-space plane → top/bottom. A thin lip solid
 *   (a slab straddling the split, intersected with the *inner* offset) is
 *   added to one half and subtracted (as a slightly larger groove) from the
 *   other, forming a self-locating rabbet. Corner self-tapping bosses are
 *   added to both halves at the bbox corners.
 *
 * @param {object} f    the Casing feature
 * @param {Document} doc
 * @returns {string} python source assigning n_<f.id> (+ split half vars)
 */

/**
 * Rotation mapping a boss/cutout's local +Z to a connector's WORLD axis, for
 * `Shape.rotate(Axis(origin, ax), deg)`. Returns { ax:[x,y,z], deg } or null
 * when the axis is already ≈ +Z (no reorientation needed). Pure + deterministic
 * — its cleanNum'd numbers feed straight into the emitted Python, so identical
 * input yields byte-identical output. This is what makes the connector-driven
 * casing correct for non-Z connectors (a side port, an X-facing bolt boss):
 * before this, every boss/cutout was emitted along +Z regardless of the
 * connector's real axis, so side-facing functional geometry landed mis-oriented.
 */
function _zToAxisRotation(axis) {
    const v = Array.isArray(axis) ? axis.map(Number) : null;
    if (!v || v.length !== 3 || !v.every(Number.isFinite)) return null;
    const len = Math.hypot(v[0], v[1], v[2]);
    if (!(len > 1e-9)) return null;
    const t = [v[0] / len, v[1] / len, v[2] / len];
    const dot = Math.max(-1, Math.min(1, t[2]));      // cos(angle) between +Z and t
    if (dot > 0.999999) return null;                  // already +Z
    let rax;
    if (dot < -0.999999) {
        rax = [1, 0, 0];                              // antiparallel (−Z) → flip 180° about X
    } else {
        const cx = -t[1], cy = t[0];                 // cross(+Z, t) = [-t_y, t_x, 0]
        const cl = Math.hypot(cx, cy);
        rax = cl > 1e-9 ? [cx / cl, cy / cl, 0] : [1, 0, 0];
    }
    const deg = Math.acos(dot) * 180 / Math.PI;
    return { ax: [cleanNum(rax[0]), cleanNum(rax[1]), cleanNum(rax[2])], deg: cleanNum(deg) };
}

export function emitCasingPython(f, doc) {
    const id = f.id;
    const p = f.params || {};
    // Defensive JS-side sanity: wall must be > 0, clearance >= 0.
    const wall = (typeof p.wall === 'number' && p.wall > 0) ? p.wall : 2;
    const clearance = (typeof p.clearance === 'number' && p.clearance >= 0) ? p.clearance : 1;
    const lip = p.lip !== false;
    const bosses = p.bosses !== false;
    const cutouts = p.cutouts !== false;
    const splitPlane = (p.splitPlane === 'XY' || p.splitPlane === 'XZ' || p.splitPlane === 'YZ')
        ? p.splitPlane : null;
    const splitAt = (typeof p.splitAt === 'number') ? p.splitAt : null;
    const targets = Array.isArray(p.targets) ? p.targets : [];

    if (!doc) {
        return `# Casing (${id}): no document context — passthrough\nn_${id} = None`;
    }

    const { featureIds, componentIds } = resolveTargets(doc, targets);
    if (!featureIds.length) {
        return `# Casing (${id}): no enclosed bodies resolved from targets ${py(targets)}\n` +
               `n_${id} = None`;
    }

    // Placed (world-frame) body variables for the enclosed features. Reuse
    // placeBodyExpr so the casing unions bodies in the SAME world frame the
    // kernel renders them in (component placement baked, Phase 3).
    const placed = featureIds.map((fid) => {
        const ef = doc.features[fid];
        return placeBodyExpr(`n_${fid}`, doc, ef && ef.componentId);
    });

    const L = [];
    L.push(`# ── Casing ${id} (wall=${wall}mm, clearance=${clearance}mm) ──`);
    L.push(`# Connector-driven enclosure. Bosses/cutouts derive from doc.connectors`);
    L.push(`# at emit time → a Phase-2 part swap relocates them automatically.`);
    // Everything fragile lives inside one try/except so a kernel offset/split
    // failure degrades to the bare union (still a renderable body) instead of
    // blowing up the whole document.
    L.push(`try:`);
    L.push(`    _casing_enclosed_${id} = ${placed.join(' + ')}`);
    L.push(`    _casing_inner_${id} = offset(_casing_enclosed_${id}, amount=${py(clearance)})`);
    L.push(`    _casing_outer_${id} = offset(_casing_enclosed_${id}, amount=${py(clearance + wall)})`);
    L.push(`    _casing_${id} = _casing_outer_${id} - _casing_inner_${id}`);

    // ── Connector-driven functional geometry ────────────────────────────────
    const connectors = connectorsForTargets(doc, componentIds);
    const bossEntries = [];
    const cutoutEntries = [];
    for (const c of connectors) {
        const opSpec = geometryOpFor(c);
        if (!opSpec || opSpec.op === 'skip') continue;
        // Resolve the component frame the connector lives in: its parent is
        // usually the componentId directly; if it's a featureId, use that
        // feature's owning component. Either way we compose root→component.
        let frameCid = 'root';
        if (c.parent && doc.components && doc.components[c.parent]) frameCid = c.parent;
        else if (c.parent && doc.features && doc.features[c.parent]) frameCid = doc.features[c.parent].componentId || 'root';
        const t = composeComponentTransform(doc, frameCid);
        const worldOrigin = applyTransform(c.origin, t, false).map(cleanNum);
        const worldAxis   = applyTransform(c.axis,   t, true).map(cleanNum);
        if (opSpec.op === 'boss') bossEntries.push({ c, opSpec, worldOrigin, worldAxis });
        else if (opSpec.op === 'cutout') cutoutEntries.push({ c, opSpec, worldOrigin, worldAxis });
    }

    if (bosses && bossEntries.length) {
        L.push(`    # screw bosses at fastener/thread connectors`);
        for (const e of bossEntries) {
            const { pilot, outer } = bossDimsFor(e.c, e.opSpec);
            const [ox, oy, oz] = e.worldOrigin;
            const ax = e.worldAxis;
            // Boss = cylinder along the connector axis from the origin toward
            // the shell (length ≈ clearance + wall + a little), pilot hole bored.
            const len = clearance + wall + 4;
            const rot = _zToAxisRotation(ax);
            L.push(`    try:`);
            L.push(`        _b = Cylinder(${py(outer / 2)}, ${py(len)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
            L.push(`        _pilot = Cylinder(${py(pilot / 2)}, ${py(len + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
            if (rot) {
                // Reorient the +Z boss AND its coaxial pilot bore onto the
                // connector's world axis BEFORE translating to the contact point,
                // so a side-facing fastener gets a side-facing boss (not a +Z one).
                L.push(`        _bAxis = Axis((0, 0, 0), (${py(rot.ax[0])}, ${py(rot.ax[1])}, ${py(rot.ax[2])}))`);
                L.push(`        _b = _b.rotate(_bAxis, ${py(rot.deg)})  # align +Z boss to connector axis ${py(ax)}`);
                L.push(`        _pilot = _pilot.rotate(_bAxis, ${py(rot.deg)})`);
            } else {
                L.push(`        # boss axis ${py(ax)} ≈ +Z — no reorientation needed`);
            }
            L.push(`        _b = _b.moved(Location((${py(ox)}, ${py(oy)}, ${py(oz)})))`);
            L.push(`        _pilot = _pilot.moved(Location((${py(ox)}, ${py(oy)}, ${py(oz)})))`);
            L.push(`        _casing_${id} = _casing_${id} + (_b - _pilot)`);
            L.push(`    except Exception:`);
            L.push(`        pass  # skip this boss; casing still compiles`);
        }
    }

    if (cutouts && cutoutEntries.length) {
        L.push(`    # cutouts where shaft/port/switch connectors pierce the shell`);
        for (const e of cutoutEntries) {
            const dims = cutoutDimsFor(e.c, e.opSpec, clearance);
            const [ox, oy, oz] = e.worldOrigin;
            const ax = e.worldAxis;
            // Cutout tool: a long prism along the connector axis, centred on
            // the connector origin, so it crosses the shell wherever the axis
            // exits. v1 builds an axis-aligned tool (+Z) translated to origin;
            // for non-Z axes the kernel still subtracts the overlap region.
            const through = clearance + wall + 20;
            const rot = _zToAxisRotation(ax);
            L.push(`    try:`);
            if (dims.shape === 'round') {
                L.push(`        _cut = Cylinder(${py(dims.d / 2)}, ${py(through)}, align=(Align.CENTER, Align.CENTER, Align.CENTER))`);
            } else {
                L.push(`        _cut = Box(${py(dims.w)}, ${py(dims.h)}, ${py(through)}, align=(Align.CENTER, Align.CENTER, Align.CENTER))`);
            }
            if (rot) {
                // Orient the through-tool along the connector axis so it pierces
                // the shell where the axis actually exits — not always through +Z.
                L.push(`        _cut = _cut.rotate(Axis((0, 0, 0), (${py(rot.ax[0])}, ${py(rot.ax[1])}, ${py(rot.ax[2])})), ${py(rot.deg)})  # align cutout to connector axis ${py(ax)}`);
            }
            L.push(`        _cut = _cut.moved(Location((${py(ox)}, ${py(oy)}, ${py(oz)})))  # axis ${py(ax)}`);
            L.push(`        _casing_${id} = _casing_${id} - _cut`);
            L.push(`    except Exception:`);
            L.push(`        pass  # skip this cutout; casing still compiles`);
        }
    }

    // ── Split into halves with a lip/groove + corner bosses ─────────────────
    if (splitPlane) {
        const axisName = splitPlane === 'XY' ? 'Z' : splitPlane === 'XZ' ? 'Y' : 'X';
        const idx = axisName === 'Z' ? 2 : axisName === 'Y' ? 1 : 0;
        const atExpr = splitAt != null
            ? py(splitAt)
            // default: mid-bbox along the split axis.
            : `((_casing_${id}.bounding_box().min.${axisName.toLowerCase()} + ` +
              `_casing_${id}.bounding_box().max.${axisName.toLowerCase()}) / 2)`;
        L.push(`    # split into two halves at ${splitPlane}@${splitAt != null ? splitAt : 'mid-bbox'} with a lip/groove rabbet`);
        L.push(`    _split_at_${id} = ${atExpr}`);
        L.push(`    _bb_${id} = _casing_${id}.bounding_box()`);
        // Build a cutting plane offset to splitAt along the chosen axis.
        L.push(`    _plane_${id} = Plane.${splitPlane}.offset(_split_at_${id})`);
        L.push(`    try:`);
        L.push(`        _halves_${id} = _casing_${id}.split(_plane_${id}, keep=Keep.BOTH)`);
        // split(keep=BOTH) returns a list/compound of solids; take the two largest.
        L.push(`        _solids_${id} = sorted(_halves_${id}.solids(), key=lambda s: s.volume, reverse=True)`);
        L.push(`        _top_${id} = _solids_${id}[0] if len(_solids_${id}) > 0 else _casing_${id}`);
        L.push(`        _bottom_${id} = _solids_${id}[1] if len(_solids_${id}) > 1 else None`);
        if (lip) {
            // Lip rabbet: a thin slab straddling the split plane, intersected
            // with the *inner* void offset so it only adds material on the wall
            // ring. Added to top, a slightly larger version subtracted from
            // bottom → mating recess. Defensive: lip is optional polish.
            L.push(`        try:`);
            L.push(`            _lip_h = ${py(Math.min(wall, 2))}`);
            L.push(`            _lip_box = Box(_bb_${id}.size.X * 2, _bb_${id}.size.Y * 2, _lip_h, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
            L.push(`            _lip_box = _lip_box.moved(Location((_bb_${id}.center().X, _bb_${id}.center().Y, _split_at_${id})))`);
            L.push(`            _lip_ring = (offset(_casing_inner_${id}, amount=${py(wall / 2)}) - _casing_inner_${id})`);
            L.push(`            _lip = _lip_box & _lip_ring`);
            L.push(`            if _top_${id} is not None: _top_${id} = _top_${id} + _lip`);
            L.push(`            if _bottom_${id} is not None: _bottom_${id} = _bottom_${id} - _lip`);
            L.push(`        except Exception:`);
            L.push(`            pass  # lip is polish; halves stand without it`);
        }
        L.push(`        n_${id}__top = _top_${id}`);
        L.push(`        n_${id}__bottom = _bottom_${id}`);
        L.push(`        n_${id} = _top_${id} + _bottom_${id} if _bottom_${id} is not None else _top_${id}`);
        L.push(`    except Exception:`);
        L.push(`        # split failed — keep the unsplit casing as the result.`);
        L.push(`        n_${id} = _casing_${id}`);
        L.push(`        n_${id}__top = _casing_${id}`);
        L.push(`        n_${id}__bottom = None`);
    } else {
        L.push(`    n_${id} = _casing_${id}`);
    }

    // Outer except: any failure above (union/offset) degrades to a bare union
    // so the document still produces a renderable body + a tracking comment.
    L.push(`except Exception as _casing_err:`);
    L.push(`    # Casing ${id}: offset/shell/split degraded — falling back to union of enclosed bodies.`);
    L.push(`    try:`);
    L.push(`        n_${id} = ${placed.join(' + ')}`);
    L.push(`    except Exception:`);
    L.push(`        n_${id} = None`);

    return L.join('\n');
}

// ── Top-level driver ─────────────────────────────────────────────────────────

/**
 * Emit Python source for the entire active document.
 *
 * Walks the DAG in topological order; for each enabled feature, calls the
 * matching emitter. Parameters become `p_<name>` bindings first so subsequent
 * features can reference them via `=p_<name>` expressions in their params.
 *
 * Finally, populates `__paraform_result__.bodies` with the leaf features
 * (features whose body is not consumed by any other enabled feature). The
 * kernel harness reads this dict to decide what to GLB-encode.
 *
 * @param {Document} doc
 * @returns {{ code: string, order: string[], leafIds: string[] }}
 */
/**
 * Prologue prepended to every emitted document — pulls every build123d name
 * into the harness namespace (the harness exec()s our code in a namespace
 * that already has the kernel helpers like `resolve_edges`, `make_hole`, ...).
 */
const PROLOGUE = `# --- ParaForm v4 document -> build123d ---
# Auto-generated. Edit the document, not this file.
from build123d import *

`;

export function emitDocument(doc, { topologyIndex = null } = {}) {
    if (!doc) throw new Error('emitDocument: missing document');
    const order = topoOrder(doc);
    if (order === null) {
        throw new Error('emitDocument: dependency cycle detected');
    }

    // Install the emit context (queries resolve against this). On first emit,
    // before any successful render, topologyIndex is null — queries will fall
    // back to fingerprints / canonical-string comments. Always reset on exit
    // so a thrown emitter doesn't leak the index into the next call.
    const prevCtx = _emitCtx;
    _emitCtx = { topologyIndex, unresolvedQueries: [], doc };

    try {

    const lines = [PROLOGUE];

    // 1. Parameters first — they're independent of feature order
    for (const p of Object.values(doc.parameters)) {
        const name = p.name;
        if (!name) continue;
        if (p.equation) lines.push(`p_${name} = ${p.equation}`);
        else            lines.push(`p_${name} = ${py(p.value)}`);
    }

    // 2. Features in topo order
    for (const featureId of order) {
        const f = doc.features[featureId];
        if (!f || !f.enabled) continue;
        const emitter = EMITTERS[f.type];
        if (!emitter) {
            lines.push(`# unknown feature type ${f.type} (${f.id})`);
            continue;
        }
        try {
            // Drain any unresolvable-query notices collected by the emitter
            // BEFORE adding the feature line, so the comment appears just
            // above the offending statement.
            const before = _emitCtx.unresolvedQueries.length;
            const statement = emitter(f);
            for (let i = before; i < _emitCtx.unresolvedQueries.length; i++) {
                lines.push(`# Query unresolvable: ${_emitCtx.unresolvedQueries[i]}`);
            }
            lines.push(statement);
        } catch (err) {
            lines.push(`# emit failed for ${f.type} (${f.id}): ${err.message}`);
        }
    }

    // 3. Identify leaf features — features whose body is NOT referenced by any
    //    other enabled feature. These become the kernel's render targets.
    const consumed = new Set();
    for (const featureId of order) {
        const f = doc.features[featureId];
        if (!f || !f.enabled) continue;
        // E3.3 — boolean ops with keepTools=true do NOT mark their operands
        // as consumed, so the originals stay in the leaf set and render.
        const isBoolean = f.type === 'Union' || f.type === 'Cut' || f.type === 'Intersect';
        const keepTools = isBoolean && f.params && f.params.keepTools === true;
        if (keepTools) continue;
        for (const ref of collectRefs(f.inputs)) {
            if (ref.kind === 'body'   && ref.featureId) consumed.add(ref.featureId);
            if (ref.kind === 'sketch' && ref.sketchId)  consumed.add(ref.sketchId);
            // Query-bearing ref: any feature its query resolves to is also
            // consumed. Without this a Query-driven body input would never
            // hide its upstream from the leaf set.
            if (ref.query && isQuery(ref.query)) {
                for (const e of _resolveQuerySafe(ref.query)) {
                    const fid = e.descriptor && e.descriptor.feature;
                    if (fid) consumed.add(fid);
                }
            }
        }
    }
    const leafIds = order.filter(id => {
        const f = doc.features[id];
        if (!f || !f.enabled) return false;
        if (consumed.has(id)) return false;
        // Skip features whose body var was never produced (sketch-only, reference geometry, joints)
        if (['Sketch','SketchOnFace','Plane','Axis','Point','Parameter','Equation',
             'JointRigid','JointRevolute','JointSlider','JointCylindrical','JointPlanar',
             'ReplaceFace','ProjectEdges',
             'CosmeticThread','SplitFace',
             'BuildScript','ImportedMesh'].includes(f.type)) {
            return false;
        }
        return true;
    });

    // 4. Build the result dict for the harness to serialize.
    //    `feature_types` and `feature_inputs` carry the metadata that naming.py
    //    uses to dispatch the right namer (`name_from_feature_type`) and look
    //    up parent descriptors for derived ops (Fillet, Cut, Mirror, …).
    // Phase 3 — bake each leaf body's component placement into the kernel
    // geometry. `placeBodyExpr` returns `n_<id>` unchanged for root-owned
    // (identity-transform) features, so single-part docs emit byte-identically.
    const bodyDict = leafIds.map(id => {
        const f = doc.features[id];
        const placed = placeBodyExpr(`n_${id}`, doc, f && f.componentId);
        return `${py(id)}: ${placed}`;
    }).join(', ');
    const enabled = Object.values(doc.features).filter(f => f && f.enabled);
    const typesDict = enabled.map(f => `${py(f.id)}: ${py(f.type)}`).join(', ');
    const inputsDict = enabled.map(f => {
        const parentIds = [];
        for (const ref of collectRefs(f.inputs || {})) {
            const upstream = ref.featureId || ref.sketchId;
            if (upstream && !parentIds.includes(upstream)) parentIds.push(upstream);
            // Query-bearing ref: pull upstream feature ids from each
            // resolved descriptor so naming.py still sees the parent
            // lineage even when the input was authored as a Query.
            if (ref.query && isQuery(ref.query)) {
                for (const e of _resolveQuerySafe(ref.query)) {
                    const fid = e.descriptor && e.descriptor.feature;
                    if (fid && !parentIds.includes(fid)) parentIds.push(fid);
                }
            }
        }
        return `${py(f.id)}: [${parentIds.map(py).join(', ')}]`;
    }).join(', ');
    const bodyVarDict = enabled.map(f => `${py(f.id)}: "n_${f.id}"`).join(', ');
    // feature → owning component id, so the kernel can group leaf bodies
    // into per-component triangle meshes for the interference overlay.
    // Defaults to 'root' for features without an explicit componentId.
    const componentDict = enabled.map(f => `${py(f.id)}: ${py(f.componentId || 'root')}`).join(', ');

    lines.push(
        `__paraform_result__ = {` +
        `"bodies": {${bodyDict}}, ` +
        `"nodes": [${enabled.map(f => py(f.id)).join(', ')}], ` +
        `"feature_types": {${typesDict}}, ` +
        `"feature_inputs": {${inputsDict}}, ` +
        `"feature_bodies": {${bodyVarDict}}, ` +
        `"feature_components": {${componentDict}}` +
        `}`
    );

    return { code: lines.join('\n'), order, leafIds };

    } finally {
        // Restore the previous emit context so nested / sequential calls see
        // their own topologyIndex (or none) rather than this call's.
        _emitCtx = prevCtx;
    }
}

/** Flatten a feature.inputs map into the list of Refs it contains. */
function collectRefs(inputs) {
    const out = [];
    for (const v of Object.values(inputs || {})) {
        if (!v) continue;
        if (Array.isArray(v)) { out.push(...v.filter(Boolean)); continue; }
        if (typeof v === 'object' && v.kind) out.push(v);
    }
    return out;
}
