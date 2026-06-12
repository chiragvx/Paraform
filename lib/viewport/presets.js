/**
 * Navigation presets — mappings from {button, modifier} → action.
 *
 * Pick one preset at controller construction; the controller uses the
 * resulting table to decide whether a pointer-down starts an orbit, pan,
 * or zoom drag.
 *
 * Actions:
 *   'orbit' | 'pan' | 'zoom' | null
 *
 * Buttons: 0 = LMB, 1 = MMB, 2 = RMB
 *
 * Modifiers checked in priority order: 'shift' > 'ctrl' > 'alt' > 'plain'.
 * The first row whose button + modifier matches wins.
 */

/** @typedef {{ button: number, mod: 'plain'|'shift'|'ctrl'|'alt', action: 'orbit'|'pan'|'zoom' }} Mapping */

/** @type {Mapping[]} */
const SOLIDWORKS = [
    { button: 1, mod: 'ctrl',  action: 'pan'   },
    { button: 1, mod: 'shift', action: 'zoom'  },
    { button: 1, mod: 'plain', action: 'orbit' },
];

/** @type {Mapping[]} */
const FUSION = [
    { button: 1, mod: 'shift', action: 'orbit' },
    { button: 1, mod: 'ctrl',  action: 'zoom'  },
    { button: 1, mod: 'plain', action: 'pan'   },
];

/** @type {Mapping[]} */
const ONSHAPE = [
    { button: 2, mod: 'ctrl',  action: 'pan'   },
    { button: 2, mod: 'plain', action: 'orbit' },
    { button: 1, mod: 'plain', action: 'pan'   },
];

/** @type {Mapping[]} */
const BLENDER = [
    { button: 1, mod: 'shift', action: 'pan'   },
    { button: 1, mod: 'ctrl',  action: 'zoom'  },
    { button: 1, mod: 'plain', action: 'orbit' },
];

export const NAV_PRESETS = Object.freeze({
    solidworks: SOLIDWORKS,
    fusion:     FUSION,
    onshape:    ONSHAPE,
    blender:    BLENDER,
});

export const DEFAULT_PRESET = 'solidworks';

/**
 * Resolve `event.button + event.modifiers` to one of {orbit, pan, zoom, null}.
 * Returns `null` when no row matches (the controller leaves the event alone).
 */
export function resolveAction(preset, event) {
    const table = NAV_PRESETS[preset] || NAV_PRESETS[DEFAULT_PRESET];
    const mod   = event.shiftKey ? 'shift'
                : event.ctrlKey  ? 'ctrl'
                : event.altKey   ? 'alt'
                : 'plain';
    // Exact (button + modifier) match first.
    for (const row of table) {
        if (row.button === event.button && row.mod === mod) return row.action;
    }
    // Fall back to a plain-modifier row on the same button if a modifier was
    // held but the table doesn't cover that combination — keeps things from
    // feeling broken when the user happens to be holding Alt.
    for (const row of table) {
        if (row.button === event.button && row.mod === 'plain') return row.action;
    }
    return null;
}

export function listPresets() { return Object.keys(NAV_PRESETS); }
