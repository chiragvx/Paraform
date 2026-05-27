/**
 * Context assembler — builds the "design brief" injected into every AI prompt.
 *
 * Sections (all optional, omitted when empty):
 *   1. HARDWARE ASSETS  — what's in the asset library with connection points
 *   2. SCENE COMPONENTS — what hardware is currently placed in the scene
 *   3. SKILLS           — available skill_* modules (from skills.js)
 */

import { getAssetManifest } from './catalog.js';
import { buildSkillContext } from './skills.js';

const SEP = '═══════════════════════════════════════════';

// ── 1. Hardware asset library ─────────────────────────────────────────────────

export function buildAssetContext() {
    const assets = getAssetManifest();
    if (!assets.length) return '';

    const lines = [
        SEP,
        'HARDWARE ASSET LIBRARY',
        SEP,
        'These are real components you can reference in designs.',
        'Each has an anchor origin (see "Anchor") and typed connection points.',
        'When placing a component, translate() to align its anchor with the',
        'target position on the parent body.',
        '',
    ];

    for (const asset of assets) {
        const env = asset.envelope_mm?.join(' × ') ?? '?';
        lines.push(`### ${asset.id}  —  ${asset.label}  (${env} mm)`);
        if (asset.anchor_description) lines.push(`Anchor: ${asset.anchor_description}`);
        if (asset.connection_points?.length) {
            lines.push('Connection points:');
            for (const cp of asset.connection_points) {
                const pos = cp.position.map(v => +v.toFixed(2)).join(', ');
                const dia = cp.diameter != null ? `  Ø${cp.diameter}` : '';
                lines.push(`  ${cp.id} [${cp.type}] @ [${pos}]${dia}  — ${cp.name}`);
            }
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ── 2. Scene components ───────────────────────────────────────────────────────

export function buildSceneContext(sceneComponents) {
    if (!sceneComponents?.length) return '';

    const lines = [
        SEP,
        'COMPONENTS PLACED IN THE SCENE',
        SEP,
        'These hardware components are already positioned. Your geometry must',
        'accommodate them: leave clearance, add mount holes, route cables, etc.',
        '',
    ];

    for (const c of sceneComponents) {
        const pos = (c.position || [0, 0, 0]).map(v => (+v).toFixed(1)).join(', ');
        const rot = (c.rotation || [0, 0, 0]).map(v => (+v).toFixed(0)).join(', ');
        const color = c.color ? `  color: ${c.color}` : '';
        lines.push(`  ${c.assetId}  "${c.name}"  pos [${pos}]  rot [${rot}°]${color}`);

        // Add connection point positions in world space if asset info is available
        // (helps the AI know exactly where mount holes / shafts land)
    }
    lines.push('');
    lines.push('Clearance rule: every subtracted clearance volume must extend ≥1 mm past');
    lines.push('the outer face of the enclosure wall (translate −1, height + 2).');
    lines.push('');

    return lines.join('\n');
}

// ── 3. Full assembled context ─────────────────────────────────────────────────

/**
 * Assemble the complete design-brief block to prepend to the AI system prompt.
 * Each section is omitted when empty so the prompt stays concise for simple requests.
 *
 * @param {Array} sceneComponents - currentState.sceneComponents
 * @returns {string}
 */
export function buildDesignBrief(sceneComponents) {
    const sections = [
        buildAssetContext(),
        buildSceneContext(sceneComponents),
        buildSkillContext(),
    ].filter(s => s.trim());

    if (!sections.length) return '';

    return [
        SEP,
        'DESIGN BRIEF — READ BEFORE GENERATING CODE',
        SEP,
        '',
        ...sections,
    ].join('\n');
}
