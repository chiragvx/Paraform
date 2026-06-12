/**
 * Self-contained CSS for the in-viewport sketcher. Prefix: `pf4-sk3d-`.
 * Coexists with the modal sketcher's `.pf4-sk-*` styles.
 */

const CSS = `
.pf4-sk3d-overlay {
    position: absolute;
    pointer-events: none;
    inset: 0;
    z-index: 4800;       /* below the v4 panel (5000) so the panel is reachable */
}
.pf4-sk3d-overlay > * { pointer-events: auto; }

/* Top floating toolbar */
.pf4-sk3d-toolbar {
    position: absolute; top: 12px; left: 50%;
    transform: translateX(-50%);
    display: flex; align-items: center; gap: 6px;
    background: rgba(20, 22, 26, 0.92);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px;
    padding: 6px 10px;
    color: #d6d4d0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    box-shadow: 0 12px 36px rgba(0,0,0,0.55);
    user-select: none;
}
.pf4-sk3d-title {
    font-weight: 600; letter-spacing: 0.4px; font-size: 11px;
    color: #ff8f6b; text-transform: uppercase;
    margin-right: 6px;
}
.pf4-sk3d-sep {
    width: 1px; height: 22px; background: rgba(255,255,255,0.08);
    margin: 0 4px;
}
.pf4-sk3d-tool {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.1);
    color: inherit;
    padding: 4px 9px;
    border-radius: 3px;
    font-size: 11px; letter-spacing: 0.4px;
    cursor: pointer;
    text-transform: uppercase;
}
.pf4-sk3d-tool:hover { background: rgba(255,143,107,0.10); border-color: rgba(255,143,107,0.4); }
.pf4-sk3d-tool.pf4-active {
    background: rgba(255,143,107,0.18);
    border-color: rgba(255,143,107,0.6);
    color: #ffbfa1;
}
.pf4-sk3d-int {
    width: 46px;
    background: rgba(255,255,255,0.04); color: inherit;
    border: 1px solid rgba(255,255,255,0.1);
    padding: 4px 6px; border-radius: 3px;
    font-size: 11px;
}
.pf4-sk3d-num {
    width: 64px;
    background: rgba(255,255,255,0.04); color: inherit;
    border: 1px solid rgba(255,255,255,0.1);
    padding: 4px 6px; border-radius: 3px;
    font-size: 11px;
}
.pf4-sk3d-primary {
    background: linear-gradient(180deg, #ff8f6b 0%, #e6724d 100%);
    border: 1px solid rgba(255,143,107,0.6);
    color: #fff; padding: 5px 14px; border-radius: 3px;
    font-size: 11px; letter-spacing: 0.4px; cursor: pointer;
    text-transform: uppercase; font-weight: 600;
}
.pf4-sk3d-primary:hover { filter: brightness(1.1); }
.pf4-sk3d-secondary {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.15);
    color: #d6d4d0; padding: 5px 12px; border-radius: 3px;
    font-size: 11px; letter-spacing: 0.4px; cursor: pointer;
    text-transform: uppercase;
}
.pf4-sk3d-secondary:hover { background: rgba(255,255,255,0.04); }

/* Live dimension readout (cursor-following) */
.pf4-sk3d-dim {
    position: absolute;
    background: rgba(20, 22, 26, 0.94);
    border: 1px solid rgba(255,143,107,0.55);
    border-radius: 4px;
    padding: 3px 8px;
    color: #ffbfa1;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    display: flex; align-items: center; gap: 6px;
    pointer-events: none;
    box-shadow: 0 6px 16px rgba(0,0,0,0.6);
    white-space: nowrap;
    z-index: 5001;
}
.pf4-sk3d-dim-num   { color: #8a8682; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
.pf4-sk3d-dim-unit  { color: #8a8682; font-size: 10px; }
.pf4-sk3d-dim-sep   { color: #4a4a4a; padding: 0 2px; }

/* Status pill in the bottom-left of the viewport */
.pf4-sk3d-status {
    position: absolute; bottom: 12px; left: 12px;
    background: rgba(20, 22, 26, 0.88);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 4px;
    padding: 4px 10px;
    color: #b0aca8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11px;
    display: flex; gap: 14px;
    pointer-events: none;
    z-index: 4800;
}
.pf4-sk3d-status .pf4-sk3d-dof.pf4-sk3d-bad { color: #ef6b6b; }
.pf4-sk3d-status .pf4-sk3d-dof.pf4-sk3d-good { color: #88e07a; }

/* Dimension input (anchored over the canvas) */
.pf4-sk3d-diminput {
    position: absolute;
    background: rgba(20, 22, 26, 0.98);
    border: 1px solid rgba(255,143,107,0.6);
    border-radius: 4px;
    padding: 3px 8px;
    display: flex; align-items: center; gap: 4px;
    box-shadow: 0 6px 16px rgba(0,0,0,0.6);
    z-index: 5100;
}
.pf4-sk3d-diminput input {
    background: transparent; border: 0; outline: 0;
    color: #ffbfa1; font-size: 13px; width: 70px;
    text-align: right;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.pf4-sk3d-diminput-unit {
    font-size: 10px; color: #8a8682;
    text-transform: uppercase; letter-spacing: 0.4px;
}

/* Constraint panel (left-edge selection-aware buttons) */
.pf4-sk3d-cstr-panel {
    position: absolute; top: 64px; left: 12px;
    display: flex; flex-direction: column; gap: 4px;
    background: rgba(20, 22, 26, 0.92);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px;
    padding: 6px;
    box-shadow: 0 12px 36px rgba(0,0,0,0.55);
    z-index: 4900;
    pointer-events: auto;
    user-select: none;
}
.pf4-sk3d-cstr-btn {
    width: 28px; height: 28px;
    padding: 0; margin: 0;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 3px;
    color: #ffbfa1;
    font-size: 14px;
    line-height: 26px;
    text-align: center;
    cursor: pointer;
}
.pf4-sk3d-cstr-btn:hover:not(:disabled) {
    background: rgba(255,143,107,0.18);
    border-color: rgba(255,143,107,0.6);
}
.pf4-sk3d-cstr-btn:disabled {
    color: #4a4a4a;
    cursor: not-allowed;
    opacity: 0.5;
}

/* Inferred-constraint glyph row (cursor-anchored, while drawing) */
.pf4-sk3d-glyph-row {
    position: absolute;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 3px;
    pointer-events: none;
    z-index: 5050;
    animation: pf4-sk3d-glyph-fade 120ms ease-out both;
}
.pf4-sk3d-glyph {
    height: 16px;
    min-width: 16px;
    padding: 0 5px;
    border-radius: 10px;
    background: #f3bf8e;
    color: #1c1f24;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    letter-spacing: 0.2px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.55);
    user-select: none;
}
.pf4-sk3d-glyph[data-kind="parallel"],
.pf4-sk3d-glyph[data-kind="perpendicular"],
.pf4-sk3d-glyph[data-kind="equal-length"] {
    background: #f7d2a8;     /* softer tint for relational hints */
}
.pf4-sk3d-glyph[data-kind="tangent"],
.pf4-sk3d-glyph[data-kind="coincident"],
.pf4-sk3d-glyph[data-kind="midpoint"] {
    background: #ffb088;     /* warm accent for "snap-based" inferences */
    color: #1c1f24;
}
@keyframes pf4-sk3d-glyph-fade {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: none; }
}

/* Dynamic dimension input (cursor-anchored, while drawing) */
.pf4-sk3d-dyn {
    position: absolute;
    display: flex; flex-direction: row; align-items: center; gap: 4px;
    pointer-events: none;     /* container ignored — fields opt in below */
    z-index: 5080;
    animation: pf4-sk3d-glyph-fade 120ms ease-out both;
}
.pf4-sk3d-dyn-field {
    display: flex; align-items: center; gap: 3px;
    background: rgba(20, 22, 26, 0.96);
    border: 1px solid rgba(255,143,107,0.45);
    border-radius: 4px;
    padding: 2px 6px;
    pointer-events: auto;     /* re-enable so user can click + type */
    box-shadow: 0 4px 12px rgba(0,0,0,0.55);
}
.pf4-sk3d-dyn-field:focus-within {
    border-color: rgba(255,143,107,0.95);
}
.pf4-sk3d-dyn-label {
    color: #8a8682; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.pf4-sk3d-dyn-unit {
    color: #6a6661; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.pf4-sk3d-dyn-field input {
    background: transparent;
    border: 0; outline: 0;
    color: #ffbfa1;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    width: 44px;
    text-align: right;
    padding: 0;
}

/* Constraint badges */
.pf4-sk3d-badges {
    position: absolute; inset: 0;
    pointer-events: none;
    z-index: 4900;
}
.pf4-sk3d-badge {
    position: absolute;
    transform: translate(-50%, -50%);
    width: 18px; height: 18px;
    padding: 0; margin: 0;
    background: rgba(20, 22, 26, 0.92);
    border: 1px solid rgba(255,143,107,0.6);
    border-radius: 50%;
    color: #ffbfa1;
    font-size: 10px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 16px;
    text-align: center;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
    user-select: none;
}
.pf4-sk3d-badge:hover {
    background: rgba(239, 107, 107, 0.18);
    border-color: #ef6b6b;
    color: #fff;
}

/* Constraint badge popover (single-click menu / inline value editor) */
.pf4-sk3d-badge-pop {
    position: absolute;
    z-index: 5000;
    pointer-events: auto;
    background: rgba(20, 22, 26, 0.96);
    border: 1px solid rgba(255,143,107,0.5);
    border-radius: 4px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
    padding: 6px 8px;
    color: #e6e6e6;
    font: 11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-width: 100px;
}
.pf4-sk3d-badge-pop-head {
    color: #ffbfa1;
    font-weight: 600;
    margin-bottom: 4px;
    user-select: none;
}
.pf4-sk3d-badge-pop-row {
    display: flex; align-items: center; gap: 4px;
    margin-bottom: 6px;
}
.pf4-sk3d-badge-pop-row input {
    flex: 1; min-width: 64px;
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(255,143,107,0.4);
    border-radius: 3px;
    color: #fff;
    font: 11px/1.4 monospace;
    padding: 2px 4px;
    outline: none;
}
.pf4-sk3d-badge-pop-row input:focus {
    border-color: #ff8f6b;
}
.pf4-sk3d-badge-pop-unit {
    color: #b5b5b5;
    font-size: 10px;
}
.pf4-sk3d-badge-pop-actions {
    display: flex; justify-content: flex-end;
}
.pf4-sk3d-badge-pop-del {
    background: rgba(239, 107, 107, 0.15);
    border: 1px solid rgba(239, 107, 107, 0.5);
    color: #ffbfa1;
    border-radius: 3px;
    padding: 2px 8px;
    font: 10px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
    cursor: pointer;
}
.pf4-sk3d-badge-pop-del:hover {
    background: rgba(239, 107, 107, 0.35);
    color: #fff;
}
`;

let _injected = false;
export function ensureStyles(doc = (typeof document !== 'undefined' ? document : null)) {
    if (_injected) return;
    // Defensive on the host: tests may install a minimal document stub that
    // doesn't carry `head`. No-op rather than crash so unit tests can keep
    // running without jsdom.
    if (!doc || !doc.head || typeof doc.createElement !== 'function') return;
    const s = doc.createElement('style');
    s.id = 'pf4-sk3d-styles';
    s.textContent = CSS;
    doc.head.appendChild(s);
    _injected = true;
}
