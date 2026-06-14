/**
 * Benchmark suite — CAD tasks as DATA.
 *
 *   BENCHMARK_TASKS — array of { id, prompt, spec:{ acceptance, negative, assembly } }
 *
 * This is the project's first eval set. Each task pairs a VERBATIM
 * natural-language prompt (exactly what a user would type into the AI chat)
 * with a deterministic, kernel-free acceptance spec the scorer can check
 * against a measured `DocResult` (see ../scorer.js for the DocResult shape and
 * the closed set of check `kind`s).
 *
 * Two families of task, on purpose:
 *
 *   single-part — calibration block, flange, L-bracket, keyed shaft,
 *     enclosure-with-lid. These are the standard text-to-CAD bar (dimensions,
 *     solid/hole counts, no self-interference) and let our numbers sit next to
 *     the published text-to-CAD literature once chamferDistance / IoU are wired.
 *
 *   assembly — M3 bolt+nut into a 2020 T-slot, two plates bolted with 4×M3, a
 *     bearing on a shaft. These exercise the connector contract + the mate
 *     solver, and they carry checks NO competitor benchmark has: `mateSolved`,
 *     `inducedJoint`, `casingBossAligned`, `swapStable`. That is the moat —
 *     anyone can score a bounding box; only a connector-native stack can score
 *     "the nut actually slides in the channel and induces a prismatic joint."
 *
 * A check `kind` is one of (see scorer.js):
 *   bbox | bboxSize | volume | solidCount | holeCount | noInterference        (single-part)
 *   mustNotHaveHoleAt | maxVolume                                             (negative)
 *   mateSolved | inducedJoint | casingBossAligned | swapStable                (assembly)
 *
 * Numbers are nominal targets in mm / mm³, Z-up. The scorer applies TOL_MM.
 */

export const BENCHMARK_TASKS = [
    // ── single-part ──────────────────────────────────────────────────────────
    {
        id: 'calibration-block',
        prompt: 'Make a 20 mm calibration cube — a solid 20×20×20 mm block.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: 20 },
                { kind: 'bbox', axis: 'y', size: 20 },
                { kind: 'bbox', axis: 'z', size: 20 },
                { kind: 'solidCount', equals: 1 },
                { kind: 'volume', equals: 8000, tol: 1 },
            ],
            negative: [
                { kind: 'holeCount', equals: 0 },
            ],
            assembly: [],
        },
    },
    {
        id: 'round-flange',
        prompt: 'Design a round mounting flange: an 80 mm diameter disc, 6 mm thick, with a 20 mm bore in the centre and four 5 mm bolt holes on a 60 mm bolt circle.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: 80 },
                { kind: 'bbox', axis: 'y', size: 80 },
                { kind: 'bbox', axis: 'z', size: 6 },
                { kind: 'solidCount', equals: 1 },
                { kind: 'holeCount', equals: 5 },  // centre bore + four bolt holes
                { kind: 'noInterference' },
            ],
            negative: [
                // No stray hole dead-centre off the disc plane.
                { kind: 'mustNotHaveHoleAt', origin: [40, 40, 0] },
            ],
            assembly: [],
        },
    },
    {
        id: 'l-bracket',
        prompt: 'Make an L-bracket: two 40×40 mm legs, 4 mm wall, 60 mm wide, with a 5 mm mounting hole centred in each leg.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', max: 41 },
                { kind: 'bbox', axis: 'y', max: 61 },
                { kind: 'bbox', axis: 'z', max: 41 },
                { kind: 'solidCount', equals: 1 },
                { kind: 'holeCount', equals: 2 },
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [],
        },
    },
    {
        id: 'keyed-shaft',
        prompt: 'Model a keyed shaft: a 10 mm diameter cylinder, 50 mm long, with a 3 mm wide × 3 mm deep keyway flat milled along one side.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'z', size: 50 },
                { kind: 'bbox', axis: 'x', max: 10.5 },
                { kind: 'bbox', axis: 'y', max: 10.5 },
                { kind: 'solidCount', equals: 1 },
            ],
            negative: [
                // The keyway is a cut, not a separate solid: still one body.
                { kind: 'solidCount', max: 1 },
            ],
            assembly: [],
        },
    },
    {
        id: 'enclosure-with-lid',
        prompt: 'Create a small project enclosure with a snap-on lid: an 80×50×30 mm box, hollowed to a 2 mm wall, split into a base and a lid that screw together with four corner bosses.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: 80 },
                { kind: 'bbox', axis: 'y', size: 50 },
                { kind: 'bbox', axis: 'z', size: 30 },
                { kind: 'solidCount', equals: 2 },   // base + lid
                { kind: 'noInterference' },
            ],
            negative: [
                { kind: 'maxVolume', max: 120000 },  // hollow shell, not a solid brick
            ],
            assembly: [
                { kind: 'casingBossAligned', equals: 4 },
            ],
        },
    },

    // ── assembly (the differentiators) ───────────────────────────────────────
    {
        id: 'bolt-nut-tslot',
        prompt: 'Drop an M3 bolt and an M3 nut into a 250 mm length of 2020 aluminium T-slot extrusion: the bolt threads down through the slot and the nut slides in the channel underneath.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'z', max: 250.5 },
                { kind: 'solidCount', min: 3 },   // extrusion + bolt + nut
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [
                { kind: 'mateSolved' },
                // The nut+channel is a sliding joint — the project's signature
                // profile-generated slot port. This is the check no one else has.
                { kind: 'inducedJoint', equals: 'prismatic' },
            ],
        },
    },
    {
        id: 'two-plates-4xM3',
        prompt: 'Bolt two 60×40×5 mm plates together face-to-face with four M3 bolts, one near each corner on a 50×30 mm hole pattern.',
        spec: {
            acceptance: [
                { kind: 'bbox', axis: 'x', size: 60 },
                { kind: 'bbox', axis: 'y', size: 40 },
                { kind: 'solidCount', min: 6 },   // 2 plates + 4 bolts
                { kind: 'holeCount', equals: 8 },  // 4 through each plate
                { kind: 'noInterference' },
            ],
            negative: [
                { kind: 'mustNotHaveHoleAt', origin: [30, 20, 5] },  // no hole dead-centre
            ],
            assembly: [
                { kind: 'mateSolved', equals: 4 },
                { kind: 'inducedJoint', equals: 'fixed' },
            ],
        },
    },
    {
        id: 'bearing-on-shaft',
        prompt: 'Press a 608 bearing (8 mm bore) onto an 8 mm shaft so the inner race spins freely on the shaft.',
        spec: {
            acceptance: [
                { kind: 'solidCount', min: 2 },   // shaft + bearing
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [
                { kind: 'mateSolved' },
                { kind: 'inducedJoint', equals: 'revolute' },
            ],
        },
    },
    {
        id: 'servo-swap-stable',
        prompt: 'Mount an SG90 servo to a bracket through its two mounting tabs, then swap it for an MG90S — the mounts should stay aligned.',
        spec: {
            acceptance: [
                { kind: 'solidCount', min: 2 },   // bracket + servo
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [
                { kind: 'mateSolved' },
                // The swap must rebind every mate with nothing left unresolved —
                // the role/interfaceId re-binding the connector contract enables.
                { kind: 'swapStable' },
            ],
        },
    },
    {
        id: 'standoff-stack',
        prompt: 'Stack a PCB on four M3 brass standoffs above a baseplate, all four standoffs threaded into the baseplate and the PCB resting on top.',
        spec: {
            acceptance: [
                { kind: 'solidCount', min: 6 },   // baseplate + PCB + 4 standoffs
                { kind: 'noInterference' },
            ],
            negative: [],
            assembly: [
                { kind: 'mateSolved' },
                { kind: 'inducedJoint', equals: 'fixed' },
            ],
        },
    },
];

export default BENCHMARK_TASKS;
