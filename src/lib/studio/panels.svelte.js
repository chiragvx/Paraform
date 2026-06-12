/**
 * Shared collapse state for the studio's docked panels.
 *
 *   left      — the browser / features sidebar (Sidebar.svelte)
 *   inspector — the right-hand properties panel (Inspector.svelte)
 *   chat      — the AI assistant panel (ChatPanel.svelte)
 *
 * `true` = collapsed (rendered as a thin rail with an expand button),
 * `false` = open. State is persisted to localStorage so the chosen layout
 * survives reloads. App.svelte swaps each panel for a <PanelRail/> when its
 * flag is true; each panel's header carries a collapse button that toggles it.
 */

const KEY = 'paraform_panels_v1';

function _load() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch { return null; }
}

const _saved = _load();

export const panels = $state({
  left:      _saved?.left      ?? false,
  inspector: _saved?.inspector ?? false,
  // The AI chat starts collapsed: it was wide by default and crowded the 3D
  // viewport. One click on the rail opens it.
  chat:      _saved?.chat      ?? true,
});

function _persist() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      left: panels.left, inspector: panels.inspector, chat: panels.chat,
    }));
  } catch { /* private mode / quota — non-fatal */ }
}

/** Toggle a panel between open and collapsed. */
export function togglePanel(id) {
  if (id in panels) { panels[id] = !panels[id]; _persist(); }
}

/** Force a panel open (e.g. when an action needs it visible). No-op if open. */
export function openPanel(id) {
  if (id in panels && panels[id]) { panels[id] = false; _persist(); }
}
