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
