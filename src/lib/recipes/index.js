/**
 * Part-Recipe Library — parametric build123d code generators.
 *
 * THE KEYSTONE (PLAN-functional-design-brain.md §3): a structural part is
 *
 *     part = f(the component it hosts, the load, its neighbours)
 *
 * authored as CODE, not as static geometry, so it REFLOWS when the hosted
 * servo changes or the load changes. `replace_component` re-binds mates *and*
 * (because the part is a recipe) the mount re-evaluates against the new
 * `servo.dims`, so the bracket resizes automatically. A hand-modelled bracket
 * cannot do that.
 *
 * Each recipe is a pure function `recipe(opts) -> Python source string`. The
 * studio runs that string through the BuildScript path (tools_recipes.js ->
 * addBuildScript), so the Python obeys the BuildScript contract:
 *
 *   - `from build123d import *`
 *   - assign the final body to a variable named exactly `result`
 *   - world Z-UP, millimetres
 *   - SANDBOXED: only build123d, math, numpy — no os/sys/subprocess/etc.
 *
 * THE `# param` CONVENTION (lib/document/script_params.js, system_prompt.js §
 * "Dropping to code"): a top-of-script line of the form
 *
 *     WALL = 3.0  # param [2:6] mm
 *
 * is auto-hoisted into an editable slider by the studio. The hoister's regex
 * (`script_params.js` ASSIGN_RE) ONLY matches a BARE NUMERIC LITERAL on the
 * left of the comment — `NAME = <number>  # param ...`. An EXPRESSION on that
 * line (`WALL = LOAD * 0.5  # param`) will NOT hoist. So the strategy here is:
 *
 *   1. JS bakes every load-bearing number (servo dims, load-derived wall,
 *      clearance, counts) as a PLAIN LITERAL `# param` constant at the TOP.
 *   2. Python DERIVES all geometry from those constants — the f(servo, load,
 *      neighbour) relationship lives in the body of the script, while the
 *      tunable inputs are the hoisted sliders.
 *
 * That gives both halves of the keystone: the recipe derives geometry from the
 * hosted component / load at generation time, AND every load-bearing number
 * stays a turnable knob afterwards.
 */

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Finite number or fallback (never NaN / Infinity). */
function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Format a number for a Python literal that the `# param` hoister can read.
 * The hoister's ASSIGN_RE only matches `-?\d+(\.\d+)?`, so we emit a plain
 * decimal — never exponential, never `Infinity`/`NaN`. Rounded to 0.01 mm so
 * the slider value reads cleanly.
 */
function pyNum(v, fallback = 0) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = fallback;
    n = Math.round(n * 100) / 100;
    // toFixed avoids exponential form; trim trailing zeros but keep it a literal.
    let s = n.toFixed(2);
    s = s.replace(/\.?0+$/, '');
    return s.length ? s : '0';
}

/**
 * Wall thickness derived from the load (Nm). Below ~0.3 Nm a 9g hobby servo
 * load, ~2 mm is plenty; it grows ~roughly with the square-root of torque and
 * is clamped to a sane printable band [2, 8] mm. This is the load->structure
 * relationship made explicit; it is baked as the DEFAULT of the WALL slider,
 * which the user can still override.
 */
function wallForLoad(loadNm) {
    const L = Math.max(0, num(loadNm, 0.3));
    const w = 2.0 + 2.6 * Math.sqrt(L); // 0Nm->2.0, ~0.25Nm->3.3, ~2Nm->5.7
    return Math.min(8, Math.max(2, w));
}

/** Standard servo-dims block, defaulting to SG90 when a field is absent. */
function servoDims(servo) {
    const s = (servo && typeof servo === 'object') ? (servo.dims || servo) : {};
    return {
        bodyL: num(s.bodyL, 22.8),
        bodyW: num(s.bodyW, 12.2),
        bodyH: num(s.bodyH, 22.5),
        flangeEar: num(s.flangeEar, 4.6),
        flangeT: num(s.flangeT, 2.5),
        flangeZ: num(s.flangeZ, 15.9),
        bossR: num(s.bossR, 5.5),
        bossH: num(s.bossH, 4.0),
        shaftR: num(s.shaftR, 2.4),
        mountHoleD: num(s.mountHoleD, 2.0),
    };
}

/** Common header. Kept tiny so the hoisted `# param` block is the first thing. */
const HEADER = 'from build123d import *\nimport math\n\n';

/* ------------------------------------------------------------------ */
/* recipes                                                            */
/* ------------------------------------------------------------------ */

/**
 * servoMount — a U-bracket that cradles a servo by its flange ears, with the
 * mounting-hole pattern and the body cut-out DERIVED from `opts.servo` dims and
 * wall thickness DERIVED from `opts.loadNm`. Reflows when the servo is swapped.
 *
 * opts: { servo, loadNm, clearance }
 */
export function servoMount(opts = {}) {
    const d = servoDims(opts.servo);
    const wall = wallForLoad(opts.loadNm);
    const clr = num(opts.clearance, 0.2);
    // Flange-screw centres: the ears stick out flangeEar each side of bodyL.
    const holeSpanX = d.bodyL + d.flangeEar; // centre-to-centre along length
    return (
        HEADER +
        `# servoMount — cradles a servo by its flange; pattern derives from servo dims\n` +
        `BODY_L = ${pyNum(d.bodyL)}      # param [10:60] mm — hosted servo body length\n` +
        `BODY_W = ${pyNum(d.bodyW)}      # param [6:30] mm — hosted servo body width\n` +
        `FLANGE_Z = ${pyNum(d.flangeZ)}  # param [6:40] mm — flange height up the body\n` +
        `HOLE_SPAN = ${pyNum(holeSpanX)} # param [12:70] mm — flange screw centre span\n` +
        `HOLE_D = ${pyNum(d.mountHoleD)} # param [1.5:4] mm — flange screw clearance dia\n` +
        `WALL = ${pyNum(wall)}           # param [2:8] mm — load-derived wall\n` +
        `CLEAR = ${pyNum(clr)}           # param [0:0.6] mm — printed mating clearance\n` +
        `\n` +
        `# pocket the servo body sits in (plus printed clearance)\n` +
        `pocket_w = BODY_W + 2 * CLEAR\n` +
        `pocket_l = BODY_L + 2 * CLEAR\n` +
        `# U-bracket envelope: pocket walled on both long sides + a floor\n` +
        `outer_w = pocket_w + 2 * WALL\n` +
        `outer_l = pocket_l + 2 * WALL\n` +
        `height = FLANGE_Z + WALL\n` +
        `\n` +
        `block = Box(outer_l, outer_w, height, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `# carve the servo channel from the top, leaving a WALL-thick floor\n` +
        `cavity = Box(pocket_l, pocket_w, height, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `cavity = cavity.translate((0, 0, WALL))\n` +
        `body = block - cavity\n` +
        `\n` +
        `# flange screw holes through the two long side walls, at flange height\n` +
        `hole = Cylinder(HOLE_D / 2, outer_w + 2, align=(Align.CENTER, Align.CENTER, Align.CENTER))\n` +
        `hole = hole.rotate(Axis.X, 90)  # bore through +/-Y walls\n` +
        `for sx in (-HOLE_SPAN / 2, HOLE_SPAN / 2):\n` +
        `    body -= hole.translate((sx, 0, WALL + FLANGE_Z * 0.5))\n` +
        `\n` +
        `result = body\n`
    );
}

/**
 * legLink — a structural link (thigh / shin) spanning two joints. Length and
 * end-hub bore DERIVE from the neighbour spacing (`opts.lengthMm`) and the
 * actuator shaft/horn it bolts to; wall DERIVES from load. The two end hubs are
 * the mounting interfaces to its neighbours.
 *
 * opts: { lengthMm, loadNm, boreD, clearance }
 */
export function legLink(opts = {}) {
    const len = num(opts.lengthMm, 60);
    const wall = wallForLoad(opts.loadNm);
    const bore = num(opts.boreD, 3.2); // M3 clearance default
    const clr = num(opts.clearance, 0.2);
    const hubR = Math.max(bore / 2 + wall, 5);
    return (
        HEADER +
        `# legLink — beam between two joints; length derives from neighbour spacing\n` +
        `LENGTH = ${pyNum(len)}    # param [20:200] mm — joint-to-joint span\n` +
        `HUB_R = ${pyNum(hubR)}    # param [4:20] mm — end-hub radius (around the bore)\n` +
        `BORE_D = ${pyNum(bore)}   # param [2:8] mm — pivot bore at each end\n` +
        `WALL = ${pyNum(wall)}     # param [2:8] mm — load-derived web thickness\n` +
        `CLEAR = ${pyNum(clr)}     # param [0:0.6] mm — printed mating clearance\n` +
        `\n` +
        `web_h = 2 * HUB_R       # the connecting web is as tall as the hubs\n` +
        `thick = WALL * 2        # out-of-plane beam thickness\n` +
        `\n` +
        `# two end hubs joined by a tapered web — an I-ish link\n` +
        `hub = Cylinder(HUB_R, thick, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `a = hub.translate((-LENGTH / 2, 0, 0))\n` +
        `b = hub.translate((LENGTH / 2, 0, 0))\n` +
        `web = Box(LENGTH, web_h, thick, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `body = a + b + web\n` +
        `\n` +
        `# pivot bore through each hub (Z axis = pivot axis, Z-up)\n` +
        `bore = Cylinder((BORE_D + CLEAR) / 2, thick + 2, align=(Align.CENTER, Align.CENTER, Align.CENTER))\n` +
        `bore = bore.translate((0, 0, thick / 2))\n` +
        `body -= bore.translate((-LENGTH / 2, 0, 0))\n` +
        `body -= bore.translate((LENGTH / 2, 0, 0))\n` +
        `\n` +
        `result = body\n`
    );
}

/**
 * revoluteClevis — a forked (clevis) bracket for a single-axis revolute joint:
 * two parallel ears with a coaxial pin bore, on a mounting base. Gap between
 * ears DERIVES from the mating tongue thickness (`opts.tongueW`), pin bore from
 * the pin, wall/ear thickness from load. The induced joint is REVOLUTE.
 *
 * opts: { tongueW, pinD, loadNm, baseW, clearance }
 */
export function revoluteClevis(opts = {}) {
    const tongueW = num(opts.tongueW, 12);
    const pinD = num(opts.pinD, 4);
    const wall = wallForLoad(opts.loadNm);
    const clr = num(opts.clearance, 0.3);
    const earR = Math.max(pinD / 2 + wall, 6);
    const baseW = num(opts.baseW, tongueW + 4 * wall + 8);
    return (
        HEADER +
        `# revoluteClevis — forked ears + coaxial pin bore; induced joint = REVOLUTE\n` +
        `GAP = ${pyNum(tongueW)}    # param [4:40] mm — slot for the mating tongue\n` +
        `EAR_R = ${pyNum(earR)}     # param [4:25] mm — ear radius around the pin\n` +
        `PIN_D = ${pyNum(pinD)}     # param [2:12] mm — pivot pin diameter\n` +
        `EAR_T = ${pyNum(wall)}     # param [2:8] mm — load-derived ear thickness\n` +
        `BASE_W = ${pyNum(baseW)}   # param [10:80] mm — mounting base width\n` +
        `CLEAR = ${pyNum(clr)}      # param [0:0.6] mm — printed clearance in the slot\n` +
        `\n` +
        `slot = GAP + 2 * CLEAR\n` +
        `base_h = EAR_T            # base plate thickness\n` +
        `base_l = 2 * EAR_R        # base footprint along the pin axis depth\n` +
        `\n` +
        `# mounting base on the XY plane\n` +
        `base = Box(base_l, BASE_W, base_h, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `\n` +
        `# two ears rise in +Z, separated by the slot along Y, pin bore along X\n` +
        `ear = Cylinder(EAR_R, EAR_T, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `ear = ear.rotate(Axis.Y, 90)              # disk faces +/-X, axis along X\n` +
        `ear = ear.translate((0, 0, base_h + EAR_R))\n` +
        `ear_a = ear.translate((0, (slot + EAR_T) / 2, 0))\n` +
        `ear_b = ear.translate((0, -(slot + EAR_T) / 2, 0))\n` +
        `body = base + ear_a + ear_b\n` +
        `\n` +
        `# coaxial pin bore through both ears (axis = X = the revolute axis)\n` +
        `pin = Cylinder((PIN_D + CLEAR) / 2, slot + 2 * EAR_T + 2, align=(Align.CENTER, Align.CENTER, Align.CENTER))\n` +
        `pin = pin.rotate(Axis.Y, 90)\n` +
        `pin = pin.translate((0, 0, base_h + EAR_R))\n` +
        `body -= pin\n` +
        `\n` +
        `result = body\n`
    );
}

/**
 * ballSocket — a spherical socket cup for a ball-joint (multi-DOF link). Socket
 * radius DERIVES from the ball (`opts.ballD`) plus a printed snap clearance; the
 * cup mouth is undercut so the ball clicks in. Wall DERIVES from load. Sits on
 * a mounting stem.
 *
 * opts: { ballD, loadNm, clearance, stemD }
 */
export function ballSocket(opts = {}) {
    const ballD = num(opts.ballD, 10);
    const wall = wallForLoad(opts.loadNm);
    const clr = num(opts.clearance, 0.25);
    const stemD = num(opts.stemD, Math.max(ballD * 0.6, 5));
    return (
        HEADER +
        `# ballSocket — spherical cup that snaps over a ball; socket derives from ball\n` +
        `BALL_D = ${pyNum(ballD)}   # param [4:40] mm — mating ball diameter\n` +
        `WALL = ${pyNum(wall)}      # param [2:8] mm — load-derived cup wall\n` +
        `CLEAR = ${pyNum(clr)}      # param [0:0.6] mm — printed snap clearance\n` +
        `STEM_D = ${pyNum(stemD)}   # param [3:30] mm — mounting stem diameter\n` +
        `MOUTH = 70                 # param [40:120] deg — opening (>90 = snap-fit lip)\n` +
        `\n` +
        `ball_r = BALL_D / 2\n` +
        `socket_r = ball_r + CLEAR\n` +
        `outer_r = socket_r + WALL\n` +
        `\n` +
        `# solid cup: outer sphere on a stem, hollowed by the socket sphere\n` +
        `cup = Sphere(outer_r, align=(Align.CENTER, Align.CENTER, Align.CENTER))\n` +
        `cup = cup.translate((0, 0, outer_r))\n` +
        `socket = Sphere(socket_r, align=(Align.CENTER, Align.CENTER, Align.CENTER))\n` +
        `cup -= socket.translate((0, 0, outer_r))\n` +
        `\n` +
        `# open the mouth: clip off the top cap so the ball can enter (+Z)\n` +
        `# mouth angle controls how much of the top is removed\n` +
        `cap_z = outer_r * math.cos(math.radians(MOUTH) / 2)\n` +
        `mouth = Box(4 * outer_r, 4 * outer_r, 2 * outer_r, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `cup -= mouth.translate((0, 0, outer_r + cap_z))\n` +
        `\n` +
        `# mounting stem dropping to the XY plane\n` +
        `stem = Cylinder(STEM_D / 2, outer_r, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `body = cup + stem\n` +
        `\n` +
        `result = body\n`
    );
}

/**
 * bodyShellWithBosses — a hollow body shell (the chassis / casing) with a ring
 * of screw bosses for a lid. Shell wall DERIVES from load; boss count and bore
 * DERIVE from the fastener (`opts.screwD`). The cavity is the keep-out envelope
 * the electronics live in (`opts.innerL/W/H`).
 *
 * opts: { innerL, innerW, innerH, loadNm, screwD, bossCount, clearance }
 */
export function bodyShellWithBosses(opts = {}) {
    const innerL = num(opts.innerL, 60);
    const innerW = num(opts.innerW, 40);
    const innerH = num(opts.innerH, 25);
    const wall = wallForLoad(opts.loadNm);
    const screwD = num(opts.screwD, 3);
    const bossCount = Math.max(2, Math.round(num(opts.bossCount, 4)));
    const clr = num(opts.clearance, 0.2);
    return (
        HEADER +
        `# bodyShellWithBosses — hollow casing + lid screw bosses; cavity = keep-out\n` +
        `INNER_L = ${pyNum(innerL)}     # param [20:200] mm — cavity length (keep-out)\n` +
        `INNER_W = ${pyNum(innerW)}     # param [20:200] mm — cavity width (keep-out)\n` +
        `INNER_H = ${pyNum(innerH)}     # param [10:150] mm — cavity height (keep-out)\n` +
        `WALL = ${pyNum(wall)}          # param [2:8] mm — load-derived shell wall\n` +
        `SCREW_D = ${pyNum(screwD)}     # param [2:8] mm — lid screw size\n` +
        `BOSS_N = ${pyNum(bossCount)}   # param [2:8] count — screw bosses\n` +
        `CLEAR = ${pyNum(clr)}          # param [0:0.6] mm — printed clearance\n` +
        `\n` +
        `outer_l = INNER_L + 2 * WALL\n` +
        `outer_w = INNER_W + 2 * WALL\n` +
        `outer_h = INNER_H + WALL          # open top (lid closes it)\n` +
        `\n` +
        `# shell = outer box minus inner cavity (floor stays WALL thick)\n` +
        `outer = Box(outer_l, outer_w, outer_h, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `cavity = Box(INNER_L, INNER_W, INNER_H + WALL, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `body = outer - cavity.translate((0, 0, WALL))\n` +
        `\n` +
        `# screw bosses standing in the inner corners, hole for the lid screw\n` +
        `boss_r = SCREW_D / 2 + WALL\n` +
        `pilot_r = (SCREW_D - 0.5) / 2          # self-tapping pilot (snug)\n` +
        `# distribute BOSS_N around the inner perimeter (corner-biased)\n` +
        `px = INNER_L / 2 - boss_r\n` +
        `py = INNER_W / 2 - boss_r\n` +
        `corners = [(px, py), (-px, py), (-px, -py), (px, -py)]\n` +
        `n = int(round(BOSS_N))\n` +
        `for i in range(min(n, 4)):\n` +
        `    cx, cy = corners[i]\n` +
        `    boss = Cylinder(boss_r, outer_h, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `    hole = Cylinder(pilot_r, outer_h, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `    body += boss.translate((cx, cy, WALL))\n` +
        `    body -= hole.translate((cx, cy, WALL))\n` +
        `\n` +
        `result = body\n`
    );
}

/**
 * ventGrille — a vented panel placed over a heat source (controller / battery).
 * Panel size DERIVES from the area to cover (`opts.panelL/W`); slot count /
 * pitch DERIVE from open-area target. Z-up: the panel lies in the XY plane,
 * slots cut through its thickness. Wall (rib) thickness DERIVES from load.
 *
 * opts: { panelL, panelW, loadNm, slotCount, openFraction }
 */
export function ventGrille(opts = {}) {
    const panelL = num(opts.panelL, 50);
    const panelW = num(opts.panelW, 30);
    const wall = Math.min(wallForLoad(opts.loadNm), 4); // panels stay thin
    const slots = Math.max(2, Math.round(num(opts.slotCount, 6)));
    const open = Math.min(0.8, Math.max(0.2, num(opts.openFraction, 0.5)));
    return (
        HEADER +
        `# ventGrille — louvred panel over a heat source; slots derive from open-area\n` +
        `PANEL_L = ${pyNum(panelL)}   # param [10:200] mm — panel length (over the source)\n` +
        `PANEL_W = ${pyNum(panelW)}   # param [10:200] mm — panel width\n` +
        `THICK = ${pyNum(wall)}       # param [1.5:5] mm — panel/rib thickness\n` +
        `SLOTS = ${pyNum(slots)}      # param [2:24] count — vent slots\n` +
        `OPEN = ${pyNum(open)}        # param [0.2:0.8] fraction — open-area target\n` +
        `\n` +
        `# the panel: a thin plate on the XY plane\n` +
        `panel = Box(PANEL_L, PANEL_W, THICK, align=(Align.CENTER, Align.CENTER, Align.MIN))\n` +
        `\n` +
        `# slots run along +Y; their width derives from the open-area fraction\n` +
        `n = int(round(SLOTS))\n` +
        `pitch = PANEL_L / n\n` +
        `slot_w = max(0.6, pitch * OPEN)\n` +
        `slot_l = PANEL_W * 0.85\n` +
        `body = panel\n` +
        `start = -PANEL_L / 2 + pitch / 2\n` +
        `for i in range(n):\n` +
        `    cx = start + i * pitch\n` +
        `    slot = Box(slot_w, slot_l, THICK + 2, align=(Align.CENTER, Align.CENTER, Align.CENTER))\n` +
        `    body -= slot.translate((cx, 0, THICK / 2))\n` +
        `\n` +
        `result = body\n`
    );
}

/* ------------------------------------------------------------------ */
/* registry                                                           */
/* ------------------------------------------------------------------ */

/**
 * The recipe registry: name -> generator. Keep the keys camelCase and stable —
 * the AI tool (`build_part_recipe`) selects by these names, and they are the
 * public contract.
 */
export const RECIPES = {
    servoMount,
    legLink,
    revoluteClevis,
    ballSocket,
    bodyShellWithBosses,
    ventGrille,
};

/** The set of recipe names (for tool enums / validation). */
export const RECIPE_NAMES = Object.keys(RECIPES);

/**
 * Machine-readable per-recipe metadata — the SINGLE SOURCE OF TRUTH that the
 * recipe meta-tools (tools_recipe_meta.js) read. `describe_recipe(recipe)`
 * returns one of these entries as a TOOL RESULT, so the heavy per-recipe
 * parameter docs are fetched ON DEMAND instead of being inlined in an always-on
 * tool description. That is what keeps the advertised recipe surface O(1) as the
 * library grows: the `tools` array carries three small fixed tools, and the
 * per-recipe schema only enters context for the one recipe the model commits to.
 *
 * Shape: { purpose, params: { key: { type, description, default? } }, required }.
 * Keep this in lock-step with the recipe functions above — a param a recipe
 * reads from `opts` should appear here so the model can discover it.
 */
export const RECIPE_SPECS = {
    servoMount: {
        purpose: 'U-bracket that cradles a servo by its flange ears — hole pattern + body envelope derive from the servo dims, wall thickness from load. Reflows when the servo is swapped.',
        params: {
            servo: { type: 'object', description: 'Hosted servo dims object: {bodyL,bodyW,bodyH,flangeEar,flangeZ,bossR,shaftR,mountHoleD} in mm. Omitted fields default to SG90.' },
            loadNm: { type: 'number', description: 'Joint load in Nm — drives the load-derived wall thickness.', default: 0.3 },
            clearance: { type: 'number', description: 'Printed mating clearance in mm.', default: 0.2 },
        },
        required: [],
    },
    legLink: {
        purpose: 'A beam/link between two joints — length derives from neighbour spacing, end bores from the pivot pin, web thickness from load.',
        params: {
            lengthMm: { type: 'number', description: 'Joint-to-joint span in mm.', default: 60 },
            loadNm: { type: 'number', description: 'Joint load in Nm — drives web thickness.', default: 0.3 },
            boreD: { type: 'number', description: 'Pivot bore diameter at each end in mm.', default: 3.2 },
            clearance: { type: 'number', description: 'Printed mating clearance in mm.', default: 0.2 },
        },
        required: [],
    },
    revoluteClevis: {
        purpose: 'Forked (clevis) ears + coaxial pin bore for a single-axis REVOLUTE joint — the ear gap derives from the mating tongue, the bore from the pin, ear/wall thickness from load.',
        params: {
            tongueW: { type: 'number', description: 'Mating tongue thickness in mm — sets the slot between the ears.', default: 12 },
            pinD: { type: 'number', description: 'Pivot pin diameter in mm.', default: 4 },
            loadNm: { type: 'number', description: 'Joint load in Nm — drives ear/wall thickness.', default: 0.3 },
            baseW: { type: 'number', description: 'Mounting base width in mm (defaults derived from tongue + walls).' },
            clearance: { type: 'number', description: 'Printed clearance in the slot in mm.', default: 0.3 },
        },
        required: [],
    },
    ballSocket: {
        purpose: 'A snap-fit spherical socket cup for a multi-DOF ball joint — socket radius derives from the ball, wall from load, mounted on a stem.',
        params: {
            ballD: { type: 'number', description: 'Mating ball diameter in mm.', default: 10 },
            loadNm: { type: 'number', description: 'Joint load in Nm — drives the cup wall.', default: 0.3 },
            clearance: { type: 'number', description: 'Printed snap clearance in mm.', default: 0.25 },
            stemD: { type: 'number', description: 'Mounting stem diameter in mm (defaults ~0.6×ball).' },
        },
        required: [],
    },
    bodyShellWithBosses: {
        purpose: 'A hollow chassis/casing with a ring of lid screw bosses — the cavity is the electronics keep-out envelope, wall from load, boss bore from the fastener.',
        params: {
            innerL: { type: 'number', description: 'Cavity (keep-out) length in mm.', default: 60 },
            innerW: { type: 'number', description: 'Cavity (keep-out) width in mm.', default: 40 },
            innerH: { type: 'number', description: 'Cavity (keep-out) height in mm.', default: 25 },
            loadNm: { type: 'number', description: 'Load in Nm — drives the shell wall.', default: 0.3 },
            screwD: { type: 'number', description: 'Lid screw size in mm.', default: 3 },
            bossCount: { type: 'number', description: 'Number of lid screw bosses (corner-biased, max 4 placed).', default: 4 },
            clearance: { type: 'number', description: 'Printed clearance in mm.', default: 0.2 },
        },
        required: [],
    },
    ventGrille: {
        purpose: 'A louvred panel placed over a heat source — panel size covers the area, slot count/pitch derive from the open-area target, rib thickness from load.',
        params: {
            panelL: { type: 'number', description: 'Panel length (over the source) in mm.', default: 50 },
            panelW: { type: 'number', description: 'Panel width in mm.', default: 30 },
            loadNm: { type: 'number', description: 'Load in Nm — drives panel/rib thickness (clamped thin).', default: 0.3 },
            slotCount: { type: 'number', description: 'Number of vent slots.', default: 6 },
            openFraction: { type: 'number', description: 'Open-area target as a fraction 0.2–0.8.', default: 0.5 },
        },
        required: [],
    },
};

/**
 * Generate the build123d source for `name(opts)`, or null if the name is not a
 * known recipe. Never throws on a bad opts — recipes coerce their own inputs.
 */
export function buildRecipeSource(name, opts = {}) {
    const fn = RECIPES[name];
    if (typeof fn !== 'function') return null;
    return fn(opts || {});
}

export default RECIPES;
