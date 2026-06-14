/**
 * Data-synth — a DETERMINISTIC procedural generator of training/eval triplets.
 *
 *   synthTriplet(index)          → Triplet
 *   synthDataset(count, opts?)   → Triplet[]
 *   verifyTriplet(triplet, docResult) → { ok, score, failures }
 *
 * A Triplet is the substrate of the data flywheel (see FLYWHEEL.md):
 *
 *   {
 *     id,                 — stable, derived from index (NO randomness)
 *     prompt,             — natural-language spec a user might type
 *     typedOpProgram,     — [{ tool, input }] using REAL project tool names
 *                           (addBox, addCylinder, addHole, addSketch, addExtrude,
 *                           placeLibraryPart, add_mate, declareConnector, …)
 *     acceptanceSpec,     — { acceptance, negative, assembly } scored by ../scorer.js
 *   }
 *
 * The program is what an agent would emit to satisfy the prompt; the
 * acceptanceSpec is the deterministic gate. After a runner EXECUTES the program
 * on the kernel and measures a `DocResult`, `verifyTriplet` re-uses the scorer
 * to KEEP only triplets whose real geometry matches their own spec — the
 * Chamfer-distance "is this sample good enough to train on" idea, expressed with
 * our deterministic acceptance checks instead of a single float threshold.
 *
 * DETERMINISM CONTRACT (hard): every output is a pure function of the integer
 * `index`. No Date.now, no Math.random, no Set/Map iteration order leaks. Calling
 * synthTriplet(7) a million times returns byte-identical JSON. Variation comes
 * only from index-seeded arithmetic over fixed parameter ladders. This is what
 * lets a dataset be regenerated reproducibly and diffed in review.
 *
 * Generators include ASSEMBLY-AWARE triplets (parts + connectors + mates) that
 * only this stack can synthesize — a bolt declared with a connector and mated
 * into a host, carrying an `inducedJoint` assertion. That is data no
 * primitives-only text-to-CAD pipeline can produce.
 */

import { scoreTask } from './scorer.js';

// ── deterministic index→value helpers (no RNG) ───────────────────────────────

/** Pick from a fixed ladder by index — wraps, fully deterministic. */
const pick = (ladder, index) => ladder[((index % ladder.length) + ladder.length) % ladder.length];

/** A stable, zero-padded id segment so dataset order sorts lexically. */
const seg = (n) => String(n).padStart(4, '0');

// Fixed parameter ladders. Index walks these; nothing here is random.
const CUBE_SIZES   = [10, 15, 20, 25, 30, 40];
const PLATE_DIMS   = [[60, 40, 5], [80, 50, 6], [50, 50, 4], [100, 60, 8]];
const ROD_DIMS     = [[5, 40], [8, 50], [10, 60], [6, 30]];   // [radius, height]
const BOLT_SIZES   = [3, 4, 5, 6];                            // M-size, mm
const EXTRUSION_LEN = [120, 200, 250, 300];

// ── generators — one per shape family, each a pure fn of index ───────────────

/** Single-part: a calibration cube. */
function genCube(index) {
    const s = pick(CUBE_SIZES, index);
    return {
        id: `synth-cube-${seg(index)}`,
        prompt: `Make a solid ${s} mm calibration cube.`,
        typedOpProgram: [
            { tool: 'addBox', input: { length: s, width: s, height: s, centered: true } },
        ],
        acceptanceSpec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: s },
                { kind: 'bbox', axis: 'y', size: s },
                { kind: 'bbox', axis: 'z', size: s },
                { kind: 'solidCount', equals: 1 },
                { kind: 'volume', equals: s * s * s, tol: 1 },
            ],
            negative: [{ kind: 'holeCount', equals: 0 }],
            assembly: [],
        },
    };
}

/** Single-part: a plate with one central through-hole. */
function genDrilledPlate(index) {
    const [l, w, h] = pick(PLATE_DIMS, index);
    const dia = pick(BOLT_SIZES, index);
    return {
        id: `synth-plate-${seg(index)}`,
        prompt: `Make a ${l}×${w}×${h} mm plate with a single ${dia} mm hole drilled through the centre.`,
        typedOpProgram: [
            { tool: 'addBox', input: { length: l, width: w, height: h, centered: true } },
            { tool: 'addHole', input: { diameter: dia, through: true, origin: [0, 0, h] } },
        ],
        acceptanceSpec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: l },
                { kind: 'bbox', axis: 'y', size: w },
                { kind: 'bbox', axis: 'z', size: h },
                { kind: 'solidCount', equals: 1 },
                { kind: 'holeCount', equals: 1 },
                { kind: 'noInterference' },
            ],
            negative: [
                // No spurious hole at a corner.
                { kind: 'mustNotHaveHoleAt', origin: [l / 2, w / 2, 0] },
            ],
            assembly: [],
        },
    };
}

/** Single-part: a round standoff/rod from a sketch + extrude (exercises the sketch path). */
function genExtrudedRod(index) {
    const [r, hgt] = pick(ROD_DIMS, index);
    const sketchId = `sk_${seg(index)}`;
    return {
        id: `synth-rod-${seg(index)}`,
        prompt: `Make a round rod ${2 * r} mm in diameter and ${hgt} mm tall.`,
        typedOpProgram: [
            { tool: 'addSketch', input: { id: sketchId, plane: 'XY', circles: [{ cx: 0, cy: 0, r }] } },
            { tool: 'addExtrude', input: { sketchFeatureId: sketchId, amount: hgt } },
        ],
        acceptanceSpec: {
            acceptance: [
                { kind: 'bbox', axis: 'z', size: hgt },
                { kind: 'bbox', axis: 'x', max: 2 * r + 0.5 },
                { kind: 'bbox', axis: 'y', max: 2 * r + 0.5 },
                { kind: 'solidCount', equals: 1 },
            ],
            negative: [],
            assembly: [],
        },
    };
}

/**
 * Assembly-aware: a bolt declared with a connector and mated into a host
 * extrusion's slot — the triplet only THIS stack can synthesize. Walks both the
 * fixed-joint and prismatic-joint variants by index so the dataset covers the
 * joint kinds the connector contract distinguishes.
 */
function genBoltIntoExtrusion(index) {
    const m = pick(BOLT_SIZES, index);
    const len = pick(EXTRUSION_LEN, index);
    const partId = `tslot-2020-${len}`;
    const boltId = `bolt-m${m}-12`;
    // Even index → a fixed bolt; odd → a sliding nut (prismatic). Deterministic.
    const sliding = index % 2 === 1;
    const joint = sliding ? 'prismatic' : 'fixed';
    const hostConnectorId = `c_${seg(index)}_host`;
    return {
        id: `synth-extrusion-${seg(index)}`,
        prompt: sliding
            ? `Slide an M${m} t-nut into the channel of a ${len} mm length of 2020 extrusion so it can move along the slot.`
            : `Bolt an M${m} screw into a ${len} mm length of 2020 extrusion so it is fixed in place.`,
        typedOpProgram: [
            { tool: 'placeLibraryPart', input: { partId, name: 'extrusion' } },
            {
                tool: 'declareConnector',
                input: {
                    featureId: 'extrusion',
                    kind: 'slot',
                    gender: 'female',
                    size: { nominal: m, unit: 'mm' },
                    origin: [0, 10, len / 2],
                    axis: [0, 0, 1],          // slide direction (channel run)
                    normal: [0, 1, 0],        // seating-face outward (⟂ axis)
                    profile: 'tslot-2020',
                    inducedJoint: joint,
                },
            },
            {
                tool: 'placeLibraryPart',
                input: { partId: boltId, hostConnectorId, name: 'fastener' },
            },
            {
                tool: 'add_mate',
                input: {
                    componentId: 'fastener',
                    hostConnectorId,
                    partConnectorId: `c_${seg(index)}_part`,
                    inducedJoint: joint,
                },
            },
        ],
        acceptanceSpec: {
            acceptance: [
                { kind: 'bbox', axis: 'z', max: len + 0.5 },
                { kind: 'solidCount', min: 2 },
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [
                { kind: 'mateSolved' },
                { kind: 'inducedJoint', equals: joint },
            ],
        },
    };
}

/** Assembly-aware: a bearing pressed on a shaft → a revolute joint. */
function genBearingOnShaft(index) {
    const [r, hgt] = pick(ROD_DIMS, index);
    const hostConnectorId = `c_${seg(index)}_shaft`;
    return {
        id: `synth-bearing-${seg(index)}`,
        prompt: `Press a 608 bearing onto a ${2 * r} mm shaft so the inner race spins on the shaft.`,
        typedOpProgram: [
            { tool: 'addCylinder', input: { radius: r, height: hgt, centered: true } },
            {
                tool: 'declareConnector',
                input: {
                    featureId: 'shaft',
                    kind: 'shaft',
                    gender: 'male',
                    size: { nominal: 2 * r, unit: 'mm' },
                    origin: [0, 0, hgt / 2],
                    axis: [0, 0, 1],
                    inducedJoint: 'revolute',
                },
            },
            { tool: 'placeLibraryPart', input: { partId: 'bearing-608', hostConnectorId, name: 'bearing' } },
            {
                tool: 'add_mate',
                input: {
                    componentId: 'bearing',
                    hostConnectorId,
                    partConnectorId: `c_${seg(index)}_bore`,
                    inducedJoint: 'revolute',
                },
            },
        ],
        acceptanceSpec: {
            acceptance: [
                { kind: 'solidCount', min: 2 },
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [
                { kind: 'mateSolved' },
                { kind: 'inducedJoint', equals: 'revolute' },
            ],
        },
    };
}

// The generator roster. Index modulo length selects the family; integer
// division advances the within-family parameter, so the dataset spreads evenly
// across families AND ladders. Order is FIXED — never sort by a Set/Map.
const GENERATORS = [
    genCube,
    genDrilledPlate,
    genExtrudedRod,
    genBoltIntoExtrusion,
    genBearingOnShaft,
];

/**
 * Synthesize a single deterministic triplet for an integer index. Pure: the
 * same index always returns the identical object.
 *
 * @param {number} index — non-negative integer
 * @returns {{ id:string, prompt:string, typedOpProgram:Array<{tool:string,input:object}>, acceptanceSpec:object }}
 */
export function synthTriplet(index) {
    const i = Math.trunc(Math.abs(Number(index) || 0));
    const family = i % GENERATORS.length;
    const within = Math.floor(i / GENERATORS.length);
    return GENERATORS[family](within);
}

/**
 * Synthesize a deterministic dataset of `count` triplets, indices [start, start+count).
 *
 * @param {number} count
 * @param {{ start?: number }} [opts]
 * @returns {Array} triplets
 */
export function synthDataset(count, opts = {}) {
    const n = Math.max(0, Math.trunc(Number(count) || 0));
    const start = Math.trunc(Number(opts.start) || 0);
    const out = [];
    for (let k = 0; k < n; k += 1) out.push(synthTriplet(start + k));
    return out;
}

/**
 * The flywheel KEEP gate: a triplet enters the dataset only if its EXECUTED
 * geometry (measured into `docResult` by the runner) satisfies its OWN
 * acceptanceSpec. Reuses the scorer so the synth path and the eval path judge
 * geometry the exact same way. Pure; never throws.
 *
 * @param {{ id:string, acceptanceSpec:object }} triplet
 * @param {import('./scorer.js').DocResult} docResult — measured from executing triplet.typedOpProgram
 * @returns {{ ok:boolean, score:number, total:number, failures:Array }}
 */
export function verifyTriplet(triplet, docResult) {
    const t = triplet || {};
    const score = scoreTask({ id: t.id, spec: t.acceptanceSpec }, docResult);
    return {
        ok: score.passed,
        score: score.score,
        total: score.total,
        failures: score.failures,
    };
}

export default { synthTriplet, synthDataset, verifyTriplet };
