/**
 * ISO 286 fit-class band lookup + ISO 273 clearance-hole table.
 *
 * Mirrors the data from:
 *   b123d_server/standard_parts/iso_fits.json            (ISO 286-2 bands)
 *   b123d_server/standard_parts/iso_metric_clearance.json (ISO 273 holes)
 *
 * Data is duplicated as JS literals here so the DFM check library can run
 * in a plain Node test without a kernel HTTP round-trip. Keep this file in
 * sync with the JSON tables — they're the source of truth.
 *
 * Units in BANDS are micrometers (deviation from nominal). Conversion to
 * millimeters is done in `fitBand`. CLEARANCE_HOLES are already in mm.
 */

// ── ISO 286-2 deviation tables (µm) ─────────────────────────────────────────
//
// Each band is { upper, lower } in micrometers, relative to nominal.
// For HOLE classes (H7), the deviation is positive (the bore can grow).
// For SHAFT classes (g6/h6/k6), the deviation sign tells you whether the
// shaft is undersized (clearance), zero-line (line-to-line), or oversized
// (interference).
//
// Size-range keys are strings 'min-max' (mm). The convention follows
// iso_fits.json: range is `min < d <= max` (so 18 is in '10-18', 30 in
// '18-30' — that's how ISO 286 publishes them).

export const BANDS = {
    'H7': {
        '3-6':    { upper:  12, lower: 0 },
        '6-10':   { upper:  15, lower: 0 },
        '10-18':  { upper:  18, lower: 0 },
        '18-30':  { upper:  21, lower: 0 },
        '30-50':  { upper:  25, lower: 0 },
        '50-80':  { upper:  30, lower: 0 },
        '80-120': { upper:  35, lower: 0 },
    },
    'g6': {
        '3-6':    { upper:  -4, lower: -12 },
        '6-10':   { upper:  -5, lower: -14 },
        '10-18':  { upper:  -6, lower: -17 },
        '18-30':  { upper:  -7, lower: -20 },
        '30-50':  { upper:  -9, lower: -25 },
        '50-80':  { upper: -10, lower: -29 },
        '80-120': { upper: -12, lower: -34 },
    },
    'h6': {
        '3-6':    { upper:   0, lower:  -8 },
        '6-10':   { upper:   0, lower:  -9 },
        '10-18':  { upper:   0, lower: -11 },
        '18-30':  { upper:   0, lower: -13 },
        '30-50':  { upper:   0, lower: -16 },
        '50-80':  { upper:   0, lower: -19 },
        '80-120': { upper:   0, lower: -22 },
    },
    'k6': {
        '3-6':    { upper:   9, lower:  1 },
        '6-10':   { upper:  10, lower:  1 },
        '10-18':  { upper:  12, lower:  1 },
        '18-30':  { upper:  15, lower:  2 },
        '30-50':  { upper:  18, lower:  2 },
        '50-80':  { upper:  21, lower:  2 },
        '80-120': { upper:  25, lower:  3 },
    },
};

const SIZE_RANGES = [
    { key: '3-6',    min: 3,  max: 6   },
    { key: '6-10',   min: 6,  max: 10  },
    { key: '10-18',  min: 10, max: 18  },
    { key: '18-30',  min: 18, max: 30  },
    { key: '30-50',  min: 30, max: 50  },
    { key: '50-80',  min: 50, max: 80  },
    { key: '80-120', min: 80, max: 120 },
];

/**
 * Get the ISO 286 size-range key for a nominal diameter in mm.
 *
 * Range is `min < d <= max` (per ISO convention). Diameters outside the
 * tabulated 3–120 mm window clamp to the nearest end so callers can still
 * get a defensive answer — the check function should report the clamp.
 *
 * @param {number} nominalMm
 * @returns {string}  e.g. '18-30'
 */
export function sizeRange(nominalMm) {
    const d = Number(nominalMm);
    if (!Number.isFinite(d)) return SIZE_RANGES[0].key;
    if (d <= SIZE_RANGES[0].min) return SIZE_RANGES[0].key;
    const last = SIZE_RANGES[SIZE_RANGES.length - 1];
    if (d > last.max) return last.key;
    for (const r of SIZE_RANGES) {
        if (d > r.min && d <= r.max) return r.key;
    }
    return last.key;
}

/**
 * Return `true` if `nominalMm` is outside the tabulated 3..120 mm window.
 * The check functions surface this as a warning so the user knows the
 * band was clamped.
 */
export function isOutOfTabulatedRange(nominalMm) {
    const d = Number(nominalMm);
    if (!Number.isFinite(d)) return true;
    return d <= SIZE_RANGES[0].min || d > SIZE_RANGES[SIZE_RANGES.length - 1].max;
}

/**
 * Compose a paired fit class (e.g. 'H7/g6') into the effective
 * clearance band, in millimeters.
 *
 * For a hole-basis paired class `H/s`, the effective clearance range is:
 *
 *   clearance_max = hole_upper - shaft_lower
 *   clearance_min = hole_lower - shaft_upper
 *
 * (i.e. largest hole minus smallest shaft, smallest hole minus largest
 * shaft). Positive = running clearance, negative = interference.
 *
 * @param {string} fitClass  e.g. 'H7/g6'
 * @param {number} nominalMm  e.g. 22
 * @returns {{
 *   class: string, nominalMm: number, sizeRange: string,
 *   holeBand: {upper:number, lower:number},
 *   shaftBand: {upper:number, lower:number},
 *   clearanceMin: number, clearanceMax: number, bandWidthMm: number,
 *   outOfRange: boolean
 * } | null}  null if `fitClass` is malformed / unknown.
 */
export function fitBand(fitClass, nominalMm) {
    if (typeof fitClass !== 'string' || !fitClass.includes('/')) return null;
    const [holeClass, shaftClass] = fitClass.split('/').map((s) => s.trim());
    const holeTable  = BANDS[holeClass];
    const shaftTable = BANDS[shaftClass];
    if (!holeTable || !shaftTable) return null;

    const range = sizeRange(nominalMm);
    const holeBand  = holeTable[range];
    const shaftBand = shaftTable[range];
    if (!holeBand || !shaftBand) return null;

    // Effective clearance range in micrometers.
    const clearanceMaxUm = holeBand.upper - shaftBand.lower;
    const clearanceMinUm = holeBand.lower - shaftBand.upper;

    // Convert µm → mm.
    const clearanceMin = clearanceMinUm / 1000;
    const clearanceMax = clearanceMaxUm / 1000;
    const bandWidthMm  = (clearanceMaxUm - clearanceMinUm) / 1000;

    return {
        class: fitClass,
        nominalMm: Number(nominalMm),
        sizeRange: range,
        holeBand,
        shaftBand,
        clearanceMin,
        clearanceMax,
        bandWidthMm,
        outOfRange: isOutOfTabulatedRange(nominalMm),
    };
}

// ── ISO 273 clearance-hole table (mm) ───────────────────────────────────────
//
// Mirrored from iso_metric_clearance.json. Keys are the metric thread
// nominal (the number after the 'M', as a string for exact lookup), and
// each entry has close/medium/loose hole diameters in mm.

export const CLEARANCE_HOLES = {
    '3':  { close: 3.2,  medium: 3.4,  loose: 3.6  },
    '4':  { close: 4.3,  medium: 4.5,  loose: 4.8  },
    '5':  { close: 5.3,  medium: 5.5,  loose: 5.8  },
    '6':  { close: 6.4,  medium: 6.6,  loose: 7.0  },
    '8':  { close: 8.4,  medium: 9.0,  loose: 10.0 },
    '10': { close: 10.5, medium: 11.0, loose: 12.0 },
    '12': { close: 13.0, medium: 14.0, loose: 15.0 },
    '16': { close: 17.0, medium: 18.0, loose: 19.0 },
};

/**
 * Look up clearance-hole diameters for a metric thread nominal.
 *
 * Accepts either a number (3, 3.0) or a string ('3', 'M3', 'm3').
 *
 * @param {number|string} threadNominal
 * @returns {{close:number, medium:number, loose:number} | null}
 */
export function clearanceHoles(threadNominal) {
    if (threadNominal == null) return null;
    let key = String(threadNominal).trim().toUpperCase();
    if (key.startsWith('M')) key = key.slice(1);
    // Normalise '3.0' → '3' so the table key matches.
    const n = Number(key);
    if (Number.isFinite(n) && Number.isInteger(n)) key = String(n);
    return CLEARANCE_HOLES[key] || null;
}
