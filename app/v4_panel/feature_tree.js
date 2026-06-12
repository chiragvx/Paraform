/**
 * Feature Tree — sidebar list of every v4 feature in the active document.
 *
 * Renders inside a host DOM element. Subscribes to a DocumentStore and
 * rebuilds on every commit. Each row shows the feature's display name,
 * type label, and three affordances:
 *   - eye toggle  → suppress / unsuppress (commits a `set-enabled` change)
 *   - select      → highlights the row, sets `store._selectedFeatureId`,
 *                   notifies the inspector via the `onSelect` callback
 *   - delete      → commits a `remove-feature` change
 *
 * Header also exposes an Onshape-style search box with `:type`, `:errors`,
 * `:suppressed`, `:variable` prefix filters — see `./search.js`. Esc or the
 * inline ✕ clear the query.
 *
 * Right-click on a row opens a small context menu (Edit / Rename / Suppress /
 * Delete). Double-click opens the same edit dialog as Edit Feature.
 *
 * Pure DOM; no framework. Styles are applied via class names whose CSS
 * lives in `app/v4_panel/styles.js`.
 */

import { typeLabel } from './schemas.js';
import { parseSearch, matchFeature } from './search.js';
import { typeBadgeHtml, colorForType } from './feature_visuals.js';

export class FeatureTree {
    /**
     * @param {HTMLElement} host
     * @param {DocumentStore} store
     * @param {object} [opts]
     * @param {(featureId: string|null) => void} [opts.onSelect]
     * @param {(featureId: string) => void} [opts.onDelete]
     * @param {(featureId: string) => void} [opts.onEdit]
     *        — Fires on double-click or via the context menu; host opens the
     *          CommandDialog at the feature's existing params for live-preview
     *          editing.
     */
    constructor(host, store, opts = {}) {
        if (!host) throw new Error('FeatureTree: missing host');
        if (!store) throw new Error('FeatureTree: missing store');
        this.host  = host;
        this.store = store;
        this.opts  = opts;
        this._query = '';
        this._wantsFocus = false;
        this._ctxMenu = null;
        this._docClickHandler = null;
        this._dismissCtxOnKey = null;
        this._unsub = this.store.subscribe(() => this.render());
        this.render();
    }

    destroy() {
        if (this._unsub) this._unsub();
        this._dismissContextMenu();
        this.host.innerHTML = '';
    }

    /** Programmatic search — used by command palette / tests. */
    setQuery(q) {
        this._query = String(q || '');
        this.render();
    }
    getQuery() { return this._query; }

    /** Re-render the list. Called automatically on every commit. */
    render() {
        const doc = this.store.doc;
        const selectedId = this.store.selectedFeatureId();
        const allFeatures = doc.featureOrder
            .map(id => doc.features[id])
            .filter(Boolean);

        const parsed = parseSearch(this._query);
        const queryActive = !!(this._query && this._query.trim());
        const visible = queryActive
            ? allFeatures.filter(f => matchFeature(f, parsed))
            : allFeatures;

        const totalCount   = allFeatures.length;
        const visibleCount = visible.length;
        const countLabel = queryActive
            ? `${visibleCount}/${totalCount}`
            : String(totalCount);

        // Header (always rendered, even when empty, so the search box stays
        // visible and the user can keep typing).
        const head =
            `<div class="pf4-tree-head">` +
              `<span class="pf4-tree-head-title">Features</span>` +
              `<span class="pf4-tree-head-count">${esc(countLabel)}</span>` +
            `</div>` +
            this._renderSearchBar();

        if (!totalCount) {
            this.host.innerHTML = head +
                `<div class="pf4-tree-empty">No features yet. Try Ctrl+K → "v4: Add Box".</div>`;
            this._wireSearch();
            return;
        }

        if (!visibleCount) {
            this.host.innerHTML = head +
                `<div class="pf4-tree-empty">No features match this search.</div>`;
            this._wireSearch();
            return;
        }

        const rows = visible.map(f => this._renderRow(f, selectedId === f.id)).join('');
        this.host.innerHTML = head + `<div class="pf4-tree-rows">${rows}</div>`;
        this._wireSearch();

        // Wire row interactions
        const draggable = !queryActive;     // disable drag while a search is filtering
        for (const row of this.host.querySelectorAll('.pf4-tree-row')) {
            const id = row.dataset.id;
            if (draggable) this._wireDrag(row, id);
            row.addEventListener('click', (e) => {
                if (e.target.closest('[data-act]')) return;   // affordance handled below
                this._select(id);
            });
            row.addEventListener('dblclick', (e) => {
                if (e.target.closest('[data-act]')) return;
                if (typeof this.opts.onEdit === 'function') {
                    e.preventDefault();
                    this._select(id);
                    this.opts.onEdit(id);
                }
            });
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._select(id);
                this._showContextMenu(id, e.clientX, e.clientY);
            });
            const eye = row.querySelector('[data-act="toggle"]');
            if (eye) eye.addEventListener('click', (e) => { e.stopPropagation(); this._toggleEnabled(id); });
            const del = row.querySelector('[data-act="delete"]');
            if (del) del.addEventListener('click', (e) => { e.stopPropagation(); this._delete(id); });
        }
    }

    // ── Search box ────────────────────────────────────────────────────────
    _renderSearchBar() {
        const q = this._query || '';
        const clearVis = q ? '' : ' pf4-tree-search-clear-hidden';
        return (
            `<div class="pf4-tree-search">` +
              `<input class="pf4-tree-search-input" type="text" spellcheck="false" autocomplete="off"` +
                ` placeholder="Search… (:type :errors :suppressed :variable)"` +
                ` value="${esc(q)}" />` +
              `<button type="button" class="pf4-tree-search-clear${clearVis}" data-act="clear-search" title="Clear search (Esc)">×</button>` +
            `</div>`
        );
    }

    _wireSearch() {
        const input = this.host.querySelector('.pf4-tree-search-input');
        const clear = this.host.querySelector('[data-act="clear-search"]');
        if (!input) return;

        // Restore caret position to end after re-render. Without this every
        // keystroke would jump the caret as the store re-renders us.
        try {
            const len = input.value.length;
            input.setSelectionRange(len, len);
        } catch (_) { /* not a text input */ }

        if (this._wantsFocus) {
            input.focus();
            this._wantsFocus = false;
        }

        input.addEventListener('input', () => {
            this._wantsFocus = true;
            this._query = input.value;
            this.render();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._query) {
                e.preventDefault();
                this._wantsFocus = true;
                this._query = '';
                this.render();
            }
        });
        if (clear) {
            clear.addEventListener('click', (e) => {
                e.stopPropagation();
                this._wantsFocus = true;
                this._query = '';
                this.render();
            });
        }
    }

    // ── Right-click context menu ───────────────────────────────────────────
    _showContextMenu(featureId, x, y) {
        this._dismissContextMenu();
        const feat = this.store.doc.features[featureId];
        if (!feat) return;
        const doc = this.host.ownerDocument || document;
        const menu = doc.createElement('div');
        menu.className = 'pf4-ctx-menu';
        menu.style.left = `${x}px`;
        menu.style.top  = `${y}px`;
        const suppressLabel = feat.enabled ? 'Suppress' : 'Unsuppress';
        menu.innerHTML =
            `<button type="button" class="pf4-ctx-item" data-ctx="edit">Edit Feature…</button>` +
            `<button type="button" class="pf4-ctx-item" data-ctx="rename">Rename…</button>` +
            `<button type="button" class="pf4-ctx-item" data-ctx="suppress">${esc(suppressLabel)}</button>` +
            `<button type="button" class="pf4-ctx-item pf4-ctx-danger" data-ctx="delete">Delete</button>`;
        doc.body.appendChild(menu);
        this._ctxMenu = menu;

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ctx]');
            if (!btn) return;
            const act = btn.dataset.ctx;
            this._dismissContextMenu();
            if (act === 'edit') {
                if (typeof this.opts.onEdit === 'function') this.opts.onEdit(featureId);
            } else if (act === 'rename') {
                this._rename(featureId);
            } else if (act === 'suppress') {
                this._toggleEnabled(featureId);
            } else if (act === 'delete') {
                this._delete(featureId);
            }
        });

        // Dismiss on outside click / Esc.
        this._docClickHandler = (ev) => {
            if (!this._ctxMenu) return;
            if (!this._ctxMenu.contains(ev.target)) this._dismissContextMenu();
        };
        // Defer one tick so the contextmenu's own mousedown doesn't dismiss us immediately.
        setTimeout(() => {
            if (this._docClickHandler) doc.addEventListener('mousedown', this._docClickHandler, true);
        }, 0);
        this._dismissCtxOnKey = (e) => {
            if (e.key === 'Escape') this._dismissContextMenu();
        };
        doc.addEventListener('keydown', this._dismissCtxOnKey);
    }

    _dismissContextMenu() {
        if (this._ctxMenu && this._ctxMenu.parentNode) {
            this._ctxMenu.parentNode.removeChild(this._ctxMenu);
        }
        this._ctxMenu = null;
        const doc = this.host.ownerDocument || document;
        if (this._docClickHandler) {
            doc.removeEventListener('mousedown', this._docClickHandler, true);
            this._docClickHandler = null;
        }
        if (this._dismissCtxOnKey) {
            doc.removeEventListener('keydown', this._dismissCtxOnKey);
            this._dismissCtxOnKey = null;
        }
    }

    _rename(id) {
        const f = this.store.doc.features[id];
        if (!f) return;
        const win = this.host.ownerDocument?.defaultView || window;
        const next = win.prompt('Rename feature:', f.name || typeLabel(f.type));
        if (next == null) return;
        const name = String(next).trim();
        if (!name || name === f.name) return;
        import('../../lib/document/changelog.js').then(({ renameFeatureChange }) => {
            this.store.commit(renameFeatureChange(id, name));
        });
    }

    _renderRow(f, selected) {
        const cls = ['pf4-tree-row'];
        if (selected)   cls.push('pf4-selected');
        if (!f.enabled) cls.push('pf4-suppressed');
        const hasErr = Array.isArray(f.warnings) && f.warnings.length > 0;
        if (hasErr) cls.push('pf4-has-error');
        const errBadge = hasErr
            ? ` <span class="pf4-err-dot" title="${esc(f.warnings.join('; '))}">!</span>`
            : '';
        const color = colorForType(f.type);
        const tlabel = typeLabel(f.type);
        return (
            `<div class="${cls.join(' ')}" data-id="${esc(f.id)}" title="${esc(tlabel)} · ${esc(f.id)}" style="--row-accent:${color};">` +
              `<button class="pf4-icon pf4-eye" data-act="toggle" title="${f.enabled ? 'Suppress' : 'Unsuppress'}" aria-label="toggle">` +
                (f.enabled ? svgEye() : svgEyeOff()) +
              `</button>` +
              typeBadgeHtml(f.type, { size: 18 }) +
              `<div class="pf4-row-text">` +
                `<div class="pf4-row-name">${esc(f.name || tlabel)}${errBadge}</div>` +
                `<div class="pf4-row-type">${esc(tlabel)}</div>` +
              `</div>` +
              `<button class="pf4-icon pf4-icon-del" data-act="delete" title="Delete" aria-label="delete">` +
                svgTrash() +
              `</button>` +
            `</div>`
        );
    }

    // ── Drag-to-reorder ────────────────────────────────────────────────────
    // Native HTML5 DnD — every row is draggable, drop targets are its
    // siblings. On drop we commit a `reorderFeatureChange(id, newIndex)`.
    // Mid-history rolled-back features (past playhead) are still draggable
    // — the store handles the merge correctly. While dragging, the source
    // row dims and the drop target shows a colored top/bottom edge bar.
    _wireDrag(row, id) {
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', (e) => {
            row.classList.add('pf4-dragging');
            try { e.dataTransfer.setData('text/pf4-feature-id', id); } catch (_) {}
            e.dataTransfer.effectAllowed = 'move';
            // Carry our payload on the instance too — `dataTransfer.getData`
            // is empty in dragover for security on some browsers, and we
            // need the id to ignore self-drop.
            this._dragId = id;
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('pf4-dragging');
            this._clearDropMarkers();
            this._dragId = null;
        });
        row.addEventListener('dragover', (e) => {
            if (!this._dragId || this._dragId === id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = row.getBoundingClientRect();
            const above = (e.clientY - rect.top) < (rect.height / 2);
            this._clearDropMarkers();
            row.classList.add(above ? 'pf4-drop-above' : 'pf4-drop-below');
            this._dropTargetId = id;
            this._dropAbove = above;
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('pf4-drop-above', 'pf4-drop-below');
        });
        row.addEventListener('drop', (e) => {
            if (!this._dragId || this._dragId === id) return;
            e.preventDefault();
            this._clearDropMarkers();
            const fromId = this._dragId;
            const toId = id;
            const above = this._dropAbove;
            this._dragId = null;
            this._commitReorder(fromId, toId, above);
        });
    }

    _clearDropMarkers() {
        for (const r of this.host.querySelectorAll('.pf4-drop-above, .pf4-drop-below')) {
            r.classList.remove('pf4-drop-above', 'pf4-drop-below');
        }
    }

    _commitReorder(fromId, toId, above) {
        const order = this.store.doc.featureOrder || [];
        const fromIdx = order.indexOf(fromId);
        const toIdx   = order.indexOf(toId);
        if (fromIdx < 0 || toIdx < 0) return;
        let newIndex = above ? toIdx : toIdx + 1;
        // Adjust for the removal of the source from earlier in the list.
        if (fromIdx < newIndex) newIndex--;
        if (newIndex === fromIdx) return;
        import('../../lib/document/changelog.js').then(({ reorderFeatureChange }) => {
            try { this.store.commit(reorderFeatureChange(fromId, newIndex)); }
            catch (err) { console.warn('[FeatureTree reorder]', err); }
        });
    }

    // ── Actions ────────────────────────────────────────────────────────────
    _select(id) {
        this.store.selectFeature(id);
        if (this.opts.onSelect) {
            try { this.opts.onSelect(id); }
            catch (e) { console.error('[FeatureTree onSelect]', e); }
        }
    }

    _toggleEnabled(id) {
        const f = this.store.doc.features[id];
        if (!f) return;
        import('../../lib/document/changelog.js').then(({ setEnabledChange }) => {
            this.store.commit(setEnabledChange(id, !f.enabled));
        });
    }

    _delete(id) {
        if (this.opts.onDelete) {
            try { this.opts.onDelete(id); return; }
            catch (e) { console.error('[FeatureTree onDelete]', e); }
        }
        import('../../lib/document/changelog.js').then(({ removeFeatureChange }) => {
            this.store.commit(removeFeatureChange(id));
        });
    }
}

// ── Inline SVG icons (no font dependency) ───────────────────────────────────
function svgEye() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function svgEyeOff() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}
function svgTrash() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
}

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
