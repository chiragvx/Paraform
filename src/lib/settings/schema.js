/**
 * Settings schema — the source of truth for the SettingsDialog UI.
 *
 * Each entry describes one panel: an id (matches the panel component +
 * dialog nav), a human label, an icon name (resolved by the dialog), and a
 * default values object whose keys define what each panel renders.
 *
 * Persistence is delegated to `app/settings/index.js` — we hold the per-key
 * value at `settings.<panelId>.<key>` inside the existing
 * `paraform_app_settings` localStorage blob so it composes with the rest of
 * the app's settings tree.
 */

import { readSettings, writeSettings } from '../../../app/settings/index.js';
import { V1 } from '../flags.js';

/**
 * Full schema — every panel the app knows about, including ones hidden for
 * the v1 launch. Persistence (loadAllSettings / saveSetting / reset) runs
 * over THIS list so stored values for hidden panels keep round-tripping.
 */
const FULL_SETTINGS_SCHEMA = [
  {
    id: 'general',
    label: 'General',
    icon: 'Settings',
    defaults: {
      theme: 'dark',
      launchView: 'restore',
    },
    fields: [
      {
        key: 'theme',
        label: 'Theme',
        kind: 'select',
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'System' },
        ],
      },
      {
        key: 'launchView',
        label: 'Launch view',
        kind: 'select',
        options: [
          { value: 'restore', label: 'Restore last session' },
          { value: 'landing', label: 'Landing' },
          { value: 'library', label: 'Library' },
        ],
      },
    ],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: 'Keyboard',
    defaults: {},
    fields: [],
  },
  {
    id: 'markingMenu',
    label: 'Marking Menu',
    icon: 'Sparkles',
    defaults: {},
    fields: [],
  },
  {
    id: 'viewport',
    label: 'Viewport',
    icon: 'Monitor',
    defaults: {
      background: 'gradient',
      showGrid: true,
      gridSize: 10,
      showAxes: true,
      fov: 50,
    },
    fields: [
      {
        key: 'background',
        label: 'Background',
        kind: 'select',
        options: [
          { value: 'gradient', label: 'Gradient' },
          { value: 'default', label: 'Default' },
          { value: 'black', label: 'Black' },
          { value: 'gray', label: 'Gray' },
          { value: 'blue', label: 'Blue' },
        ],
      },
      { key: 'showGrid', label: 'Show grid', kind: 'boolean' },
      { key: 'gridSize', label: 'Grid size', kind: 'number', min: 1, max: 1000, step: 1 },
      { key: 'showAxes', label: 'Show axes', kind: 'boolean' },
      { key: 'fov', label: 'Field of view', kind: 'number', min: 20, max: 120, step: 1 },
    ],
  },
  {
    id: 'camera',
    label: 'Camera',
    icon: 'Camera',
    defaults: {
      orbitSpeed: 1.0,
      zoomSpeed: 1.0,
      panSpeed: 1.0,
      damping: 0.08,
      invertY: false,
      autoFit: true,
    },
    fields: [
      { key: 'orbitSpeed', label: 'Orbit speed', kind: 'number', min: 0.1, max: 5, step: 0.1 },
      { key: 'zoomSpeed', label: 'Zoom speed', kind: 'number', min: 0.1, max: 5, step: 0.1 },
      { key: 'panSpeed', label: 'Pan speed', kind: 'number', min: 0.1, max: 5, step: 0.1 },
      { key: 'damping', label: 'Damping', kind: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'invertY', label: 'Invert Y axis', kind: 'boolean' },
      { key: 'autoFit', label: 'Auto-fit on compile', kind: 'boolean' },
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'Cpu',
    defaults: {
      autoRecompileMs: 250,
      workerThreads: 2,
    },
    fields: [
      { key: 'autoRecompileMs', label: 'Auto-recompile delay (ms)', kind: 'number', min: 0, max: 5000, step: 50 },
      { key: 'workerThreads', label: 'Worker threads', kind: 'number', min: 1, max: 16, step: 1 },
    ],
  },
  {
    id: 'graphics',
    label: 'Graphics',
    icon: 'Sparkles',
    defaults: {
      tessellationQuality: 'medium',
      antiAliasing: true,
      edgeThickness: 1.0,
      devicePixelRatio: 'auto',
    },
    fields: [
      {
        key: 'tessellationQuality',
        label: 'Tessellation quality',
        kind: 'select',
        options: [
          { value: 'draft', label: 'Draft (0.20 mm)' },
          { value: 'medium', label: 'Medium (0.05 mm)' },
          { value: 'high', label: 'High (0.015 mm)' },
          { value: 'ultra', label: 'Ultra (0.005 mm)' },
        ],
      },
      { key: 'antiAliasing', label: 'Anti-aliasing', kind: 'boolean' },
      { key: 'edgeThickness', label: 'Edge thickness', kind: 'number', min: 0.25, max: 5, step: 0.25 },
      {
        key: 'devicePixelRatio',
        label: 'Device pixel ratio',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: '1', label: '1x' },
          { value: '2', label: '2x' },
          { value: '3', label: '3x' },
        ],
      },
    ],
  },
  {
    id: 'measurement',
    label: 'Measurement',
    icon: 'Ruler',
    defaults: {
      units: 'mm',
      decimals: 2,
    },
    fields: [
      {
        key: 'units',
        label: 'Units',
        kind: 'select',
        options: [
          { value: 'mm', label: 'Millimeters (mm)' },
          { value: 'cm', label: 'Centimeters (cm)' },
          { value: 'm', label: 'Meters (m)' },
          { value: 'in', label: 'Inches (in)' },
        ],
      },
      { key: 'decimals', label: 'Decimal places', kind: 'number', min: 0, max: 6, step: 1 },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    icon: 'Download',
    defaults: {
      defaultFormat: 'stl',
      stlBinary: true,
      filenamePattern: '{name}_{date}',
    },
    fields: [
      {
        key: 'defaultFormat',
        label: 'Default format',
        kind: 'select',
        options: [
          { value: 'stl', label: 'STL' },
          { value: 'step', label: 'STEP' },
          // glTF/3MF/OBJ export is not implemented in the kernel exporter
          // (lib/document/exporter.js FILE_EXTENSIONS) — hidden for v1.
          ...(V1
            ? []
            : [
                { value: 'glb', label: 'glTF (GLB)' },
                { value: '3mf', label: '3MF' },
                { value: 'obj', label: 'OBJ' },
              ]),
        ],
      },
      // stlBinary has no consumer in the exporter (always binary) — field removed.
      { key: 'filenamePattern', label: 'Filename pattern', kind: 'text' },
    ],
  },
  {
    id: 'ai',
    label: 'AI Assistant',
    icon: 'Sparkles',
    defaults: {
      provider: 'openai',
      openaiModel: 'openai/gpt-oss-120b:free',
      geminiModel: 'gemini-2.5-flash',
      maxTokens: 32768,
      // Bring-your-own keys. Stored locally in this browser and sent to YOUR
      // kernel proxy, which uses them in place of its server env keys. Leave
      // blank to fall back to the server-configured key.
      openaiApiKey: '',
      openaiBaseUrl: '',
      geminiApiKey: '',
    },
    fields: [
      {
        key: 'provider',
        label: 'Provider',
        kind: 'select',
        options: [
          { value: 'openai', label: 'OpenRouter / OpenAI-compatible (default)' },
          { value: 'gemini', label: 'Google Gemini direct' },
        ],
      },
      {
        key: 'openaiModel',
        label: 'Model',
        kind: 'select',
        options: [
          { value: 'openai/gpt-oss-120b:free', label: 'openai/gpt-oss-120b:free' },
        ],
      },
      { key: 'openaiApiKey', label: 'OpenRouter API key', kind: 'secret', placeholder: 'sk-or-v1-… (paste from openrouter.ai/keys)' },
      { key: 'openaiBaseUrl', label: 'Host base URL (advanced)', kind: 'text', placeholder: 'leave blank for OpenRouter — e.g. https://api.groq.com/openai/v1' },
      {
        key: 'geminiModel',
        label: 'Gemini model',
        kind: 'select',
        options: [
          { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
          { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
          { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
        ],
      },
      { key: 'geminiApiKey', label: 'Gemini API key', kind: 'secret', placeholder: 'AIza… (stored in this browser)' },
      { key: 'maxTokens', label: 'Max output tokens', kind: 'number', min: 256, max: 500000, step: 256 },
    ],
  },
  {
    id: 'manufacturing',
    label: 'Manufacturing',
    icon: 'Factory',
    defaults: {
      profile: '3d-print',
      customThresholds: { minWallMm: null, minHoleMm: null },
      invariantShowPasses: false,
    },
    fields: [],
  },
  {
    id: 'presets',
    label: 'Presets',
    icon: 'Bookmark',
    defaults: {},
    fields: [],
  },
];

/** Panels hidden behind the v1 launch flag (code retained, UI gated). */
// 'performance' panel holds only autoRecompileMs + workerThreads, neither of
// which has a consumer yet — hide it in v1 rather than show dead controls.
const V1_HIDDEN_PANELS = new Set(['manufacturing', 'markingMenu', 'shortcuts', 'performance']);

/**
 * The UI-facing schema — the single choke point the settings dialog, nav,
 * search, and per-panel components all consume. Under V1, non-hero panels
 * are filtered out here; persistence below still uses the full schema so
 * stored values for hidden panels are preserved (just not shown).
 */
export const SETTINGS_SCHEMA = V1
  ? FULL_SETTINGS_SCHEMA.filter((p) => !V1_HIDDEN_PANELS.has(p.id))
  : FULL_SETTINGS_SCHEMA;

/** Quick lookup by panel id (full schema — persistence must not break). */
const BY_ID = Object.fromEntries(FULL_SETTINGS_SCHEMA.map((p) => [p.id, p]));

/** Build the in-memory settings tree from defaults + persisted store. */
export function loadAllSettings() {
  const stored = readSettings();
  const out = {};
  for (const panel of FULL_SETTINGS_SCHEMA) {
    const persisted = stored?.[panel.id];
    out[panel.id] = { ...panel.defaults, ...(persisted && typeof persisted === 'object' ? persisted : {}) };
  }
  return out;
}

/** Persist one field — `settings.<panelId>.<key> = value`. */
export function saveSetting(panelId, key, value) {
  if (!BY_ID[panelId]) return;
  writeSettings({ [panelId]: { [key]: value } });
}

/** Convenience: write the defaults for every panel (factory reset). */
export function resetAllSettings() {
  const patch = {};
  for (const panel of FULL_SETTINGS_SCHEMA) {
    patch[panel.id] = { ...panel.defaults };
  }
  writeSettings(patch);
}

export function getPanelDefaults(panelId) {
  return BY_ID[panelId] ? { ...BY_ID[panelId].defaults } : {};
}
