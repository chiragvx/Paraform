/**
 * Shared, reactive measurement-units state.
 *
 * Keeps a single source of truth for `unit` ('mm' | 'in' | 'cm' | 'm') and
 * `decimals` (number of fractional digits used to format lengths). Every
 * consumer — the HUD, the inspector, the export dialog, the settings panel —
 * reads and writes through this module so a change in one place propagates
 * everywhere reactively.
 *
 * Persistence lives in the existing settings tree under `measurement.units`
 * and `measurement.decimals` via `saveSetting`. `loadUnits()` reads them
 * back at module init.
 */

import { loadAllSettings, saveSetting } from '../settings/schema.js';

/** Reactive units state. */
export const units = $state({ unit: 'mm', decimals: 2 });

/** Conversion factors from millimetres → display unit. */
const MM_TO = {
  mm: 1,
  cm: 0.1,
  m: 0.001,
  in: 1 / 25.4,
};

function clampDecimals(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.max(0, Math.min(6, Math.round(v)));
}

function normalizeUnit(u) {
  return u === 'mm' || u === 'cm' || u === 'm' || u === 'in' ? u : 'mm';
}

/** Load from persisted settings into the reactive state. */
export function loadUnits() {
  try {
    const all = loadAllSettings();
    const m = (all && all.measurement) || {};
    units.unit = normalizeUnit(m.units);
    units.decimals = clampDecimals(m.decimals);
  } catch {
    units.unit = 'mm';
    units.decimals = 2;
  }
}

/** Mutate the unit + persist. */
export function setUnits(unit) {
  const next = normalizeUnit(unit);
  units.unit = next;
  try { saveSetting('measurement', 'units', next); } catch {}
}

/** Mutate the decimals + persist. */
export function setDecimals(n) {
  const next = clampDecimals(n);
  units.decimals = next;
  try { saveSetting('measurement', 'decimals', next); } catch {}
}

/**
 * Format a length given in millimetres into the active display unit, with
 * the active decimals precision and a unit suffix. Returns '—' for null /
 * undefined / NaN.
 */
export function formatLength(mm) {
  if (mm == null || !Number.isFinite(Number(mm))) return '—';
  const factor = MM_TO[units.unit] ?? 1;
  const v = Number(mm) * factor;
  return `${v.toFixed(units.decimals)} ${units.unit}`;
}

/**
 * Format a raw number with the active decimals precision — no unit
 * conversion, no suffix. Useful for HUD coords that already share the
 * scene's natural units.
 */
export function formatNumber(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toFixed(units.decimals);
}

// Hydrate once at module load.
loadUnits();
