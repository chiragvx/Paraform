/**
 * Chat store — the AI conversation's home, OUTSIDE any component.
 *
 * ChatPanel mounts/unmounts whenever its panel is toggled (App.svelte:
 * `{#if panels.chat}<ChatPanel/>{/if}`), so any chat state held in the
 * component was destroyed on close — closing the panel wiped the conversation.
 * Moving the transcript, provider history, and the run loop here (a module-level
 * rune store) keeps the chat alive across panel toggles AND across reloads (it
 * persists to localStorage), and lets the user keep / revisit OLD chats.
 *
 * Reactive surface (read by ChatPanel):
 *   chat.items        — display transcript of the active session
 *   chat.history      — provider neutral history for the active session
 *   chat.sessions     — all saved sessions (the "old chats" list source)
 *   chat.currentId    — active session id
 *   chat.running      — a turn is in flight
 *   chat.pendingCount — queued re-steer messages
 *
 * Engine API: submit({text, attachments}), stop(), newSession(), loadSession(id),
 * deleteSession(id), clearCurrent(), sessionList(), ensureHydrated().
 *
 * Persistence note: images are STRIPPED from the localStorage copy (base64 would
 * blow the ~5MB quota) — they survive panel toggles in memory, but a reloaded
 * old chat shows text only. Empty non-active sessions are pruned so the list
 * stays clean.
 */

import { runAgentTurn } from './agent.js';
import { setAttachedImages, clearAttachedImages } from './attachments.js';
import { getAIContext } from './context.js';
import { isCloudEnabled } from '../../../lib/cloud.js';
import { session } from '../auth/session.svelte.js';
import { cloudListChats, cloudUpsertChat, cloudDeleteChat } from '../../../lib/cloud_projects.js';

const LS_KEY = 'paraform.ai.chats.v1';
const MAX_SESSIONS = 40;
const MAX_BYTES = 4_000_000;

export const chat = $state({
    items: [],
    history: [],
    sessions: [],     // [{ id, title, createdAt, updatedAt, items, history }]
    currentId: null,
    running: false,
    pendingCount: 0,
    autoMode: false,  // focus/auto mode: keep going until the goal is complete
});

/** Toggle auto/focus mode (persisted). */
export function setAutoMode(v) { chat.autoMode = !!v; persist(); }

// Non-reactive engine internals.
let controller = null;
let draining = false;
let reSteering = false;
let _pending = [];      // [{ text, images }]
let _saveTimer = null;
let _hydrated = false;

function uid() {
    return 'chat_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

function titleFor(items) {
    const u = (items || []).find((it) => it && it.role === 'user' && it.text && it.text.trim());
    if (u) { const t = u.text.trim().replace(/\s+/g, ' '); return t.length > 48 ? t.slice(0, 48) + '…' : t; }
    return 'New chat';
}

// ── Cloud mirror (local-first; signed-in only) ───────────────────────────────
function _uid() { try { return session.user?.id || null; } catch { return null; } }
function _cloudReady() { return isCloudEnabled() && !!_uid(); }
function _stripItems(items) { return (items || []).map((it) => (it && it.images && it.images.length ? (({ images, ...r }) => r)(it) : it)); }
function _stripHistory(history) { return (history || []).map((h) => (h && h.images ? (({ images, ...r }) => r)(h) : h)); }
function _pushSession(s) {
    if (!_cloudReady() || !s || !s.items || s.items.length === 0) return; // skip empty chats
    cloudUpsertChat(_uid(), {
        id: s.id, title: s.title || titleFor(s.items),
        items: _stripItems(s.items), history: _stripHistory(s.history),
        autoMode: chat.autoMode, documentId: null,
    });
}

/** Write the live items/history into the current session record. */
function syncCurrent() {
    let s = chat.sessions.find((x) => x.id === chat.currentId);
    if (!s) {
        s = { id: chat.currentId || uid(), createdAt: Date.now() };
        chat.currentId = s.id;
        chat.sessions = [s, ...chat.sessions];
    }
    s.items = chat.items;
    s.history = chat.history;
    s.title = titleFor(chat.items);
    s.updatedAt = Date.now();
}

/** Strip image blobs and prune empties for the localStorage copy. */
function serialize() {
    const sessions = chat.sessions
        .filter((s) => s.id === chat.currentId || (s.items && s.items.length))
        .slice(0, MAX_SESSIONS)
        .map((s) => ({
            id: s.id,
            title: s.title || 'New chat',
            createdAt: s.createdAt || Date.now(),
            updatedAt: s.updatedAt || Date.now(),
            items: (s.items || []).map((it) => {
                if (it && it.images && it.images.length) { const { images, ...rest } = it; return rest; }
                return it;
            }),
            history: (s.history || []).map((h) => {
                if (h && h.images) { const { images, ...rest } = h; return rest; }
                return h;
            }),
        }));
    return sessions;
}

function persist() {
    try {
        if (typeof localStorage !== 'undefined') {
            let sessions = serialize();
            const meta = { v: 1, currentId: chat.currentId, autoMode: chat.autoMode };
            let payload = JSON.stringify({ ...meta, sessions });
            // Trim oldest sessions until under the size cap.
            while (payload.length > MAX_BYTES && sessions.length > 1) {
                sessions = sessions.slice(0, -1);
                payload = JSON.stringify({ ...meta, sessions });
            }
            localStorage.setItem(LS_KEY, payload);
        }
    } catch { /* quota / disabled — keep working in-memory */ }
    // Mirror the active chat to the cloud (fire-and-forget; signed-in only).
    try { const cur = chat.sessions.find((s) => s.id === chat.currentId); if (cur) _pushSession(cur); } catch { /* */ }
}

/** Sync the live session and schedule a debounced persist. */
export function markDirty() {
    syncCurrent();
    if (_saveTimer) return;
    if (typeof setTimeout === 'undefined') { persist(); return; }
    _saveTimer = setTimeout(() => { _saveTimer = null; persist(); }, 400);
}

export function ensureHydrated() {
    if (_hydrated) return;
    _hydrated = true;
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data && Array.isArray(data.sessions)) {
                    chat.sessions = data.sessions;
                    chat.currentId = data.currentId || null;
                    chat.autoMode = !!data.autoMode;
                }
            }
        }
    } catch { /* ignore corrupt store */ }
    const cur = chat.sessions.find((s) => s.id === chat.currentId);
    if (cur) { chat.items = cur.items || []; chat.history = cur.history || []; }
    else if (chat.sessions.length) {
        const s = chat.sessions[0];
        chat.currentId = s.id; chat.items = s.items || []; chat.history = s.history || [];
    } else {
        newSession();
    }
}

export function newSession() {
    syncCurrent();
    const cur = chat.sessions.find((s) => s.id === chat.currentId);
    // Don't pile up empty sessions — if the current one is blank, it IS a fresh chat.
    if (cur && (!cur.items || cur.items.length === 0)) { try { getAIContext().reset(); } catch { /* */ } return; }
    const s = { id: uid(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), items: [], history: [] };
    chat.sessions = [s, ...chat.sessions].slice(0, MAX_SESSIONS);
    chat.currentId = s.id;
    chat.items = s.items;
    chat.history = s.history;
    try { getAIContext().reset(); } catch { /* */ }
    try { clearAttachedImages(); } catch { /* */ }
    persist();
}

export function loadSession(id) {
    if (!id || id === chat.currentId) return;
    syncCurrent();
    const s = chat.sessions.find((x) => x.id === id);
    if (!s) return;
    chat.currentId = s.id;
    chat.items = s.items || [];
    chat.history = s.history || [];
    // The design-context memory belongs to a session; reset it on switch so a
    // resumed old chat doesn't inherit another chat's aliases/decisions.
    try { getAIContext().reset(); } catch { /* */ }
    try { clearAttachedImages(); } catch { /* */ }
    markDirty();
}

export function deleteSession(id) {
    chat.sessions = chat.sessions.filter((s) => s.id !== id);
    if (_cloudReady()) cloudDeleteChat(_uid(), id);
    if (id === chat.currentId) {
        if (chat.sessions.length) {
            const s = chat.sessions[0];
            chat.currentId = s.id; chat.items = s.items || []; chat.history = s.history || [];
        } else {
            chat.currentId = null; chat.items = []; chat.history = [];
            newSession();
            return;
        }
    }
    persist();
}

export function clearCurrent() {
    chat.items = [];
    chat.history = [];
    try { clearAttachedImages(); } catch { /* */ }
    try { getAIContext().reset(); } catch { /* */ }
    markDirty();
}

/** Session metadata for the "old chats" list, newest first. */
export function sessionList() {
    return chat.sessions
        .map((s) => ({ id: s.id, title: s.title || 'New chat', updatedAt: s.updatedAt || 0, count: (s.items || []).length }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Cloud pull + merge (call when the chat panel mounts) ─────────────────────
let _cloudSynced = false;
export async function syncCloud(force = false) {
    if (!_cloudReady()) return;
    if (_cloudSynced && !force) return;
    _cloudSynced = true;
    ensureHydrated();
    let cc = [];
    try { cc = await cloudListChats(_uid()); } catch { return; }
    const map = new Map(chat.sessions.map((s) => [s.id, s]));
    for (const c of cc) {
        const l = map.get(c.id);
        if (!l || (c.updatedAt || 0) >= (l.updatedAt || 0)) {
            map.set(c.id, { id: c.id, title: c.title, items: c.items || [], history: c.history || [], createdAt: c.createdAt, updatedAt: c.updatedAt });
        }
    }
    const ccIds = new Set(cc.map((c) => c.id));
    const upLocal = chat.sessions.filter((s) => s.items && s.items.length && !ccIds.has(s.id));
    chat.sessions = [...map.values()];
    // Re-point the working arrays at the (possibly updated) current session.
    const cur = chat.sessions.find((s) => s.id === chat.currentId);
    if (cur) { chat.items = cur.items || []; chat.history = cur.history || []; }
    persist();
    for (const s of upLocal) _pushSession(s);   // migrate local-only chats up
}

// ── Run engine ────────────────────────────────────────────────────────────────

function pushItem(item) { chat.items = [...chat.items, item]; markDirty(); }

function appendAssistantText(text) {
    const last = chat.items[chat.items.length - 1];
    if (last && last.role === 'assistant' && last.streaming) {
        last.text += text;
        chat.items = [...chat.items];
    } else {
        chat.items = [...chat.items, { role: 'assistant', text, streaming: true }];
    }
    markDirty();
}

function finalizeAssistant() {
    const last = chat.items[chat.items.length - 1];
    if (last && last.role === 'assistant' && last.streaming) {
        last.streaming = false;
        chat.items = [...chat.items];
        markDirty();
    }
}

const onEvent = (ev) => {
    switch (ev.type) {
        case 'text': appendAssistantText(ev.text); break;
        case 'tool_call':
            finalizeAssistant();
            pushItem({ role: 'tool', kind: 'call', name: ev.name, input: ev.input });
            break;
        case 'tool_result':
            pushItem({ role: 'tool', kind: 'result', name: ev.name, ok: !(ev.result && ev.result.ok === false), result: ev.result });
            break;
        case 'error':
            finalizeAssistant();
            if (ev.error === 'cancelled' && (reSteering || _pending.length)) break;
            pushItem({ role: 'assistant', error: true, text: ev.error });
            break;
        case 'done': finalizeAssistant(); break;
        // 'usage' — ignored.
    }
};

/**
 * Submit a message. attachments: [{ mediaType, dataBase64, dataUrl }]. While a
 * turn is running this re-steers it (interrupt + queue).
 */
export function submit({ text, attachments } = {}) {
    const t = (text || '').trim();
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!t && !atts.length) return;
    const imgs = atts.map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 })).filter((x) => x.dataBase64);
    const display = atts.map((a) => a.dataUrl).filter(Boolean);
    pushItem({ role: 'user', text: t, images: display });
    _pending.push({ text: t, images: imgs });
    chat.pendingCount = _pending.length;
    if (chat.running && controller) {
        reSteering = true;
        try { controller.abort(); } catch { /* settled */ }
    }
    drain();
}

async function drain() {
    if (draining) return;
    draining = true;
    try {
        while (_pending.length) {
            const job = _pending.shift();
            chat.pendingCount = _pending.length;
            chat.running = true;
            reSteering = false;
            controller = new AbortController();
            try {
                if (job.images && job.images.length) setAttachedImages(job.images);
                const res = await runAgentTurn({ userMessage: job.text, images: job.images, history: chat.history, onEvent, signal: controller.signal, autoMode: chat.autoMode });
                chat.history = res.history || chat.history;
                markDirty();
            } catch (e) {
                if (!(reSteering || _pending.length)) pushItem({ role: 'assistant', error: true, text: (e && e.message) || String(e) });
            } finally {
                finalizeAssistant();
                controller = null;
            }
        }
    } finally {
        draining = false;
        chat.running = false;
        markDirty();
    }
}

export function stop() {
    _pending = [];
    chat.pendingCount = 0;
    if (controller) { try { controller.abort(); } catch { /* settled */ } }
}
