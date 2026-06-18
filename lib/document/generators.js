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
    L.push(`try:`);
    L.push(`    _sl_${id}=n_${id}.solids()`);
    L.push(`    if len(_sl_${id})>1: n_${id}=Compound(list(_sl_${id}))`);
    L.push(`except Exception: pass`);
    return L.join('\n');
}
