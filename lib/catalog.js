/**
 * catalog.js — Remote model catalog + local project storage
 *
 * Remote (read-only, from your Supabase public bucket):
 *   <VITE_BUCKET_BASE_URL>/catalog.json          ← lists all templates
 *   Each template entry includes a `scad_url`    ← direct link to the .scad file
 *
 * Local (read-write, browser localStorage only):
 *   paraform_scad_<id>   ← cached SCAD source so repeat opens are instant
 *   paraform_projects    ← all user-saved projects (source + params)
 *   thumbnail_<id>       ← generated/captured preview images
 */

const BUCKET_BASE_URL   = (import.meta.env.VITE_BUCKET_BASE_URL || '').replace(/\/$/, '');
const SCAD_CACHE_PREFIX = 'paraform_scad_';
const PROJECTS_KEY      = 'paraform_projects';

// ── Remote catalog ─────────────────────────────────────────────────────────

/**
 * Fetch catalog.json from the public bucket.
 * Returns an array of template descriptors, or [] if unavailable.
 *
 * Expected catalog.json shape:
 * {
 *   "version": 1,
 *   "templates": [
 *     {
 *       "id": "rugged_box_v1",
 *       "title": "Rugged Utility Box",
 *       "description": "A durable parameterized enclosure.",
 *       "category": "Tech",
 *       "tags": ["box", "enclosure"],
 *       "thumbnail_url": "https://<bucket>/thumbnails/rugged_box.png",
 *       "scad_url": "https://<bucket>/scad/rugged_box_v1.scad",
 *       "ui_parameters": [
 *         { "key": "box_width", "label": "Width", "type": "number",
 *           "min": 40, "max": 150, "step": 1, "default": 80, "unit": "mm" }
 *       ]
 *     }
 *   ]
 * }
 */
export async function fetchCatalog() {
    if (!BUCKET_BASE_URL) {
        console.info('[Catalog] VITE_BUCKET_BASE_URL not set — using built-in defaults.');
        return [];
    }
    try {
        const res = await fetch(`${BUCKET_BASE_URL}/catalog.json`, {
            cache: 'no-cache',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const templates = Array.isArray(json.templates) ? json.templates : [];
        console.info(`[Catalog] Loaded ${templates.length} template(s) from bucket.`);
        return templates;
    } catch (e) {
        console.warn('[Catalog] Could not fetch catalog:', e.message);
        return [];
    }
}

/**
 * Fetch the OpenSCAD source for a template.
 * - If the template already has an inline `source` field, that is returned as-is.
 * - Otherwise the source is downloaded from `template.scad_url`.
 * - Downloaded sources are cached in localStorage so subsequent loads are instant.
 */
export async function fetchScadSource(template) {
    // Inline source (DEFAULT_TEMPLATES / custom scripts)
    if (template.source) return template.source;

    // localStorage cache hit
    const cacheKey = `${SCAD_CACHE_PREFIX}${template.id}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        console.info(`[Catalog] SCAD cache hit for "${template.id}"`);
        return cached;
    }

    // Fetch from bucket
    const url = template.scad_url;
    if (!url) throw new Error(`No scad_url defined for template "${template.id}"`);

    console.info(`[Catalog] Fetching SCAD source: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SCAD fetch failed (HTTP ${res.status})`);
    const source = await res.text();

    try {
        localStorage.setItem(cacheKey, source);
    } catch {
        console.warn('[Catalog] localStorage quota hit — SCAD source not cached.');
    }

    return source;
}

/**
 * Clear the cached SCAD source for a template (forces a fresh download next time).
 */
export function clearScadCache(templateId) {
    localStorage.removeItem(`${SCAD_CACHE_PREFIX}${templateId}`);
}

// ── Local project storage ──────────────────────────────────────────────────

/**
 * Return all locally saved projects, newest first.
 * Each project: { id, title, templateId, source, params, savedAt }
 */
export function listProjects() {
    try {
        return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
    } catch {
        return [];
    }
}

/**
 * Save or update a project in localStorage.
 * Pass { id, title, templateId, source, params }.
 * Returns the saved entry (with `savedAt` timestamp).
 */
export function saveProject({ id, title, templateId, source, params }) {
    const projects = listProjects();
    const idx = projects.findIndex(p => p.id === id);
    const entry = { id, title, templateId, source, params, savedAt: Date.now() };

    if (idx >= 0) {
        projects[idx] = entry;            // update existing
    } else {
        projects.unshift(entry);          // prepend newest
    }

    // Cap history at 50 projects to avoid ballooning storage
    if (projects.length > 50) projects.length = 50;

    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    return entry;
}

/**
 * Remove a project by id.
 */
export function deleteProject(id) {
    const updated = listProjects().filter(p => p.id !== id);
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(updated));
}

/**
 * Load a saved project by id. Returns null if not found.
 */
export function loadProject(id) {
    return listProjects().find(p => p.id === id) || null;
}

// ── Immutable asset & semantic library ─────────────────────────────────────
// updatex.md §3B — Origin Anchor Rule. Assets are read-only, bundled at
// build time via Vite ?raw imports so they're always available offline.

import semanticApiSrc from '../lib/semantic_api.scad?raw';
import fastenersSrc   from '../lib/fasteners.scad?raw';
import assetManifest  from '../assets/index.json';
import sg90Src        from '../assets/servos/sg90.scad?raw';
import mg996rSrc      from '../assets/servos/mg996r.scad?raw';
import bearing608Src  from '../assets/bearings/608zz.scad?raw';
import boltM3x12Src   from '../assets/bolts/m3x12.scad?raw';

// path-on-disk → bundled source text. The path is what `use <…>` resolves to.
const ASSET_SOURCES = {
    'lib/semantic_api.scad':      semanticApiSrc,
    'lib/fasteners.scad':         fastenersSrc,
    'assets/servos/sg90.scad':    sg90Src,
    'assets/servos/mg996r.scad':  mg996rSrc,
    'assets/bearings/608zz.scad': bearing608Src,
    'assets/bolts/m3x12.scad':    boltM3x12Src,
};

// Always available — semantic + fastener libs are auto-included in every compile.
const ALWAYS_INCLUDED = ['lib/semantic_api.scad', 'lib/fasteners.scad'];

export function getAssetManifest() {
    return assetManifest.assets;
}

export function getAssetSource(path) {
    return ASSET_SOURCES[path] || null;
}

/**
 * Parse `// @dependency <path>` comment headers + `use <path>` directives
 * from a SCAD source and return the full transitive closure as
 * `{ path, content }` entries suitable for cad.worker.js's `files` payload.
 *
 * Always includes lib/semantic_api.scad and lib/fasteners.scad.
 * Silently skips dependencies whose source isn't registered.
 */
export function resolveDependencies(source) {
    const seen = new Set();
    const out = [];

    const queue = [...ALWAYS_INCLUDED];

    const headerRe = /^\s*\/\/\s*@dependency\s+([^\s]+)/gm;
    const useRe    = /\buse\s*<\s*([^>]+?)\s*>/g;

    function scanSource(text) {
        let m;
        headerRe.lastIndex = 0;
        while ((m = headerRe.exec(text)) !== null) queue.push(m[1].trim());
        useRe.lastIndex = 0;
        while ((m = useRe.exec(text)) !== null)    queue.push(m[1].trim());
    }

    scanSource(source);

    while (queue.length) {
        const path = queue.shift();
        if (seen.has(path)) continue;
        const content = ASSET_SOURCES[path];
        if (!content) continue; // not a managed asset — skip silently
        seen.add(path);
        out.push({ path, content });
        scanSource(content);
    }

    return out;
}

/**
 * Build the `files` map the cad.worker.js expects (path → content).
 * Wraps resolveDependencies() and folds the array into an object.
 */
export function buildWorkerFiles(source) {
    const deps = resolveDependencies(source);
    const files = {};
    for (const { path, content } of deps) files[path] = content;
    return files;
}
