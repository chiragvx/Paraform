/**
 * Stylesheet for the bottom timeline strip. Injected once, idempotent.
 * Class prefix: `pf4-tl-`.
 */

const CSS = `
.pf4-timeline {
    position: fixed;
    bottom: 0;
    /* Left edge aligns with the docked sidebar so the timeline doesn't
       hide behind it. Width respects the docked panel and any docked
       inspector via CSS variables. Height is tokenized in style.css
       :root so the viewport-container's bottom inset stays in sync. */
    left: 0;
    right: 0;
    height: var(--pf-timeline-h, 56px);
    background: rgba(20, 22, 26, 0.92);
    border-top: 1px solid rgba(255,255,255,0.08);
    color: #d6d4d0;
    display: flex; align-items: stretch;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    /* Bottom-chrome slot (z:250) per style.css "Z-INDEX / STACKING ORDER".
       Was 4800 — an ad-hoc tier above almost everything. Brought into the
       documented stack so popovers/modals/toasts overlay cleanly. */
    z-index: 250;
    user-select: none;
    -webkit-backdrop-filter: blur(6px);
            backdrop-filter: blur(6px);
}
.pf4-timeline.pf4-tl-hidden { display: none; }

.pf4-tl-controls {
    display: flex; align-items: center; gap: 2px;
    padding: 0 8px;
    border-right: 1px solid rgba(255,255,255,0.06);
    background: rgba(0,0,0,0.18);
}
.pf4-tl-btn {
    background: transparent;
    border: 1px solid transparent;
    color: #b9b6b0;
    width: 26px; height: 26px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    display: flex; align-items: center; justify-content: center;
    padding: 0;
}
.pf4-tl-btn:hover {
    background: rgba(255,143,107,0.10);
    color: #ffd9c8;
    border-color: rgba(255,143,107,0.30);
}
.pf4-tl-btn:disabled { opacity: 0.35; cursor: default; }
.pf4-tl-btn.pf4-tl-playing { color: #88e07a; }

.pf4-tl-track {
    position: relative;
    flex: 1;
    padding: 6px 16px 6px 12px;
    overflow: hidden;
}
.pf4-tl-rail {
    position: absolute;
    left: 12px; right: 16px; top: 50%;
    height: 2px;
    background: rgba(255,255,255,0.06);
    transform: translateY(-1px);
    pointer-events: none;
}
.pf4-tl-icons {
    position: relative;
    display: flex; align-items: center;
    height: 100%;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0 4px;
    scrollbar-width: thin;
}
.pf4-tl-icons::-webkit-scrollbar { height: 6px; }
.pf4-tl-icons::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }

.pf4-tl-item {
    --tl-color: #a8a29e;
    position: relative;
    flex: 0 0 auto;
    min-width: 58px; max-width: 96px; height: 44px;
    padding: 4px 6px 3px;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    gap: 1px;
    background: color-mix(in srgb, var(--tl-color) 8%, rgba(255,255,255,0.03));
    border: 1px solid color-mix(in srgb, var(--tl-color) 32%, rgba(255,255,255,0.06));
    border-radius: 5px;
    color: #cfcdc8;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s, transform 0.08s;
}
.pf4-tl-item:hover {
    background: color-mix(in srgb, var(--tl-color) 18%, rgba(255,255,255,0.04));
    border-color: color-mix(in srgb, var(--tl-color) 70%, transparent);
    transform: translateY(-1px);
}
.pf4-tl-item.pf4-tl-selected {
    background: color-mix(in srgb, var(--tl-color) 22%, rgba(255,255,255,0.05));
    border-color: var(--tl-color);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--tl-color) 38%, transparent);
}
.pf4-tl-item.pf4-tl-suppressed { opacity: 0.45; }
.pf4-tl-item.pf4-tl-rolled-back {
    /* Features past the playhead are visually muted. */
    opacity: 0.45;
    filter: grayscale(0.6);
    border-style: dashed;
}
.pf4-tl-item.pf4-tl-error {
    border-color: rgba(239,68,68,0.7);
    color: #ffd2d2;
    background: rgba(239,68,68,0.1);
}
.pf4-tl-item[draggable="true"] { cursor: grab; }
.pf4-tl-item[draggable="true"]:active { cursor: grabbing; }
.pf4-tl-item.pf4-tl-dragging {
    opacity: 0.45;
    transform: translateY(-2px);
}
.pf4-tl-item.pf4-tl-drop-before {
    box-shadow: -3px 0 0 #ff8f6b;
}
.pf4-tl-item.pf4-tl-drop-after {
    box-shadow: 3px 0 0 #ff8f6b;
}
.pf4-tl-glyph {
    color: var(--tl-color);
    width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center;
    flex: 0 0 18px;
}
.pf4-tl-glyph svg { width: 100%; height: 100%; }
.pf4-tl-name {
    font-size: 9.5px; line-height: 1.1;
    color: #b9b6b0;
    text-align: center;
    width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    letter-spacing: 0.2px;
}
.pf4-tl-item.pf4-tl-selected .pf4-tl-name { color: #ffe2d4; }
.pf4-tl-item-idx {
    position: absolute;
    top: -4px; right: -4px;
    background: rgba(20,22,26,0.96);
    border: 1px solid color-mix(in srgb, var(--tl-color) 50%, rgba(255,255,255,0.12));
    color: color-mix(in srgb, var(--tl-color) 60%, #cfcdc8);
    font-size: 8.5px;
    line-height: 1;
    border-radius: 7px;
    padding: 1px 4px;
    pointer-events: none;
    font-weight: 600;
}

.pf4-tl-playhead {
    position: absolute;
    top: 4px; bottom: 4px;
    width: 0;
    pointer-events: none;
    z-index: 5;
}
.pf4-tl-playhead-line {
    position: absolute;
    top: 0; bottom: 0;
    left: -1px;
    width: 2px;
    background: #ff8f6b;
    box-shadow: 0 0 8px rgba(255,143,107,0.6);
}
.pf4-tl-playhead-handle {
    position: absolute;
    top: -2px;
    left: -6px;
    width: 12px; height: 12px;
    background: #ff8f6b;
    border-radius: 50%;
    cursor: ew-resize;
    pointer-events: auto;
    box-shadow: 0 0 8px rgba(255,143,107,0.8);
}
.pf4-tl-playhead-tail {
    position: absolute;
    bottom: -2px;
    left: -4px;
    width: 8px; height: 8px;
    background: #ff8f6b;
    border-radius: 50%;
    pointer-events: none;
    opacity: 0.7;
}

.pf4-tl-counter {
    display: flex; align-items: center;
    padding: 0 10px;
    border-left: 1px solid rgba(255,255,255,0.06);
    background: rgba(0,0,0,0.18);
    color: #9a9690;
    font-size: 10.5px;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    white-space: nowrap;
}
.pf4-tl-counter strong { color: #ffd9c8; font-weight: 600; margin-right: 4px; }

/* Tooltip ------------------------------------------------------------ */
.pf4-tl-tooltip {
    position: fixed;
    /* Tooltip slot (z:500) per style.css "Z-INDEX / STACKING ORDER". */
    z-index: 500;
    background: rgba(20,22,26,0.98);
    color: #ffd9c8;
    border: 1px solid rgba(255,143,107,0.35);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    line-height: 1.3;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    pointer-events: none;
    white-space: nowrap;
}
.pf4-tl-tooltip-type {
    color: #9a9690;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
}

/* Context menu (re-uses panel ctx menu styles when both are loaded; this
   is a fallback when the v4 panel isn't mounted). */
.pf4-tl-ctx {
    position: fixed;
    /* Context-menu slot (z:600) per style.css "Z-INDEX / STACKING ORDER". */
    z-index: 600;
    min-width: 180px;
    background: rgba(20,22,26,0.98);
    color: #d6d4d0;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    box-shadow: 0 14px 36px rgba(0,0,0,0.6);
    padding: 4px 0;
    font-size: 12px;
    user-select: none;
}
.pf4-tl-ctx-item {
    display: block; width: 100%; text-align: left;
    background: transparent; color: inherit;
    border: none;
    padding: 5px 14px;
    font: inherit; cursor: pointer;
}
.pf4-tl-ctx-item:hover { background: rgba(255,143,107,0.14); color: #ffd9c8; }
.pf4-tl-ctx-item.pf4-tl-ctx-danger:hover { background: rgba(239,68,68,0.18); color: #ffd2d2; }
.pf4-tl-ctx-sep {
    height: 1px;
    margin: 4px 0;
    background: rgba(255,255,255,0.06);
}
`;

let _injected = false;

export function ensureTimelineStyles(doc = (typeof document !== 'undefined' ? document : null)) {
    if (_injected || !doc) return;
    const style = doc.createElement('style');
    style.id = 'pf4-timeline-styles';
    style.textContent = CSS;
    doc.head.appendChild(style);
    _injected = true;
}
