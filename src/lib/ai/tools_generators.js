/**
 * Parametric domain generators — AI tool surface.
 *
 * These wrap the typed ops in lib/document/operations.js (addPulley, addSprocket,
 * addTSlotExtrusion, addScrewBoss, addStandoff). Like addGear / add_casing, each
 * builds a whole functional part in ONE call from its standard parameters, so a
 * weak model never hand-composes a pulley out of cylinders (the place it most
 * reliably fails). The correctness lives in the generator, not the model's
 * spatial reasoning.
 *
 * Convention matches every other tools_*.js module: an array of
 * { name, description, input_schema, handler }; handlers return { ok, ... } and
 * never throw (the document ops can throw on bad input, so each call is
 * wrapped). Sizes are mm; bodies sit Align.MIN on Z (bottom face at Z=0).
 */

import {
    addPulley, addSprocket, addTSlotExtrusion, addScrewBoss, addStandoff, addFan,
    addMountingPlate, addBracket, addThreadedInsertBoss, addNutTrap, addSnapHook,
    addBearingPocket, addMotorMount, addShaftCoupler, addWheel, addTimingPulley,
    addHinge, addProjectBox, addPCBTray, addKnob,
    addFoot, addGusset, addHandle, addShaftHub, addLid, addRackGear,
    addBatteryHolder, addDINRailClip, addCableClip, addGridfinityBin, addTSlotBracket,
} from '../../../lib/document/index.js';
import { N, S, B, feat, fail } from './tools_util.js';

/** Shared fan/blade input schema (addFanBlade is addFan with bladeCount fixed). */
const FAN_PROPS = {
    diameter: N('Overall fan / propeller tip diameter (mm)'),
    bladeCount: N('Number of blades (default 5; 3+ recommended)'),
    airfoil: S('Blade cross-section: a NACA 4-digit code like "4412" or "0012", or a preset "flat" / "cambered" (default "4412")'),
    pitch: N('Geometric pitch — axial advance per revolution (mm/rev); sets the blade twist. Default ≈ diameter (1:1). Larger = more aggressive bite.'),
    pitchAngleDeg: N('Alternative to pitch: blade angle at the 75% station (deg); the twist distribution is derived from it.'),
    rootChord: N('Blade chord (width) at the hub (mm; default ~18% of diameter)'),
    tipChord: N('Blade chord at the tip (mm; default ~60% of rootChord — a taper)'),
    thicknessScale: N('Multiplier on the airfoil thickness for print strength (default 1.0; try 1.5–2 for small printed blades)'),
    handed: S('Spin/twist handedness', { enum: ['ccw', 'cw'] }),
    hubDiameter: N('Central hub outer diameter (mm; default ~35% of diameter)'),
    hubHeight: N('Hub length along the spin (Z) axis (mm; default ~0.8× rootChord)'),
    bore: N('Centre shaft-hole diameter through the hub (mm, 0 = none)'),
    setScrew: N('Radial grub-screw hole diameter into the bore (mm, 0 = none)'),
    shroud: B('Add a non-contacting outer duct/shroud ring around the blade tips (for a ducted EDF fan; default false)'),
    shroudThickness: N('Shroud ring wall thickness (mm; default 3)'),
    tipGap: N('Radial gap between blade tips and the shroud inner wall (mm; default 1)'),
    componentId: S('Target component id (default: active / root)'),
};

export const GENERATOR_TOOLS = [
    {
        name: 'addPulley',
        description: 'Create a belt pulley in ONE call: a hub disk with an optional centre bore, end flanges to keep the belt on, and (for V/round belts) a revolved belt groove. Do NOT build a pulley from cylinders — use this. pulleyType "flat" is a plain crowned face, "vbelt" cuts a V-groove, "round" cuts a round-belt groove. Add a bore for the shaft and a setScrew diameter for a grub screw to lock it. Sits on Z=0. Dimensions mm. Verify with measure {type:"bbox"} after.',
        input_schema: {
            type: 'object',
            properties: {
                diameter: N('Outer / pitch diameter of the pulley (mm)'),
                width: N('Face width along Z (mm, default 10)'),
                bore: N('Centre shaft-hole DIAMETER (mm, default 0 = no bore)'),
                pulleyType: S('Belt type', { enum: ['flat', 'vbelt', 'round'] }),
                flange: B('Add raised end flanges to retain the belt (default true for vbelt/round)'),
                flangeDiameter: N('Flange outer diameter (mm; default ~1.25× the pulley)'),
                flangeThickness: N('Flange thickness (mm; default ~15% of width)'),
                setScrew: N('Radial grub-screw hole diameter into the bore (mm, 0 = none)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['diameter'],
        },
        handler: (i) => {
            try { return feat(addPulley(i), `Pulley ${i.pulleyType || 'flat'} Ø${i.diameter}×${i.width ?? 10}mm${i.bore ? ` bore Ø${i.bore}` : ''}`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addSprocket',
        description: 'Create a roller-chain sprocket in ONE call: a toothed disk whose tooth form is derived from the chain pitch and roller diameter (pitch diameter = pitch / sin(180/teeth)), with an optional centre bore and bolt circle. Do NOT build a sprocket from primitives — use this (it is the chain analogue of addGear). Common chains: #25 pitch 6.35mm, #35 pitch 9.525mm, #40 / "1/2 inch" pitch 12.7mm. For a ring of mounting holes set boltCount + boltCircleDiameter. Sits on Z=0. Dimensions mm. Verify with measure {type:"bbox"} after.',
        input_schema: {
            type: 'object',
            properties: {
                teeth: N('Number of teeth (>= 6)'),
                chainPitch: N('Chain pitch — distance between roller centres (mm, default 12.7 = #40)'),
                rollerDiameter: N('Chain roller diameter (mm; default ~0.6× pitch)'),
                thickness: N('Sprocket thickness / face width (mm, default 5)'),
                bore: N('Centre shaft-hole DIAMETER (mm, default 0 = no bore)'),
                boltCount: N('Number of mounting holes evenly spaced around the centre (0 = none)'),
                boltCircleDiameter: N('Diameter of the circle the mounting holes sit on (mm)'),
                boltHoleDiameter: N('Each mounting-hole diameter (mm, default 3 for M3)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['teeth'],
        },
        handler: (i) => {
            try { return feat(addSprocket(i), `Sprocket ${i.teeth}T pitch ${i.chainPitch ?? 12.7}mm × ${i.thickness ?? 5}mm${i.bore ? ` bore Ø${i.bore}` : ''}`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addTSlotExtrusion',
        description: 'Create a length of aluminium T-slot framing extrusion (the 2020 / 3030 / 4040 profile used for machine frames) in ONE call: a square bar with a centre bore and a T-slot channel down each of the four faces. Use this for structural frames/rails instead of plain boxes when the user wants 80/20-style framing. size is the profile cross-section (20, 30, or 40 for the common series); length is along +Z. Dimensions mm. Verify with measure {type:"bbox"} after.',
        input_schema: {
            type: 'object',
            properties: {
                size: N('Profile cross-section size (mm) — 20, 30, or 40 for standard series (default 20)'),
                length: N('Length of the extrusion along Z (mm, default 100)'),
                slotWidth: N('Slot opening width on each face (mm; default ~30% of size)'),
                bore: N('Centre through-bore diameter (mm; default ~25% of size; 0 = none)'),
                slots: B('Cut the four face slots (default true)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['size', 'length'],
        },
        handler: (i) => {
            try { return feat(addTSlotExtrusion(i), `T-slot ${i.size}×${i.size} × ${i.length}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addScrewBoss',
        description: 'Create a screw boss / mounting post in ONE call: a cylindrical collar with a pilot hole for a self-tapping screw, optional triangular support ribs (gussets) for strength, and an optional base fillet. Use this for the posts inside an enclosure that screws fasten into. Size it by screwSize (M2/M2.5/M3/M4/M5 — picks a self-tapping pilot automatically) or give explicit outerDiameter/pilotDiameter. Sits on Z=0. Dimensions mm.',
        input_schema: {
            type: 'object',
            properties: {
                screwSize: S('Metric screw the boss accepts — sets the pilot hole', { enum: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6'] }),
                height: N('Boss height along Z (mm, default 8)'),
                outerDiameter: N('Outer collar diameter (mm; default sized from screwSize)'),
                pilotDiameter: N('Pilot-hole diameter for the self-tapping screw (mm; default from screwSize)'),
                pilotDepth: N('Depth of the pilot hole (mm; default height − 1)'),
                ribs: N('Number of triangular support ribs around the boss (0 = none)'),
                ribThickness: N('Rib thickness (mm; default ~18% of outer diameter)'),
                baseFillet: N('Fillet radius where the boss meets the floor (mm, 0 = none)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['height'],
        },
        handler: (i) => {
            try { return feat(addScrewBoss(i), `Screw boss ${i.screwSize || ''} h${i.height}${i.ribs ? `, ${i.ribs} ribs` : ''}`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addStandoff',
        description: 'Create a PCB / panel standoff (spacer) in ONE call: a hex or round pillar with a through bore, used to mount circuit boards and panels off a surface. shape "hex" sizes by across-flats (like a real nut/standoff); "round" sizes by outer diameter. Sits on Z=0. Dimensions mm.',
        input_schema: {
            type: 'object',
            properties: {
                shape: S('Pillar cross-section', { enum: ['hex', 'round'] }),
                size: N('Across-flats (hex) or outer diameter (round) in mm (default 6)'),
                height: N('Standoff height along Z (mm, default 10)'),
                bore: N('Through-bore diameter (mm; default ~40% of size)'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['size', 'height'],
        },
        handler: (i) => {
            try { return feat(addStandoff(i), `Standoff ${i.shape || 'hex'} ${i.size}×${i.height}mm`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addFan',
        description: 'Create a complete axial FAN / PROPELLER / EDF rotor in ONE call: a central hub with a ring of TWISTED AIRFOIL blades. Do NOT build fan/propeller/impeller/EDF blades from boxes, cylinders, or extrudes — a real blade is a twisted, cambered, tapered airfoil loft that you CANNOT express by hand, and a box "blade" is wrong. Use this. The cross-section is a real airfoil (airfoil: a NACA 4-digit code like "4412", or "flat"/"cambered"); the twist comes from a physical pitch (mm of advance per rev) — bigger pitch = more aggressive blades. Size by diameter (tip Ø) + bladeCount. Add a bore for the motor shaft (+ setScrew to lock it), thicknessScale 1.5–2 to strengthen small printed blades, and shroud:true for a ducted EDF fan. Sits on Z=0, spins about Z. Dimensions mm. Verify with measure {type:"bbox"} and capture_views after — confirm the blades are twisted airfoils, not flat plates.',
        input_schema: { type: 'object', properties: FAN_PROPS, required: ['diameter'] },
        handler: (i) => {
            try { return feat(addFan(i), `Fan Ø${i.diameter} ${i.bladeCount ?? 5} blades, NACA ${i.airfoil || '4412'}${i.shroud ? ', shrouded' : ''}`); }
            catch (e) { return fail(e); }
        },
    },
    {
        name: 'addFanBlade',
        description: 'Create a SINGLE twisted-airfoil fan/propeller blade (no hub) — for mating one blade onto a custom hub or studying a profile. Same airfoil + pitch + chord controls as addFan; it just fixes bladeCount=1. For a whole fan use addFan instead (it builds the hub + the full blade ring). Do NOT approximate a blade with a box/extrude — use this so it is a real twisted airfoil. Sits on Z=0. Dimensions mm.',
        input_schema: { type: 'object', properties: FAN_PROPS, required: ['diameter'] },
        handler: (i) => {
            try { return feat(addFan({ ...i, bladeCount: 1 }), `Fan blade Ø${i.diameter}, NACA ${i.airfoil || '4412'}`); }
            catch (e) { return fail(e); }
        },
    },

    // ── P0 foundation generators ────────────────────────────────────────────────
    {
        name: 'addMountingPlate',
        description: 'Create a flat MOUNTING PLATE / base plate in ONE call: a rectangular plate with a centred rows×cols grid of through-holes, optional countersinks and rounded corners. Use this for any baseplate, adapter plate, or bolt-down base instead of stacking a box + hand-placed holes. Set rows/cols/pitchX/pitchY for the hole grid (the bolt pattern parts mount on). Sits on Z=0. mm. Verify with measure {type:"bbox"} after.',
        input_schema: { type: 'object', properties: {
            length: N('Plate length, X (mm)'), width: N('Plate width, Y (mm)'), thickness: N('Plate thickness, Z (mm, default 4)'),
            holeDia: N('Through-hole diameter (mm; 0 = no holes)'), rows: N('Hole rows along Y (default 1)'), cols: N('Hole columns along X (default 1)'),
            pitchX: N('Column spacing (mm)'), pitchY: N('Row spacing (mm)'),
            cornerRadius: N('Round the vertical corners (mm, 0 = sharp)'),
            countersinkDia: N('Countersink top diameter (mm, 0 = none)'), countersinkDepth: N('Countersink depth (mm)'),
            componentId: S('Target component id'),
        }, required: ['length', 'width'] },
        handler: (i) => { try { return feat(addMountingPlate(i), `Plate ${i.length}×${i.width}${i.holeDia ? `, ${i.rows ?? 1}×${i.cols ?? 1} holes` : ''}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addBracket',
        description: 'Create an L / right-angle BRACKET in ONE call: a horizontal arm + a vertical arm meeting at a corner, each with a row of bolt holes, plus an optional triangular gusset for strength. Use this for any angle bracket / corner brace / shelf bracket instead of unioning two boxes by hand. angle defaults to 90°. Sits on Z=0 (corner at the origin). mm.',
        input_schema: { type: 'object', properties: {
            armA: N('Horizontal arm length, X (mm)'), armB: N('Vertical arm length, Z (mm)'), width: N('Bracket width, Y (mm)'),
            thickness: N('Material thickness (mm, default 4)'), holeDia: N('Bolt-hole diameter (mm, default 4)'),
            holesPerArm: N('Holes per arm (default 1)'), angle: N('Angle between arms (deg, default 90)'), gusset: B('Add a corner gusset rib (default false)'),
            componentId: S('Target component id'),
        }, required: ['armA', 'armB'] },
        handler: (i) => { try { return feat(addBracket(i), `Bracket ${i.armA}×${i.armB}mm${i.gusset ? ' gusseted' : ''}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addThreadedInsertBoss',
        description: 'Create a HEAT-SET THREADED-INSERT boss in ONE call: a post with a straight counterbore sized so a brass heat-set insert melts/presses in (the pro way to put screw threads in a 3D print). Pick insertSize M2–M6 and the pilot hole is sized automatically. Optional support ribs + base fillet. Use this (NOT addScrewBoss) when the user wants a metal threaded insert. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            insertSize: S('Insert thread size', { enum: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6'] }), height: N('Boss height (mm, default 8)'),
            outerDiameter: N('Outer Ø (mm; default from size)'), holeDiameter: N('Insert pilot Ø (mm; default from size)'), holeDepth: N('Pocket depth (mm)'),
            ribs: N('Support ribs (0 = none)'), ribThickness: N('Rib thickness (mm)'), baseFillet: N('Base fillet radius (mm)'), componentId: S('Target component id'),
        }, required: ['height'] },
        handler: (i) => { try { return feat(addThreadedInsertBoss(i), `Insert boss ${i.insertSize || 'M3'} h${i.height}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addNutTrap',
        description: 'Create a captive hex-NUT TRAP in ONE call: a block with a coaxial bolt clearance hole and a hex pocket sized to a standard nut, entered from the bottom or a side, so a nut is held captive for a bolted printed joint. Pick nutSize M2–M6 (across-flats + thickness auto). Use this for any captive-nut fastening instead of carving a hex by hand. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            nutSize: S('Nut size', { enum: ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6'] }), entry: S('Pocket entry', { enum: ['bottom', 'side'] }),
            block: N('Block size (mm; default from nut)'), height: N('Block height (mm)'), boltClear: N('Bolt clearance Ø (mm; default from size)'), componentId: S('Target component id'),
        }, required: ['nutSize'] },
        handler: (i) => { try { return feat(addNutTrap(i), `Nut trap ${i.nutSize} ${i.entry || 'bottom'}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addSnapHook',
        description: 'Create a cantilever SNAP-FIT HOOK in ONE call: a flexible arm with a hook (catch face + lead-in ramp) at the tip — the standard hardware-free way to clip enclosures/lids together. The deflecting hook geometry is not hand-modelable; use this. Tune armLength/armThickness for stiffness, hookDepth for grip, leadAngle for insertion force. Sits on Z=0 (arm rises +Z). mm.',
        input_schema: { type: 'object', properties: {
            armLength: N('Arm length, Z (mm, default 16)'), armThickness: N('Arm thickness, X (mm, default 2)'), width: N('Arm width, Y (mm, default 8)'),
            hookDepth: N('Hook protrusion (mm, default 1.5)'), leadAngle: N('Lead-in ramp angle (deg, default 45)'), componentId: S('Target component id'),
        }, required: ['armLength'] },
        handler: (i) => { try { return feat(addSnapHook(i), `Snap hook ${i.armLength}mm`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addBearingPocket',
        description: 'Create a press-fit BEARING POCKET / housing in ONE call: a collar with a recess sized to a standard ball bearing (name it: 608, 623, 625, 626, 688, 6800, 6900, lm8uu…) plus a retaining shoulder and a shaft clearance hole. The exact OD + shoulder are what hand-modelling gets wrong; use this so the COTS bearing actually press-fits. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            bearing: S('Standard bearing designation (e.g. "608", "623", "6800", "lm8uu")'),
            od: N('Bearing outer Ø (mm; if not a named bearing)'), id: N('Bearing bore Ø (mm)'), width: N('Bearing width (mm)'),
            wall: N('Wall around the bearing (mm)'), shoulder: N('Retaining shoulder thickness (mm)'), throughHole: N('Shaft clearance Ø through the shoulder (mm)'), componentId: S('Target component id'),
        }, required: [] },
        handler: (i) => { try { return feat(addBearingPocket(i), `Bearing pocket ${i.bearing || `Ø${i.od}`}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addMotorMount',
        description: 'Create a MOTOR MOUNT faceplate in ONE call: a plate with the correct bolt pattern + centre shaft/pilot clearance hole for a motor. Name motorType (nema17, nema23, nema14, n20, 2208, 775) and the bolt circle/square + pilot are set automatically; or pass body/boltPattern/screw/pilot/kind for a custom motor. The bolt pattern is exactly what a model gets wrong from primitives. (For a hobby SERVO use the servoMount recipe instead.) Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            motorType: S('Motor', { enum: ['nema17', 'nema23', 'nema14', 'n20', '2208', '775'] }),
            body: N('Motor body size (mm; custom)'), boltPattern: N('Bolt square/circle size (mm; custom)'), screw: N('Bolt-hole Ø (mm; custom)'),
            pilot: N('Centre pilot/shaft clearance Ø (mm; custom)'), kind: S('Pattern', { enum: ['square', 'twohole', 'circle3'] }),
            thickness: N('Plate thickness (mm, default 4)'), plate: N('Plate size (mm; default from body)'), componentId: S('Target component id'),
        }, required: [] },
        handler: (i) => { try { return feat(addMotorMount(i), `Motor mount ${i.motorType || 'custom'}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addShaftCoupler',
        description: 'Create a rigid SHAFT COUPLER in ONE call: a cylinder with a bore from each end (bore1, bore2 — can differ) joining two shafts, with radial set-screw holes. Use this to connect a motor shaft to a driven shaft instead of hand-boring a cylinder. Sits on Z=0 (axis +Z). mm.',
        input_schema: { type: 'object', properties: {
            bore1: N('Bore at one end (motor shaft Ø, mm)'), bore2: N('Bore at the other end (driven shaft Ø, mm; default = bore1)'),
            outerDiameter: N('Coupler outer Ø (mm; default from bores)'), length: N('Coupler length (mm)'),
            setScrew: N('Set-screw hole Ø (mm)'), screwsPerSide: N('Set-screws per side (default 1)'), componentId: S('Target component id'),
        }, required: ['bore1'] },
        handler: (i) => { try { return feat(addShaftCoupler(i), `Coupler Ø${i.bore1}/${i.bore2 ?? i.bore1}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addWheel',
        description: 'Create a WHEEL in ONE call: a disk with a shaft bore (round / D-flat / hex), an optional tire groove around the rim, optional lightening holes (spokes), and a radial set-screw. Use this for any robot/cart wheel or pulley-disk instead of composing cylinders. Size by diameter + width. Sits on Z=0 (axis +Z). mm.',
        input_schema: { type: 'object', properties: {
            diameter: N('Wheel outer Ø (mm)'), width: N('Wheel width / tread (mm, default 10)'), bore: N('Shaft bore Ø (mm, default 5)'),
            shaftType: S('Bore type', { enum: ['round', 'D', 'hex'] }), setScrew: N('Radial set-screw Ø (mm, 0 = none)'),
            spokes: N('Lightening holes / spokes (0 = solid)'), tireGroove: B('Cut a tire groove around the rim (default true)'), componentId: S('Target component id'),
        }, required: ['diameter'] },
        handler: (i) => { try { return feat(addWheel(i), `Wheel Ø${i.diameter}×${i.width ?? 10}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addTimingPulley',
        description: 'Create a toothed TIMING-BELT PULLEY (GT2 / GT3 / HTD) in ONE call: pitch diameter from teeth × belt pitch, belt teeth as grooves, optional flanges, centre bore, set-screw. This is the 3D-printer/CNC belt-drive standard — distinct from addPulley (which is a friction/V-belt pulley). Size by teeth + beltType. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            teeth: N('Number of teeth'), beltType: S('Belt profile', { enum: ['GT2', 'GT3', 'HTD5', 'HTD3'] }),
            width: N('Pulley width (mm, default 7)'), bore: N('Centre bore Ø (mm, default 5)'), flanges: B('Add belt-retaining flanges (default true)'),
            setScrew: N('Radial set-screw Ø (mm, 0 = none)'), componentId: S('Target component id'),
        }, required: ['teeth'] },
        handler: (i) => { try { return feat(addTimingPulley(i), `${i.teeth}T ${i.beltType || 'GT2'} pulley`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addHinge',
        description: 'Create a pinned HINGE form in ONE call: two coplanar leaves joined by a knuckle barrel along the pin axis, with a through pin-bore. Use this for any hinge/pivot mount instead of hand-building knuckles. (A fully articulating hinge is a 2-part assembly — print/split the leaves; this is the single-body form for layout + the mounting interface.) Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            length: N('Hinge length along the pin (mm)'), leafWidth: N('Each leaf width (mm, default 20)'), thickness: N('Leaf thickness (mm, default 3)'),
            knuckles: N('Knuckle segments (visual, default 5)'), pinDia: N('Pin bore Ø (mm, default 3)'), gap: N('Knuckle clearance gap (mm)'), componentId: S('Target component id'),
        }, required: ['length'] },
        handler: (i) => { try { return feat(addHinge(i), `Hinge ${i.length}mm pin Ø${i.pinDia ?? 3}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addProjectBox',
        description: 'Create an enclosure / PROJECT BOX base in ONE call: an open-top box with a usable inner cavity (innerLength/Width/Height) plus `wall` all round and a floor, with optional internal corner screw bosses and a lid lip. Use this for a standalone electronics enclosure (vs add_casing, which wraps EXISTING placed components). Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            innerLength: N('Inner cavity length (mm)'), innerWidth: N('Inner cavity width (mm)'), innerHeight: N('Inner cavity height (mm)'),
            wall: N('Wall + floor thickness (mm, default 2)'), bosses: B('Add internal corner screw bosses (default false)'),
            screwSize: S('Boss screw size', { enum: ['M2', 'M2.5', 'M3', 'M4'] }), lip: B('Add a top lip for a lid (default false)'), componentId: S('Target component id'),
        }, required: ['innerLength', 'innerWidth', 'innerHeight'] },
        handler: (i) => { try { return feat(addProjectBox(i), `Box ${i.innerLength}×${i.innerWidth}×${i.innerHeight} inner`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addPCBTray',
        description: 'Create a PCB TRAY in ONE call: a base plate with four standoff posts placed to a board\'s mounting-hole pattern (inset from the PCB corners), each with a pilot hole for a self-tapping screw. Give the PCB size + hole inset and the posts land correctly — what a model fumbles by hand. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            pcbLength: N('PCB length (mm)'), pcbWidth: N('PCB width (mm)'), holeInset: N('Mounting-hole inset from PCB edge (mm, default 3.5)'),
            standoffHeight: N('Standoff height (mm, default 6)'), standoffDia: N('Standoff Ø (mm; default from screw)'), screwDia: N('Screw Ø (mm, default 2.5)'),
            margin: N('Base plate margin around the PCB (mm)'), baseThickness: N('Base plate thickness (mm)'), componentId: S('Target component id'),
        }, required: ['pcbLength', 'pcbWidth'] },
        handler: (i) => { try { return feat(addPCBTray(i), `PCB tray ${i.pcbLength}×${i.pcbWidth}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addKnob',
        description: 'Create a control KNOB in ONE call: a cylinder with a gripped rim (knurl ≈ fine flutes / flute ≈ finger scallops / smooth), a shaft bore (round or D-flat), and an optional set-screw + pointer. Knurling is not hand-modelable — use this for any dial/knob. Size by diameter + height. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: {
            diameter: N('Knob Ø (mm)'), height: N('Knob height (mm, default 16)'), gripType: S('Rim grip', { enum: ['knurl', 'flute', 'smooth'] }),
            flutes: N('Number of flutes/knurls (default auto)'), shaftBore: N('Shaft bore Ø (mm, default 6)'), shaftType: S('Bore type', { enum: ['round', 'D'] }),
            setScrew: N('Set-screw Ø (mm, 0 = none)'), pointer: B('Add a pointer/indicator (default false)'), componentId: S('Target component id'),
        }, required: ['diameter'] },
        handler: (i) => { try { return feat(addKnob(i), `Knob Ø${i.diameter} ${i.gripType || 'knurl'}`); } catch (e) { return fail(e); } },
    },

    // ── P1 generators ───────────────────────────────────────────────────────────
    {
        name: 'addFoot',
        description: 'Create a FOOT / leveling pad / bumper in ONE call: a puck with a top screw counterbore and a bottom grip recess (for a rubber pad). Use for the feet of any enclosure/stand. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { diameter: N('Foot Ø (mm)'), height: N('Foot height (mm, default 8)'), screw: N('Mounting screw Ø (mm, default 4)'), recessDia: N('Bottom recess Ø (mm)'), recessDepth: N('Bottom recess depth (mm)'), componentId: S('Target component id') }, required: [] },
        handler: (i) => { try { return feat(addFoot(i), `Foot Ø${i.diameter ?? 20}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addGusset',
        description: 'Create a standalone triangular GUSSET brace in ONE call: a right triangle with a bolt hole near each leg, to reinforce an L-joint between two panels. Sits on Z=0 (legs along +X and +Z). mm.',
        input_schema: { type: 'object', properties: { legA: N('Leg along X (mm)'), legB: N('Leg along Z (mm)'), thickness: N('Thickness, Y (mm, default 4)'), holeDia: N('Bolt-hole Ø (mm, default 4)'), componentId: S('Target component id') }, required: [] },
        handler: (i) => { try { return feat(addGusset(i), `Gusset ${i.legA ?? 30}×${i.legB ?? 30}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addHandle',
        description: 'Create a pull HANDLE in ONE call: two posts at ±span/2 rising to a grip bar, with a mounting screw hole down each post. Use for drawer/lid/door pulls. span = mounting-hole spacing. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { span: N('Mounting-hole span (mm)'), height: N('Handle height (mm, default 30)'), gripDia: N('Grip bar Ø (mm, default 12)'), postDia: N('Post Ø (mm; default = grip)'), screw: N('Mounting screw Ø (mm, default 4)'), componentId: S('Target component id') }, required: ['span'] },
        handler: (i) => { try { return feat(addHandle(i), `Handle span ${i.span}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addShaftHub',
        description: 'Create a SHAFT HUB adapter in ONE call: a flange disk + a raised hub with a centre shaft bore (round/D/hex), a bolt circle, and a set-screw — to mount a wheel/arm/disc onto a shaft. The bolt circle + bore fit are what hand-modelling gets wrong. Sits on Z=0 (axis +Z). mm.',
        input_schema: { type: 'object', properties: { bore: N('Shaft bore Ø (mm)'), shaftType: S('Bore type', { enum: ['round', 'D', 'hex'] }), flangeDiameter: N('Flange Ø (mm)'), hubDiameter: N('Hub boss Ø (mm)'), hubHeight: N('Hub height (mm)'), boltCount: N('Bolt-circle holes (default 4)'), boltCircle: N('Bolt-circle Ø (mm)'), boltHole: N('Bolt-hole Ø (mm, default 3)'), setScrew: N('Set-screw Ø (mm, default 3)'), componentId: S('Target component id') }, required: ['bore'] },
        handler: (i) => { try { return feat(addShaftHub(i), `Shaft hub Ø${i.bore}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addLid',
        description: 'Create a LID / cover in ONE call: a plate with an inner lip that drops into a box opening, plus optional corner screw holes. Pairs with addProjectBox (match its outer length/width). Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { length: N('Lid length (mm)'), width: N('Lid width (mm)'), thickness: N('Lid thickness (mm, default 2)'), wall: N('Box wall thickness it sits over (mm, default 2)'), lipDepth: N('Lip depth into the box (mm, default 4)'), screw: N('Corner screw Ø (mm, 0 = none)'), componentId: S('Target component id') }, required: ['length', 'width'] },
        handler: (i) => { try { return feat(addLid(i), `Lid ${i.length}×${i.width}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addRackGear',
        description: 'Create a linear gear RACK in ONE call: a bar with trapezoidal teeth at module pitch, to pair with a spur pinion of the same module (rack-and-pinion linear drive). Use addGear for the pinion. Sits on Z=0 (teeth up). mm.',
        input_schema: { type: 'object', properties: { length: N('Rack length (mm)'), module: N('Gear module (mm/tooth, must match the pinion)'), width: N('Rack width (mm, default 8)'), baseHeight: N('Bar height below the teeth (mm)'), pressureAngle: N('Pressure angle (deg, default 20)'), componentId: S('Target component id') }, required: ['length', 'module'] },
        handler: (i) => { try { return feat(addRackGear(i), `Rack ${i.length}mm m${i.module}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addBatteryHolder',
        description: 'Create a BATTERY HOLDER in ONE call: a cradle with N half-round troughs sized to a cell (18650, 21700, AA, AAA, C, 9V) side by side with end walls. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { cellType: S('Cell', { enum: ['18650', '21700', 'AA', 'AAA', 'C', '9V'] }), cellCount: N('Number of cells (default 1)'), wall: N('Wall thickness (mm, default 2)'), componentId: S('Target component id') }, required: [] },
        handler: (i) => { try { return feat(addBatteryHolder(i), `Battery holder ${i.cellCount ?? 1}× ${i.cellType || '18650'}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addDINRailClip',
        description: 'Create a 35mm DIN-RAIL CLIP in ONE call: a mounting platform with a channel + retaining lips that snaps onto standard 35mm DIN rail. Use for panel/industrial mounting. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { width: N('Clip width along the rail (mm, default 20)'), platform: N('Platform span (mm, default 45)'), screw: N('Mounting screw Ø (mm, default 3.4)'), componentId: S('Target component id') }, required: [] },
        handler: (i) => { try { return feat(addDINRailClip(i), `DIN clip ${i.width ?? 20}mm`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addCableClip',
        description: 'Create a CABLE CLIP / saddle in ONE call: a single-piece clamp with a top-insert channel sized to the cable and two screw-down feet. Use for wire management / strain relief. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { cableDia: N('Cable Ø (mm)'), wall: N('Wall thickness (mm, default 2)'), screw: N('Foot screw Ø (mm, default 3)'), width: N('Clip width (mm, default 8)'), componentId: S('Target component id') }, required: ['cableDia'] },
        handler: (i) => { try { return feat(addCableClip(i), `Cable clip Ø${i.cableDia}`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addGridfinityBin',
        description: 'Create a GRIDFINITY storage BIN in ONE call: a bin on the 42mm Gridfinity grid (gridX×gridY units, heightUnits × 7mm tall) with a hollow cavity, a chamfered base foot, and a top stacking lip. v1 approximation of the standard profile. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { gridX: N('Grid units in X (×42mm, default 1)'), gridY: N('Grid units in Y (×42mm, default 1)'), heightUnits: N('Height units (×7mm, default 3)'), wall: N('Wall thickness (mm, default 1.2)'), componentId: S('Target component id') }, required: [] },
        handler: (i) => { try { return feat(addGridfinityBin(i), `Gridfinity ${i.gridX ?? 1}×${i.gridY ?? 1}×${i.heightUnits ?? 3}U`); } catch (e) { return fail(e); } },
    },
    {
        name: 'addTSlotBracket',
        description: 'Create a T-SLOT corner BRACKET in ONE call: an inside-corner L sized to the extrusion series (20/30/40) with a bolt hole on each arm for a T-nut, plus a gusset — to join two pieces of aluminium framing. Pairs with addTSlotExtrusion. Sits on Z=0. mm.',
        input_schema: { type: 'object', properties: { size: N('Extrusion series (20/30/40 mm, default 20)'), thickness: N('Bracket thickness (mm)'), armLength: N('Arm length (mm)'), holeDia: N('Bolt-hole Ø (mm; default from series)'), componentId: S('Target component id') }, required: [] },
        handler: (i) => { try { return feat(addTSlotBracket(i), `T-slot bracket ${i.size ?? 20}`); } catch (e) { return fail(e); } },
    },
];
