/**
 * Timeline — horizontal bottom strip that mirrors the v4 feature DAG.
 *
 * Layout
 * ──────
 *   ┌──────────────┬───────────────────────────────────────────────┬──────────┐
 *   │ ⏮ ⏪ ⏵ ⏩ ⏭ │  icon … icon  [playhead]  icon … icon         │  N / M   │
 *   └──────────────┴───────────────────────────────────────────────┴──────────┘
 *      controls                      track (icons + draggable line)    counter
 *
 *   • One small icon per feature in `doc.featureOrder` (authored order).
 *     Icons are categorical (Box / Sketch / Extrude / Fillet / …) so the
 *     strip stays readable when the history grows past a few dozen items.
 *   • A vertical line — the *playhead* — is positioned between icons. Drag
 *     it left/right to roll history backward (anything to the right of the
 *     line is grayed out and excluded from the regenerated document).
 *   • Playback controls jump / step / animate the playhead.
 *
 * Data flow
 * ─────────
 *   1. We subscribe to the DocumentStore. Every commit (or undo / redo /
 *      setHead) re-renders the icon list and re-positions the playhead.
 *   2. Each icon caches the *changelog index* of its `add-feature` change.
 *      When the user moves the playhead onto icon N, we call
 *      `store.setHead(changelogIndex(N))`, which truncates the changelog
 *      and refolds the document. The viewport regen subscriber (in the
 *      bridge) sees the resulting `set-head` event and re-emits geometry.
 *   3. "Rolled-back" features (those past the playhead) are not removed
 *      from the visual strip — they remain greyed out so the user can drag
 *      the playhead back to recover them.
 *
 * Selection sync
 * ──────────────
 *   Clicking an icon calls `store.selectFeature(id)`, the same call the
 *   feature tree uses. Both surfaces (panel + timeline) therefore stay in
 *   sync over a shared subscription channel.
 *
 * Edit / suppress / delete
 * ────────────────────────
 *   Right-clicking an icon opens a small menu mirroring the panel's
 *   context menu. "Edit" defers to the same `openEditFeatureDialog`. The
 *   timeline does not import the v4_panel directly to keep its dep graph
 *   minimal — instead the consumer (main.js or a host) can override the
 *   edit handler via `onEditFeature`.
 *
 * Mid-history insertion (the "rollback bar")
 * ─────────────────────────────────────────
 *   When new features are committed while the playhead is mid-history,
 *   the store's existing behaviour applies: `commit()` clears the redo
 *   stack and appends past the current head, so the new feature naturally
 *   takes the playhead's slot. The timeline does not need extra logic
 *   for this — it just re-renders.
 */

import { ensureTimelineStyles } from './styles.js';
import { iconForType, categoryForType } from './icons.js';
import { colorForType } from '../v4_panel/feature_visuals.js';

const PLAYBACK_MS_PER_STEP = 220;

export class Timeline {
    /**
     * @param {object} opts
     * @param {DocumentStore} opts.store
     * @param {(featureId:string)=>void} [opts.onEditFeature]
     *        Called when the user picks "Edit" from the context menu.
     * @param {number} [opts.rightOffset=340]  px reserved on the right edge
     *        so the strip doesn't overlap the v4 panel.
     * @param {Document} [opts.doc]
     */
    constructor({ store, onEditFeature = null, rightOffset = 0, doc = (typeof document !== 'undefined' ? document : null) } = {}) {
        if (!store) throw new Error('Timeline: missing store');
        if (!doc)   throw new Error('Timeline: no document');
        this.store = store;
        this.doc   = doc;
        this.onEditFeature = onEditFeature;
        this.rightOffset = rightOffset;
        this._playing = false;
        this._playTimer = null;
        this._tooltip = null;
        this._ctxMenu = null;
        this._docHandlers = [];

        ensureTimelineStyles(doc);
        this._build();
        this._unsub = this.store.subscribe(() => this._render());
        this._render();
    }

    destroy() {
        this._stopPlayback();
        if (this._unsub) this._unsub();
        this._dismissTooltip();
        this._dismissCtxMenu();
        for (const off of this._docHandlers) try { off(); } catch (_) {}
        this._docHandlers.length = 0;
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }

    show() { this.el.classList.remove('pf4-tl-hidden'); }
    hide() { this.el.classList.add('pf4-tl-hidden'); this._stopPlayback(); }
    toggle() {
        if (this.el.classList.contains('pf4-tl-hidden')) this.show();
        else this.hide();
    }
    isVisible() { return !this.el.classList.contains('pf4-tl-hidden'); }

    /** Allow the host to resize when the v4 panel dock width changes. */
    setRightOffset(px) {
        this.rightOffset = Math.max(0, px | 0);
        this.el.style.right = `${this.rightOffset}px`;
    }

    // ── Build static DOM scaffold ─────────────────────────────────────────
    _build() {
        this.el = this.doc.createElement('div');
        this.el.className = 'pf4-timeline';
        this.el.style.right = `${this.rightOffset}px`;
        this.el.innerHTML =
            `<div class="pf4-tl-controls">` +
              `<button class="pf4-tl-btn" data-act="first" title="Jump to start">⏮</button>` +
              `<button class="pf4-tl-btn" data-act="prev"  title="Step back">⏪</button>` +
              `<button class="pf4-tl-btn" data-act="play"  title="Play history">⏵</button>` +
              `<button class="pf4-tl-btn" data-act="next"  title="Step forward">⏩</button>` +
              `<button class="pf4-tl-btn" data-act="last"  title="Jump to end">⏭</button>` +
            `</div>` +
            `<div class="pf4-tl-track" data-host="track">` +
              `<div class="pf4-tl-rail"></div>` +
              `<div class="pf4-tl-icons" data-host="icons"></div>` +
              `<div class="pf4-tl-playhead" data-host="playhead">` +
                `<div class="pf4-tl-playhead-handle" data-drag="playhead" title="Drag to roll back"></div>` +
                `<div class="pf4-tl-playhead-line"></div>` +
                `<div class="pf4-tl-playhead-tail"></div>` +
              `</div>` +
            `</div>` +
            `<div class="pf4-tl-counter" data-host="counter">` +
              `<strong>0</strong>/0` +
            `</div>`;
        this.doc.body.appendChild(this.el);
        this._trackHost   = this.el.querySelector('[data-host="track"]');
        this._iconsHost   = this.el.querySelector('[data-host="icons"]');
        this._playhead    = this.el.querySelector('[data-host="playhead"]');
        this._handle      = this._playhead.querySelector('[data-drag="playhead"]');
        this._counterEl   = this.el.querySelector('[data-host="counter"]');

        // Playback button wiring
        for (const btn of this.el.querySelectorAll('[data-act]')) {
            btn.addEventListener('click', () => this._onCtl(btn.dataset.act));
        }

        // Playhead drag — translate cursor X into a feature index.
        this._wirePlayheadDrag();
    }

    _onCtl(act) {
        const total = this._currentFeatureOrder().length;
        if (!total) return;
        const idx = this._featureIndexAtHead();
        switch (act) {
            case 'first': this._stopPlayback(); this._setPlayheadToFeatureIndex(-1); break;
            case 'prev':  this._stopPlayback(); this._setPlayheadToFeatureIndex(Math.max(-1, idx - 1)); break;
            case 'next':  this._stopPlayback(); this._setPlayheadToFeatureIndex(Math.min(total - 1, idx + 1)); break;
            case 'last':  this._stopPlayback(); this._setPlayheadToFeatureIndex(total - 1); break;
            case 'play':  this._togglePlayback(); break;
        }
    }

    _togglePlayback() {
        if (this._playing) this._stopPlayback();
        else this._startPlayback();
    }

    _startPlayback() {
        const total = this._currentFeatureOrder().length;
        if (!total) return;
        this._playing = true;
        this.el.querySelector('[data-act="play"]').classList.add('pf4-tl-playing');
        const tick = () => {
            if (!this._playing) return;
            const ids = this._currentFeatureOrder();
            const idx = this._featureIndexAtHead();
            if (idx >= ids.length - 1) {
                this._stopPlayback();
                return;
            }
            this._setPlayheadToFeatureIndex(idx + 1);
            this._playTimer = setTimeout(tick, PLAYBACK_MS_PER_STEP);
        };
        // If we're already at the end, restart from the beginning.
        if (this._featureIndexAtHead() >= total - 1) {
            this._setPlayheadToFeatureIndex(-1);
        }
        this._playTimer = setTimeout(tick, PLAYBACK_MS_PER_STEP);
    }

    _stopPlayback() {
        this._playing = false;
        if (this._playTimer) { clearTimeout(this._playTimer); this._playTimer = null; }
        const btn = this.el.querySelector('[data-act="play"]');
        if (btn) btn.classList.remove('pf4-tl-playing');
    }

    _wirePlayheadDrag() {
        let dragging = false;
        const onDown = (e) => {
            dragging = true;
            e.preventDefault();
            this._stopPlayback();
        };
        const onMove = (e) => {
            if (!dragging) return;
            const idx = this._featureIndexAtClientX(e.clientX);
            this._setPlayheadToFeatureIndex(idx);
        };
        const onUp = () => { dragging = false; };
        this._handle.addEventListener('mousedown', onDown);
        this.doc.addEventListener('mousemove', onMove);
        this.doc.addEventListener('mouseup',   onUp);
        this._docHandlers.push(
            () => this.doc.removeEventListener('mousemove', onMove),
            () => this.doc.removeEventListener('mouseup',   onUp),
        );

        // Clicking on the track (but not an icon) jumps the playhead there.
        this._trackHost.addEventListener('click', (e) => {
            if (e.target.closest('.pf4-tl-item')) return;
            if (e.target.closest('[data-drag="playhead"]')) return;
            const idx = this._featureIndexAtClientX(e.clientX);
            this._stopPlayback();
            this._setPlayheadToFeatureIndex(idx);
        });
    }

    // ── State helpers ─────────────────────────────────────────────────────
    _currentFeatureOrder() {
        const doc = this.store.doc;
        if (!doc || !Array.isArray(doc.featureOrder)) return [];
        return doc.featureOrder.slice();
    }

    /**
     * Walk the changelog, mapping each currently-live feature id to the
     * changelog index of its `add-feature` change. Used to translate icon
     * positions into `store.setHead(...)` calls.
     */
    _featureIndexMap() {
        const map = new Map();
        const cl = this.store.doc.changelog || [];
        for (let i = 0; i < cl.length; i++) {
            const ch = cl[i];
            if (ch && ch.kind === 'add-feature' && ch.payload && ch.payload.feature) {
                map.set(ch.payload.feature.id, i);
            }
        }
        return map;
    }

    /**
     * Find the highest feature index whose `add-feature` change is ≤ head.
     * Returns -1 if no feature is past the playhead.
     */
    _featureIndexAtHead() {
        const ids = this._currentFeatureOrder();
        const head = this.store.doc.head;
        const map = this._featureIndexMap();
        let last = -1;
        for (let i = 0; i < ids.length; i++) {
            const ci = map.get(ids[i]);
            if (ci != null && ci <= head) last = i;
        }
        return last;
    }

    _featureIndexAtClientX(clientX) {
        const items = this._iconsHost.querySelectorAll('.pf4-tl-item');
        if (!items.length) return -1;
        // Compare against the *centre* of each icon. The playhead clamps to
        // the gap between icons, so clicking just left of icon 0 → -1, just
        // right of icon i → i.
        let idx = -1;
        for (let i = 0; i < items.length; i++) {
            const rect = items[i].getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (clientX >= mid) idx = i;
            else break;
        }
        return idx;
    }

    _setPlayheadToFeatureIndex(targetIdx) {
        const ids = this._currentFeatureOrder();
        const total = ids.length;
        const clamped = Math.max(-1, Math.min(total - 1, targetIdx));

        // Translate to changelog head:
        //   -1 → set head to the index just before the very first add-feature
        //        change (or -1 if there's none).
        //   N  → set head to the changelog index of feature N's add-feature
        //        change. We deliberately do NOT include "side-effect" changes
        //        (set-params, rename, …) that happened after that point; the
        //        playhead semantic is "show me everything up to and including
        //        feature N".
        const map = this._featureIndexMap();
        let newHead;
        if (clamped < 0) {
            // Find the earliest add-feature and step just before it.
            let firstAdd = -1;
            for (const ch of (this.store.doc.changelog || [])) {
                if (ch && ch.kind === 'add-feature') break;
                firstAdd++;
            }
            newHead = firstAdd;
        } else {
            // Include all changes up to AND including the feature's add
            // change, plus any *subsequent* changes that target this feature
            // (so its params edits travel with it). Cheapest to do: head =
            // change index of the next add-feature - 1, or end of log.
            const myAdd = map.get(ids[clamped]);
            if (myAdd == null) return;
            const cl = this.store.doc.changelog || [];
            let next = cl.length;
            for (let i = myAdd + 1; i < cl.length; i++) {
                if (cl[i].kind === 'add-feature') { next = i; break; }
            }
            newHead = next - 1;
        }

        if (newHead === this.store.doc.head) {
            // Selection still benefits — single-click on an icon should
            // highlight even if the playhead is already there.
            if (clamped >= 0) this.store.selectFeature(ids[clamped]);
            this._render();
            return;
        }
        try { this.store.setHead(newHead); }
        catch (err) { console.warn('[Timeline setHead]', err); }
        if (clamped >= 0 && this.store.doc.features[ids[clamped]]) {
            this.store.selectFeature(ids[clamped]);
        }
    }

    // ── Render ────────────────────────────────────────────────────────────
    _render() {
        const ids = this._currentFeatureOrder();
        const total = ids.length;
        const headIdx = this._featureIndexAtHead();
        const selectedId = (typeof this.store.selectedFeatureId === 'function')
            ? this.store.selectedFeatureId() : null;

        if (!total) {
            this._iconsHost.innerHTML =
                `<div style="color:#6f6c68;font-size:11px;padding:0 12px;">No features yet — add one to start the history.</div>`;
            this._playhead.style.display = 'none';
            this._counterEl.innerHTML = `<strong>0</strong>/0`;
            return;
        }

        this._playhead.style.display = '';
        const html = ids.map((id, i) => this._renderItem(id, i, headIdx, selectedId)).join('');
        this._iconsHost.innerHTML = html;

        // Wire item interactions
        const items = this._iconsHost.querySelectorAll('.pf4-tl-item');
        items.forEach((it, i) => {
            it.addEventListener('click', () => this._onItemClick(ids[i], i));
            it.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this._showCtxMenu(ids[i], e.clientX, e.clientY);
            });
            it.addEventListener('mouseenter', (e) => this._showTooltip(ids[i], e));
            it.addEventListener('mousemove',  (e) => this._moveTooltip(e));
            it.addEventListener('mouseleave', () => this._dismissTooltip());
            this._wireChipDrag(it, ids[i]);
        });

        this._positionPlayhead(headIdx);
        this._counterEl.innerHTML =
            `<strong>${headIdx + 1}</strong>/${total}` +
            (headIdx < total - 1 ? ` <span style="color:#ff8f6b;margin-left:4px;">(rolled back)</span>` : '');
    }

    _renderItem(id, i, headIdx, selectedId) {
        const f = this.store.doc.features[id];
        if (!f) return '';
        const cls = ['pf4-tl-item'];
        if (id === selectedId) cls.push('pf4-tl-selected');
        if (f.enabled === false) cls.push('pf4-tl-suppressed');
        if (Array.isArray(f.warnings) && f.warnings.length) cls.push('pf4-tl-error');
        if (i > headIdx) cls.push('pf4-tl-rolled-back');
        const color = colorForType(f.type);
        const label = f.name || categoryForType(f.type);
        return (
            `<div class="${cls.join(' ')}" data-tl-id="${esc(id)}" data-tl-i="${i}" style="--tl-color:${color};">` +
              `<div class="pf4-tl-glyph">${iconForType(f.type)}</div>` +
              `<div class="pf4-tl-name">${esc(label)}</div>` +
              `<span class="pf4-tl-item-idx">${i + 1}</span>` +
            `</div>`
        );
    }

    _positionPlayhead(headIdx) {
        // Position the playhead in the *gap* AFTER icon[headIdx]. When
        // headIdx === -1 → just before icon 0.
        const items = this._iconsHost.querySelectorAll('.pf4-tl-item');
        if (!items.length) { this._playhead.style.display = 'none'; return; }
        const trackRect = this._trackHost.getBoundingClientRect();
        let x;
        if (headIdx < 0) {
            const r = items[0].getBoundingClientRect();
            x = r.left - trackRect.left - 4;
        } else if (headIdx >= items.length - 1) {
            const r = items[items.length - 1].getBoundingClientRect();
            x = r.right - trackRect.left + 4;
        } else {
            const ra = items[headIdx].getBoundingClientRect();
            const rb = items[headIdx + 1].getBoundingClientRect();
            x = (ra.right + rb.left) / 2 - trackRect.left;
        }
        this._playhead.style.left = `${x}px`;
    }

    _onItemClick(featureId, i) {
        this.store.selectFeature(featureId);
        // Single-click should *not* roll history — only the playhead drag
        // (or playback controls) does that. This matches Fusion 360.
    }

    // ── Chip drag-to-reorder ─────────────────────────────────────────────
    _wireChipDrag(chip, id) {
        chip.setAttribute('draggable', 'true');
        chip.addEventListener('dragstart', (e) => {
            chip.classList.add('pf4-tl-dragging');
            try { e.dataTransfer.setData('text/pf4-feature-id', id); } catch (_) {}
            e.dataTransfer.effectAllowed = 'move';
            this._dragId = id;
            this._dismissTooltip();
        });
        chip.addEventListener('dragend', () => {
            chip.classList.remove('pf4-tl-dragging');
            this._clearChipDropMarkers();
            this._dragId = null;
        });
        chip.addEventListener('dragover', (e) => {
            if (!this._dragId || this._dragId === id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = chip.getBoundingClientRect();
            const before = (e.clientX - rect.left) < (rect.width / 2);
            this._clearChipDropMarkers();
            chip.classList.add(before ? 'pf4-tl-drop-before' : 'pf4-tl-drop-after');
            this._chipDropTargetId = id;
            this._chipDropBefore = before;
        });
        chip.addEventListener('dragleave', () => {
            chip.classList.remove('pf4-tl-drop-before', 'pf4-tl-drop-after');
        });
        chip.addEventListener('drop', (e) => {
            if (!this._dragId || this._dragId === id) return;
            e.preventDefault();
            this._clearChipDropMarkers();
            const fromId = this._dragId;
            const before = this._chipDropBefore;
            this._dragId = null;
            this._commitChipReorder(fromId, id, before);
        });
    }

    _clearChipDropMarkers() {
        for (const c of this._iconsHost.querySelectorAll('.pf4-tl-drop-before, .pf4-tl-drop-after')) {
            c.classList.remove('pf4-tl-drop-before', 'pf4-tl-drop-after');
        }
    }

    _commitChipReorder(fromId, toId, before) {
        const order = this._currentFeatureOrder();
        const fromIdx = order.indexOf(fromId);
        const toIdx   = order.indexOf(toId);
        if (fromIdx < 0 || toIdx < 0) return;
        let newIndex = before ? toIdx : toIdx + 1;
        if (fromIdx < newIndex) newIndex--;
        if (newIndex === fromIdx) return;
        import('../../lib/document/changelog.js').then(({ reorderFeatureChange }) => {
            try { this.store.commit(reorderFeatureChange(fromId, newIndex)); }
            catch (err) { console.warn('[Timeline reorder]', err); }
        });
    }

    // ── Tooltip ───────────────────────────────────────────────────────────
    _showTooltip(featureId, e) {
        const f = this.store.doc.features[featureId];
        if (!f) return;
        this._dismissTooltip();
        const t = this.doc.createElement('div');
        t.className = 'pf4-tl-tooltip';
        const name = f.name || f.type;
        t.innerHTML =
            `<div>${esc(name)}</div>` +
            `<div class="pf4-tl-tooltip-type">${esc(f.type)} · ${esc(categoryForType(f.type))}</div>`;
        this.doc.body.appendChild(t);
        this._tooltip = t;
        this._moveTooltip(e);
    }
    _moveTooltip(e) {
        if (!this._tooltip) return;
        const x = e.clientX + 12;
        const y = e.clientY - 36;
        this._tooltip.style.left = `${x}px`;
        this._tooltip.style.top  = `${y}px`;
    }
    _dismissTooltip() {
        if (this._tooltip && this._tooltip.parentNode) this._tooltip.parentNode.removeChild(this._tooltip);
        this._tooltip = null;
    }

    // ── Context menu ──────────────────────────────────────────────────────
    _showCtxMenu(featureId, x, y) {
        this._dismissCtxMenu();
        this._dismissTooltip();
        const f = this.store.doc.features[featureId];
        if (!f) return;
        const menu = this.doc.createElement('div');
        menu.className = 'pf4-tl-ctx';
        menu.style.left = `${x}px`;
        menu.style.top  = `${y}px`;
        const suppLabel = f.enabled === false ? 'Unsuppress' : 'Suppress';
        menu.innerHTML =
            `<button class="pf4-tl-ctx-item" data-ctx="edit">Edit Feature…</button>` +
            `<button class="pf4-tl-ctx-item" data-ctx="rollback">Roll History Here</button>` +
            `<div class="pf4-tl-ctx-sep"></div>` +
            `<button class="pf4-tl-ctx-item" data-ctx="suppress">${esc(suppLabel)}</button>` +
            `<button class="pf4-tl-ctx-item pf4-tl-ctx-danger" data-ctx="delete">Delete</button>`;
        this.doc.body.appendChild(menu);
        this._ctxMenu = menu;

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ctx]');
            if (!btn) return;
            const act = btn.dataset.ctx;
            this._dismissCtxMenu();
            switch (act) {
                case 'edit':     this._editFeature(featureId); break;
                case 'rollback': this._rollbackTo(featureId);  break;
                case 'suppress': this._toggleSuppress(featureId); break;
                case 'delete':   this._delete(featureId); break;
            }
        });

        // Dismiss on outside click / Esc.
        const onDown = (ev) => {
            if (!this._ctxMenu) return;
            if (!this._ctxMenu.contains(ev.target)) this._dismissCtxMenu();
        };
        const onKey = (ev) => { if (ev.key === 'Escape') this._dismissCtxMenu(); };
        setTimeout(() => this.doc.addEventListener('mousedown', onDown, true), 0);
        this.doc.addEventListener('keydown', onKey);
        this._ctxOff = () => {
            this.doc.removeEventListener('mousedown', onDown, true);
            this.doc.removeEventListener('keydown', onKey);
        };
    }

    _dismissCtxMenu() {
        if (this._ctxMenu && this._ctxMenu.parentNode) this._ctxMenu.parentNode.removeChild(this._ctxMenu);
        this._ctxMenu = null;
        if (this._ctxOff) { try { this._ctxOff(); } catch (_) {} this._ctxOff = null; }
    }

    _editFeature(id) {
        if (typeof this.onEditFeature === 'function') {
            try { this.onEditFeature(id); } catch (err) { console.warn('[Timeline edit]', err); }
            return;
        }
        // Fall back to the panel's edit dialog if available (dynamic import
        // keeps the timeline standalone if the v4_panel isn't bundled).
        this.store.selectFeature(id);
        import('../v4_panel/edit_feature.js').then(({ openEditFeatureDialog }) => {
            openEditFeatureDialog({ store: this.store, featureId: id });
        }).catch(err => console.warn('[Timeline] no edit dialog available:', err));
    }

    _rollbackTo(id) {
        const ids = this._currentFeatureOrder();
        const i = ids.indexOf(id);
        if (i < 0) return;
        this._stopPlayback();
        this._setPlayheadToFeatureIndex(i);
    }

    _toggleSuppress(id) {
        const f = this.store.doc.features[id];
        if (!f) return;
        import('../../lib/document/changelog.js').then(({ setEnabledChange }) => {
            try { this.store.commit(setEnabledChange(id, f.enabled === false)); }
            catch (err) { console.warn('[Timeline suppress]', err); }
        });
    }

    _delete(id) {
        import('../../lib/document/changelog.js').then(({ removeFeatureChange }) => {
            try { this.store.commit(removeFeatureChange(id)); }
            catch (err) { console.warn('[Timeline delete]', err); }
        });
    }
}

// ── Module singleton ────────────────────────────────────────────────────────
let _instance = null;

/**
 * Lazy singleton mounted on first call. Pass `store` once — subsequent
 * calls return the existing instance and ignore opts (call .destroy() and
 * re-init for a fresh one).
 */
export function getTimeline(opts = {}) {
    if (_instance) return _instance;
    _instance = new Timeline(opts);
    return _instance;
}

export function disposeTimeline() {
    if (_instance) { _instance.destroy(); _instance = null; }
}

/**
 * Convenience host bootstrap. Typical usage from main.js:
 *
 *   import { initTimeline } from './app/timeline/index.js';
 *   initTimeline({ store: getDocumentStore() });
 */
export function initTimeline(opts = {}) {
    return getTimeline(opts);
}

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
