/**
 * cloud.js — ParaForm cloud sync module.
 *
 * All Supabase persistence lives here. main.js never calls supabase directly for data.
 * Architecture: local-first. localStorage is the instant-read cache; Supabase is a
 * fire-and-forget mirror. Every export is safe to call when cloud is unconfigured —
 * isCloudEnabled() guards every write/read path.
 */

import { supabase } from './supabase.js';

// ─── Guard ────────────────────────────────────────────────────────────────────

/**
 * Returns true only when Supabase is configured with real credentials.
 * Guards every cloud path so the app works offline / during development.
 */
export function isCloudEnabled() {
    const url = import.meta.env.VITE_SUPABASE_URL || '';
    return url.length > 0 && !url.includes('your-project-id');
}

// ─── Message sanitisation ─────────────────────────────────────────────────────

/**
 * Strip fields that are too large for cloud storage before writing chat messages.
 * rawResponse can be 50–200 KB; thinkingContent is similar; pendingParts carries
 * full SCAD source for every part.  We keep a lightweight pendingPartIds array
 * so the re-apply button still knows which parts changed.
 *
 * Does NOT mutate the original array.
 */
export function sanitiseMessages(messages) {
    return messages.map(msg => {
        if (!msg.meta) return msg;
        const { rawResponse, thinkingContent, pendingParts, ...safeRest } = msg.meta;
        const pendingPartIds = pendingParts?.map(p => p.id);
        return {
            ...msg,
            meta: {
                ...safeRest,
                ...(pendingPartIds?.length ? { pendingPartIds } : {}),
            },
        };
    });
}

// ─── Project CRUD ─────────────────────────────────────────────────────────────

/**
 * Upsert a single project to Supabase (fire-and-forget — caller does not await).
 * @param {string} userId
 * @param {object} project  {id, title, templateId, source, params, parts,
 *                           globalParams, partParams, savedAt}
 */
export async function cloudSaveProject(userId, project) {
    if (!isCloudEnabled() || !userId) return;
    try {
        const { error } = await supabase
            .from('user_projects')
            .upsert(
                {
                    id:           project.id,
                    user_id:      userId,
                    title:        project.title       || 'Untitled Project',
                    template_id:  project.templateId  ?? null,
                    source:       project.source      ?? '',
                    params:       project.params      ?? {},
                    parts:        project.parts       ?? null,
                    global_params: project.globalParams ?? null,
                    part_params:  project.partParams  ?? null,
                    saved_at:     project.savedAt     ?? Date.now(),
                },
                { onConflict: 'id,user_id' }
            );
        if (error) console.warn('[Cloud] Save failed:', error.message);
    } catch (e) {
        console.warn('[Cloud] Save error:', e.message);
    }
}

/**
 * Fetch all projects for a user from Supabase (normalised to camelCase).
 * Returns [] on any failure.
 */
export async function cloudListProjects(userId) {
    if (!isCloudEnabled() || !userId) return [];
    try {
        const { data, error } = await supabase
            .from('user_projects')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false });
        if (error) throw error;
        return (data ?? []).map(row => ({
            id:            row.id,
            title:         row.title,
            templateId:    row.template_id,
            source:        row.source,
            params:        row.params       ?? {},
            parts:         row.parts        ?? null,
            globalParams:  row.global_params ?? null,
            partParams:    row.part_params  ?? null,
            savedAt:       row.saved_at,
            _cloudUpdatedAt: row.updated_at,
        }));
    } catch (e) {
        console.warn('[Cloud] List failed:', e.message);
        return [];
    }
}

/**
 * Delete a project from Supabase (fire-and-forget).
 */
export async function cloudDeleteProject(userId, projectId) {
    if (!isCloudEnabled() || !userId) return;
    try {
        const { error } = await supabase
            .from('user_projects')
            .delete()
            .eq('id', projectId)
            .eq('user_id', userId);
        if (error) console.warn('[Cloud] Delete failed:', error.message);
    } catch (e) {
        console.warn('[Cloud] Delete error:', e.message);
    }
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Reconcile local localStorage projects with cloud projects.
 *
 * Conflict rule: compare savedAt (client epoch ms) — higher value wins.
 *   LOCAL only      → keep; schedule upload (toUpload)
 *   CLOUD only      → pull down (toWriteLocal)
 *   BOTH exist      → newer savedAt wins; if local is newer add to toUpload,
 *                     if cloud is newer add to toWriteLocal
 *   Equal savedAt   → no action on either side
 *
 * Returns:
 *   merged       — the final reconciled project list (write to localStorage)
 *   toUpload     — projects to push to Supabase
 *   toWriteLocal — projects to write into localStorage
 */
export function mergeProjects(local, cloud) {
    const localMap = new Map((local || []).map(p => [p.id, p]));
    const cloudMap = new Map((cloud || []).map(p => [p.id, p]));
    const merged = [];
    const toUpload = [];
    const toWriteLocal = [];

    const allIds = new Set([...localMap.keys(), ...cloudMap.keys()]);
    for (const id of allIds) {
        const lp = localMap.get(id);
        const cp = cloudMap.get(id);

        if (!cp) {
            merged.push(lp);
            toUpload.push(lp);
        } else if (!lp) {
            merged.push(cp);
            toWriteLocal.push(cp);
        } else {
            const localTs = lp.savedAt ?? 0;
            const cloudTs = cp.savedAt ?? 0;
            if (cloudTs > localTs) {
                merged.push(cp);
                toWriteLocal.push(cp);
            } else {
                merged.push(lp);
                if (localTs > cloudTs) toUpload.push(lp);
            }
        }
    }

    merged.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    merged.splice(50); // mirror catalog.js cap

    return { merged, toUpload, toWriteLocal };
}

// ─── Chat session ─────────────────────────────────────────────────────────────

/**
 * Push the current chat session to Supabase (fire-and-forget).
 * Strips heavy fields (rawResponse, thinkingContent, pendingParts) before upload.
 */
export async function cloudSaveChatSession(userId, messages, projectId = null) {
    if (!isCloudEnabled() || !userId) return;
    try {
        const { error } = await supabase
            .from('user_chat_sessions')
            .upsert(
                {
                    user_id:    userId,
                    project_id: projectId,
                    messages:   sanitiseMessages(messages),
                },
                { onConflict: 'user_id' }
            );
        if (error) console.warn('[Cloud] Chat sync failed:', error.message);
    } catch (e) {
        console.warn('[Cloud] Chat sync error:', e.message);
    }
}

/**
 * Fetch the stored chat session for a user. Returns [] on any failure.
 */
export async function cloudLoadChatSession(userId) {
    if (!isCloudEnabled() || !userId) return [];
    try {
        const { data, error } = await supabase
            .from('user_chat_sessions')
            .select('messages')
            .eq('user_id', userId)
            .single();
        if (error) return [];
        return Array.isArray(data?.messages) ? data.messages : [];
    } catch {
        return [];
    }
}
