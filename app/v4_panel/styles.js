/**
 * Self-contained CSS for the v4 panel — injected once at panel mount so the
 * panel doesn't leak into the global stylesheet or collide with existing
 * `.pf-*` selectors. Class prefix: `pf4-`.
 */

const CSS = `
.pf4-panel {
    /* Docked LEFT sidebar — Fusion 360 Browser style. Pinned to the left
       edge of the viewport area, full height below the app bar + create
       ribbon, fixed width. NOT draggable, NOT floating. The heights
       are tokenized in style.css :root so they don't drift. */
    position: fixed;
    left: 0;
    top:  calc(var(--app-bar-h, 42px) + var(--pf-create-ribbon-h, 64px));
    /* Sit above the timeline strip so they don't overlap. */
    bottom: var(--pf-timeline-h, 56px);
    width: 288px;
    background: rgba(18, 20, 24, 0.98);
    color: #d6d4d0;
    border: 0;
    border-right: 1px solid rgba(255,255,255,0.07);
    border-radius: 0;
    box-shadow: 2px 0 24px rgba(0,0,0,0.45);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    display: flex; flex-direction: column;
    z-index: 50;
    user-select: none;
    pointer-events: auto;
}
.pf4-panel.pf4-hidden {
    transform: translateX(-100%);
    transition: transform 200ms cubic-bezier(0.2,0.7,0.2,1);
}
.pf4-panel:not(.pf4-hidden) {
    transform: translateX(0);
    transition: transform 200ms cubic-bezier(0.2,0.7,0.2,1);
}

.pf4-panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    /* Docked — no drag handle. */
    cursor: default;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    background: linear-gradient(180deg, rgba(255,143,107,0.08), rgba(255,143,107,0));
}
.pf4-panel-title {
    font-weight: 600; letter-spacing: 0.4px; font-size: 11px;
    color: #ff8f6b;
    text-transform: uppercase;
}
.pf4-panel-actions { display: flex; gap: 4px; }
.pf4-panel-actions button {
    background: transparent; color: inherit;
    border: 1px solid rgba(255,255,255,0.1);
    padding: 3px 8px; font-size: 11px; cursor: pointer;
    border-radius: 3px;
}
.pf4-panel-actions button:hover { background: rgba(255,255,255,0.06); }
.pf4-panel-close { font-size: 14px !important; padding: 0 6px !important; }

.pf4-panel-body {
    display: flex; flex-direction: column;
    overflow: hidden; flex: 1; min-height: 0;
}

/* Feature tree --------------------------------------------------------- */
.pf4-tree {
    border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex; flex-direction: column;
    /* Take roughly half of the docked sidebar so the inspector below
       still has room. The :has() selector lets users drag if we ever
       wire a splitter; for now this is the static split. */
    max-height: 45%;
    flex: 0 1 auto;
    overflow: hidden;
}
.pf4-tree-head {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 6px 10px;
    font-size: 10px; letter-spacing: 0.6px;
    color: #8a8682; text-transform: uppercase;
}
.pf4-tree-head-count {
    background: rgba(255,255,255,0.06);
    border-radius: 9px; padding: 0 6px; font-size: 10px;
}
.pf4-tree-rows {
    overflow-y: auto; padding-bottom: 4px;
}

/* Search box --------------------------------------------------------- */
.pf4-tree-search {
    position: relative;
    padding: 4px 10px 6px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
}
.pf4-tree-search-input {
    width: 100%; box-sizing: border-box;
    background: rgba(255,255,255,0.04);
    color: inherit;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 3px;
    padding: 4px 22px 4px 8px;
    font-family: inherit; font-size: 11.5px;
    line-height: 1.3;
}
.pf4-tree-search-input::placeholder {
    color: #6f6c68; font-size: 10.5px;
}
.pf4-tree-search-input:focus {
    outline: none;
    border-color: rgba(255,143,107,0.6);
    background: rgba(255,255,255,0.06);
}
.pf4-tree-search-clear {
    position: absolute;
    top: calc(50% + 1px); right: 14px;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: #8a8682;
    font-size: 16px; line-height: 1;
    width: 16px; height: 16px;
    padding: 0;
    cursor: pointer;
    border-radius: 3px;
}
.pf4-tree-search-clear:hover { color: #ef4444; background: rgba(255,255,255,0.06); }
.pf4-tree-search-clear-hidden { display: none; }

/* Error indicators --------------------------------------------------- */
.pf4-tree-row.pf4-has-error { border-left-color: #ef4444; }
.pf4-err-dot {
    display: inline-block;
    margin-left: 4px;
    background: #ef4444;
    color: #fff;
    font-size: 9px;
    width: 12px; height: 12px;
    line-height: 12px;
    text-align: center;
    border-radius: 50%;
    vertical-align: middle;
    font-weight: 700;
}

/* Right-click context menu ------------------------------------------- */
.pf4-ctx-menu {
    position: fixed;
    /* Context-menu slot (z:600) per style.css "Z-INDEX / STACKING ORDER". */
    z-index: 600;
    min-width: 160px;
    background: rgba(20,22,26,0.98);
    color: #d6d4d0;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    box-shadow: 0 14px 36px rgba(0,0,0,0.6);
    padding: 4px 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    user-select: none;
}
.pf4-ctx-item {
    display: block; width: 100%;
    text-align: left;
    background: transparent; color: inherit;
    border: none;
    padding: 5px 14px;
    font: inherit; cursor: pointer;
}
.pf4-ctx-item:hover { background: rgba(255,143,107,0.14); color: #ffd9c8; }
.pf4-ctx-item.pf4-ctx-danger:hover { background: rgba(239,68,68,0.18); color: #ffd2d2; }

.pf4-tree-empty {
    padding: 16px 12px; color: #707070; font-size: 11px;
    line-height: 1.4; text-align: center;
}
.pf4-tree-row {
    --row-accent: #ff8f6b;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px 6px 8px; cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.1s, border-left-color 0.1s;
    position: relative;
}
.pf4-tree-row:hover {
    background: rgba(255,255,255,0.03);
    border-left-color: color-mix(in srgb, var(--row-accent) 55%, transparent);
}
.pf4-tree-row.pf4-selected {
    background: rgba(255, 143, 107, 0.10);
    border-left-color: var(--row-accent);
}
.pf4-tree-row.pf4-suppressed { opacity: 0.45; }
.pf4-row-text { flex: 1; min-width: 0; }
.pf4-row-name {
    font-size: 12px; line-height: 1.2;
    color: #e9e6e0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pf4-row-type {
    font-size: 9.5px; color: #8a8682; line-height: 1.2;
    text-transform: uppercase; letter-spacing: 0.3px;
    margin-top: 1px;
}
.pf4-icon {
    background: transparent; border: 0; color: #8a8682; cursor: pointer;
    padding: 4px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
}
.pf4-icon:hover { background: rgba(255,255,255,0.06); color: #d6d4d0; }
.pf4-icon-del:hover { color: #ef4444; }
.pf4-eye { opacity: 0.55; }
.pf4-tree-row:hover .pf4-eye { opacity: 1; }
.pf4-tree-row.pf4-suppressed .pf4-eye { opacity: 1; color: #ff8f6b; }

/* Feature visual badge (colored chip wrapping the type glyph) ---------- */
.pf4-fv-badge {
    --fv-color: #a8a29e;
    display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 auto;
    background: color-mix(in srgb, var(--fv-color) 18%, transparent);
    color: var(--fv-color);
    border: 1px solid color-mix(in srgb, var(--fv-color) 45%, transparent);
    border-radius: 4px;
    box-sizing: border-box;
}
.pf4-fv-badge > svg {
    width: 70%; height: 70%; display: block;
}
.pf4-tree-row .pf4-fv-badge {
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 0.15s;
}
.pf4-tree-row.pf4-selected .pf4-fv-badge {
    background: color-mix(in srgb, var(--fv-color) 28%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--fv-color) 22%, transparent);
}

/* Drag-to-reorder visuals --------------------------------------------- */
.pf4-tree-row.pf4-dragging {
    opacity: 0.4;
    background: rgba(255,143,107,0.06);
}
.pf4-tree-row.pf4-drop-above {
    box-shadow: 0 -2px 0 0 #ff8f6b inset, 0 -2px 0 0 #ff8f6b;
}
.pf4-tree-row.pf4-drop-below {
    box-shadow: 0 2px 0 0 #ff8f6b inset, 0 2px 0 0 #ff8f6b;
}
.pf4-tree-row[draggable="true"] { cursor: grab; }
.pf4-tree-row[draggable="true"]:active { cursor: grabbing; }

/* Inspector ----------------------------------------------------------- */
.pf4-insp {
    overflow-y: auto;
    padding-bottom: 8px;
    flex: 1; min-height: 0;
}
.pf4-insp-empty {
    padding: 16px 12px; color: #707070; font-size: 11px;
    line-height: 1.4; text-align: center;
}
.pf4-insp-head {
    padding: 8px 10px 6px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
}
.pf4-insp-head-title {
    font-size: 13px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pf4-insp-head-type {
    font-size: 10px; color: #8a8682;
    text-transform: uppercase; letter-spacing: 0.3px;
    margin-top: 2px;
}
.pf4-insp-head-id {
    font-size: 10px; color: #6f6c68;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    margin-top: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pf4-insp-actions {
    display: flex; gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
}
.pf4-insp-btn {
    background: rgba(255,143,107,0.10);
    border: 1px solid rgba(255,143,107,0.45);
    color: #ffbfa1;
    padding: 4px 10px;
    border-radius: 3px;
    font-size: 10.5px;
    cursor: pointer;
    letter-spacing: 0.4px;
    text-transform: uppercase;
}
.pf4-insp-btn:hover { background: rgba(255,143,107,0.20); }
.pf4-insp-fields { padding: 6px 10px; }
.pf4-field {
    display: grid; grid-template-columns: 90px 1fr;
    align-items: center; gap: 6px;
    margin: 4px 0;
}
.pf4-field-label {
    font-size: 11px; color: #b0aca8;
}
.pf4-field-control {
    display: flex; align-items: center; gap: 4px;
}
.pf4-field-control > input,
.pf4-field-control > select {
    flex: 1; min-width: 0;
    background: rgba(255,255,255,0.04);
    color: inherit;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 3px;
    padding: 4px 6px;
    font-family: inherit; font-size: 11.5px;
}
.pf4-field-control > input:focus,
.pf4-field-control > select:focus {
    outline: none;
    border-color: rgba(255,143,107,0.6);
    background: rgba(255,255,255,0.06);
}
.pf4-field-control > input[type=checkbox] {
    flex: 0; width: 14px; height: 14px;
    accent-color: #ff8f6b;
}
.pf4-field-unit {
    font-size: 10px; color: #8a8682;
    text-transform: uppercase; letter-spacing: 0.3px;
}
.pf4-vec3 {
    display: flex; gap: 3px; width: 100%;
}
.pf4-vec3 input {
    flex: 1; min-width: 0;
    background: rgba(255,255,255,0.04);
    color: inherit;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 3px;
    padding: 4px 6px;
    font-family: inherit; font-size: 11.5px;
}
.pf4-field-error {
    grid-column: 2 / -1;
    font-size: 10px; color: #ef4444;
    min-height: 12px;
}

/* Persistence bar ---------------------------------------------------- */
.pf4-persist-bar {
    display: flex; gap: 4px;
    padding: 6px 10px;
    border-top: 1px solid rgba(255,255,255,0.06);
    background: rgba(0,0,0,0.18);
}
.pf4-persist-bar button {
    flex: 1;
    background: transparent; color: inherit;
    border: 1px solid rgba(255,255,255,0.1);
    padding: 4px 8px; font-size: 10.5px; cursor: pointer;
    border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.pf4-persist-bar button:hover { background: rgba(255,143,107,0.10); border-color: rgba(255,143,107,0.4); }
.pf4-status {
    padding: 4px 10px;
    font-size: 10px; color: #707070;
    min-height: 14px;
    border-top: 1px solid rgba(255,255,255,0.04);
    background: rgba(0,0,0,0.18);
}
.pf4-status.pf4-status-ok    { color: #34d399; }
.pf4-status.pf4-status-error { color: #ef4444; }

/* Parameters section ------------------------------------------------- */
.pf4-params {
    border-bottom: 1px solid rgba(255,255,255,0.06);
    max-height: 30vh; overflow-y: auto;
    background: rgba(0,0,0,0.10);
}
.pf4-param-head {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 6px 10px;
    font-size: 10px; letter-spacing: 0.6px;
    color: #8a8682; text-transform: uppercase;
}
.pf4-param-title { color: #8a8682; }
.pf4-param-add {
    background: transparent; color: #ff8f6b;
    border: 1px solid rgba(255,143,107,0.35);
    padding: 1px 8px; font-size: 10px; cursor: pointer;
    border-radius: 3px;
    letter-spacing: 0.3px;
}
.pf4-param-add:hover { background: rgba(255,143,107,0.10); }
.pf4-param-empty {
    padding: 8px 10px 12px;
    color: #707070; font-size: 11px; font-style: italic;
}
.pf4-param-list {
    display: flex; flex-direction: column;
}
.pf4-param-row {
    display: grid;
    grid-template-columns: 1fr 1fr 40px 20px;
    gap: 4px;
    padding: 3px 8px;
    align-items: center;
}
.pf4-param-row > input {
    background: rgba(255,255,255,0.04);
    color: inherit;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit; font-size: 11px;
    min-width: 0;
}
.pf4-param-row > input:focus {
    outline: none;
    border-color: rgba(255,143,107,0.5);
}
.pf4-param-del {
    background: transparent; color: #707070;
    border: none; cursor: pointer;
    font-size: 14px; padding: 0;
    border-radius: 3px;
}
.pf4-param-del:hover { color: #ef4444; background: rgba(239,68,68,0.08); }

/* Picking / Selection section ------------------------------------- */
.pf4-pick {
    border-bottom: 1px solid rgba(255,255,255,0.06);
    max-height: 22vh; overflow-y: auto;
    background: rgba(0,0,0,0.10);
}
.pf4-pick-head {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 6px 10px;
    font-size: 10px; letter-spacing: 0.6px;
    color: #8a8682; text-transform: uppercase;
}
.pf4-pick-title { color: #8a8682; }
.pf4-pick-clear {
    background: transparent; color: #88e07a;
    border: 1px solid rgba(136,224,122,0.35);
    padding: 1px 8px; font-size: 10px; cursor: pointer;
    border-radius: 3px;
    letter-spacing: 0.3px;
}
.pf4-pick-clear:hover { background: rgba(136,224,122,0.10); }
.pf4-pick-empty {
    padding: 6px 10px 12px;
    color: #707070; font-size: 10.5px; font-style: italic;
}
.pf4-pick-hover {
    padding: 2px 10px 6px;
    color: #707070; font-size: 10.5px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pf4-pick-hover.pf4-pick-hover-live {
    color: #ffd166;
}
.pf4-pick-list {
    display: flex; flex-direction: column;
}
.pf4-pick-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 2px 10px;
    font-size: 11px;
}
.pf4-pick-row:hover { background: rgba(136,224,122,0.05); }
.pf4-pick-label {
    color: #cfcdc8;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pf4-pick-del {
    background: transparent; color: #707070;
    border: none; cursor: pointer;
    font-size: 13px; padding: 0 4px;
    border-radius: 3px;
}
.pf4-pick-del:hover { color: #ef4444; background: rgba(239,68,68,0.08); }

/* Add-Feature menu popup -------------------------------------------- */
.pf4-feature-menu {
    position: fixed;
    min-width: 220px; max-width: 280px;
    max-height: 70vh; overflow-y: auto;
    background: rgba(20, 22, 26, 0.98);
    color: #d6d4d0;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.7);
    padding: 6px 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    user-select: none;
}
.pf4-fm-group {
    padding: 4px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
}
.pf4-fm-group:last-child { border-bottom: none; }
.pf4-fm-heading {
    padding: 4px 12px 2px;
    font-size: 9.5px; letter-spacing: 0.7px;
    color: #ff8f6b; text-transform: uppercase;
    font-weight: 600;
}
.pf4-fm-item {
    display: block; width: 100%;
    text-align: left;
    background: transparent; color: inherit;
    border: none;
    padding: 5px 14px;
    font: inherit; cursor: pointer;
}
.pf4-fm-item:hover:not(:disabled) {
    background: rgba(255,143,107,0.12);
    color: #ffd9c8;
}
.pf4-fm-item:disabled {
    color: #555; cursor: not-allowed;
}

/* ── Prompt modal (pre-feature parameter dialog) ─────────────────────── */
.pf4-prompt-backdrop {
    position: absolute; inset: 0;
    background: rgba(0,0,0,0.46);
    display: flex; align-items: center; justify-content: center;
    -webkit-backdrop-filter: blur(2px);
            backdrop-filter: blur(2px);
}
.pf4-prompt-modal {
    background: rgba(20,22,26,0.98);
    color: #d6d4d0;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 8px;
    box-shadow: 0 18px 48px rgba(0,0,0,0.6);
    min-width: 320px; max-width: 460px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    padding: 16px 18px 14px;
    user-select: none;
}
.pf4-prompt-head { margin-bottom: 12px; }
.pf4-prompt-title {
    font-size: 14px; font-weight: 600;
    color: #ffd9c8; letter-spacing: 0.02em;
}
.pf4-prompt-sub {
    font-size: 11px; color: #9a9690;
    margin-top: 2px;
}
.pf4-prompt-fields {
    display: flex; flex-direction: column;
    gap: 9px;
    margin-bottom: 14px;
}
.pf4-prompt-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: center;
    column-gap: 10px;
    row-gap: 2px;
}
.pf4-prompt-label {
    color: #b9b6b0; font-size: 12px;
}
.pf4-prompt-control {
    display: flex; align-items: center; gap: 6px;
}
.pf4-prompt-control input[type="text"],
.pf4-prompt-control select {
    flex: 1;
    background: rgba(10,10,10,0.4);
    border: 1px solid rgba(255,255,255,0.10);
    color: #f1efeb;
    padding: 4px 7px;
    border-radius: 4px;
    font: inherit;
}
.pf4-prompt-control input[type="text"]:focus,
.pf4-prompt-control select:focus {
    outline: none;
    border-color: #ff8f6b;
}
.pf4-prompt-control input[type="checkbox"] {
    margin: 0;
}
.pf4-prompt-vec3 {
    display: flex; gap: 4px; flex: 1;
}
.pf4-prompt-vec3 input { width: 0; flex: 1; }
.pf4-prompt-unit {
    color: #8a8680; font-size: 11px;
    min-width: 22px;
}
.pf4-prompt-error {
    grid-column: 2 / 3;
    color: #ff7a5c; font-size: 11px;
    min-height: 0;
}
.pf4-prompt-error:empty { display: none; }
.pf4-prompt-foot {
    display: flex; justify-content: flex-end; gap: 8px;
}
.pf4-prompt-foot button {
    background: rgba(255,255,255,0.06);
    color: #d6d4d0;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 4px;
    padding: 5px 14px;
    font: inherit; cursor: pointer;
}
.pf4-prompt-foot button:hover {
    background: rgba(255,255,255,0.10);
}
.pf4-prompt-ok {
    background: rgba(255,143,107,0.22) !important;
    color: #ffd9c8 !important;
    border-color: rgba(255,143,107,0.40) !important;
}
.pf4-prompt-ok:hover {
    background: rgba(255,143,107,0.32) !important;
}
`;

let _injected = false;

/** Inject the panel stylesheet once (idempotent). */
export function ensureStyles(doc = (typeof document !== 'undefined' ? document : null)) {
    if (_injected || !doc) return;
    const style = doc.createElement('style');
    style.id = 'pf4-panel-styles';
    style.textContent = CSS;
    doc.head.appendChild(style);
    _injected = true;
}
