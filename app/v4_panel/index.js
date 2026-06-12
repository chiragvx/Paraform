/**
 * v4 Panel — feature tree + property inspector + save/load.
 *
 * One floating panel docked to the right side of the viewport. Created
 * lazily on first `getV4Panel()` call. Toggles visibility via `toggle()`,
 * `show()`, `hide()`. Mouse-drag the header to reposition.
 *
 * This module is the only DOM-aware glue in `app/v4_panel/`; the rest is
 * pure data + small DOM builders (tree, inspector, schemas, persistence,
 * styles).
 */

import { ensureStyles } from './styles.js';
import { FeatureTree } from './feature_tree.js';
import { Inspector } from './inspector.js';
import { FeatureMenu } from './feature_menu.js';
import { ParametersPanel } from './parameters.js';
import { PickingSection } from './picking_section.js';
import { openEditFeatureDialog } from './edit_feature.js';
import {
    saveToStorage, loadFromStorage, clearStorage, storageSize,
    attachAutoSave, downloadAsFile, readFromFile,
} from './persistence.js';

const PANEL_ID = 'pf4-panel';

export class V4Panel {
    /**
     * @param {object} opts
     * @param {DocumentStore} opts.store
     * @param {object} [opts.bridge] — bridge.runNow() called after load
     * @param {Document} [opts.doc]  — host document (defaults to window.document)
     * @param {(msg:string, kind?:string)=>void} [opts.toast] — optional toast hook
     * @param {object} [opts.parameterOps] — { add(name, value, unit, equation), set(id, patch), remove(id) }
     *                                       Required to enable the Parameters section.
     * @param {object} [opts.pickingSelection] — PickingSelection instance; enables the Selection section.
     * @param {(featureId:string)=>void} [opts.onEditFeature]
     *        Fires when the user double-clicks a feature row. Host wires
     *        this to `commandRuntime.openEditCommand(featureId)` to get
     *        live-preview editing of existing features.
     */
    constructor({ store, bridge = null, doc = (typeof document !== 'undefined' ? document : null), toast = null, parameterOps = null, pickingSelection = null, onEditFeature = null }) {
        if (!store) throw new Error('V4Panel: missing store');
        if (!doc)   throw new Error('V4Panel: no document');
        this.store  = store;
        this.bridge = bridge;
        this.doc    = doc;
        this.toast  = toast || ((msg) => console.info('[v4-panel]', msg));

        ensureStyles(doc);
        this._buildShell();
        this._wireHeader();
        this._wirePersistenceBar();

        // Default edit handler — opens the schema-driven prompt seeded with
        // the feature's current params and live-previews via setParamsChange.
        // The host can pass a custom `onEditFeature` to intercept (e.g. wire
        // through the command runtime for richer edit commands).
        const editHandler = onEditFeature || ((featureId) => {
            try { openEditFeatureDialog({ store, featureId }); }
            catch (e) { console.warn('[v4-panel] openEditFeatureDialog threw:', e); }
        });
        this.tree = new FeatureTree(this._treeHost, store, {
            onSelect: () => { /* inspector re-renders via store subscription */ },
            onEdit:   (featureId) => {
                try { editHandler(featureId); }
                catch (e) { console.warn('[v4-panel] onEditFeature threw:', e); }
            },
        });
        this.inspector = new Inspector(this._inspHost, store);
        if (parameterOps) {
            this.parameters = new ParametersPanel(this._paramsHost, store, parameterOps);
            this.parameters.onMessage = (msg, kind) => this._status(msg, kind === 'error' ? 'error' : '');
        }
        if (pickingSelection) {
            this.picking = new PickingSection(this._pickHost, pickingSelection);
        }

        this._detachAutoSave = attachAutoSave(store, {
            onSave: (ok) => this._status(ok ? 'Saved.' : 'Save failed.', ok ? 'ok' : 'error'),
        });

        // Body class — lets the host stylesheet push #viewport-container right
        // so the viewport isn't covered by the docked sidebar.
        this.doc.body.classList.add('pf4-panel-docked-left');
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────
    destroy() {
        if (this._detachAutoSave) this._detachAutoSave();
        if (this.featureMenu) this.featureMenu.destroy();
        if (this.parameters)  this.parameters.destroy();
        if (this.picking)     this.picking.destroy();
        this.tree.destroy();
        this.inspector.destroy();
        this.doc.body.classList.remove('pf4-panel-docked-left');
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }

    show() { this.el.classList.remove('pf4-hidden'); this.doc.body.classList.add('pf4-panel-docked-left'); }
    hide() { this.el.classList.add('pf4-hidden'); this.doc.body.classList.remove('pf4-panel-docked-left'); }
    toggle() {
        if (this.el.classList.contains('pf4-hidden')) this.show();
        else this.hide();
    }
    isVisible() { return !this.el.classList.contains('pf4-hidden'); }

    // ── Persistence actions ────────────────────────────────────────────────

    /** Save the current document to localStorage. */
    saveBrowser() {
        const ok = saveToStorage(this.store.toJSON());
        this._status(ok ? `Saved (${storageSize()} B).` : 'Save failed.', ok ? 'ok' : 'error');
        return ok;
    }

    /** Load from localStorage and replace the current document. */
    loadBrowser() {
        const json = loadFromStorage();
        if (!json) { this._status('Nothing stored to load.', 'error'); return false; }
        try {
            this.store.fromJSON(json);
            if (this.bridge && typeof this.bridge.runNow === 'function') this.bridge.runNow();
            this._status('Loaded from browser.', 'ok');
            return true;
        } catch (err) {
            this._status(`Load failed: ${err.message}`, 'error');
            return false;
        }
    }

    /** Clear the persisted document. */
    clearBrowser() {
        clearStorage();
        this._status('Cleared browser save.', 'ok');
    }

    /** Download the current document as a JSON file. */
    exportJson() {
        try {
            const name = `paraform-${(this.store.doc.metadata && this.store.doc.metadata.title) || 'document'}-${Date.now()}.json`;
            downloadAsFile(this.store.toJSON(), name, this.doc);
            this._status(`Exported ${name}.`, 'ok');
        } catch (err) {
            this._status(`Export failed: ${err.message}`, 'error');
        }
    }

    /** Open a file picker and load the selected JSON. */
    importJson() {
        const input = this.doc.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            try {
                const json = await readFromFile(file);
                this.store.fromJSON(json);
                if (this.bridge && typeof this.bridge.runNow === 'function') this.bridge.runNow();
                this._status(`Imported ${file.name}.`, 'ok');
            } catch (err) {
                this._status(`Import failed: ${err.message}`, 'error');
            } finally {
                this.doc.body.removeChild(input);
            }
        };
        this.doc.body.appendChild(input);
        input.click();
    }

    // ── DOM construction ───────────────────────────────────────────────────

    _buildShell() {
        this.el = this.doc.createElement('aside');
        this.el.id = PANEL_ID;
        this.el.className = 'pf4-panel';
        this.el.innerHTML = `
            <div class="pf4-panel-head" data-drag>
                <span class="pf4-panel-title">v4 Document</span>
                <div class="pf4-panel-actions">
                    <button data-act="add-feature" data-fm-anchor title="Add Feature">+ Feature</button>
                    <button data-act="close" class="pf4-panel-close" title="Close">×</button>
                </div>
            </div>
            <div class="pf4-panel-body">
                <div class="pf4-tree"  data-host="tree"></div>
                <div class="pf4-params" data-host="params"></div>
                <div class="pf4-pick"   data-host="pick"></div>
                <div class="pf4-insp"  data-host="insp"></div>
                <div class="pf4-persist-bar">
                    <button data-act="save"  title="Save to browser">Save</button>
                    <button data-act="load"  title="Load from browser">Load</button>
                    <button data-act="exp"   title="Export JSON file">Export</button>
                    <button data-act="imp"   title="Import JSON file">Import</button>
                    <button data-act="export-cad" title="Export STEP / STL / BREP">CAD…</button>
                </div>
                <div class="pf4-status" data-host="status">Ready.</div>
            </div>`;
        this.doc.body.appendChild(this.el);
        this._treeHost   = this.el.querySelector('[data-host="tree"]');
        this._paramsHost = this.el.querySelector('[data-host="params"]');
        this._pickHost   = this.el.querySelector('[data-host="pick"]');
        this._inspHost   = this.el.querySelector('[data-host="insp"]');
        this._statusEl   = this.el.querySelector('[data-host="status"]');
    }

    _wireHeader() {
        // Action buttons
        this.el.querySelector('[data-act="close"]').addEventListener('click', () => this.hide());

        // Add-Feature menu — popup driven by FeatureMenu. The host (main.js)
        // registers handler functions via `setQuickAction(action, fn)` so the
        // panel itself stays free of `lib/document` imports.
        const addFeat = this.el.querySelector('[data-act="add-feature"]');
        this.featureMenu = new FeatureMenu(this.el, {
            onAction: (action) => this._dispatch(action),
            getDoc: () => this.store.doc,
            getSelection: () => (this.store.selectedFeatureId && this.store.selectedFeatureId()) || null,
            getPickedCount: () => (this.picking && this.picking.selection)
                ? this.picking.selection.size
                : 0,
        });
        addFeat.addEventListener('click', () => this.featureMenu.toggle(addFeat));

        // Drag-to-move — disabled now that the panel is docked LEFT (Fusion
        // Browser style). Kept for fallback / future "undock" mode but the
        // handler is a no-op while the docked class is active. The cursor
        // and visual cue come from CSS now.
        const dragHandle = this.el.querySelector('[data-drag]');
        let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
        const DRAG_DISABLED = true;
        dragHandle.addEventListener('mousedown', (e) => {
            if (DRAG_DISABLED) return;
            if (e.target.closest('button')) return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = this.el.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            this.el.style.left = `${startLeft}px`;
            this.el.style.top  = `${startTop}px`;
            this.el.style.right = '';
            e.preventDefault();
        });
        this.doc.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            this.el.style.left = `${startLeft + (e.clientX - startX)}px`;
            this.el.style.top  = `${Math.max(0, startTop + (e.clientY - startY))}px`;
        });
        this.doc.addEventListener('mouseup', () => { dragging = false; });
    }

    _wirePersistenceBar() {
        this.el.querySelector('[data-act="save"]').addEventListener('click', () => this.saveBrowser());
        this.el.querySelector('[data-act="load"]').addEventListener('click', () => this.loadBrowser());
        this.el.querySelector('[data-act="exp"]').addEventListener('click',  () => this.exportJson());
        this.el.querySelector('[data-act="imp"]').addEventListener('click',  () => this.importJson());
        const cad = this.el.querySelector('[data-act="export-cad"]');
        if (cad) cad.addEventListener('click', () => this._dispatch('export-cad'));
    }

    /** Register a callback for one of the header quick-action buttons. */
    setQuickAction(name, fn) {
        this._actions = this._actions || {};
        this._actions[name] = fn;
    }

    /** Run a registered quick action by name. Public seam so the command
     *  palette / hotkeys can fire the same logic as a panel button. */
    runAction(name) { this._dispatch(name); }

    _dispatch(name) {
        const fn = this._actions && this._actions[name];
        if (fn) {
            try { fn(); } catch (e) { this._status(e.message, 'error'); }
        } else {
            this._status(`Action "${name}" not bound.`, 'error');
        }
    }

    _status(msg, kind = '') {
        if (!this._statusEl) return;
        this._statusEl.textContent = msg;
        this._statusEl.className = 'pf4-status' + (kind === 'ok' ? ' pf4-status-ok' : kind === 'error' ? ' pf4-status-error' : '');
        // Soft fade after 4s
        if (this._fadeTimer) clearTimeout(this._fadeTimer);
        this._fadeTimer = setTimeout(() => {
            this._statusEl.textContent = '';
            this._statusEl.className = 'pf4-status';
        }, 4000);
    }
}

// ── Module singleton ─────────────────────────────────────────────────────────

let _panel = null;

/** Lazy singleton. First call constructs; subsequent calls return the same instance. */
export function getV4Panel(opts = {}) {
    if (_panel) return _panel;
    _panel = new V4Panel(opts);
    return _panel;
}

export function disposeV4Panel() {
    if (_panel) { _panel.destroy(); _panel = null; }
}
