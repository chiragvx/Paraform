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
    addPulley, addSprocket, addTSlotExtrusion, addScrewBoss, addStandoff,
} from '../../../lib/document/index.js';
import { N, S, B, feat, fail } from './tools_util.js';

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
];
