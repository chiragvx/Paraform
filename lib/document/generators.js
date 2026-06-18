/**
 * Parametric domain generators — the "scaffold, not the model" family.
 *
 * Each function turns a feature's params into deterministic build123d Python
 * that assigns `n_<id>` (the generated body). They follow the contract proven
 * by emitGearPython / emitCasingPython in emit.js:
 *
 *   1. PURE + DETERMINISTIC — only the feature params decide the output. Every
 *      number is cleanNum'd so an identical feature emits byte-identical Python
 *      (the content-addressed compile cache depends on this).
 *   2. Z-UP, Align.MIN ON Z — the body sits on the world XY plane (bottom face
 *      at Z=0), per the project's primitive convention (CLAUDE.md).
 *   3. FAIL-SAFE — the whole build is wrapped in try/except that DEGRADES to a
 *      plain primitive, so even if an OCCT op chokes the document still compiles
 *      and the user sees *something* roughly the right size instead of a hard
 *      "name not defined" crash.
 *
 * These exist because hand-composing a pulley / sprocket / extrusion / boss out
 * of primitives is exactly where a weak model fails: the correctness lives in
 * the generator, not in the model's spatial reasoning. Each is also a planning
 * vocabulary word (a "pulley" is one node, not five).
 *
 * Geometry notes are intentionally v1-pragmatic: shapes are recognisable and
 * printable, sized to the standard parameters, but not metrologically exact
 * (e.g. T-slots are simple open channels, not the full undercut "T"). Refining a
 * profile is a localised change to one emitter here.
 */

import { cleanNum } from './casing.js';

const C = cleanNum;

/**
 * A reusable centre-bore subtraction: a through-cut cylinder spanning the body
 * in Z with 1mm of overhang each end so the boolean is clean.
 * @param {string} id   feature id (for the n_<id> variable)
 * @param {number} dia  bore diameter (mm); <= 0 emits nothing
 * @param {number} th   body thickness/height in Z (mm)
 * @param {string} [cx] centre X expression (default '0')
 * @param {string} [cy] centre Y expression (default '0')
 */
function boreCut(id, dia, th, cx = '0', cy = '0') {
    if (!(dia > 0)) return null;
    return `    n_${id} = n_${id} - Cylinder(${C(dia / 2)}, ${C(th + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((${cx}, ${cy}, -1)))`;
}

/**
 * Normalise n_<id> to a single Compound when a boolean left a multi-solid
 * ShapeList (a fuse of disjoint bodies) — the kernel can't tessellate/measure a
 * ShapeList. No-op for a single solid. (Learned from the fan shroud.)
 */
function compoundFix(id) {
    return [
        `try:`,
        `    _sl_${id}=n_${id}.solids()`,
        `    if len(_sl_${id})>1: n_${id}=Compound(list(_sl_${id}))`,
        `except Exception: pass`,
    ];
}

/**
 * Subtract a centred rows×cols grid of through-holes from n_<id>. Holes run
 * along +Z through a body of height `th` (bottom at z0). Returns python lines.
 */
function holeGridCuts(id, { holeDia, rows, cols, pitchX, pitchY, th, z0 = 0, csDia = 0, csDepth = 0 }) {
    const hd = Number(holeDia) > 0 ? Number(holeDia) : 0;
    const r = Math.max(1, Math.round(Number(rows) || 1));
    const c = Math.max(1, Math.round(Number(cols) || 1));
    if (!(hd > 0) || r * c < 1) return [];
    const px = Number(pitchX) > 0 ? Number(pitchX) : 10;
    const py = Number(pitchY) > 0 ? Number(pitchY) : 10;
    const out = [
        `for _gi in range(${r}):`,
        `    for _gj in range(${c}):`,
        `        _gx=(_gj-(${c}-1)/2.0)*${C(px)}; _gy=(_gi-(${r}-1)/2.0)*${C(py)}`,
        `        n_${id}=n_${id}-Cylinder(${C(hd / 2)},${C(th + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_gx,_gy,${C(z0 - 1)})))`,
    ];
    if (csDia > 0 && csDepth > 0) {
        // Countersink cone at the top face (z0+th), opening up.
        out.push(`        n_${id}=n_${id}-Cone(${C(csDia / 2)},${C(hd / 2)},${C(csDepth)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_gx,_gy,${C(z0 + th - csDepth)})))`);
    }
    return out;
}

/** A ring of bolt-circle holes (shared with the gear convention). */
function boltCircleCuts(id, count, circleDia, holeDia, th) {
    const bc = Math.max(0, Math.round(Number(count) || 0));
    const bcd = Number(circleDia) > 0 ? Number(circleDia) : 0;
    const bhd = Number(holeDia) > 0 ? Number(holeDia) : 3;
    if (!(bc > 0 && bcd > 0)) return [];
    return [
        `    _bcr_${id} = ${C(bcd / 2)}`,
        `    for _j in range(${bc}):`,
        `        _ba = 2*_m.pi*_j/${bc}`,
        `        n_${id} = n_${id} - Cylinder(${C(bhd / 2)}, ${C(th + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((_bcr_${id}*_m.cos(_ba), _bcr_${id}*_m.sin(_ba), -1)))`,
    ];
}

// ── Pulley ─────────────────────────────────────────────────────────────────────
/**
 * Belt pulley: a hub of `diameter` × `width`, optional end flanges, a centre
 * bore, an optional V-groove (revolved wedge) for a V-belt, and an optional
 * radial set-screw hole through the hub. Degrades to a bored cylinder.
 *
 * params: { diameter, width, bore, pulleyType:'flat'|'vbelt'|'round',
 *           flange:boolean, flangeDiameter, flangeThickness, setScrew }
 */
export function emitPulleyPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 30;
    const W = Number(p.width) > 0 ? Number(p.width) : 10;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 0;
    const type = ['flat', 'vbelt', 'round'].includes(p.pulleyType) ? p.pulleyType : 'flat';
    const flange = p.flange !== false && (type === 'vbelt' || type === 'round' || p.flange === true);
    const fD = Number(p.flangeDiameter) > 0 ? Number(p.flangeDiameter) : D + 2 * Math.max(2, D * 0.12);
    const fT = Number(p.flangeThickness) > 0 ? Number(p.flangeThickness) : Math.max(1.5, W * 0.15);
    const setScrew = Number(p.setScrew) > 0 ? Number(p.setScrew) : 0;
    const r = D / 2;

    const L = [];
    L.push(`# ── Pulley ${id} (${type}, Ø${C(D)} × ${C(W)}mm${bore ? `, bore Ø${C(bore)}` : ''}${flange ? ', flanged' : ''}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id} = Cylinder(${C(r)}, ${C(W)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    if (flange) {
        // Two thin disks of flangeDiameter at each end; the belt rides between them.
        L.push(`    n_${id} = n_${id} + Cylinder(${C(fD / 2)}, ${C(fT)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
        L.push(`    n_${id} = n_${id} + Cylinder(${C(fD / 2)}, ${C(fT)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, ${C(W - fT)})))`);
    }
    if (type === 'vbelt') {
        // Revolve a V wedge around Z, biting into the rim mid-face.
        const half = Math.min(W * 0.35, r * 0.5);
        const depth = Math.min(r * 0.35, W * 0.4);
        const zc = W / 2;
        L.push(`    try:`);
        L.push(`        _gv_${id} = [(${C(r + 0.5)}, ${C(zc - half)}), (${C(r - depth)}, ${C(zc)}), (${C(r + 0.5)}, ${C(zc + half)})]`);
        L.push(`        _groove_${id} = revolve(make_face(Polyline(*_gv_${id}, close=True)), Axis.Z)`);
        L.push(`        n_${id} = n_${id} - _groove_${id}`);
        L.push(`    except Exception: pass  # groove skipped — pulley still valid`);
    } else if (type === 'round') {
        // Round-belt groove: subtract a torus seated at the rim mid-face.
        const minor = Math.min(W * 0.3, r * 0.3);
        L.push(`    try:`);
        L.push(`        n_${id} = n_${id} - Torus(${C(r)}, ${C(minor)}).moved(Location((0, 0, ${C(W / 2)})))`);
        L.push(`    except Exception: pass  # groove skipped — pulley still valid`);
    }
    const bc = boreCut(id, bore, flange ? Math.max(W, fT) : W);
    if (bc) L.push(bc);
    if (setScrew > 0) {
        // Radial hole through the hub wall into the bore region (M-grub screw).
        const zc = flange ? W / 2 : W * 0.5;
        L.push(`    try:`);
        L.push(`        n_${id} = n_${id} - Cylinder(${C(setScrew / 2)}, ${C(r + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, ${C(zc)}), (0, 90, 0)))`);
        L.push(`    except Exception: pass  # set-screw hole skipped`);
    }
    L.push(`except Exception as _pulley_err_${id}:`);
    L.push(`    n_${id} = Cylinder(${C(r)}, ${C(W)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    const fb = boreCut(id, bore, W);
    if (fb) L.push(fb);
    return L.join('\n');
}

// ── Sprocket ─────────────────────────────────────────────────────────────────
/**
 * Roller-chain sprocket. Pitch diameter D = pitch / sin(pi/N); the tooth tip
 * disk is sized by the standard outside-diameter formula and N roller-seat
 * pockets are carved at the pitch circle so the teeth fall out between them.
 * Optional bore + bolt circle (same convention as the gear). Degrades to a
 * bored disk.
 *
 * params: { teeth, chainPitch, rollerDiameter, thickness, bore,
 *           boltCount, boltCircleDiameter, boltHoleDiameter }
 */
export function emitSprocketPython(f) {
    const p = f.params || {};
    const id = f.id;
    const N = Math.max(6, Math.round(Number(p.teeth) || 16));
    const P = Number(p.chainPitch) > 0 ? Number(p.chainPitch) : 12.7;     // default #40 / 1/2"
    const Dr = Number(p.rollerDiameter) > 0 ? Number(p.rollerDiameter) : P * 0.6;
    const th = Number(p.thickness) > 0 ? Number(p.thickness) : 5;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 0;

    const pitchR = P / (2 * Math.sin(Math.PI / N));
    // Standard outside (tip) diameter: OD = P * (0.6 + cot(180/N)).
    const od = P * (0.6 + 1 / Math.tan(Math.PI / N));
    const tipR = od / 2;
    const seatR = Dr / 2;

    const L = [];
    L.push(`# ── Sprocket ${id} (${N}T, pitch ${C(P)}mm, roller Ø${C(Dr)}, PD Ø${C(2 * pitchR)}, OD Ø${C(od)}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id} = Cylinder(${C(tipR)}, ${C(th)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    L.push(`    _pr_${id} = ${C(pitchR)}`);
    L.push(`    for _k in range(${N}):`);
    L.push(`        _a = 2*_m.pi*_k/${N}`);
    L.push(`        n_${id} = n_${id} - Cylinder(${C(seatR)}, ${C(th + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((_pr_${id}*_m.cos(_a), _pr_${id}*_m.sin(_a), -1)))`);
    const bc = boreCut(id, bore, th);
    if (bc) L.push(bc);
    for (const line of boltCircleCuts(id, p.boltCount, p.boltCircleDiameter, p.boltHoleDiameter, th)) L.push(line);
    L.push(`except Exception as _sprk_err_${id}:`);
    L.push(`    n_${id} = Cylinder(${C(tipR)}, ${C(th)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    const fb = boreCut(id, bore, th);
    if (fb) L.push(fb);
    return L.join('\n');
}

// ── T-slot extrusion ───────────────────────────────────────────────────────────
/**
 * Aluminium framing profile (2020 / 3030 / 4040 style): a `size` × `size` bar of
 * `length` along +Z, with a centre bore and one open slot channel per face.
 * v1 slots are simple rectangular channels (not the full undercut "T"), which
 * print and read correctly. Degrades to a plain square bar.
 *
 * params: { size, length, slotWidth, bore, slots:boolean }
 */
export function emitTSlotPython(f) {
    const p = f.params || {};
    const id = f.id;
    const S = Number(p.size) > 0 ? Number(p.size) : 20;
    const Lz = Number(p.length) > 0 ? Number(p.length) : 100;
    // 20-series ~6mm slot; scale with profile size.
    const slotW = Number(p.slotWidth) > 0 ? Number(p.slotWidth) : Math.max(4, S * 0.3);
    const bore = Number(p.bore) > 0 ? Number(p.bore) : Math.max(4, S * 0.25);
    const slots = p.slots !== false;
    const depth = S * 0.32;          // how far a slot channel bites toward centre
    const half = S / 2;

    const L = [];
    L.push(`# ── T-slot extrusion ${id} (${C(S)}×${C(S)} series, ${C(Lz)}mm long${slots ? ', 4 slots' : ''}) ──`);
    L.push(`try:`);
    // Rectangle / RegularPolygon are already 2D faces in build123d algebra mode
    // (unlike Polyline, a wire) — extrude them directly, no make_face.
    L.push(`    n_${id} = extrude(Rectangle(${C(S)}, ${C(S)}), amount=${C(Lz)})`);
    if (bore > 0) {
        L.push(`    n_${id} = n_${id} - Cylinder(${C(bore / 2)}, ${C(Lz + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, -1)))`);
    }
    if (slots) {
        // One channel per face: a box of slotW × depth running the full length,
        // its outer edge flush with the face, biting `depth` toward the centre.
        // +X / -X faces (channel runs along Z, width in Y): Box(depth, slotW, Lz).
        L.push(`    _slot_x_${id} = Box(${C(depth + 1)}, ${C(slotW)}, ${C(Lz + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((${C(half - depth / 2 + 0.5)}, 0, -1)))`);
        L.push(`    _slot_y_${id} = Box(${C(slotW)}, ${C(depth + 1)}, ${C(Lz + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, ${C(half - depth / 2 + 0.5)}, -1)))`);
        L.push(`    n_${id} = n_${id} - _slot_x_${id} - _slot_x_${id}.moved(Location((${C(-(2 * half - depth - 1))}, 0, 0)))`);
        L.push(`    n_${id} = n_${id} - _slot_y_${id} - _slot_y_${id}.moved(Location((0, ${C(-(2 * half - depth - 1))}, 0)))`);
    }
    L.push(`except Exception as _tslot_err_${id}:`);
    L.push(`    n_${id} = Box(${C(S)}, ${C(S)}, ${C(Lz)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    return L.join('\n');
}

/** Self-tapping pilot diameter (mm) for a metric screw nominal, for bosses. */
const SCREW_PILOT_MM = { M2: 1.6, 'M2.5': 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5.0 };

// ── Screw boss ───────────────────────────────────────────────────────────────
/**
 * Mounting boss/post for a self-tapping screw: an outer collar of `outer` ×
 * `height` with a pilot hole, optional triangular support ribs (gussets) around
 * it and an optional base fillet. Sized from `screwSize` when explicit diameters
 * are omitted. Degrades to a plain bored post.
 *
 * params: { screwSize, height, outerDiameter, pilotDiameter, pilotDepth,
 *           ribs, ribThickness, baseFillet }
 */
export function emitScrewBossPython(f) {
    const p = f.params || {};
    const id = f.id;
    const pilot = Number(p.pilotDiameter) > 0 ? Number(p.pilotDiameter)
        : (SCREW_PILOT_MM[p.screwSize] || 2.5);
    const outer = Number(p.outerDiameter) > 0 ? Number(p.outerDiameter)
        : Math.max(pilot + 3, pilot * 2.2);
    const H = Number(p.height) > 0 ? Number(p.height) : 8;
    const pilotDepth = Number(p.pilotDepth) > 0 ? Math.min(Number(p.pilotDepth), H) : Math.max(1, H - 1);
    const ribs = Math.max(0, Math.round(Number(p.ribs) || 0));
    const ribThk = Number(p.ribThickness) > 0 ? Number(p.ribThickness) : Math.max(1, outer * 0.18);
    const ribLen = outer * 0.9;       // how far a rib reaches out from the post centre
    const ribH = H * 0.8;
    const baseFillet = Number(p.baseFillet) > 0 ? Number(p.baseFillet) : 0;
    const ro = outer / 2;

    const L = [];
    L.push(`# ── Screw boss ${id} (${p.screwSize || 'self-tap'}: outer Ø${C(outer)}, pilot Ø${C(pilot)}, h${C(H)}${ribs ? `, ${ribs} ribs` : ''}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id} = Cylinder(${C(ro)}, ${C(H)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    if (ribs > 0) {
        // Each rib: a thin box reaching from the post centre outward, rotated.
        L.push(`    for _k in range(${ribs}):`);
        L.push(`        _ra = 360.0*_k/${ribs}`);
        L.push(`        _rib = Box(${C(ribLen)}, ${C(ribThk)}, ${C(ribH)}, align=(Align.MIN, Align.CENTER, Align.MIN)).moved(Location((0, 0, 0), (0, 0, _ra)))`);
        L.push(`        n_${id} = n_${id} + _rib`);
    }
    if (baseFillet > 0) {
        L.push(`    try:`);
        L.push(`        n_${id} = fillet(n_${id}.edges().group_by(Axis.Z)[0], radius=${C(baseFillet)})`);
        L.push(`    except Exception: pass  # base fillet skipped`);
    }
    // Pilot hole down from the top, leaving `H - pilotDepth` of floor.
    L.push(`    n_${id} = n_${id} - Cylinder(${C(pilot / 2)}, ${C(pilotDepth + 1)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, ${C(H - pilotDepth)})))`);
    L.push(`except Exception as _boss_err_${id}:`);
    L.push(`    n_${id} = Cylinder(${C(ro)}, ${C(H)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    L.push(`    n_${id} = n_${id} - Cylinder(${C(pilot / 2)}, ${C(pilotDepth + 1)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, ${C(H - pilotDepth)})))`);
    return L.join('\n');
}

// ── Standoff / spacer ──────────────────────────────────────────────────────────
/**
 * PCB / panel standoff (spacer): a hex or round pillar of `height` with a
 * through bore. Hex `size` is across-flats; round `size` is the outer diameter.
 * Degrades to a bored cylinder.
 *
 * params: { shape:'hex'|'round', size, height, bore }
 */
export function emitStandoffPython(f) {
    const p = f.params || {};
    const id = f.id;
    const shape = p.shape === 'round' ? 'round' : 'hex';
    const size = Number(p.size) > 0 ? Number(p.size) : 6;
    const H = Number(p.height) > 0 ? Number(p.height) : 10;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : Math.max(1.5, size * 0.4);
    // Hex circumradius from across-flats: R = AF / (2*cos30) = AF / sqrt(3).
    const circR = size / Math.sqrt(3);
    const roundR = size / 2;

    const L = [];
    L.push(`# ── Standoff ${id} (${shape}, ${shape === 'hex' ? `AF ${C(size)}` : `Ø${C(size)}`} × ${C(H)}mm, bore Ø${C(bore)}) ──`);
    L.push(`try:`);
    if (shape === 'hex') {
        L.push(`    n_${id} = extrude(RegularPolygon(${C(circR)}, 6), amount=${C(H)})`);
    } else {
        L.push(`    n_${id} = Cylinder(${C(roundR)}, ${C(H)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    }
    if (bore > 0) {
        L.push(`    n_${id} = n_${id} - Cylinder(${C(bore / 2)}, ${C(H + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, -1)))`);
    }
    L.push(`except Exception as _stdoff_err_${id}:`);
    L.push(`    n_${id} = Cylinder(${C(shape === 'hex' ? circR : roundR)}, ${C(H)}, align=(Align.CENTER, Align.CENTER, Align.MIN))`);
    if (bore > 0) {
        L.push(`    n_${id} = n_${id} - Cylinder(${C(bore / 2)}, ${C(H + 2)}, align=(Align.CENTER, Align.CENTER, Align.MIN)).moved(Location((0, 0, -1)))`);
    }
    return L.join('\n');
}

// ── Fan / propeller / EDF rotor ────────────────────────────────────────────────
/**
 * Axial fan / propeller / EDF rotor: a central hub carrying a ring of
 * `bladeCount` TWISTED AIRFOIL blades. Each blade is lofted through radial
 * stations whose 2D cross-section is a NACA 4-digit airfoil (camber m, position
 * p, thickness t — all fractions of chord), scaled by a root→tip chord taper and
 * twisted by the local blade angle β(r) = atan(pitch / 2π·r) so the geometric
 * `pitch` (mm/rev) is physically meaningful. Optional centre bore, radial
 * set-screw, and a non-contacting outer shroud/duct ring (the rotor spins inside
 * it — for ducted EDF fans).
 *
 * The reason this is a generator and not a thing the model hand-builds: a
 * twisted, cambered, tapered airfoil loft is not expressible from primitives —
 * a box "blade" is the classic weak-model failure. Correctness lives here.
 *
 * Construction (Z-up): each blade is lofted with its SPAN along +Z (parallel
 * airfoil faces stacked in Z — the most reliable loft configuration), then the
 * finished blade is rotated −90° about X so the span lies radial (+Y) about the
 * Z spin axis, and arrayed `bladeCount` times about Z. FAIL-SAFE ladder:
 * twisted loft → extruded (untwisted) root airfoil → tapered-box blades, so the
 * document always compiles. Sits Align.MIN on Z. Assigns n_<id>.
 *
 * params: { diameter, bladeCount, hubDiameter, hubHeight, bore, setScrew,
 *           airfoil, camber, camberPos, thickness, pitch, rootChord, tipChord,
 *           thicknessScale, handed:'cw'|'ccw', shroud, shroudThickness, tipGap }
 */
export function emitFanPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 80;
    const tipR = D / 2;
    const hubD = Number(p.hubDiameter) > 0 ? Number(p.hubDiameter) : Math.max(8, D * 0.35);
    const hubR = hubD / 2;
    const r0 = Math.max(1, hubR * 0.82);            // blade root buried inside the hub for a solid union
    const hubH = Number(p.hubHeight) > 0 ? Number(p.hubHeight) : Math.max(6, (Number(p.rootChord) || D * 0.18) * 0.8);
    const NB = Math.max(1, Math.round(Number(p.bladeCount) || 5));
    const rootC = Number(p.rootChord) > 0 ? Number(p.rootChord) : Math.max(4, D * 0.18);
    const tipC = Number(p.tipChord) > 0 ? Number(p.tipChord) : Math.max(2, rootC * 0.6);
    const m = Number(p.camber) >= 0 ? Number(p.camber) : 0.04;
    const pp = Number(p.camberPos) >= 0 ? Number(p.camberPos) : 0.4;
    const tScale = Number(p.thicknessScale) > 0 ? Number(p.thicknessScale) : 1;
    const t = (Number(p.thickness) > 0 ? Number(p.thickness) : 0.12) * tScale;
    const pitch = Number(p.pitch) > 0 ? Number(p.pitch) : D;
    const sgn = p.handed === 'cw' ? -1 : 1;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 0;
    const setScrew = Number(p.setScrew) > 0 ? Number(p.setScrew) : 0;
    const shroud = p.shroud === true;
    const tipGap = Number(p.tipGap) >= 0 ? Number(p.tipGap) : 1;
    const shThk = Number(p.shroudThickness) > 0 ? Number(p.shroudThickness) : 3;
    const NS = 7;     // radial loft stations
    const NC = 20;    // chordwise samples per surface

    const L = [];
    L.push(`# ── Fan ${id} (Ø${C(D)}, ${NB} blades, NACA ${p.airfoil || '4412'}, pitch ${C(pitch)}mm${bore ? `, bore Ø${C(bore)}` : ''}${shroud ? ', shrouded' : ''}) ──`);
    L.push(`import math as _m`);
    // Tunable geometry constants (cleanNum'd → byte-stable emit → cache-safe).
    L.push(`_TIPR_${id}=${C(tipR)}; _HUBR_${id}=${C(hubR)}; _R0_${id}=${C(r0)}; _HUBH_${id}=${C(hubH)}`);
    L.push(`_NB_${id}=${NB}; _RC_${id}=${C(rootC)}; _TC_${id}=${C(tipC)}`);
    L.push(`_M_${id}=${C(m)}; _P_${id}=${C(pp)}; _T_${id}=${C(t)}; _PITCH_${id}=${C(pitch)}; _SGN_${id}=${sgn}`);
    // Airfoil section: NACA 4-digit points scaled to chord c, centred at quarter-chord.
    L.push(`def _afp_${id}(c):`);
    L.push(`    _up=[]; _lo=[]`);
    L.push(`    for _i in range(${NC}+1):`);
    L.push(`        _x=(1-_m.cos(_m.pi*_i/${NC}))/2.0`);
    L.push(`        _yt=5*_T_${id}*(0.2969*_m.sqrt(_x)-0.1260*_x-0.3516*_x**2+0.2843*_x**3-0.1015*_x**4)`);
    L.push(`        if _M_${id}>0 and _P_${id}>0:`);
    L.push(`            if _x<_P_${id}:`);
    L.push(`                _yc=_M_${id}/_P_${id}**2*(2*_P_${id}*_x-_x**2); _dy=2*_M_${id}/_P_${id}**2*(_P_${id}-_x)`);
    L.push(`            else:`);
    L.push(`                _yc=_M_${id}/(1-_P_${id})**2*((1-2*_P_${id})+2*_P_${id}*_x-_x**2); _dy=2*_M_${id}/(1-_P_${id})**2*(_P_${id}-_x)`);
    L.push(`        else:`);
    L.push(`            _yc=0.0; _dy=0.0`);
    L.push(`        _th=_m.atan(_dy)`);
    L.push(`        _up.append(((_x-_yt*_m.sin(_th)-0.25)*c,(_yc+_yt*_m.cos(_th))*c))`);
    L.push(`        _lo.append(((_x+_yt*_m.sin(_th)-0.25)*c,(_yc-_yt*_m.cos(_th))*c))`);
    L.push(`    return _up+[_q for _q in reversed(_lo[1:-1])]`);
    // Blade by twisted loft: parallel airfoil faces stacked in Z (span), each
    // rotated by the local blade angle β(r), then stood up radial about Z.
    L.push(`def _blade_loft_${id}():`);
    L.push(`    _secs=[]`);
    L.push(`    for _i in range(${NS}+1):`);
    L.push(`        _tt=_i/float(${NS}); _r=_R0_${id}+(_TIPR_${id}-_R0_${id})*_tt; _c=_RC_${id}+(_TC_${id}-_RC_${id})*_tt`);
    L.push(`        _beta=_m.degrees(_m.atan2(_PITCH_${id},2*_m.pi*max(_r,0.5)))*_SGN_${id}`);
    L.push(`        _secs.append(make_face(Polyline(*_afp_${id}(_c),close=True)).moved(Location((0,0,_r),(0,0,_beta))))`);
    L.push(`    return loft(_secs).rotate(Axis.X,-90).moved(Location((0,0,_HUBH_${id}/2.0)))`);
    // Robust fallback: extrude one root airfoil section (untwisted) — a different,
    // more forgiving op than loft.
    L.push(`def _blade_flat_${id}():`);
    L.push(`    _bl=extrude(make_face(Polyline(*_afp_${id}(_RC_${id}),close=True)),amount=_TIPR_${id}-_R0_${id})`);
    L.push(`    return _bl.rotate(Axis.X,-90).moved(Location((0,_R0_${id},_HUBH_${id}/2.0)))`);
    L.push(`def _fanbody_${id}(_mk):`);
    L.push(`    _n=Cylinder(_HUBR_${id},_HUBH_${id},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    _b=_mk()`);
    L.push(`    for _k in range(_NB_${id}):`);
    L.push(`        _n=_n+_b.rotate(Axis.Z,360.0*_k/_NB_${id})`);
    L.push(`    return _n`);
    // ── Fail-safe ladder: twisted loft → extruded flat → tapered box ──
    L.push(`try:`);
    L.push(`    n_${id}=_fanbody_${id}(_blade_loft_${id})`);
    L.push(`except Exception:`);
    L.push(`    try:`);
    L.push(`        n_${id}=_fanbody_${id}(_blade_flat_${id})`);
    L.push(`    except Exception:`);
    L.push(`        n_${id}=Cylinder(_HUBR_${id},_HUBH_${id},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`        for _k in range(_NB_${id}):`);
    L.push(`            n_${id}=n_${id}+Box(_TIPR_${id}-_R0_${id},_RC_${id},max(1.5,_T_${id}*_RC_${id}),align=(Align.MIN,Align.CENTER,Align.CENTER)).moved(Location((_R0_${id},0,_HUBH_${id}/2.0),(0,0,360.0*_k/_NB_${id})))`);
    // ── Bore / set-screw / shroud (low-risk booleans, each guarded) ──
    if (bore > 0) {
        L.push(`try:`);
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(hubH + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
        L.push(`except Exception: pass  # bore skipped`);
    }
    if (setScrew > 0) {
        L.push(`try:`);
        L.push(`    n_${id}=n_${id}-Cylinder(${C(setScrew / 2)},${C(hubR + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(hubH / 2)}),(0,90,0)))`);
        L.push(`except Exception: pass  # set-screw skipped`);
    }
    if (shroud) {
        const innerR = tipR + tipGap;
        const outerR = innerR + shThk;
        L.push(`try:`);
        L.push(`    _sh_${id}=Cylinder(${C(outerR)},${C(hubH)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(innerR)},${C(hubH + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
        L.push(`    n_${id}=n_${id}+_sh_${id}`);
        L.push(`except Exception: pass  # shroud skipped`);
    }
    // Normalise a multi-solid result (a disjoint shroud ring, or a blade that
    // didn't fuse) into a single Compound — a fuse of disjoint solids can surface
    // as a ShapeList, which the kernel can't tessellate / measure. No-op for a
    // single solid.
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Mounting plate ─────────────────────────────────────────────────────────────
/**
 * Flat plate with a centred rows×cols through-hole grid, optional countersinks
 * and rounded corners. The foundational "host" part: a guest's bolt pattern can
 * be stamped onto it. Degrades to a plain plate.
 *
 * params: { length, width, thickness, holeDia, rows, cols, pitchX, pitchY,
 *           cornerRadius, countersinkDia, countersinkDepth }
 */
export function emitMountingPlatePython(f) {
    const p = f.params || {};
    const id = f.id;
    const Lx = Number(p.length) > 0 ? Number(p.length) : 60;
    const Wy = Number(p.width) > 0 ? Number(p.width) : 40;
    const T = Number(p.thickness) > 0 ? Number(p.thickness) : 4;
    const cr = Number(p.cornerRadius) > 0 ? Math.min(Number(p.cornerRadius), Math.min(Lx, Wy) / 2 - 0.5) : 0;
    const L = [];
    L.push(`# ── Mounting plate ${id} (${C(Lx)}×${C(Wy)}×${C(T)}mm, ${Math.max(1, Math.round(Number(p.rows) || 1))}×${Math.max(1, Math.round(Number(p.cols) || 1))} holes) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=extrude(Rectangle(${C(Lx)},${C(Wy)}),amount=${C(T)})`);
    if (cr > 0) {
        L.push(`    try:`);
        L.push(`        n_${id}=fillet(n_${id}.edges().filter_by(Axis.Z),radius=${C(cr)})`);
        L.push(`    except Exception: pass  # corner round skipped`);
    }
    for (const ln of holeGridCuts(id, {
        holeDia: p.holeDia, rows: p.rows, cols: p.cols, pitchX: p.pitchX, pitchY: p.pitchY,
        th: T, z0: 0, csDia: p.countersinkDia, csDepth: p.countersinkDepth,
    })) L.push('    ' + ln);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(Lx)},${C(Wy)},${C(T)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Bracket (L / corner) ───────────────────────────────────────────────────────
/**
 * Right-angle (or angled) L-bracket: a horizontal arm (X) + a vertical arm (Z)
 * sharing the corner at the origin, each with a row of bolt holes, plus an
 * optional triangular gusset. armB leans by (angle−90) about Y for non-90 angles.
 * Degrades to a plain L of two boxes.
 *
 * params: { armA, armB, width, thickness, holeDia, holesPerArm, angle, gusset }
 */
export function emitBracketPython(f) {
    const p = f.params || {};
    const id = f.id;
    const aA = Number(p.armA) > 0 ? Number(p.armA) : 40;
    const aB = Number(p.armB) > 0 ? Number(p.armB) : 40;
    const w = Number(p.width) > 0 ? Number(p.width) : 30;
    const t = Number(p.thickness) > 0 ? Number(p.thickness) : 4;
    const hd = Number(p.holeDia) > 0 ? Number(p.holeDia) : 4;
    const nh = Math.max(0, Math.round(Number(p.holesPerArm) || 1));
    const ang = Number(p.angle) > 0 && Number(p.angle) <= 170 ? Number(p.angle) : 90;
    const gusset = p.gusset === true;
    const insA = Math.max(hd, Math.min(aA * 0.25, 8));
    const insB = Math.max(hd, Math.min(aB * 0.25, 8));
    const gLen = Math.min(aA - t, aB - t) * 0.7;

    const L = [];
    L.push(`# ── Bracket ${id} (${C(aA)}×${C(aB)}mm arms, ${C(w)}mm wide, ${ang}°${gusset ? ', gusset' : ''}) ──`);
    L.push(`import math as _m`);
    L.push(`def _holes_x_${id}(_a,_inset,_along):  # holes along an arm length _a`);
    L.push(`    if ${nh}<=0: return []`);
    L.push(`    if ${nh}==1: return [(_a+_inset)/2.0]`);   // single hole at mid (approx)
    L.push(`    return [_inset+_k*(_a-2*_inset)/(${nh}-1) for _k in range(${nh})]`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(aA)},${C(w)},${C(t)},align=(Align.MIN,Align.CENTER,Align.MIN))`);   // horizontal arm
    L.push(`    _vert_${id}=Box(${C(t)},${C(w)},${C(aB)},align=(Align.MIN,Align.CENTER,Align.MIN))`); // vertical arm
    // holes through the vertical arm (along X), cut before any lean
    L.push(`    for _z in _holes_x_${id}(${C(aB)},${C(insB)},0):`);
    L.push(`        _vert_${id}=_vert_${id}-Cylinder(${C(hd / 2)},${C(t + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).moved(Location((${C(t / 2)},0,_z),(0,90,0)))`);
    if (ang !== 90) L.push(`    _vert_${id}=_vert_${id}.rotate(Axis.Y,${C(-(ang - 90))})`);
    L.push(`    n_${id}=n_${id}+_vert_${id}`);
    // holes through the horizontal arm (along Z)
    L.push(`    for _x in _holes_x_${id}(${C(aA)},${C(insA)},0):`);
    L.push(`        if _x<${C(t)}: continue  # skip under the vertical arm`);
    L.push(`        n_${id}=n_${id}-Cylinder(${C(hd / 2)},${C(t + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_x,0,-1)))`);
    if (gusset && ang === 90 && gLen > 2) {
        L.push(`    try:`);
        L.push(`        _gus_${id}=extrude(make_face(Polyline((${C(t)},${C(t)}),(${C(t + gLen)},${C(t)}),(${C(t)},${C(t + gLen)}),close=True)),amount=${C(Math.max(2, w * 0.2))})`);
        L.push(`        _gus_${id}=_gus_${id}.rotate(Axis.X,90).moved(Location((0,${C(Math.max(2, w * 0.2) / 2)},0)))`);
        L.push(`        n_${id}=n_${id}+_gus_${id}`);
        L.push(`    except Exception: pass  # gusset skipped`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(aA)},${C(w)},${C(t)},align=(Align.MIN,Align.CENTER,Align.MIN))+Box(${C(t)},${C(w)},${C(aB)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// Standard heat-set insert pilot-hole Ø (mm) by metric size (CNC-Kitchen-ish).
const INSERT_HOLE_MM = { M2: 3.2, 'M2.5': 3.6, M3: 4.0, M4: 5.6, M5: 6.4, M6: 8.0 };
// Hex nut across-flats (AF) + thickness (mm) by metric size.
const NUT_AF_MM = { M2: 4.0, 'M2.5': 5.0, M3: 5.5, M4: 7.0, M5: 8.0, M6: 10.0 };
const NUT_THK_MM = { M2: 1.6, 'M2.5': 2.0, M3: 2.4, M4: 3.2, M5: 4.0, M6: 5.0 };
const BOLT_CLEAR_MM = { M2: 2.4, 'M2.5': 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6 };

// ── Threaded (heat-set) insert boss ────────────────────────────────────────────
/**
 * Mounting boss for a HEAT-SET threaded insert: a collar with a straight
 * counterbore sized so a brass insert melts/presses in. Distinct from
 * ScrewBoss (self-tapping). Optional ribs + base fillet. Degrades to a bored post.
 *
 * params: { insertSize(M2..M6), height, outerDiameter, holeDiameter, holeDepth,
 *           ribs, ribThickness, baseFillet }
 */
export function emitInsertBossPython(f) {
    const p = f.params || {};
    const id = f.id;
    const hole = Number(p.holeDiameter) > 0 ? Number(p.holeDiameter) : (INSERT_HOLE_MM[p.insertSize] || 4.0);
    const outer = Number(p.outerDiameter) > 0 ? Number(p.outerDiameter) : Math.max(hole + 3, hole * 1.9);
    const H = Number(p.height) > 0 ? Number(p.height) : 8;
    const depth = Number(p.holeDepth) > 0 ? Math.min(Number(p.holeDepth), H) : Math.max(2, H - 1);
    const ribs = Math.max(0, Math.round(Number(p.ribs) || 0));
    const ribThk = Number(p.ribThickness) > 0 ? Number(p.ribThickness) : Math.max(1, outer * 0.18);
    const baseFillet = Number(p.baseFillet) > 0 ? Number(p.baseFillet) : 0;
    const ro = outer / 2;
    const L = [];
    L.push(`# ── Insert boss ${id} (${p.insertSize || 'heat-set'}: outer Ø${C(outer)}, hole Ø${C(hole)}, h${C(H)}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(ro)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    if (ribs > 0) {
        L.push(`    for _k in range(${ribs}):`);
        L.push(`        n_${id}=n_${id}+Box(${C(outer * 0.9)},${C(ribThk)},${C(H * 0.8)},align=(Align.MIN,Align.CENTER,Align.MIN)).moved(Location((0,0,0),(0,0,360.0*_k/${ribs})))`);
    }
    if (baseFillet > 0) {
        L.push(`    try:`);
        L.push(`        n_${id}=fillet(n_${id}.edges().group_by(Axis.Z)[0],radius=${C(baseFillet)})`);
        L.push(`    except Exception: pass  # base fillet skipped`);
    }
    L.push(`    n_${id}=n_${id}-Cylinder(${C(hole / 2)},${C(depth + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(H - depth)})))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(ro)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(hole / 2)},${C(depth + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(H - depth)})))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Nut trap (captive hex-nut boss) ────────────────────────────────────────────
/**
 * A captive hex-nut boss: a block with a coaxial bolt clearance hole and a hex
 * pocket sized to a standard nut, entered from the bottom or a side. Degrades to
 * a block with a through hole.
 *
 * params: { nutSize(M2..M6), entry('bottom'|'side'), block, height, boltClear }
 */
export function emitNutTrapPython(f) {
    const p = f.params || {};
    const id = f.id;
    const af = NUT_AF_MM[p.nutSize] || 5.5;
    const nthk = NUT_THK_MM[p.nutSize] || 2.4;
    const bolt = Number(p.boltClear) > 0 ? Number(p.boltClear) : (BOLT_CLEAR_MM[p.nutSize] || 3.4);
    const blk = Number(p.block) > 0 ? Number(p.block) : Math.max(af + 4, af * 1.8);
    const H = Number(p.height) > 0 ? Number(p.height) : Math.max(nthk + 4, 8);
    const entry = p.entry === 'side' ? 'side' : 'bottom';
    const circR = af / Math.sqrt(3);  // hex circumradius from AF
    const L = [];
    L.push(`# ── Nut trap ${id} (${p.nutSize || 'M3'} ${entry}-entry, AF ${C(af)}, block ${C(blk)}×${C(H)}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(blk)},${C(blk)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(bolt / 2)},${C(H + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    if (entry === 'bottom') {
        // hex pocket opening at the bottom face, depth = nut thickness (+ a bit)
        L.push(`    n_${id}=n_${id}-extrude(RegularPolygon(${C(circR)},6),amount=${C(nthk + 0.3)}).moved(Location((0,0,-0.1)))`);
    } else {
        // hex slot from +Y face inward to centre, at mid height
        L.push(`    _pk_${id}=extrude(RegularPolygon(${C(circR)},6),amount=${C(blk / 2 + 0.2)}).rotate(Axis.X,-90).moved(Location((0,${C(blk / 2)},${C(H / 2)})))`);
        L.push(`    n_${id}=n_${id}-_pk_${id}`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(blk)},${C(blk)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(bolt / 2)},${C(H + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Snap hook (cantilever snap-fit) ────────────────────────────────────────────
/**
 * A cantilever snap-fit hook: a flexible arm standing in +Z with a hook (catch
 * face + lead-in ramp) protruding +X at the tip. Degrades to a plain arm.
 *
 * params: { armLength, armThickness, width, hookDepth, leadAngle }
 */
export function emitSnapHookPython(f) {
    const p = f.params || {};
    const id = f.id;
    const aL = Number(p.armLength) > 0 ? Number(p.armLength) : 16;
    const aT = Number(p.armThickness) > 0 ? Number(p.armThickness) : 2;
    const w = Number(p.width) > 0 ? Number(p.width) : 8;
    const hk = Number(p.hookDepth) > 0 ? Number(p.hookDepth) : 1.5;
    const lead = Number(p.leadAngle) > 0 && Number(p.leadAngle) < 80 ? Number(p.leadAngle) : 45;
    const rampH = hk / Math.tan(lead * Math.PI / 180);
    const L = [];
    L.push(`# ── Snap hook ${id} (arm ${C(aL)}×${C(aT)}, hook ${C(hk)}mm @ ${lead}°) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(aT)},${C(w)},${C(aL)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    // hook profile in XZ at the arm tip: catch face (flat shelf), lead-in ramp to the tip
    L.push(`    _hook_${id}=extrude(make_face(Polyline((${C(aT)},${C(aL - hk - rampH)}),(${C(aT + hk)},${C(aL - rampH)}),(${C(aT)},${C(aL)}),close=True)),amount=${C(w)}).rotate(Axis.X,90).moved(Location((0,${C(w / 2)},0)))`);
    L.push(`    n_${id}=n_${id}+_hook_${id}`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(aT)},${C(w)},${C(aL)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// Standard ball-bearing trade sizes → [bore id, outer od, width] mm.
const BEARING_MM = {
    '623': [3, 10, 4], '624': [4, 13, 5], '625': [5, 16, 5], '626': [6, 19, 6],
    '688': [8, 16, 5], '608': [8, 22, 7], '6800': [10, 19, 5], '6801': [12, 21, 5],
    '6802': [15, 24, 5], '6900': [10, 22, 6], '6901': [12, 24, 6], '6902': [15, 28, 7],
    'lm8uu': [8, 15, 24],
};
// Motor face patterns → { body, bolt: square pitch (or circle dia), screw, shaft, pilot, kind }.
const MOTOR_MM = {
    nema17: { body: 42.3, bolt: 31.0, screw: 3.4, shaft: 5, pilot: 22, kind: 'square' },
    nema23: { body: 56.4, bolt: 47.14, screw: 5.5, shaft: 6.35, pilot: 38.1, kind: 'square' },
    nema14: { body: 35.2, bolt: 26.0, screw: 3.0, shaft: 5, pilot: 22, kind: 'square' },
    n20: { body: 12, bolt: 17.0, screw: 2.2, shaft: 3, pilot: 7, kind: 'twohole' },
    '2208': { body: 28, bolt: 16.0, screw: 3.4, shaft: 4, pilot: 7, kind: 'circle3' },
    '775': { body: 42, bolt: 29.0, screw: 4.5, shaft: 5, pilot: 17.4, kind: 'twohole' },
};

// ── Bearing pocket / housing ────────────────────────────────────────────────────
/**
 * Press-fit seat/housing for a standard ball bearing: an outer collar with a
 * recessed pocket (Ø = bearing OD) and a retaining shoulder with a clearance
 * hole for the shaft. Degrades to a bored ring.
 *
 * params: { bearing(name) | od,id,width, wall, shoulder, throughHole }
 */
export function emitBearingPocketPython(f) {
    const p = f.params || {};
    const id = f.id;
    const std = BEARING_MM[String(p.bearing || '').toLowerCase()] || null;
    const od = Number(p.od) > 0 ? Number(p.od) : (std ? std[1] : 22);
    const bid = Number(p.id) > 0 ? Number(p.id) : (std ? std[0] : 8);
    const wid = Number(p.width) > 0 ? Number(p.width) : (std ? std[2] : 7);
    const wall = Number(p.wall) > 0 ? Number(p.wall) : Math.max(2, od * 0.15);
    const shoulder = Number(p.shoulder) > 0 ? Number(p.shoulder) : Math.max(1.2, wid * 0.25);
    const through = Number(p.throughHole) > 0 ? Number(p.throughHole) : bid + 2;
    const ro = od / 2 + wall;
    const H = wid + shoulder;
    const L = [];
    L.push(`# ── Bearing pocket ${id} (${p.bearing || `${C(od)}OD`}: pocket Ø${C(od)}×${C(wid)}, shoulder ${C(shoulder)}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(ro)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(od / 2)},${C(wid + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(shoulder)})))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(through / 2)},${C(H + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(ro)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(od / 2)},${C(H + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Motor mount (faceplate) ─────────────────────────────────────────────────────
/**
 * Faceplate mount for a motor (NEMA17/23/14, N20, 2208 brushless, 775): a plate
 * sized to the motor body with the correct bolt pattern + a centre shaft/pilot
 * clearance hole. Degrades to a plate with a centre hole.
 *
 * params: { motorType | body,boltPattern,screw,shaft,pilot,kind, thickness, plate }
 */
export function emitMotorMountPython(f) {
    const p = f.params || {};
    const id = f.id;
    const m = MOTOR_MM[String(p.motorType || '').toLowerCase()] || null;
    const body = Number(p.body) > 0 ? Number(p.body) : (m ? m.body : 42.3);
    const bolt = Number(p.boltPattern) > 0 ? Number(p.boltPattern) : (m ? m.bolt : 31);
    const screw = Number(p.screw) > 0 ? Number(p.screw) : (m ? m.screw : 3.4);
    const pilot = Number(p.pilot) > 0 ? Number(p.pilot) : (m ? m.pilot : 22);
    const kind = p.kind || (m ? m.kind : 'square');
    const T = Number(p.thickness) > 0 ? Number(p.thickness) : 4;
    const plate = Number(p.plate) > 0 ? Number(p.plate) : body + 2 * Math.max(4, screw + 3);
    const L = [];
    L.push(`# ── Motor mount ${id} (${p.motorType || 'custom'}: plate ${C(plate)}, bolt ${C(bolt)} ${kind}, pilot Ø${C(pilot)}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=extrude(Rectangle(${C(plate)},${C(plate)}),amount=${C(T)})`);
    L.push(`    try:`);
    L.push(`        n_${id}=fillet(n_${id}.edges().filter_by(Axis.Z),radius=${C(Math.max(2, screw))})`);
    L.push(`    except Exception: pass`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(pilot / 2)},${C(T + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    if (kind === 'square') {
        L.push(`    for _sx in (-1,1):`);
        L.push(`        for _sy in (-1,1):`);
        L.push(`            n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(T + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(bolt / 2)},_sy*${C(bolt / 2)},-1)))`);
    } else if (kind === 'twohole') {
        L.push(`    for _sx in (-1,1):`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(T + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(bolt / 2)},0,-1)))`);
    } else { // circle3 (brushless): 3 holes on a bolt circle
        L.push(`    for _k in range(3):`);
        L.push(`        _a=2*_m.pi*_k/3`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(T + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(bolt / 2)}*_m.cos(_a),${C(bolt / 2)}*_m.sin(_a),-1)))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(plate)},${C(plate)},${C(T)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(pilot / 2)},${C(T + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Shaft coupler ───────────────────────────────────────────────────────────────
/**
 * Rigid shaft coupler joining two shafts: a cylinder with a bore from each end
 * and radial set-screw holes per side. Degrades to a single-bore cylinder.
 *
 * params: { bore1, bore2, outerDiameter, length, setScrew, screwsPerSide }
 */
export function emitShaftCouplerPython(f) {
    const p = f.params || {};
    const id = f.id;
    const b1 = Number(p.bore1) > 0 ? Number(p.bore1) : 5;
    const b2 = Number(p.bore2) > 0 ? Number(p.bore2) : b1;
    const od = Number(p.outerDiameter) > 0 ? Number(p.outerDiameter) : Math.max(b1, b2) * 2.6 + 4;
    const len = Number(p.length) > 0 ? Number(p.length) : Math.max(b1, b2) * 4 + 8;
    const ss = Number(p.setScrew) > 0 ? Number(p.setScrew) : Math.max(2, Math.round(Math.max(b1, b2) * 0.5));
    const nps = Math.max(0, Math.round(Number(p.screwsPerSide) || 1));
    const ro = od / 2;
    const L = [];
    L.push(`# ── Shaft coupler ${id} (Ø${C(od)}×${C(len)}, bores ${C(b1)}/${C(b2)}, set-screw M${ss}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(ro)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(b1 / 2)},${C(len / 2 + 0.5)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-0.5)))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(b2 / 2)},${C(len / 2 + 0.5)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(len / 2)})))`);
    if (ss > 0 && nps > 0) {
        L.push(`    for _zc in (${C(len * 0.25)},${C(len * 0.75)}):`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(ss / 2)},${C(ro + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,_zc),(0,90,0)))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(ro)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(b1 / 2)},${C(len + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Wheel ───────────────────────────────────────────────────────────────────────
/**
 * Wheel: a disk with a shaft bore (round / D-flat / hex), an optional tire
 * groove around the rim, optional lightening holes, and a radial set-screw.
 * Degrades to a bored disk.
 *
 * params: { diameter, width, bore, shaftType('round'|'D'|'hex'), setScrew,
 *           spokes, tireGroove }
 */
export function emitWheelPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 60;
    const W = Number(p.width) > 0 ? Number(p.width) : 10;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 5;
    const shaft = ['round', 'D', 'hex'].includes(p.shaftType) ? p.shaftType : 'round';
    const ss = Number(p.setScrew) > 0 ? Number(p.setScrew) : 0;
    const spokes = Math.max(0, Math.round(Number(p.spokes) || 0));
    const groove = p.tireGroove !== false;
    const r = D / 2;
    const L = [];
    L.push(`# ── Wheel ${id} (Ø${C(D)}×${C(W)}, ${shaft} bore Ø${C(bore)}${spokes ? `, ${spokes} spokes` : ''}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(r)},${C(W)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    if (groove) {
        L.push(`    try:`);
        L.push(`        n_${id}=n_${id}-Torus(${C(r)},${C(Math.min(W * 0.25, r * 0.12))}).moved(Location((0,0,${C(W / 2)})))`);
        L.push(`    except Exception: pass  # tire groove skipped`);
    }
    // shaft bore
    if (shaft === 'round') {
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    } else if (shaft === 'hex') {
        L.push(`    n_${id}=n_${id}-extrude(RegularPolygon(${C(bore / Math.sqrt(3))},6),amount=${C(W + 2)}).moved(Location((0,0,-1)))`);
    } else { // D-flat: round bore minus a chord slab
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
        L.push(`    n_${id}=n_${id}+Box(${C(bore)},${C(bore * 0.18)},${C(W + 2)},align=(Align.CENTER,Align.MIN,Align.MIN)).moved(Location((0,${C(bore / 2 - bore * 0.18)},-1)))`);
    }
    if (spokes >= 3) {
        L.push(`    _spr_${id}=${C(r * 0.55)}`);
        L.push(`    for _k in range(${spokes}):`);
        L.push(`        _a=2*_m.pi*_k/${spokes}`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(Math.max(2, r * 0.12))},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_spr_${id}*_m.cos(_a),_spr_${id}*_m.sin(_a),-1)))`);
    }
    if (ss > 0) {
        L.push(`    try:`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(ss / 2)},${C(r + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(W / 2)}),(0,90,0)))`);
        L.push(`    except Exception: pass  # set-screw skipped`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(r)},${C(W)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(bore / 2)},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Timing pulley (toothed belt) ────────────────────────────────────────────────
/**
 * Toothed timing-belt pulley (GT2 / GT3 / HTD-5). Pitch diameter = teeth·pitch/π;
 * the belt teeth are approximated as rounded grooves cut at the pitch radius
 * (recognisable + printable, not metrologically exact). Optional flanges, bore,
 * set-screw. Degrades to a bored cylinder.
 *
 * params: { teeth, beltType('GT2'|'GT3'|'HTD5'), width, bore, flanges, setScrew }
 */
export function emitTimingPulleyPython(f) {
    const p = f.params || {};
    const id = f.id;
    const teeth = Math.max(8, Math.round(Number(p.teeth) || 20));
    const pitchByBelt = { gt2: 2, gt3: 3, htd5: 5, htd3: 3 };
    const pitch = pitchByBelt[String(p.beltType || 'gt2').toLowerCase()] || 2;
    const W = Number(p.width) > 0 ? Number(p.width) : 7;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 5;
    const flanges = p.flanges !== false;
    const ss = Number(p.setScrew) > 0 ? Number(p.setScrew) : 0;
    const pd = teeth * pitch / Math.PI;
    const pr = pd / 2;
    const grooveR = pitch * 0.28;
    const fR = pr + Math.max(1, pitch);
    const fT = Math.max(1, W * 0.12);
    const L = [];
    L.push(`# ── Timing pulley ${id} (${teeth}T ${String(p.beltType || 'GT2').toUpperCase()}, PD Ø${C(pd)}×${C(W)}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(pr)},${C(W)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    for _k in range(${teeth}):`);
    L.push(`        _a=2*_m.pi*_k/${teeth}`);
    L.push(`        n_${id}=n_${id}-Cylinder(${C(grooveR)},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(pr)}*_m.cos(_a),${C(pr)}*_m.sin(_a),-1)))`);
    if (flanges) {
        L.push(`    n_${id}=n_${id}+Cylinder(${C(fR)},${C(fT)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
        L.push(`    n_${id}=n_${id}+Cylinder(${C(fR)},${C(fT)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(W - fT)})))`);
    }
    L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    if (ss > 0) {
        L.push(`    try:`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(ss / 2)},${C(pr + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(W / 2)}),(0,90,0)))`);
        L.push(`    except Exception: pass  # set-screw skipped`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(pr)},${C(W)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(bore / 2)},${C(W + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Hinge (knuckle / pinned) ────────────────────────────────────────────────────
/**
 * A knuckle hinge: two flat leaves meeting at a pin axis (along Y), with
 * alternating knuckles around the pin and a through pin-bore. Leaves lie in the
 * XY plane (z 0..thickness); the pin axis runs along Y at the centre. Degrades to
 * two plates. (A separate pin/filament goes through the bore.)
 *
 * params: { length, leafWidth, thickness, knuckles, pinDia, gap }
 */
export function emitHingePython(f) {
    const p = f.params || {};
    const id = f.id;
    const len = Number(p.length) > 0 ? Number(p.length) : 40;
    const leaf = Number(p.leafWidth) > 0 ? Number(p.leafWidth) : 20;
    const t = Number(p.thickness) > 0 ? Number(p.thickness) : 3;
    const kn = Math.max(2, Math.round(Number(p.knuckles) || 5));
    const pin = Number(p.pinDia) > 0 ? Number(p.pinDia) : 3;
    const kR = pin / 2 + Math.max(1.2, t * 0.6);     // knuckle outer radius
    // Single-solid pinned-hinge FORM: two coplanar leaves joined by a knuckle
    // barrel along the pin axis (Y), with a through pin-bore. (A functional
    // articulating hinge is a 2-part assembly — print/split the leaves; this is
    // the one-body form for layout + the mounting interface.) The leaf top sits
    // at the pin centre height so the barrel sits proud above the leaves.
    const L = [];
    L.push(`# ── Hinge ${id} (${C(len)}mm, pin Ø${C(pin)}, leaf ${C(leaf)} ×2, ${kn} knuckles) ──`);
    L.push(`try:`);
    // two leaves -X / +X, coplanar, meeting at the pin line (x=0)
    L.push(`    n_${id}=Box(${C(leaf)},${C(len)},${C(t)},align=(Align.MAX,Align.CENTER,Align.MIN)).moved(Location((${C(-kR * 0.4)},0,0)))`);
    L.push(`    n_${id}=n_${id}+Box(${C(leaf)},${C(len)},${C(t)},align=(Align.MIN,Align.CENTER,Align.MIN)).moved(Location((${C(kR * 0.4)},0,0)))`);
    // knuckle barrel along Y at the pin axis, raised so it reads as the hinge spine
    L.push(`    n_${id}=n_${id}+Cylinder(${C(kR)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.X,90).moved(Location((0,0,${C(kR)})))`);
    // visual knuckle gaps (alternating relief grooves around the barrel)
    if (kn >= 3) {
        const seg = len / kn;
        L.push(`    for _k in range(1,${kn}):`);
        L.push(`        try:`);
        L.push(`            n_${id}=n_${id}-Box(${C(kR * 2.2)},${C(Math.min(0.6, seg * 0.15))},${C(kR * 1.2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,-${C(len / 2)}+_k*${C(seg)},${C(kR)})))`);
        L.push(`        except Exception: pass`);
    }
    // pin bore through the barrel
    L.push(`    n_${id}=n_${id}-Cylinder(${C(pin / 2)},${C(len + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.X,90).moved(Location((0,0,${C(kR)})))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(leaf * 2)},${C(len)},${C(t)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Project box (enclosure base) ────────────────────────────────────────────────
/**
 * Standalone enclosure BASE: an open-top box with a usable inner cavity and
 * optional internal corner screw bosses + lid lip. (Pair with a lid later.)
 * Inner cavity = innerL×innerW×innerH; outer adds `wall` all round + a floor.
 * Degrades to a hollow box.
 *
 * params: { innerLength, innerWidth, innerHeight, wall, bosses, screwSize, lip }
 */
export function emitProjectBoxPython(f) {
    const p = f.params || {};
    const id = f.id;
    const iL = Number(p.innerLength) > 0 ? Number(p.innerLength) : 60;
    const iW = Number(p.innerWidth) > 0 ? Number(p.innerWidth) : 40;
    const iH = Number(p.innerHeight) > 0 ? Number(p.innerHeight) : 25;
    const wall = Number(p.wall) > 0 ? Number(p.wall) : 2;
    const bosses = p.bosses === true;
    const pilot = { M2: 1.6, 'M2.5': 2.05, M3: 2.5, M4: 3.3 }[p.screwSize] || 2.5;
    const lip = p.lip === true;
    const oL = iL + 2 * wall, oW = iW + 2 * wall, oH = iH + wall;
    const L = [];
    L.push(`# ── Project box ${id} (inner ${C(iL)}×${C(iW)}×${C(iH)}, wall ${C(wall)}${bosses ? ', bosses' : ''}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(oL)},${C(oW)},${C(oH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}-Box(${C(iL)},${C(iW)},${C(iH + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(wall)})))`);
    if (lip) {
        // inner lip ridge around the top rim (a thin raised wall the lid sits over)
        L.push(`    try:`);
        L.push(`        _lipO=Box(${C(iL + wall)},${C(iW + wall)},${C(Math.max(1.5, wall))},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(oH)})))`);
        L.push(`        _lipI=Box(${C(iL)},${C(iW)},${C(Math.max(1.5, wall) + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(oH - 0.5)})))`);
        L.push(`        n_${id}=n_${id}+(_lipO-_lipI)`);
        L.push(`    except Exception: pass  # lip skipped`);
    }
    if (bosses) {
        L.push(`    _bx=${C(iL / 2 - 4)}; _by=${C(iW / 2 - 4)}`);
        L.push(`    for _sx in (-1,1):`);
        L.push(`        for _sy in (-1,1):`);
        L.push(`            _b=Cylinder(${C(Math.max(3, pilot + 2))},${C(iH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*_bx,_sy*_by,${C(wall)})))`);
        L.push(`            _b=_b-Cylinder(${C(pilot / 2)},${C(iH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*_bx,_sy*_by,${C(wall + 1)})))`);
        L.push(`            n_${id}=n_${id}+_b`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(oL)},${C(oW)},${C(oH)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Box(${C(iL)},${C(iW)},${C(iH + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(wall)})))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── PCB tray ────────────────────────────────────────────────────────────────────
/**
 * A base plate with four standoff posts placed to a PCB's mounting-hole pattern
 * (inset from the PCB corners), each with a pilot hole. The auto-fitting host for
 * a board. Degrades to a plain plate.
 *
 * params: { pcbLength, pcbWidth, holeInset, standoffHeight, standoffDia,
 *           screwDia, margin, baseThickness }
 */
export function emitPCBTrayPython(f) {
    const p = f.params || {};
    const id = f.id;
    const pL = Number(p.pcbLength) > 0 ? Number(p.pcbLength) : 50;
    const pW = Number(p.pcbWidth) > 0 ? Number(p.pcbWidth) : 30;
    const inset = Number(p.holeInset) > 0 ? Number(p.holeInset) : 3.5;
    const sH = Number(p.standoffHeight) > 0 ? Number(p.standoffHeight) : 6;
    const screw = Number(p.screwDia) > 0 ? Number(p.screwDia) : 2.5;
    const sD = Number(p.standoffDia) > 0 ? Number(p.standoffDia) : Math.max(screw + 3, 6);
    const margin = Number(p.margin) > 0 ? Number(p.margin) : 4;
    const base = Number(p.baseThickness) > 0 ? Number(p.baseThickness) : 3;
    const plL = pL + 2 * margin, plW = pW + 2 * margin;
    const hx = pL / 2 - inset, hy = pW / 2 - inset;
    const L = [];
    L.push(`# ── PCB tray ${id} (PCB ${C(pL)}×${C(pW)}, standoffs h${C(sH)} M${screw}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=extrude(Rectangle(${C(plL)},${C(plW)}),amount=${C(base)})`);
    L.push(`    for _sx in (-1,1):`);
    L.push(`        for _sy in (-1,1):`);
    L.push(`            _po=Cylinder(${C(sD / 2)},${C(sH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(hx)},_sy*${C(hy)},${C(base)})))`);
    L.push(`            _po=_po-Cylinder(${C(screw / 2)},${C(sH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(hx)},_sy*${C(hy)},${C(base + 1)})))`);
    L.push(`            n_${id}=n_${id}+_po`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(plL)},${C(plW)},${C(base)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Knob ────────────────────────────────────────────────────────────────────────
/**
 * Control knob: a cylinder with a gripped rim (knurl ≈ many fine flutes / flute ≈
 * fewer finger scallops / smooth), a shaft bore (round / D-flat), and an optional
 * set-screw + pointer. Degrades to a bored cylinder.
 *
 * params: { diameter, height, gripType, flutes, shaftBore, shaftType('round'|'D'),
 *           setScrew, pointer }
 */
export function emitKnobPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 24;
    const H = Number(p.height) > 0 ? Number(p.height) : 16;
    const grip = ['knurl', 'flute', 'smooth'].includes(p.gripType) ? p.gripType : 'knurl';
    const flutes = Number(p.flutes) > 0 ? Math.round(Number(p.flutes))
        : (grip === 'knurl' ? Math.max(20, Math.round(D * 1.4)) : grip === 'flute' ? Math.max(6, Math.round(D / 3)) : 0);
    const bore = Number(p.shaftBore) > 0 ? Number(p.shaftBore) : 6;
    const shaft = p.shaftType === 'D' ? 'D' : 'round';
    const ss = Number(p.setScrew) > 0 ? Number(p.setScrew) : 0;
    const pointer = p.pointer === true;
    const r = D / 2;
    const fluteR = grip === 'flute' ? Math.max(1.2, D * 0.06) : Math.max(0.5, D * 0.025);
    const L = [];
    L.push(`# ── Knob ${id} (Ø${C(D)}×${C(H)}, ${grip}${flutes ? ` ${flutes}` : ''}, bore Ø${C(bore)} ${shaft}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(r)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    if (flutes >= 3) {
        L.push(`    for _k in range(${flutes}):`);
        L.push(`        _a=2*_m.pi*_k/${flutes}`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(fluteR)},${C(H + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(r)}*_m.cos(_a),${C(r)}*_m.sin(_a),-1)))`);
    }
    if (pointer) {
        L.push(`    try:`);
        L.push(`        n_${id}=n_${id}+Box(${C(r * 0.5)},${C(Math.max(2, D * 0.1))},${C(H)},align=(Align.MIN,Align.CENTER,Align.MIN)).moved(Location((${C(r * 0.8)},0,0)))`);
        L.push(`    except Exception: pass  # pointer skipped`);
    }
    // shaft bore (blind from the bottom, leaving a 1.5mm cap)
    if (shaft === 'round') {
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(H - 1.5)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-0.1)))`);
    } else { // D-flat
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(H - 1.5)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-0.1)))`);
        L.push(`    n_${id}=n_${id}+Box(${C(bore)},${C(bore * 0.18)},${C(H - 1.5)},align=(Align.CENTER,Align.MIN,Align.MIN)).moved(Location((0,${C(bore / 2 - bore * 0.18)},-0.1)))`);
    }
    if (ss > 0) {
        L.push(`    try:`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(ss / 2)},${C(r + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(H * 0.3)}),(0,90,0)))`);
        L.push(`    except Exception: pass  # set-screw skipped`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(r)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(bore / 2)},${C(H - 1.5)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-0.1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Foot / bumper ───────────────────────────────────────────────────────────────
/** A foot/leveling pad: a puck with a top screw counterbore + a bottom grip
 * recess. params: { diameter, height, screw, recessDia, recessDepth } */
export function emitFootPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 20;
    const H = Number(p.height) > 0 ? Number(p.height) : 8;
    const screw = Number(p.screw) > 0 ? Number(p.screw) : 4;
    const recess = Number(p.recessDia) > 0 ? Number(p.recessDia) : D * 0.7;
    const rd = Number(p.recessDepth) > 0 ? Number(p.recessDepth) : Math.min(2, H * 0.3);
    const L = [];
    L.push(`# ── Foot ${id} (Ø${C(D)}×${C(H)}, M${screw}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(D / 2)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    try:`);
    L.push(`        n_${id}=fillet(n_${id}.edges().group_by(Axis.Z)[-1],radius=${C(Math.min(2, H * 0.25))})`);
    L.push(`    except Exception: pass`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(H - rd - 2)})))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(recess / 2)},${C(rd + 0.5)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-0.5)))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(D / 2)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Gusset (standalone brace) ───────────────────────────────────────────────────
/** A right-triangle brace, legs along +X (legA) and +Z (legB), thickness in Y,
 * with a bolt hole near each leg. params: { legA, legB, thickness, holeDia } */
export function emitGussetPython(f) {
    const p = f.params || {};
    const id = f.id;
    const a = Number(p.legA) > 0 ? Number(p.legA) : 30;
    const b = Number(p.legB) > 0 ? Number(p.legB) : 30;
    const t = Number(p.thickness) > 0 ? Number(p.thickness) : 4;
    const hd = Number(p.holeDia) > 0 ? Number(p.holeDia) : 4;
    const L = [];
    L.push(`# ── Gusset ${id} (${C(a)}×${C(b)} legs, ${C(t)} thick) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=extrude(make_face(Polyline((0,0),(${C(a)},0),(0,${C(b)}),close=True)),amount=${C(t)}).rotate(Axis.X,90).moved(Location((0,${C(t / 2)},0)))`);
    if (hd > 0) {
        L.push(`    n_${id}=n_${id}-Cylinder(${C(hd / 2)},${C(t + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.X,90).moved(Location((${C(a * 0.55)},0,${C(Math.max(hd, b * 0.12))})))`);
        L.push(`    n_${id}=n_${id}-Cylinder(${C(hd / 2)},${C(t + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.X,90).moved(Location((${C(Math.max(hd, a * 0.12))},0,${C(b * 0.55)})))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=extrude(make_face(Polyline((0,0),(${C(a)},0),(0,${C(b)}),close=True)),amount=${C(t)})`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Handle (bar / loop) ─────────────────────────────────────────────────────────
/** A pull handle: two posts at ±span/2 rising to `height`, joined by a grip bar,
 * with a mounting screw hole down each post. params: { span, height, gripDia,
 * postDia, screw } */
export function emitHandlePython(f) {
    const p = f.params || {};
    const id = f.id;
    const span = Number(p.span) > 0 ? Number(p.span) : 80;
    const H = Number(p.height) > 0 ? Number(p.height) : 30;
    const grip = Number(p.gripDia) > 0 ? Number(p.gripDia) : 12;
    const post = Number(p.postDia) > 0 ? Number(p.postDia) : grip;
    const screw = Number(p.screw) > 0 ? Number(p.screw) : 4;
    const L = [];
    L.push(`# ── Handle ${id} (span ${C(span)}, height ${C(H)}, grip Ø${C(grip)}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(post / 2)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(-span / 2)},0,0)))`);
    L.push(`    n_${id}=n_${id}+Cylinder(${C(post / 2)},${C(H)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(span / 2)},0,0)))`);
    L.push(`    n_${id}=n_${id}+Cylinder(${C(grip / 2)},${C(span + post)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.Y,90).moved(Location((0,0,${C(H - grip / 2)})))`);
    if (screw > 0) {
        L.push(`    for _sx in (${C(-span / 2)},${C(span / 2)}):`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(H * 0.6)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx,0,-0.5)))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(grip / 2)},${C(span)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.Y,90).moved(Location((0,0,${C(H)})))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Shaft hub (shaft → bolt-circle adapter) ─────────────────────────────────────
/** A hub that adapts a shaft to a bolt circle (mount a wheel/arm/disc to a
 * shaft): a flange disk + a raised hub boss, centre bore (round/D), a bolt circle
 * and a radial set-screw. params: { bore, shaftType, flangeDiameter, hubDiameter,
 * hubHeight, boltCount, boltCircle, boltHole, setScrew } */
export function emitShaftHubPython(f) {
    const p = f.params || {};
    const id = f.id;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 5;
    const shaft = p.shaftType === 'D' ? 'D' : (p.shaftType === 'hex' ? 'hex' : 'round');
    const flange = Number(p.flangeDiameter) > 0 ? Number(p.flangeDiameter) : Math.max(bore * 5, 24);
    const hubD = Number(p.hubDiameter) > 0 ? Number(p.hubDiameter) : Math.max(bore * 2.4, 12);
    const flT = 3, hubH = Number(p.hubHeight) > 0 ? Number(p.hubHeight) : Math.max(bore * 1.6, 8);
    const bc = Math.max(0, Math.round(Number(p.boltCount) || 4));
    const bcd = Number(p.boltCircle) > 0 ? Number(p.boltCircle) : (flange + hubD) / 2;
    const bhd = Number(p.boltHole) > 0 ? Number(p.boltHole) : 3;
    const ss = Number(p.setScrew) > 0 ? Number(p.setScrew) : 3;
    const L = [];
    L.push(`# ── Shaft hub ${id} (bore Ø${C(bore)} ${shaft}, flange Ø${C(flange)}, ${bc}-bolt) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(flange / 2)},${C(flT)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}+Cylinder(${C(hubD / 2)},${C(hubH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    if (shaft === 'round') {
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(hubH + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    } else if (shaft === 'hex') {
        L.push(`    n_${id}=n_${id}-extrude(RegularPolygon(${C(bore / Math.sqrt(3))},6),amount=${C(hubH + 2)}).moved(Location((0,0,-1)))`);
    } else {
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(hubH + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
        L.push(`    n_${id}=n_${id}+Box(${C(bore)},${C(bore * 0.18)},${C(hubH + 2)},align=(Align.CENTER,Align.MIN,Align.MIN)).moved(Location((0,${C(bore / 2 - bore * 0.18)},-1)))`);
    }
    if (bc > 0 && bcd > 0) {
        L.push(`    _bcr=${C(bcd / 2)}`);
        L.push(`    for _j in range(${bc}):`);
        L.push(`        _a=2*_m.pi*_j/${bc}`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(bhd / 2)},${C(flT + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_bcr*_m.cos(_a),_bcr*_m.sin(_a),-1)))`);
    }
    if (ss > 0) {
        L.push(`    try:`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(ss / 2)},${C(hubD / 2 + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(flT + hubH / 2)}),(0,90,0)))`);
        L.push(`    except Exception: pass`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(flange / 2)},${C(flT)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(bore / 2)},${C(flT + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Lid / cover ─────────────────────────────────────────────────────────────────
/** A lid for a box opening: a plate with an inner lip that drops into the box,
 * and optional corner screw holes. Pairs with ProjectBox. params: { length, width,
 * thickness, lipDepth, wall, screw } */
export function emitLidPython(f) {
    const p = f.params || {};
    const id = f.id;
    const Lx = Number(p.length) > 0 ? Number(p.length) : 64;
    const Wy = Number(p.width) > 0 ? Number(p.width) : 44;
    const T = Number(p.thickness) > 0 ? Number(p.thickness) : 2;
    const wall = Number(p.wall) > 0 ? Number(p.wall) : 2;
    const lip = Number(p.lipDepth) > 0 ? Number(p.lipDepth) : 4;
    const screw = Number(p.screw) > 0 ? Number(p.screw) : 0;
    const L = [];
    L.push(`# ── Lid ${id} (${C(Lx)}×${C(Wy)}×${C(T)}, lip ${C(lip)}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=extrude(Rectangle(${C(Lx)},${C(Wy)}),amount=${C(T)})`);
    // lip ring on the underside (drops into the box opening)
    L.push(`    _lipO=Box(${C(Lx - 2 * wall - 0.4)},${C(Wy - 2 * wall - 0.4)},${C(lip)},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((0,0,0)))`);
    L.push(`    _lipI=Box(${C(Lx - 4 * wall)},${C(Wy - 4 * wall)},${C(lip + 1)},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((0,0,0.5)))`);
    L.push(`    n_${id}=n_${id}+(_lipO-_lipI)`);
    if (screw > 0) {
        L.push(`    for _sx in (-1,1):`);
        L.push(`        for _sy in (-1,1):`);
        L.push(`            n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(T + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(Lx / 2 - wall - 3)},_sy*${C(Wy / 2 - wall - 3)},-1)))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(Lx)},${C(Wy)},${C(T)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── T-slot corner bracket ───────────────────────────────────────────────────────
/** An inside-corner bracket for joining T-slot extrusions: an L sized to the
 * profile series, with a bolt slot/hole on each arm for a T-nut. params: { size
 * (20/30/40), thickness, holeDia, armLength } */
export function emitTSlotBracketPython(f) {
    const p = f.params || {};
    const id = f.id;
    const s = Number(p.size) > 0 ? Number(p.size) : 20;
    const t = Number(p.thickness) > 0 ? Number(p.thickness) : Math.max(3, s * 0.2);
    const arm = Number(p.armLength) > 0 ? Number(p.armLength) : s * 1.5;
    const hd = Number(p.holeDia) > 0 ? Number(p.holeDia) : (s >= 40 ? 8 : s >= 30 ? 6.5 : 5.5);
    const w = s;
    const L = [];
    L.push(`# ── T-slot bracket ${id} (${C(s)}-series, arm ${C(arm)}, M${s >= 40 ? 8 : s >= 30 ? 6 : 5}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(arm)},${C(w)},${C(t)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}+Box(${C(t)},${C(w)},${C(arm)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(hd / 2)},${C(t + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(s / 2 + t / 2)},0,-1)))`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(hd / 2)},${C(t + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).moved(Location((${C(t / 2)},0,${C(s / 2 + t / 2)}),(0,90,0)))`);
    L.push(`    try:`);
    L.push(`        n_${id}=n_${id}+extrude(make_face(Polyline((${C(t)},${C(t)}),(${C(t + arm * 0.5)},${C(t)}),(${C(t)},${C(t + arm * 0.5)}),close=True)),amount=${C(w * 0.5)}).rotate(Axis.X,90).moved(Location((0,${C(w * 0.25)},0)))`);
    L.push(`    except Exception: pass  # gusset skipped`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(arm)},${C(w)},${C(t)},align=(Align.MIN,Align.CENTER,Align.MIN))+Box(${C(t)},${C(w)},${C(arm)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Rack gear (linear) ──────────────────────────────────────────────────────────
/** A linear gear rack: a bar with trapezoidal teeth on top at module pitch
 * (pairs with a spur pinion of the same module). params: { length, module,
 * width, baseHeight, pressureAngle } */
export function emitRackGearPython(f) {
    const p = f.params || {};
    const id = f.id;
    const len = Number(p.length) > 0 ? Number(p.length) : 60;
    const mod = Number(p.module) > 0 ? Number(p.module) : 2;
    const w = Number(p.width) > 0 ? Number(p.width) : 8;
    const base = Number(p.baseHeight) > 0 ? Number(p.baseHeight) : Math.max(4, mod * 2.5);
    const pitch = Math.PI * mod;
    const nT = Math.max(1, Math.floor(len / pitch));
    const tH = 2 * mod;                 // tooth height (addendum+dedendum ~2.25m, use 2m)
    const topW = mod * 0.6, botW = mod * 1.3;
    const L = [];
    L.push(`# ── Rack gear ${id} (${C(len)}mm, module ${C(mod)}, ${nT} teeth) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(len)},${C(w)},${C(base)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    L.push(`    _x0=${C((len - (nT - 1) * pitch) / 2)}`);
    L.push(`    for _k in range(${nT}):`);
    L.push(`        _cx=_x0+_k*${C(pitch)}`);
    L.push(`        _tooth=extrude(make_face(Polyline((_cx-${C(botW / 2)},${C(base)}),(_cx+${C(botW / 2)},${C(base)}),(_cx+${C(topW / 2)},${C(base + tH)}),(_cx-${C(topW / 2)},${C(base + tH)}),close=True)),amount=${C(w)}).rotate(Axis.X,90).moved(Location((0,${C(w / 2)},0)))`);
    L.push(`        n_${id}=n_${id}+_tooth`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(len)},${C(w)},${C(base)},align=(Align.MIN,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// Cell dims [diameter or width, length] mm.
const CELL_MM = { '18650': [18.6, 65], '21700': [21.2, 70], aa: [14.6, 50.5], aaa: [10.6, 44.5], c: [26.2, 50], '9v': [26.5, 48.5] };

// ── Battery holder ──────────────────────────────────────────────────────────────
/** A cradle for cylindrical cells: a block with N half-round troughs side by
 * side and end walls. params: { cellType, cellCount, wall } */
export function emitBatteryHolderPython(f) {
    const p = f.params || {};
    const id = f.id;
    const cell = CELL_MM[String(p.cellType || '18650').toLowerCase()] || CELL_MM['18650'];
    const cd = cell[0], cl = cell[1];
    const n = Math.max(1, Math.round(Number(p.cellCount) || 1));
    const wall = Number(p.wall) > 0 ? Number(p.wall) : 2;
    const pitch = cd + wall;
    const blkW = n * pitch + wall;
    const blkL = cl + 2 * wall;
    const blkH = cd * 0.65 + wall;
    const L = [];
    L.push(`# ── Battery holder ${id} (${n}× ${p.cellType || '18650'}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(blkW)},${C(blkL)},${C(blkH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    for _k in range(${n}):`);
    L.push(`        _cx=-${C(blkW / 2)}+${C(wall + cd / 2)}+_k*${C(pitch)}`);
    L.push(`        n_${id}=n_${id}-Cylinder(${C(cd / 2)},${C(cl + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.X,90).moved(Location((_cx,0,${C(blkH)})))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(blkW)},${C(blkL)},${C(blkH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── DIN-rail clip ───────────────────────────────────────────────────────────────
/** A clip that mounts onto 35mm DIN rail: a platform with a channel underneath
 * sized to the rail, with retaining lips. params: { width, platform, screw } */
export function emitDINRailClipPython(f) {
    const p = f.params || {};
    const id = f.id;
    const w = Number(p.width) > 0 ? Number(p.width) : 20;          // along the rail (Y)
    const plat = Number(p.platform) > 0 ? Number(p.platform) : 45; // platform span (X)
    const screw = Number(p.screw) > 0 ? Number(p.screw) : 3.4;
    const railW = 35, railD = 8, lip = 2.2, platT = 3;
    const blockH = railD + platT;
    const L = [];
    L.push(`# ── DIN-rail clip ${id} (35mm rail, platform ${C(plat)}×${C(w)}) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(plat)},${C(w)},${C(blockH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    // rail channel from the bottom (35 wide, railD deep)
    L.push(`    n_${id}=n_${id}-Box(${C(railW)},${C(w + 2)},${C(railD)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-0.1)))`);
    // undercut the retaining lips (widen the channel above the lip height)
    L.push(`    n_${id}=n_${id}-Box(${C(railW + 2 * lip)},${C(w + 2)},${C(railD - lip)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(lip)})))`);
    if (screw > 0) {
        L.push(`    for _sx in (-1,1):`);
        L.push(`        n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(platT + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(railW / 2 + (plat - railW) / 4)},0,${C(railD - 1)})))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(plat)},${C(w)},${C(platT)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Cable clip (saddle) ─────────────────────────────────────────────────────────
/** A saddle cable clip: an arch over the cable with two screw-down feet.
 * params: { cableDia, wall, screw, width } */
export function emitCableClipPython(f) {
    const p = f.params || {};
    const id = f.id;
    const cd = Number(p.cableDia) > 0 ? Number(p.cableDia) : 6;
    const wall = Number(p.wall) > 0 ? Number(p.wall) : 2;
    const screw = Number(p.screw) > 0 ? Number(p.screw) : 3;
    const w = Number(p.width) > 0 ? Number(p.width) : 8;
    const ir = cd / 2, or = cd / 2 + wall;
    const footL = screw + 5;
    const blkL = 2 * or + 2 * footL;            // feet on each side of the arch
    const blkH = wall + cd + wall;              // floor + cable + top wall
    const czc = wall + ir;                       // cable centre height
    const slotW = cd * 0.7;                      // top insertion slot
    const sxHole = or + footL / 2;               // screw-hole X on each foot
    const L = [];
    L.push(`# ── Cable clip ${id} (cable Ø${C(cd)}, single-piece clamp) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(blkL)},${C(w)},${C(blkH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    // cable channel through Y + a top slot so the cable pushes in
    L.push(`    n_${id}=n_${id}-Cylinder(${C(ir)},${C(w + 2)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).rotate(Axis.X,90).moved(Location((0,0,${C(czc)})))`);
    L.push(`    n_${id}=n_${id}-Box(${C(slotW)},${C(w + 2)},${C(blkH - czc + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(czc)})))`);
    // thin the feet to a low profile + screw holes
    L.push(`    for _sx in (-1,1):`);
    L.push(`        n_${id}=n_${id}-Box(${C(footL + 1)},${C(w + 2)},${C(blkH - Math.max(2, wall))},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((_sx*${C(or + footL / 2 + 0.5)},0,${C(blkH)})))`);
    L.push(`        n_${id}=n_${id}-Cylinder(${C(screw / 2)},${C(blkH + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((_sx*${C(sxHole)},0,-1)))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(blkL)},${C(w)},${C(Math.max(2, wall))},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Rotor / fluid-mover family (shares addFan's hub+blade core) ─────────────────
// These reach the rest of the rotor family addFan can't: radial (centrifugal),
// helical, cross-flow, and paddle layouts. Each generates its N blades/vanes IN
// ISOLATION inside the one generator (the rotor is a single printed part).

// ── Centrifugal impeller ────────────────────────────────────────────────────────
/**
 * Centrifugal/radial impeller (pump / blower): a backplate disc carrying N curved
 * vanes swept from the eye (inlet) to the outer rim, with an optional front
 * shroud (closed/semi-open/open), a centre bore + set-screw. `curve` sets the
 * vane sweep — backward (efficient), radial, or forward (high flow). The fan↔
 * impeller relation: same hub+blade idea, blades laid out radially + curved.
 * Degrades to a bored backplate.
 *
 * params: { outerDiameter, eyeDiameter, bladeCount, bladeHeight, backplate,
 *           bladeThickness, curve:'backward'|'radial'|'forward', wrapAngle,
 *           shroud:'open'|'semi'|'closed', bore, setScrew, hubHeight }
 */
export function emitImpellerPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D2 = Number(p.outerDiameter) > 0 ? Number(p.outerDiameter) : 80;
    const D1 = Number(p.eyeDiameter) > 0 ? Number(p.eyeDiameter) : D2 * 0.35;
    const N = Math.max(2, Math.round(Number(p.bladeCount) || 7));
    const bH = Number(p.bladeHeight) > 0 ? Number(p.bladeHeight) : Math.max(4, D2 * 0.12);
    const bp = Number(p.backplate) > 0 ? Number(p.backplate) : Math.max(2, D2 * 0.04);
    const thk = Number(p.bladeThickness) > 0 ? Number(p.bladeThickness) : Math.max(1.5, D2 * 0.03);
    const curve = ['backward', 'radial', 'forward'].includes(p.curve) ? p.curve : 'backward';
    const wrap = Number.isFinite(Number(p.wrapAngle)) && p.wrapAngle !== undefined && Number(p.wrapAngle) !== 0
        ? Number(p.wrapAngle) : (curve === 'backward' ? 38 : curve === 'forward' ? -38 : 6);
    const shroud = ['open', 'semi', 'closed'].includes(p.shroud) ? p.shroud : 'open';
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 0;
    const setScrew = Number(p.setScrew) > 0 ? Number(p.setScrew) : 0;
    const hubH = Number(p.hubHeight) > 0 ? Number(p.hubHeight) : 0;
    const r1 = D1 / 2, r2 = D2 / 2;
    const L = [];
    L.push(`# ── Impeller ${id} (Ø${C(D2)}, ${N} ${curve} vanes, eye Ø${C(D1)}${shroud !== 'open' ? `, ${shroud}` : ''}) ──`);
    L.push(`import math as _m`);
    L.push(`def _vane_${id}(r1,r2,wrap,thk,h,K=14):`);
    L.push(`    _l=[]; _r=[]`);
    L.push(`    for _i in range(K+1):`);
    L.push(`        _t=_i/K; _r0=r1+(r2-r1)*_t; _th=_m.radians(wrap)*_t`);
    L.push(`        _dr=(r2-r1)/K; _dth=_m.radians(wrap)/K`);
    L.push(`        _tx=_dr*_m.cos(_th)-_r0*_dth*_m.sin(_th); _ty=_dr*_m.sin(_th)+_r0*_dth*_m.cos(_th)`);
    L.push(`        _tl=_m.hypot(_tx,_ty) or 1.0; _nx=-_ty/_tl; _ny=_tx/_tl`);
    L.push(`        _cx=_r0*_m.cos(_th); _cy=_r0*_m.sin(_th)`);
    L.push(`        _l.append((_cx+_nx*thk/2,_cy+_ny*thk/2)); _r.append((_cx-_nx*thk/2,_cy-_ny*thk/2))`);
    L.push(`    return extrude(make_face(Polyline(*(_l+[_q for _q in reversed(_r)]),close=True)),amount=h)`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(r2)},${C(bp)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    if (hubH > 0) L.push(`    n_${id}=n_${id}+Cylinder(${C(Math.max(r1 * 0.8, bore / 2 + 3))},${C(bp + hubH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    for _k in range(${N}):`);
    L.push(`        n_${id}=n_${id}+_vane_${id}(${C(r1)},${C(r2 * 0.98)},${C(wrap)},${C(thk)},${C(bH)}).rotate(Axis.Z,360.0*_k/${N}).moved(Location((0,0,${C(bp)})))`);
    if (shroud === 'closed') {
        L.push(`    try:`);
        L.push(`        _shr_${id}=Cylinder(${C(r2)},${C(Math.max(1.5, bp * 0.7))},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(bp + bH)})))`);
        L.push(`        _shr_${id}=_shr_${id}-Cylinder(${C(r1)},${C(bp + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(bp + bH - 1)})))`);
        L.push(`        n_${id}=n_${id}+_shr_${id}`);
        L.push(`    except Exception: pass  # shroud skipped`);
    }
    if (bore > 0) {
        L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(bp + hubH + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
        if (setScrew > 0) L.push(`    try:\n        n_${id}=n_${id}-Cylinder(${C(setScrew / 2)},${C(r1 + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(bp + hubH / 2 + 0.5)}),(0,90,0)))\n    except Exception: pass`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(r2)},${C(bp)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    if (bore > 0) L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(bp + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Auger / Archimedes screw ────────────────────────────────────────────────────
/**
 * Auger / screw conveyor: a central shaft with a helical flight swept along a
 * Helix (the real helical sweep — fail-safe to a plain ribbed shaft). Optional
 * through-bore, handedness. params: { shaftDiameter, flightDiameter, length,
 * pitch, flightThickness, bore, handed } */
export function emitAugerPython(f) {
    const p = f.params || {};
    const id = f.id;
    const sD = Number(p.shaftDiameter) > 0 ? Number(p.shaftDiameter) : 10;
    const fD = Number(p.flightDiameter) > 0 ? Number(p.flightDiameter) : 30;
    const len = Number(p.length) > 0 ? Number(p.length) : 80;
    const pitch = Number(p.pitch) > 0 ? Number(p.pitch) : fD;
    const fT = Number(p.flightThickness) > 0 ? Number(p.flightThickness) : Math.max(1.5, fD * 0.05);
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 0;
    const sgn = p.handed === 'left' ? -1 : 1;
    const sR = sD / 2, fR = fD / 2;
    // Section centred on the mid-radius so it never crosses the axis: it spans
    // sR..fR (its inner edge buries into the shaft for a solid union).
    const midR = (sR + fR) / 2;
    const flightW = fR - sR;
    const L = [];
    L.push(`# ── Auger ${id} (shaft Ø${C(sD)}, flight Ø${C(fD)}, ${C(len)}mm, pitch ${C(pitch)}) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(sR)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    // The helical flight is built as a SEGMENTED helix — a stack of overlapping
    // annular sectors rising by pitch/seg. (A real `sweep` along a `Helix` works,
    // but fusing the thin swept ribbon into the shaft makes OCCT silently DROP it;
    // the segmented sectors fuse reliably.) `sgn` flips the rise direction.
    L.push(`    _M=18; _K=int(${C(len)}/${C(pitch)}*_M)+2; _da=${sgn}*360.0/_M; _dz=${C(len)}/(${C(len)}/${C(pitch)}*_M)`);
    L.push(`    for _k in range(_K):`);
    L.push(`        _a0=_k*_da; _a1=_a0+_da*1.4; _pts=[]`);
    L.push(`        for _j in range(7): _aa=_m.radians(_a0+(_a1-_a0)*_j/6.0); _pts.append((${C(fR)}*_m.cos(_aa),${C(fR)}*_m.sin(_aa)))`);
    L.push(`        for _j in range(7): _aa=_m.radians(_a1-(_a1-_a0)*_j/6.0); _pts.append((${C(sR * 0.8)}*_m.cos(_aa),${C(sR * 0.8)}*_m.sin(_aa)))`);
    L.push(`        _zc=_k*_dz`);
    L.push(`        if _zc>${C(len)}: break`);
    L.push(`        try: n_${id}=n_${id}+extrude(make_face(Polyline(*_pts,close=True)),amount=${C(fT)}).moved(Location((0,0,_zc)))`);
    L.push(`        except Exception: pass`);
    if (bore > 0) L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(len + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(sR)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Blower wheel (cross-flow / squirrel-cage) ───────────────────────────────────
/**
 * Cross-flow / squirrel-cage blower wheel: a drum cage of N forward-curved blades
 * between a bottom hub disc and a top open ring. params: { diameter, length,
 * bladeCount, bladeThickness, bore, curve, ringWidth } */
export function emitBlowerWheelPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 50;
    const len = Number(p.length) > 0 ? Number(p.length) : 40;
    const N = Math.max(6, Math.round(Number(p.bladeCount) || 24));
    const bT = Number(p.bladeThickness) > 0 ? Number(p.bladeThickness) : Math.max(1, D * 0.025);
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 5;
    const curve = Number.isFinite(Number(p.curve)) ? Number(p.curve) : 30;   // forward-lean angle
    const rw = Number(p.ringWidth) > 0 ? Number(p.ringWidth) : Math.max(2, D * 0.08);
    const r = D / 2;
    const bladeDepth = rw * 1.2, endT = Math.max(1.5, len * 0.06);
    const L = [];
    L.push(`# ── Blower wheel ${id} (Ø${C(D)}×${C(len)}, ${N} blades) ──`);
    L.push(`import math as _m`);
    L.push(`try:`);
    // bottom hub disc (carries the bore) + top open ring
    L.push(`    n_${id}=Cylinder(${C(r)},${C(endT)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    n_${id}=n_${id}+(Cylinder(${C(r)},${C(endT)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(r - rw)},${C(endT + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))).moved(Location((0,0,${C(len - endT)})))`);
    // blades around the rim, spanning the length, forward-leaned
    L.push(`    for _k in range(${N}):`);
    L.push(`        _a=360.0*_k/${N}`);
    L.push(`        _bl=Box(${C(bladeDepth)},${C(bT)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(r - bladeDepth / 2)},0,0),(0,0,${C(curve)})))`);
    L.push(`        n_${id}=n_${id}+_bl.rotate(Axis.Z,_a)`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(len + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(r)},${C(len)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Cylinder(${C(bore / 2)},${C(len + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Paddle wheel ────────────────────────────────────────────────────────────────
/**
 * Paddle / water wheel: a hub with N flat radial paddles spanning the axial
 * width. params: { diameter, width, paddleCount, paddleThickness, hubDiameter,
 * bore } */
export function emitPaddleWheelPython(f) {
    const p = f.params || {};
    const id = f.id;
    const D = Number(p.diameter) > 0 ? Number(p.diameter) : 60;
    const w = Number(p.width) > 0 ? Number(p.width) : 20;
    const N = Math.max(3, Math.round(Number(p.paddleCount) || 8));
    const pT = Number(p.paddleThickness) > 0 ? Number(p.paddleThickness) : Math.max(2, D * 0.04);
    const hubD = Number(p.hubDiameter) > 0 ? Number(p.hubDiameter) : D * 0.3;
    const bore = Number(p.bore) > 0 ? Number(p.bore) : 6;
    const r = D / 2, hubR = hubD / 2;
    const paddleLen = r - hubR + 2;
    const L = [];
    L.push(`# ── Paddle wheel ${id} (Ø${C(D)}×${C(w)}, ${N} paddles) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Cylinder(${C(hubR)},${C(w)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    for _k in range(${N}):`);
    L.push(`        _pd=Box(${C(paddleLen)},${C(pT)},${C(w)},align=(Align.MIN,Align.CENTER,Align.MIN)).moved(Location((${C(hubR - 1)},0,0),(0,0,360.0*_k/${N})))`);
    L.push(`        n_${id}=n_${id}+_pd`);
    L.push(`    n_${id}=n_${id}-Cylinder(${C(bore / 2)},${C(w + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,-1)))`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Cylinder(${C(hubR)},${C(w)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Raspberry Pi case (model-parametric) ────────────────────────────────────────
/**
 * Per-model Raspberry Pi mechanical spec. board=[L,W]; holeSpacing=[sx,sy]
 * (mounting holes at the 3.5mm-inset corners of that rectangle, Ø2.7 / M2.5);
 * ports=[{ name, edge:'front'(y=0)|'right'(x=L)|'left'(x=0)|'back'(y=W),
 * off (centre along the edge), w (along edge), h (above PCB) }].
 * front = the connector edge; GPIO runs along the back edge. Pi 4/5 numbers
 * follow the official mechanical drawings (datasheets.raspberrypi.com).
 */
export const PI_MODELS = {
    zero:   { label: 'Pi Zero',  board: [65, 30], holeSpacing: [58, 23], gpio: [3.5, 28, 51, 5], ports: [
        { name: 'mini-HDMI', edge: 'front', off: 12.4, w: 11.5, h: 4 },
        { name: 'micro-USB data', edge: 'front', off: 41.4, w: 8, h: 3.2 },
        { name: 'micro-USB pwr', edge: 'front', off: 54, w: 8, h: 3.2 },
        { name: 'microSD', edge: 'left', off: 15, w: 13, h: 2.2 } ] },
    zero2w: { label: 'Pi Zero 2 W', board: [65, 30], holeSpacing: [58, 23], gpio: [3.5, 28, 51, 5], ports: [
        { name: 'mini-HDMI', edge: 'front', off: 12.4, w: 11.5, h: 4 },
        { name: 'micro-USB data', edge: 'front', off: 41.4, w: 8, h: 3.2 },
        { name: 'micro-USB pwr', edge: 'front', off: 54, w: 8, h: 3.2 },
        { name: 'microSD', edge: 'left', off: 15, w: 13, h: 2.2 } ] },
    '3a+':  { label: 'Pi 3A+', board: [65, 56], holeSpacing: [58, 49], gpio: [3.5, 52.5, 51, 5], ports: [
        { name: 'micro-USB pwr', edge: 'front', off: 10.6, w: 8, h: 3.2 },
        { name: 'HDMI', edge: 'front', off: 32, w: 15.5, h: 7.5 },
        { name: 'AV jack', edge: 'front', off: 53.5, w: 7, h: 6 },
        { name: 'USB-A', edge: 'right', off: 29, w: 15, h: 16 } ] },
    '3b':   { label: 'Pi 3B', board: [85, 56], holeSpacing: [58, 49], gpio: [3.5, 52.5, 51, 5], ports: [
        { name: 'micro-USB pwr', edge: 'front', off: 10.6, w: 8, h: 3.2 },
        { name: 'HDMI', edge: 'front', off: 32, w: 15.5, h: 7.5 },
        { name: 'AV jack', edge: 'front', off: 53.5, w: 7, h: 6 },
        { name: 'Ethernet', edge: 'right', off: 10.25, w: 16, h: 14 },
        { name: 'USB-A 1', edge: 'right', off: 29, w: 15, h: 16 },
        { name: 'USB-A 2', edge: 'right', off: 47, w: 15, h: 16 } ] },
    '3b+':  { label: 'Pi 3B+', board: [85, 56], holeSpacing: [58, 49], gpio: [3.5, 52.5, 51, 5], ports: [
        { name: 'micro-USB pwr', edge: 'front', off: 10.6, w: 8, h: 3.2 },
        { name: 'HDMI', edge: 'front', off: 32, w: 15.5, h: 7.5 },
        { name: 'AV jack', edge: 'front', off: 53.5, w: 7, h: 6 },
        { name: 'Ethernet', edge: 'right', off: 10.25, w: 16, h: 14 },
        { name: 'USB-A 1', edge: 'right', off: 29, w: 15, h: 16 },
        { name: 'USB-A 2', edge: 'right', off: 47, w: 15, h: 16 } ] },
    '4b':   { label: 'Pi 4B', board: [85, 56], holeSpacing: [58, 49], gpio: [3.5, 52.5, 51, 5], ports: [
        { name: 'USB-C pwr', edge: 'front', off: 11.2, w: 9, h: 3.6 },
        { name: 'micro-HDMI 0', edge: 'front', off: 26, w: 7.5, h: 4.5 },
        { name: 'micro-HDMI 1', edge: 'front', off: 39.5, w: 7.5, h: 4.5 },
        { name: 'AV jack', edge: 'front', off: 54, w: 7, h: 6 },
        { name: 'USB 2.0', edge: 'right', off: 9, w: 15, h: 16 },
        { name: 'USB 3.0', edge: 'right', off: 27, w: 15, h: 16 },
        { name: 'Ethernet', edge: 'right', off: 45.75, w: 16, h: 14 } ] },
    '5':    { label: 'Pi 5', board: [85, 56], holeSpacing: [58, 49], gpio: [3.5, 52.5, 51, 5], ports: [
        { name: 'USB-C pwr', edge: 'front', off: 11.2, w: 9, h: 3.6 },
        { name: 'micro-HDMI 0', edge: 'front', off: 25.8, w: 7.5, h: 4.5 },
        { name: 'micro-HDMI 1', edge: 'front', off: 39.2, w: 7.5, h: 4.5 },
        { name: 'Ethernet', edge: 'right', off: 10.2, w: 16, h: 14 },
        { name: 'USB 3.0', edge: 'right', off: 29.1, w: 15, h: 16 },
        { name: 'USB 2.0', edge: 'right', off: 47, w: 15, h: 16 } ] },
};
const PI_ALIASES = { pizero: 'zero', 'zero w': 'zero', zerow: 'zero', pi3: '3b', '3': '3b', pi3b: '3b', pi4: '4b', '4': '4b', pi5: '5', pi: '5', '3a': '3a+', a: '3a+' };

/** Resolve a model key to a PI_MODELS entry (forgiving of aliases / case). */
export function resolvePiModel(model) {
    const k = String(model == null ? '5' : model).trim().toLowerCase().replace(/^(rpi|raspberry ?pi ?|pi ?)/, '');
    return PI_MODELS[k] || PI_MODELS[PI_ALIASES[k] || ''] || PI_MODELS[PI_ALIASES[String(model).toLowerCase()] || ''] || PI_MODELS['5'];
}

/**
 * A fully parametric Raspberry Pi case: changing `model` (Zero…Pi 5) reflows the
 * board outline, the M2.5 mounting-hole standoffs, and every port cutout in one
 * move. Adds ventilation, embossed/engraved branding text, an optional camera
 * hole, GPIO access, and microSD access. Emits the base tray, the lid, or both.
 * Degrades to a plain shelled box. Sits Align.MIN on Z. Assigns n_<id>.
 *
 * params: { model, part:'base'|'lid'|'both', wall, clearance, standoffHeight,
 *   headroom, ventilation:'none'|'slots'|'grid', brandingText, brandingEngrave,
 *   cameraHole, gpioAccess, microSDAccess, lidScrews, screwSize }
 */
export function emitPiCasePython(f) {
    const p = f.params || {};
    const id = f.id;
    const spec = resolvePiModel(p.model);
    const [bL, bW] = spec.board;
    const wall = Number(p.wall) > 0 ? Number(p.wall) : 2;
    const clr = Number(p.clearance) >= 0 ? Number(p.clearance) : 0.6;
    const standoff = Number(p.standoffHeight) > 0 ? Number(p.standoffHeight) : 4;
    const pcbThk = 1.5;
    const maxPortH = spec.ports.reduce((m, q) => Math.max(m, q.h), 8);
    const headroom = Number(p.headroom) > 0 ? Number(p.headroom) : maxPortH + 2.5;
    const part = ['base', 'lid', 'both'].includes(p.part) ? p.part : 'both';
    const vent = ['none', 'slots', 'grid'].includes(p.ventilation) ? p.ventilation : 'slots';
    const brand = typeof p.brandingText === 'string' ? p.brandingText : (spec.label || 'Raspberry Pi');
    const engrave = p.brandingEngrave !== false;
    const camera = p.cameraHole === true;
    const camDia = Number(p.cameraDiameter) > 0 ? Number(p.cameraDiameter) : 8;
    const gpio = p.gpioAccess === true;
    const sd = p.microSDAccess !== false;
    const lidScrews = p.lidScrews === true;
    const tol = 1.2;                                       // port clearance
    const stOD = 6, pilot = 2.2, sdOD = 0;
    // case geometry
    const innerHX = bL / 2 + clr, innerHY = bW / 2 + clr;
    const outerHX = innerHX + wall, outerHY = innerHY + wall;
    const floor = wall;
    const cavityH = standoff + pcbThk + headroom;
    const baseH = floor + cavityH;
    const boardTop = floor + standoff + pcbThk;            // z of PCB top (ports sit here)
    const lidThk = wall;
    const lipH = Math.min(4, headroom * 0.4);
    const bx = bL / 2, by = bW / 2;
    // mounting holes at the inset corners
    const hsx = spec.holeSpacing[0], hsy = spec.holeSpacing[1];
    const holes = [];
    for (const hx of [3.5, 3.5 + hsx]) for (const hy of [3.5, 3.5 + hsy]) holes.push([hx - bx, hy - by]);

    const L = [];
    L.push(`# ── Raspberry Pi case ${id} (${spec.label}: board ${C(bL)}×${C(bW)}, ${part}) ──`);
    L.push(`import math as _m`);

    // ----- BASE TRAY builder -----
    L.push(`def _base_${id}():`);
    L.push(`    _n=Box(${C(2 * outerHX)},${C(2 * outerHY)},${C(baseH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    try: _n=fillet(_n.edges().filter_by(Axis.Z),radius=${C(Math.min(3, wall + 1))})`);
    L.push(`    except Exception: pass`);
    L.push(`    _n=_n-Box(${C(2 * innerHX)},${C(2 * innerHY)},${C(cavityH + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(floor)})))`);
    // standoffs with pilot holes
    for (const [hx, hy] of holes) {
        L.push(`    _p=Cylinder(${C(stOD / 2)},${C(standoff)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(hx)},${C(hy)},${C(floor)})))`);
        L.push(`    _p=_p-Cylinder(${C(pilot / 2)},${C(standoff)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(hx)},${C(hy)},${C(floor + 0.8)})))`);
        L.push(`    _n=_n+_p`);
    }
    // port cutouts
    if (p.ioCutouts !== false) {
        for (const q of spec.ports) {
            if (q.name === 'microSD' && !sd) continue;
            const zc = boardTop + q.h / 2 - 0.5;
            const hh = q.h + 1.5;
            if (q.edge === 'front' || q.edge === 'back') {
                const cx = q.off - bx;
                const cy = (q.edge === 'front' ? -1 : 1) * (innerHY + wall / 2);
                L.push(`    _n=_n-Box(${C(q.w + tol)},${C(wall * 4)},${C(hh)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).moved(Location((${C(cx)},${C(cy)},${C(zc)})))  # ${q.name}`);
            } else {
                const cy = q.off - by;
                const cx = (q.edge === 'right' ? 1 : -1) * (innerHX + wall / 2);
                L.push(`    _n=_n-Box(${C(wall * 4)},${C(q.w + tol)},${C(hh)},align=(Align.CENTER,Align.CENTER,Align.CENTER)).moved(Location((${C(cx)},${C(cy)},${C(zc)})))  # ${q.name}`);
            }
        }
    }
    // side-wall ventilation (the GPIO-free left wall) + floor vents
    if (vent !== 'none') {
        // Enclosed side-wall slots: capped so they leave a solid rim top AND
        // bottom — otherwise (on a narrow board, where a port shares the wall) a
        // slot can sever the top rim and detach a fragment.
        const ventH = Math.max(2, Math.min(headroom - 1, baseH - boardTop - 3));
        L.push(`    try:`);
        L.push(`        for _i in range(6):`);
        L.push(`            _vy=-${C(innerHY * 0.7)}+_i*${C((innerHY * 1.4) / 5)}`);
        L.push(`            _n=_n-Box(${C(wall * 4)},2.2,${C(ventH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(-(innerHX + wall / 2))},_vy,${C(boardTop + 1)})))`);
        L.push(`        for _i in range(5):`);
        L.push(`            for _j in range(3):`);
        L.push(`                _n=_n-Cylinder(1.6,${C(wall + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((-${C(innerHX * 0.5)}+_i*${C(innerHX / 4)},-${C(innerHY * 0.4)}+_j*${C(innerHY * 0.4)},-1)))`);
        L.push(`    except Exception: pass  # base vents skipped`);
    }
    L.push(`    return _n`);

    // ----- LID builder -----
    L.push(`def _lid_${id}():`);
    L.push(`    _n=Box(${C(2 * outerHX)},${C(2 * outerHY)},${C(lidThk)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    L.push(`    try: _n=fillet(_n.edges().filter_by(Axis.Z),radius=${C(Math.min(3, wall + 1))})`);
    L.push(`    except Exception: pass`);
    // drop-in lip
    L.push(`    try:`);
    L.push(`        _lo=Box(${C(2 * innerHX - 0.4)},${C(2 * innerHY - 0.4)},${C(lipH)},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((0,0,0)))`);
    L.push(`        _li=Box(${C(2 * innerHX - 0.4 - 2 * wall)},${C(2 * innerHY - 0.4 - 2 * wall)},${C(lipH + 1)},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((0,0,0.5)))`);
    L.push(`        _n=_n+(_lo-_li)`);
    L.push(`    except Exception: pass`);
    // lid ventilation
    if (vent === 'slots') {
        L.push(`    try:`);
        L.push(`        for _i in range(9):`);
        L.push(`            _n=_n-Box(2.2,${C(2 * innerHY * 0.6)},${C(lidThk + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((-${C(innerHX * 0.62)}+_i*${C((innerHX * 1.24) / 8)},${C(innerHY * 0.18)},-1)))`);
        L.push(`    except Exception: pass  # lid vents skipped`);
    } else if (vent === 'grid') {
        L.push(`    try:`);
        L.push(`        _cols=int(${C(2 * innerHX)}/6); _rows=int(${C(2 * innerHY)}/6)`);
        L.push(`        for _i in range(1,_cols): `);
        L.push(`            for _j in range(1,_rows):`);
        L.push(`                _n=_n-Cylinder(1.5,${C(lidThk + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((-${C(innerHX)}+_i*6,-${C(innerHY)}+_j*6,-1)))`);
        L.push(`    except Exception: pass  # lid grid skipped`);
    }
    // GPIO access slot (over the header, back edge)
    if (gpio) {
        const [gx, , gw] = spec.gpio;
        const gcx = (gx + gw / 2) - bx;
        L.push(`    try: _n=_n-Box(${C(gw + 2)},7,${C(lidThk + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(gcx)},${C(innerHY - 5)},-1)))`);
        L.push(`    except Exception: pass  # gpio slot skipped`);
    }
    // camera hole
    if (camera) {
        L.push(`    try: _n=_n-Cylinder(${C(camDia / 2)},${C(lidThk + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(-innerHX * 0.45)},${C(-innerHY * 0.45)},-1)))`);
        L.push(`    except Exception: pass  # camera hole skipped`);
    }
    // branding text (engrave / emboss on the top face)
    if (brand && brand.trim()) {
        const fs = Math.max(4, Math.min(10, innerHX * 0.28));
        const safe = brand.replace(/\\/g, '').replace(/"/g, "'").slice(0, 24);
        L.push(`    try:`);
        L.push(`        _t=extrude(Text("${safe}",font_size=${C(fs)}),amount=0.8)`);
        if (engrave) {
            L.push(`        _n=_n-_t.moved(Location((0,${C(-innerHY * 0.45)},${C(lidThk - 0.6)})))`);
        } else {
            L.push(`        _n=_n+_t.moved(Location((0,${C(-innerHY * 0.45)},${C(lidThk)})))`);
        }
        L.push(`    except Exception: pass  # branding skipped`);
    }
    if (lidScrews) {
        for (const [hx, hy] of holes) L.push(`    try: _n=_n-Cylinder(1.7,${C(lidThk + 2)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((${C(hx)},${C(hy)},-1)))\n    except Exception: pass`);
    }
    L.push(`    return _n`);

    // ----- assemble -----
    L.push(`try:`);
    if (part === 'base') {
        L.push(`    n_${id}=_base_${id}()`);
    } else if (part === 'lid') {
        L.push(`    n_${id}=_lid_${id}()`);
    } else {
        // both: base + lid sitting on top (closed case, 2 solids)
        L.push(`    n_${id}=_base_${id}()+_lid_${id}().moved(Location((0,0,${C(baseH)})))`);
    }
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(2 * outerHX)},${C(2 * outerHY)},${C(baseH)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Box(${C(2 * innerHX)},${C(2 * innerHY)},${C(cavityH + 1)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(floor)})))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}

// ── Gridfinity bin (approx) ─────────────────────────────────────────────────────
/** A Gridfinity-compatible bin (42mm grid): an x×y×heightUnits box with a
 * hollow cavity, a chamfered base foot, and a top stacking lip. v1 approximation
 * (single base chamfer, not the exact 3-step profile). params: { gridX, gridY,
 * heightUnits, wall } */
export function emitGridfinityBinPython(f) {
    const p = f.params || {};
    const id = f.id;
    const gx = Math.max(1, Math.round(Number(p.gridX) || 1));
    const gy = Math.max(1, Math.round(Number(p.gridY) || 1));
    const hu = Math.max(2, Math.round(Number(p.heightUnits) || 3));
    const wall = Number(p.wall) > 0 ? Number(p.wall) : 1.2;
    const oL = 42 * gx - 0.5, oW = 42 * gy - 0.5, oH = 7 * hu;
    const L = [];
    L.push(`# ── Gridfinity bin ${id} (${gx}×${gy}×${hu}U, ${C(oL)}×${C(oW)}×${C(oH)}mm) ──`);
    L.push(`try:`);
    L.push(`    n_${id}=Box(${C(oL)},${C(oW)},${C(oH)},align=(Align.CENTER,Align.CENTER,Align.MIN))`);
    // chamfer the base foot (the gridfinity grip taper, approximated)
    L.push(`    try:`);
    L.push(`        n_${id}=chamfer(n_${id}.edges().group_by(Axis.Z)[0],length=${C(2.4)})`);
    L.push(`    except Exception: pass`);
    // hollow the cavity from the top, leaving floor + walls
    L.push(`    n_${id}=n_${id}-Box(${C(oL - 2 * wall)},${C(oW - 2 * wall)},${C(oH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(Math.max(3, oH * 0.12))})))`);
    // top stacking lip (a thin recess ledge around the rim)
    L.push(`    try:`);
    L.push(`        _lipCut=Box(${C(oL - 1.6)},${C(oW - 1.6)},${C(2.0)},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((0,0,${C(oH)})))`);
    L.push(`        _lipKeep=Box(${C(oL - 2 * wall)},${C(oW - 2 * wall)},${C(2.5)},align=(Align.CENTER,Align.CENTER,Align.MAX)).moved(Location((0,0,${C(oH + 0.25)})))`);
    L.push(`        n_${id}=n_${id}-(_lipCut-_lipKeep)`);
    L.push(`    except Exception: pass  # stacking lip skipped`);
    L.push(`except Exception:`);
    L.push(`    n_${id}=Box(${C(oL)},${C(oW)},${C(oH)},align=(Align.CENTER,Align.CENTER,Align.MIN))-Box(${C(oL - 2 * wall)},${C(oW - 2 * wall)},${C(oH)},align=(Align.CENTER,Align.CENTER,Align.MIN)).moved(Location((0,0,${C(wall)})))`);
    for (const ln of compoundFix(id)) L.push(ln);
    return L.join('\n');
}
