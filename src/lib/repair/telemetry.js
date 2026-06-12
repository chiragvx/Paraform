/**
 * Repair-loop telemetry — append-only JSONL log of per-run summaries.
 *
 * The eval corpus (spec 12) consumes this stream to track repair-loop
 * pass-rate / convergence across kernel + invariant revisions.
 *
 * Browser-safe: only appends to disk when a Node `fs` module is
 * available; in the browser the call is a no-op (we keep the surface
 * uniform so the studio panel can call it without a guard).
 *
 * Default path is `tests/eval/repair_runs.jsonl` relative to the
 * project root, overridable via the optional `path` argument.
 */

/**
 * Build a compact summary from a runRepairLoop() result.
 *
 * @param {object} result
 * @param {{ goal?: string, label?: string }} [meta]
 * @returns {object}
 */
export function summariseRun(result, meta = {}) {
    if (!result || typeof result !== 'object') {
        return {
            ts: Date.now(),
            ok: false,
            error: 'no result',
            ...meta,
        };
    }
    const iters = Array.isArray(result.iterations) ? result.iterations : [];
    const lastFailures = result.failures || [];
    return {
        ts: Date.now(),
        ok: !!result.success,
        iterations: iters.length,
        llmCalls: result.llmCalls || 0,
        finalFailureCount: lastFailures.length,
        finalErrorCount: lastFailures.filter((f) => f.severity === 'error').length,
        coverage: result.coverage || null,
        unmappedCount: Array.isArray(result.unmapped) ? result.unmapped.length : 0,
        ...meta,
    };
}

/**
 * Append a summary line to the JSONL log. Returns a result envelope
 * indicating whether the write happened.
 *
 * @param {object} summary
 * @param {{ path?: string }} [opts]
 * @returns {Promise<{ ok: boolean, path?: string, error?: string }>}
 */
export async function appendRepairRun(summary, opts = {}) {
    if (!summary || typeof summary !== 'object') {
        return { ok: false, error: 'no summary' };
    }
    const line = JSON.stringify(summary) + '\n';

    // Browser / missing fs → no-op.
    if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
        return { ok: false, error: 'no-node-fs' };
    }
    try {
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const target = opts.path || pathMod.resolve(process.cwd(), 'tests/eval/repair_runs.jsonl');
        // Ensure parent dir.
        try {
            await fs.mkdir(pathMod.dirname(target), { recursive: true });
        } catch { /* ignore */ }
        await fs.appendFile(target, line, 'utf8');
        return { ok: true, path: target };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/**
 * Convenience — summarise + append in one call.
 */
export async function recordRepairRun(result, meta = {}, opts = {}) {
    const summary = summariseRun(result, meta);
    return appendRepairRun(summary, opts);
}
