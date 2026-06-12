/**
 * catalog.js — Local project storage (post-OpenSCAD).
 *
 * Phase 1 (kill OpenSCAD) — the asset-loading and SCAD-cache machinery has
 * been excised. Only browser-local project save/load remains. The component
 * catalog (servos, motors, boards, etc.) will be reborn in Phase 5 as a
 * Supabase-backed catalog of build123d component classes.
 */

const PROJECTS_KEY = 'paraform_projects';

// ── Local project storage ──────────────────────────────────────────────────

export function listProjects() {
    try {
        return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
    } catch {
        return [];
    }
}

export function saveProject({ id, title, templateId, source, params }) {
    const projects = listProjects();
    const idx = projects.findIndex(p => p.id === id);
    const entry = { id, title, templateId, source, params, savedAt: Date.now() };
    if (idx >= 0) projects[idx] = entry;
    else projects.unshift(entry);
    if (projects.length > 50) projects.length = 50;
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    return entry;
}

export function deleteProject(id) {
    const updated = listProjects().filter(p => p.id !== id);
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(updated));
}

export function loadProject(id) {
    return listProjects().find(p => p.id === id) || null;
}
