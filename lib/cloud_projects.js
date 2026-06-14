/**
 * cloud_projects.js — Supabase persistence for the document library + AI chats.
 *
 * Mirrors lib/cloud.js's contract: LOCAL-FIRST. The browser stores are the
 * instant source of truth (localStorage); these functions are a best-effort
 * cloud mirror so a signed-in user's documents/folders/chats sync across
 * devices. Every export is safe to call when cloud is unconfigured or the user
 * is signed out — isCloudEnabled()/userId guard every path, and nothing throws.
 *
 * IDs are the client-generated TEXT ids (doc_*, fld_*, chat_*) shared by the
 * local store and the cloud row, so there's no id remapping. Tables + RLS are
 * defined in supabase_projects.sql. Server-managed timestamps come back as ISO
 * strings; we surface them as epoch-ms (updatedAt/createdAt) for the stores.
 */

import { supabase } from './supabase.js';
import { isCloudEnabled } from './cloud.js';

function ready(userId) { return isCloudEnabled() && !!userId; }
function ms(iso) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : Date.now(); }

// ── Folders ──────────────────────────────────────────────────────────────────
export async function cloudListFolders(userId) {
    if (!ready(userId)) return [];
    try {
        const { data, error } = await supabase.from('cad_folders').select('*').eq('user_id', userId);
        if (error) throw error;
        return (data ?? []).map((r) => ({ id: r.id, name: r.name, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) }));
    } catch (e) { console.warn('[cloud] listFolders:', e.message || e); return []; }
}
export async function cloudUpsertFolder(userId, folder) {
    if (!ready(userId) || !folder || !folder.id) return;
    try {
        const { error } = await supabase.from('cad_folders')
            .upsert({ id: folder.id, user_id: userId, name: folder.name || 'New folder' }, { onConflict: 'id' });
        if (error) console.warn('[cloud] upsertFolder:', error.message);
    } catch (e) { console.warn('[cloud] upsertFolder:', e.message || e); }
}
export async function cloudDeleteFolder(userId, id) {
    if (!ready(userId) || !id) return;
    try { await supabase.from('cad_folders').delete().eq('id', id).eq('user_id', userId); }
    catch (e) { console.warn('[cloud] deleteFolder:', e.message || e); }
}

// ── Documents ────────────────────────────────────────────────────────────────
export async function cloudListDocuments(userId) {
    if (!ready(userId)) return [];
    try {
        const { data, error } = await supabase.from('cad_documents').select('*').eq('user_id', userId);
        if (error) throw error;
        return (data ?? []).map((r) => ({
            id: r.id, name: r.name, folderId: r.folder_id ?? null,
            json: r.doc, thumb: r.thumb ?? null,
            createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
        }));
    } catch (e) { console.warn('[cloud] listDocuments:', e.message || e); return []; }
}
export async function cloudUpsertDocument(userId, doc) {
    if (!ready(userId) || !doc || !doc.id || !doc.json) return;
    try {
        const { error } = await supabase.from('cad_documents').upsert({
            id: doc.id, user_id: userId, folder_id: doc.folderId ?? null,
            name: doc.name || 'Untitled', doc: doc.json, thumb: doc.thumb ?? null,
        }, { onConflict: 'id' });
        if (error) console.warn('[cloud] upsertDocument:', error.message);
    } catch (e) { console.warn('[cloud] upsertDocument:', e.message || e); }
}
export async function cloudDeleteDocument(userId, id) {
    if (!ready(userId) || !id) return;
    try { await supabase.from('cad_documents').delete().eq('id', id).eq('user_id', userId); }
    catch (e) { console.warn('[cloud] deleteDocument:', e.message || e); }
}

// ── AI chats ─────────────────────────────────────────────────────────────────
export async function cloudListChats(userId) {
    if (!ready(userId)) return [];
    try {
        const { data, error } = await supabase.from('ai_chats').select('*').eq('user_id', userId);
        if (error) throw error;
        return (data ?? []).map((r) => ({
            id: r.id, title: r.title, documentId: r.document_id ?? null,
            items: Array.isArray(r.items) ? r.items : [],
            history: Array.isArray(r.history) ? r.history : [],
            autoMode: !!r.auto_mode,
            createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
        }));
    } catch (e) { console.warn('[cloud] listChats:', e.message || e); return []; }
}
export async function cloudUpsertChat(userId, chat) {
    if (!ready(userId) || !chat || !chat.id) return;
    try {
        const { error } = await supabase.from('ai_chats').upsert({
            id: chat.id, user_id: userId, document_id: chat.documentId ?? null,
            title: chat.title || 'New chat',
            items: chat.items ?? [], history: chat.history ?? [],
            auto_mode: !!chat.autoMode,
        }, { onConflict: 'id' });
        if (error) console.warn('[cloud] upsertChat:', error.message);
    } catch (e) { console.warn('[cloud] upsertChat:', e.message || e); }
}
export async function cloudDeleteChat(userId, id) {
    if (!ready(userId) || !id) return;
    try { await supabase.from('ai_chats').delete().eq('id', id).eq('user_id', userId); }
    catch (e) { console.warn('[cloud] deleteChat:', e.message || e); }
}
