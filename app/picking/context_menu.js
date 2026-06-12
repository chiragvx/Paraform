/**
 * Right-click context menu for picked entities.
 *
 * Shows when the user right-clicks a face or edge that is already in the
 * selection store. Currently exposes:
 *   - "Select Tangent" (edges only) — walks tangent-connected edges via
 *     lib/picking/tangent.js and adds them to the selection.
 *   - "Select Loop"    (edges only) — TODO; placeholder for future loop walk.
 *
 * The menu is a lightweight floating <div>. It positions at the cursor and
 * dismisses on outside-click, Escape, or scroll.
 */

import { getPickingSelection } from '../../lib/picking/selection.js';
import { selectTangentEdges }  from '../../lib/picking/tangent.js';

let activeMenu = null;

/**
 * Open the context menu at viewport coordinates (clientX/clientY).
 *
 * @param {{clientX:number, clientY:number}} pos
 * @param {object} ref      The ref that was right-clicked.
 * @param {object} ctx      { topology, selection? } — topology used for tangent walk.
 */
export function openContextMenu(pos, ref, ctx = {}) {
    closeContextMenu();
    if (!ref || (ref.kind !== 'edge' && ref.kind !== 'face')) return;
    const selection = ctx.selection || getPickingSelection();
    // Only show menu if the clicked entity is already selected.
    if (!selection.has(ref)) return;

    const menu = document.createElement('div');
    menu.className = 'picking-context-menu';
    Object.assign(menu.style, {
        position: 'fixed',
        left:     `${pos.clientX}px`,
        top:      `${pos.clientY}px`,
        zIndex:   '10000',
        background: '#222',
        color:     '#eee',
        border:    '1px solid #444',
        borderRadius: '4px',
        padding:   '4px 0',
        font:      '12px system-ui, sans-serif',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        minWidth:  '140px',
    });

    const items = [];

    if (ref.kind === 'edge') {
        items.push({
            label: 'Select Tangent',
            onClick: () => {
                const added = selectTangentEdges(ref, ctx.topology);
                if (added.length > 0) selection.addAll(added);
            },
        });
        items.push({
            label: 'Select Loop',
            disabled: true,                       // TODO: implement loop walk
            onClick: () => {},
        });
    } else if (ref.kind === 'face') {
        items.push({
            label: 'Select Tangent Faces',
            disabled: true,                       // TODO: face tangent walk
            onClick: () => {},
        });
    }

    for (const item of items) {
        const el = document.createElement('div');
        el.textContent = item.label;
        Object.assign(el.style, {
            padding:    '6px 12px',
            cursor:     item.disabled ? 'default' : 'pointer',
            opacity:    item.disabled ? '0.4' : '1',
        });
        if (!item.disabled) {
            el.addEventListener('mouseenter', () => { el.style.background = '#333'; });
            el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
            el.addEventListener('click', () => {
                try { item.onClick(); } finally { closeContextMenu(); }
            });
        }
        menu.appendChild(el);
    }

    document.body.appendChild(menu);
    activeMenu = menu;

    // Dismiss handlers
    const onDocClick = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
    const onKey      = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    const onScroll   = () => closeContextMenu();
    setTimeout(() => {
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown',   onKey);
        window.addEventListener('scroll',      onScroll, true);
    }, 0);
    menu._cleanup = () => {
        document.removeEventListener('mousedown', onDocClick);
        document.removeEventListener('keydown',   onKey);
        window.removeEventListener('scroll',      onScroll, true);
    };
}

export function closeContextMenu() {
    if (!activeMenu) return;
    try { activeMenu._cleanup && activeMenu._cleanup(); } catch {}
    if (activeMenu.parentNode) activeMenu.parentNode.removeChild(activeMenu);
    activeMenu = null;
}

export function isContextMenuOpen() {
    return activeMenu !== null;
}
