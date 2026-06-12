/**
 * PreviewBodyChannel — speculative, never-committed renders of a candidate
 * document. Used by feature-command dialogs to show what a Box / Extrude /
 * Fillet WILL look like before the user clicks Accept.
 *
 *   const channel = new PreviewBodyChannel({ scene, kernelClient });
 *
 *   // Typed in the dialog → debounced kernel run → yellow preview mesh.
 *   channel.requestPreview(candidateDoc);
 *
 *   // User accepted → real op commits via the store; bridge renders the
 *   // final body. We dispose the preview.
 *   channel.clear();
 *
 * The channel owns its own `DocumentExecutor` so it doesn't pollute the
 * main bridge's render events. The dedicated executor is the cheapest way
 * to inherit the executor's stale-generation guard (rapid typing → only the
 * latest preview lands).
 *
 * The preview group sits in the same scene as the bridge's committed body
 * group, with a yellow translucent material applied to every mesh. The
 * commit body remains visible at full opacity underneath — Fusion users
 * call this the "ghost preview" effect.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DocumentExecutor } from './executor.js';
import { applyChange } from './fold.js';
import { addFeatureChange, setParamsChange, setInputsChange } from './changelog.js';

const PREVIEW_GROUP_NAME = '__v4_preview__';
const PREVIEW_COLOR      = 0xffb300;   // research-spec amber-orange
const PREVIEW_OPACITY    = 0.42;
const DEFAULT_DEBOUNCE   = 220;        // ms — sub-300ms feels "live", not sluggish

export class PreviewBodyChannel {
    /**
     * @param {object} args
     * @param {THREE.Scene} [args.scene]            — scene to attach the preview group to
     * @param {object}      args.kernelClient       — implements executeCode(code)
     * @param {number}      [args.debounceMs]
     */
    constructor({ scene = null, kernelClient, debounceMs = DEFAULT_DEBOUNCE } = {}) {
        if (!kernelClient) throw new Error('PreviewBodyChannel: missing kernelClient');
        this.scene         = scene;
        this.executor      = new DocumentExecutor();
        this.executor.setClient(kernelClient);
        this.debounceMs    = debounceMs;
        this._loader       = new GLTFLoader();

        this._group       = new THREE.Group();
        this._group.name  = PREVIEW_GROUP_NAME;
        this._group.renderOrder = 999;
        if (scene) scene.add(this._group);

        this._material = new THREE.MeshStandardMaterial({
            color:        PREVIEW_COLOR,
            transparent:  true,
            opacity:      PREVIEW_OPACITY,
            metalness:    0.05,
            roughness:    0.55,
            side:         THREE.DoubleSide,
            depthWrite:   false,
        });
        this._edgeMaterial = new THREE.LineBasicMaterial({
            color:       PREVIEW_COLOR,
            transparent: true,
            opacity:     0.92,
        });

        this._debounceTimer = null;
        this._latestDoc     = null;
        this._listeners     = new Set();
    }

    /** Subscribe to render/clear/error events. `({type, ...})`. */
    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emit(evt) { for (const fn of this._listeners) { try { fn(evt); } catch {} } }

    /**
     * Schedule a preview render. Coalesces rapid calls — only the most-recent
     * candidate doc is executed after `debounceMs` of silence.
     */
    requestPreview(candidateDoc) {
        this._latestDoc = candidateDoc;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.previewNow(this._latestDoc), this.debounceMs);
    }

    /** Run immediately; bypasses debounce. Returns the kernel result. */
    async previewNow(candidateDoc) {
        clearTimeout(this._debounceTimer);
        if (!candidateDoc) return null;
        const result = await this.executor.executeDocument(candidateDoc);
        if (!result) return null;
        if (result.stale) return result;                     // a newer call superseded us
        if (!result.ok || !result.glb) {
            this._emit({ type: 'error', result });
            return result;
        }
        // Empty GLB → treat as "nothing to render" rather than handing the
        // GLTFLoader an unparseable buffer. Test stubs use 0-byte ArrayBuffers
        // to avoid bundling fixture binaries.
        const byteLength = result.glb.byteLength ?? result.glb.length ?? 0;
        if (byteLength === 0) {
            this._clearGroup();
            this._emit({ type: 'rendered', result, empty: true });
            return result;
        }
        this._render(result.glb);
        this._emit({ type: 'rendered', result });
        return result;
    }

    /** Hide and free preview meshes. */
    clear() {
        clearTimeout(this._debounceTimer);
        this._latestDoc = null;
        this._clearGroup();
        this._emit({ type: 'cleared' });
    }

    /** True while a preview mesh is visible. */
    isVisible() { return this._group.children.length > 0; }

    /** The Three.js group hosting the preview meshes. */
    get group() { return this._group; }

    dispose() {
        this.clear();
        if (this._group.parent) this._group.parent.remove(this._group);
        this._material.dispose();
        this._edgeMaterial.dispose();
    }

    // ── Internals ──────────────────────────────────────────────────────────

    _render(glb) {
        try {
            this._loader.parse(glb, '', (gltf) => {
                this._clearGroup();
                // Match the bridge's GLB-frame fixup: mm-as-meters + Y-up→Z-up
                // via +90° about X (data +Y → world +Z; −90° inverts up).
                const wrap = new THREE.Group();
                wrap.name = '__v4_preview_wrap__';
                wrap.scale.setScalar(1000);
                wrap.rotation.x = Math.PI / 2;
                wrap.add(gltf.scene);
                wrap.traverse((obj) => {
                    if (obj.isMesh) {
                        obj.material = this._material;
                        obj.renderOrder = 1000;
                    } else if (obj.isLineSegments || obj.isLine) {
                        obj.material = this._edgeMaterial;
                    }
                });
                wrap.updateMatrixWorld(true);
                this._group.add(wrap);
            }, (err) => {
                console.warn('[PreviewBodyChannel] GLB parse failed:', err);
            });
        } catch (err) {
            console.warn('[PreviewBodyChannel] _render threw:', err);
        }
    }

    _clearGroup() {
        while (this._group.children.length) {
            const child = this._group.children.pop();
            this._disposeSubtree(child);
        }
    }

    _disposeSubtree(obj) {
        obj.traverse?.((node) => {
            if (node.geometry && node.geometry.dispose) node.geometry.dispose();
            // We share the channel's two materials across nodes — don't
            // dispose those; let dispose() handle it.
        });
    }
}

/**
 * Given a base doc and a feature to append, return a NEW doc with the
 * speculative feature added. Doesn't touch the store, doesn't mutate the
 * input. Suitable for the preview channel.
 *
 * @param {object} doc      — current Document
 * @param {object} feature  — built via `makeFeature(...)`; carries its own id
 * @param {number} [insertAt]
 */
export function withSpeculativeFeature(doc, feature, insertAt = null) {
    const cloned = JSON.parse(JSON.stringify(doc));
    applyChange(cloned, addFeatureChange(feature, insertAt));
    return cloned;
}

/**
 * Speculatively patch an existing feature's params. Used by Edit-Feature
 * reentry — the user opens the dialog on a Box, types a new width, and
 * the preview channel shows the box at the new dimensions BEFORE commit.
 *
 * @param {object} doc
 * @param {string} featureId
 * @param {object} paramsPatch  — shallow-merged into feature.params
 */
export function withSpeculativeParams(doc, featureId, paramsPatch) {
    const cloned = JSON.parse(JSON.stringify(doc));
    if (!cloned.features[featureId]) return cloned;
    applyChange(cloned, setParamsChange(featureId, paramsPatch));
    return cloned;
}

/**
 * Speculatively patch an existing feature's inputs (e.g. a Fillet's target
 * body or its edge picks). Used by Edit-Feature for modifier features
 * whose target body might change.
 *
 * @param {object} doc
 * @param {string} featureId
 * @param {object} inputsPatch  — shallow-merged into feature.inputs
 */
export function withSpeculativeInputs(doc, featureId, inputsPatch) {
    const cloned = JSON.parse(JSON.stringify(doc));
    if (!cloned.features[featureId]) return cloned;
    applyChange(cloned, setInputsChange(featureId, inputsPatch));
    return cloned;
}
