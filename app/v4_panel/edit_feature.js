/**
 * openEditFeatureDialog — re-open the creation form for an existing feature.
 *
 * Looks up the feature's type, fetches the matching schema from `schemas.js`,
 * then opens the same `promptForParams` modal that the original "Add …"
 * command used — but seeded with the feature's current params. While the
 * dialog is open, every edit (debounced ~150ms) commits a `setParamsChange`
 * so the viewport regenerates live. On Apply the latest valid params are
 * committed (no-op if nothing changed). On Cancel the last live-preview
 * commit is rolled back via `store.undo()`.
 *
 * Wire this from the panel's `onEditFeature` callback:
 *
 *   getV4Panel({
 *       store, bridge,
 *       onEditFeature: (id) => openEditFeatureDialog({ store, featureId: id }),
 *   });
 *
 * The dialog never touches the kernel or bridge directly — all flow goes
 * through the store, which is what wires regen.
 */

import { promptForParams } from './prompt_modal.js';
import { schemaFor, typeLabel } from './schemas.js';
import { setParamsChange } from '../../lib/document/changelog.js';

/**
 * @param {object} opts
 * @param {DocumentStore} opts.store
 * @param {string} opts.featureId
 * @param {number} [opts.debounceMs=150]   live-preview debounce
 * @returns {Promise<{applied:boolean, params:object|null}>}
 */
export async function openEditFeatureDialog({ store, featureId, debounceMs = 150 } = {}) {
    if (!store || !featureId) {
        console.warn('[openEditFeatureDialog] missing store or featureId');
        return { applied: false, params: null };
    }
    const feat = store.doc.features[featureId];
    if (!feat) {
        console.warn('[openEditFeatureDialog] unknown feature', featureId);
        return { applied: false, params: null };
    }
    const schema = schemaFor(feat.type);
    if (!schema.length) {
        // Nothing editable through the prompt UI — bail loudly so the host
        // can fall back to e.g. opening the sketch editor for Sketch features.
        return { applied: false, params: null, reason: 'no-schema' };
    }

    // Snapshot original params so Cancel can restore even if Esc bypasses
    // the dialog's own cleanup paths.
    const originalParams = { ...(feat.params || {}) };
    const headBefore     = store.doc.head;
    let livePreviewsApplied = 0;

    const liveChange = (partial) => {
        try {
            store.commit(setParamsChange(featureId, partial));
            livePreviewsApplied++;
        } catch (err) {
            console.warn('[openEditFeatureDialog live]', err.message);
        }
    };

    const result = await promptForParams({
        title:    `Edit ${typeLabel(feat.type)}`,
        subtitle: feat.name || feat.id,
        schema,
        initial:  originalParams,
        submit:   'Apply',
        cancel:   'Cancel',
        onLiveChange: liveChange,
        liveDebounceMs: debounceMs,
    });

    if (result == null) {
        // Cancelled — roll back every live preview we pushed by undoing the
        // same number of changes. We avoid setHead() here because intervening
        // commits from other UI surfaces (e.g. autosave) would be eaten.
        while (livePreviewsApplied > 0 && store.canUndo() && store.doc.head > headBefore) {
            store.undo();
            livePreviewsApplied--;
        }
        // Defensive: if anything stuck around, write the original params back.
        const liveNow = store.doc.features[featureId];
        if (liveNow && !shallowEqual(liveNow.params, originalParams)) {
            try { store.commit(setParamsChange(featureId, originalParams)); }
            catch (err) { console.warn('[openEditFeatureDialog restore]', err.message); }
        }
        return { applied: false, params: null };
    }

    // Apply the final params (collapses to a single change if no live previews
    // fired, otherwise a no-op patch when result === last live preview).
    const liveNow = store.doc.features[featureId];
    if (!liveNow || !shallowEqual(liveNow.params, result)) {
        try { store.commit(setParamsChange(featureId, result)); }
        catch (err) {
            console.warn('[openEditFeatureDialog apply]', err.message);
            return { applied: false, params: null };
        }
    }
    return { applied: true, params: result };
}

function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        const av = a[k], bv = b[k];
        if (Array.isArray(av) && Array.isArray(bv)) {
            if (av.length !== bv.length) return false;
            for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
        } else if (av !== bv) {
            return false;
        }
    }
    return true;
}
