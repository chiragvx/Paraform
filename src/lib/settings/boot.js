import {
  readSettings,
  writeSettings,
  TESSELLATION_DEFLECTION_MM,
} from '../../../app/settings/index.js';
import { getDocumentExecutor } from '../../../lib/document/index.js';

/**
 * Loads persisted settings, applies the side-effect-bearing ones (tessellation
 * deflection on the executor), and returns helpers for the settings dialog.
 *
 * Only a slim subset of the legacy settings surface is wired here — enough
 * for the rebuild's parity. Camera speed, FOV, grid visibility etc. can be
 * piped in later without rewriting this module.
 */
export function loadAndApplySettings() {
  const settings = readSettings();
  applyTessellation(settings.graphics?.tessellationQuality);
  return settings;
}

export function patchSettings(patch) {
  const merged = writeSettings(patch);
  if (patch.graphics?.tessellationQuality) {
    applyTessellation(merged.graphics.tessellationQuality);
  }
  return merged;
}

function applyTessellation(preset) {
  if (!preset) return;
  const mm = TESSELLATION_DEFLECTION_MM[preset];
  if (typeof mm !== 'number') return;
  try { getDocumentExecutor().setTessellationDeflection(mm); }
  catch (e) { console.warn('[settings] tessellation apply failed:', e); }
}

export const TESSELLATION_PRESETS = [
  { value: 'draft',  label: 'Draft (0.20 mm)' },
  { value: 'medium', label: 'Medium (0.05 mm)' },
  { value: 'high',   label: 'High (0.015 mm)' },
  { value: 'ultra',  label: 'Ultra (0.005 mm)' },
];

export const UNIT_PRESETS = [
  { value: 'metric',   label: 'Metric (mm)' },
  { value: 'imperial', label: 'Imperial (in)' },
];
