/**
 * Vision critic — gives a BLIND builder model a pair of eyes.
 *
 * The core builder path (gpt-oss / nemotron / most OpenAI-compatible open models)
 * is TEXT-ONLY: agent.js renders the model with capture_views but then has to
 * DROP the images because the builder can't accept image input. That kills the
 * single biggest accuracy lever in CAD-from-text — the see→diagnose→fix loop.
 *
 * This module fills that gap WITHOUT making the builder multimodal. It sends the
 * captured renders to a cheap multimodal model (Gemma via Google AI Studio, or
 * any Gemini model) through the SAME /ai/chat proxy + Gemini provider the rest of
 * the stack uses, and returns a short, concrete TEXT critique. agent.js injects
 * that critique back into the builder's loop as the next user turn — so the
 * blind builder reads "the femur is a plain box, no servo pocket" and fixes it.
 *
 * Design rules this obeys (see the multi-model discussion):
 *   - Gemma's ONLY job here is perception (image → text). It is never the
 *     builder/orchestrator — Gemma can't do native tool calls, so it must not be
 *     handed the tool surface. This call sends NO tools.
 *   - The critic's output is advisory text; the deterministic gates
 *     (compile/invariants/measure) remain the authority. The critic narrows the
 *     blindness gap; it does not replace the gates.
 *   - It degrades gracefully: no key / network error / non-vision model → returns
 *     { ok:false } and the build proceeds on numeric verification alone. It must
 *     never throw into the agent loop.
 *
 *   resolveVisionCriticConfig(settings?) → { enabled, model, apiKey }
 *   buildCriticBody({ images, goal, model, maxTokens }) → gemini request body
 *   parseCritique(json) → string   (the reviewer's text)
 *   runVisionCritique({ images, goal, signal, endpoint }) → { ok, critique, model }
 */

import { readSettings } from '../../../app/settings/index.js';
import { geminiProvider } from './providers/index.js';
import { sendChat } from './provider.js';

/** Max renders we hand the critic — keep the payload small + the call fast. */
const MAX_CRITIC_IMAGES = 4;
/** The critique is short; a small output cap keeps it cheap and on-task. */
const CRITIC_MAX_TOKENS = 1024;

/**
 * The reviewer's brief. Deliberately narrow: look, name concrete fixable
 * defects, or say it's good. No praise, no preamble — the builder pastes this
 * straight into its next step, so every word should be actionable.
 */
export const CRITIC_SYSTEM =
    'You are a meticulous CAD vision reviewer. You are shown rendered views (front/right/top/iso) ' +
    'of a 3D model that another AI just built from a text request, plus that request. ' +
    'You CANNOT change anything — your only job is to LOOK and report concrete, fixable problems so the builder can fix them.\n\n' +
    'Check, in order, and report only what is actually wrong (3–8 short bullets):\n' +
    '1. Bare primitives: is any part just a plain box/cylinder where the request needs a SHAPED part ' +
    '(a bracket, mount, housing, arm with holes/pockets/fillets/cutouts)? Name the part.\n' +
    '2. Missing features: holes, slots, pockets, mounting points, fillets, vents the part clearly needs and lacks.\n' +
    '3. Spatial defects: parts clipping/overlapping, floating with a visible gap, wrong proportions, ' +
    'wrong orientation, or asymmetry that should be symmetric.\n' +
    '4. Scale / placement: anything obviously the wrong size or in the wrong location.\n\n' +
    'Be specific and reference the part ("the femur is a plain box — no servo pocket or screw holes"). ' +
    'Do NOT invent problems and do NOT comment on color/lighting/material. ' +
    'If the model genuinely looks correct and complete for the request, reply with exactly one line starting ' +
    '"LOOKS GOOD:" followed by a short reason. Otherwise reply with only the bullets — no preamble, no praise.';

/**
 * Resolve the critic config from settings (injectable for tests). The critic is
 * ACTIVE only when explicitly enabled AND a key is available. The key falls back
 * to the main Gemini key, since both are Google AI Studio keys — so a user who
 * already pasted a Gemini key just flips the toggle.
 *
 * @param {object} [settings]  result of readSettings() (or a test stub)
 * @returns {{ enabled:boolean, model:string, apiKey:(string|null) }}
 */
export function resolveVisionCriticConfig(settings) {
    let ai = {};
    try { ai = (settings || readSettings() || {}).ai || {}; } catch { ai = {}; }
    const enabled = ai.visionCritic === true;
    const model = (typeof ai.visionCriticModel === 'string' && ai.visionCriticModel.trim())
        ? ai.visionCriticModel.trim()
        : 'gemma-4-31b-it';
    const explicit = (typeof ai.visionCriticApiKey === 'string' && ai.visionCriticApiKey.trim())
        ? ai.visionCriticApiKey.trim() : '';
    const shared = (typeof ai.geminiApiKey === 'string' && ai.geminiApiKey.trim())
        ? ai.geminiApiKey.trim() : '';
    const apiKey = explicit || shared || null;
    return { enabled, model, apiKey };
}

/** True when the critic is configured enough to call (enabled + has a key). */
export function visionCriticActive(settings) {
    const c = resolveVisionCriticConfig(settings);
    return !!(c.enabled && c.apiKey);
}

/**
 * Build the Gemini-shaped request body for one critique call. Pure + testable —
 * no network, no settings read. Sends the goal + images as a single user turn,
 * the brief as systemInstruction, and NO tools (Gemma is perception-only here).
 */
export function buildCriticBody({ images = [], goal = '', model = 'gemma-4-31b-it', maxTokens = CRITIC_MAX_TOKENS } = {}) {
    const frames = (Array.isArray(images) ? images : [])
        .filter((im) => im && im.dataBase64)
        .slice(0, MAX_CRITIC_IMAGES)
        .map((im) => ({ mediaType: im.mediaType || 'image/jpeg', dataBase64: im.dataBase64 }));
    const views = [...new Set((Array.isArray(images) ? images : []).map((im) => im && im.view).filter(Boolean))];
    const text = `The user's request: "${String(goal || '').slice(0, 600)}".\n` +
        `Here ${frames.length === 1 ? 'is a render' : `are ${frames.length} renders`} of the model built so far` +
        `${views.length ? ` (${views.join(', ')})` : ''}. Review it against the request and report concrete fixable problems.`;
    const history = [{ role: 'user', text, images: frames }];
    const { body } = geminiProvider.buildBody({
        system: CRITIC_SYSTEM,
        history,
        tools: undefined,           // perception-only: Gemma gets NO tool surface
        model,
        maxTokens,
        stream: false,
    });
    return body;
}

/** Pull the reviewer's text out of a Gemini GenerateContentResponse. */
export function parseCritique(json) {
    try { return (geminiProvider.parseResponse(json).text || '').trim(); }
    catch { return ''; }
}

/**
 * Run one critique. Reads its own config, calls the multimodal model through the
 * proxy with the critic's key, and returns the text verdict. Never throws.
 *
 * @param {{ images:Array<{mediaType,dataBase64,view}>, goal?:string, signal?:AbortSignal, endpoint?:string, settings?:object }} args
 * @returns {Promise<{ ok:boolean, critique?:string, model?:string, looksGood?:boolean, error?:string }>}
 */
export async function runVisionCritique({ images, goal = '', signal, endpoint, settings } = {}) {
    const cfg = resolveVisionCriticConfig(settings);
    if (!cfg.enabled) return { ok: false, error: 'vision critic disabled' };
    if (!cfg.apiKey) return { ok: false, error: 'no vision-critic API key' };
    const frames = (Array.isArray(images) ? images : []).filter((im) => im && im.dataBase64);
    if (!frames.length) return { ok: false, error: 'no renders to review' };

    const body = buildCriticBody({ images: frames, goal, model: cfg.model });
    try {
        const json = await sendChat(body, { endpoint, signal, apiKey: cfg.apiKey });
        const critique = parseCritique(json);
        if (!critique) return { ok: false, model: cfg.model, error: 'reviewer returned no text' };
        return { ok: true, model: cfg.model, critique, looksGood: /^\s*LOOKS GOOD/i.test(critique) };
    } catch (e) {
        return { ok: false, model: cfg.model, error: (e && e.message) || String(e) };
    }
}
