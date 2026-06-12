#!/usr/bin/env node
/**
 * Phase 2.6 eval harness — pure-Node corpus runner.
 *
 * Spec: tracker/12-eval-corpus.md.
 *
 * For each entry in tests/eval/corpus/*.json:
 *   1. Feed `spec` through the deterministic extractor (spec 15).
 *   2. Compare against `expectedConstraints` and `expectedAssumptions`.
 *   3. Build a synthetic doc from the extracted constraints, then run
 *      invariants (spec 16) — per-invariant pass/fail captured separately.
 *   4. If `expectedDfm` set, run the DFM check (spec 11). Most entries
 *      lack live geometry so they short-circuit to "n/a"; only those
 *      with synthetic-doc-derived material/geometry are exercised.
 *
 * Outputs:
 *   tests/eval/report.json    — full run report.
 *   tests/eval/baseline.json  — frozen per-invariant pass rates (first run
 *                                seeds, subsequent runs gate against).
 *
 * Exits non-zero if:
 *   - any per-invariant pass-rate drops > 5% vs baseline, OR
 *   - the overall corpus pass-rate is below baseline.overallPassRate − 5%.
 *
 * Flags:
 *   --update-baseline   overwrite baseline.json with current run.
 *   --json              suppress the printable summary, emit JSON only.
 *
 * Run via:
 *   node --import ./src/lib/commands/__tests__/_register.mjs tests/eval/runner.mjs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { extract } from '$lib/extractor/index.js';
import { runAllInvariants, INVARIANTS, SCOPE } from '$lib/invariants/runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CORPUS_DIR  = path.resolve(__dirname, 'corpus');
const REPORT_PATH = path.resolve(__dirname, 'report.json');
const BASELINE_PATH = path.resolve(__dirname, 'baseline.json');

const REGRESSION_THRESHOLD = 0.05;   // 5% drop fails the gate.

// ── Argv ────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const UPDATE_BASELINE = args.has('--update-baseline');
const JSON_ONLY       = args.has('--json');

// ── Corpus loading ──────────────────────────────────────────────────────────

export function loadCorpus(dir = CORPUS_DIR) {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
        const raw = readFileSync(path.join(dir, f), 'utf8');
        const entries = JSON.parse(raw);
        for (const e of entries) {
            if (!e.id || !e.spec) {
                throw new Error(`corpus entry missing id/spec in ${f}: ${JSON.stringify(e).slice(0, 80)}`);
            }
            out.push(e);
        }
    }
    return out;
}

// ── Comparison ──────────────────────────────────────────────────────────────

/**
 * Partial match: every key on `expected` must equal the corresponding key on
 * `actual`. Extras on `actual` are ignored.
 */
export function constraintMatches(expected, actual) {
    if (expected._c !== actual._c) return false;
    for (const k of Object.keys(expected)) {
        if (k === '_c') continue;
        if (expected[k] !== actual[k]) return false;
    }
    return true;
}

/**
 * Compare extracted constraints against an expected list. Returns
 * { matched, missing, extra, ok }.
 */
export function compareConstraints(expectedList, actualList) {
    const expected = expectedList || [];
    const actual = actualList || [];
    const used = new Array(actual.length).fill(false);
    const matched = [];
    const missing = [];
    for (const exp of expected) {
        let foundIdx = -1;
        for (let i = 0; i < actual.length; i++) {
            if (used[i]) continue;
            if (constraintMatches(exp, actual[i])) { foundIdx = i; break; }
        }
        if (foundIdx >= 0) { used[foundIdx] = true; matched.push(exp); }
        else missing.push(exp);
    }
    const extra = actual.filter((_, i) => !used[i]);
    return { matched, missing, extra, ok: missing.length === 0 };
}

/**
 * Compare expected assumptions ('material-grade', 'fastener-length' …) against
 * extracted ambiguities. Returns { matched, missing, ok }. Extras OK.
 */
export function compareAssumptions(expectedList, actualList) {
    const expected = expectedList || [];
    const actual = actualList || [];
    const matched = [];
    const missing = [];
    for (const exp of expected) {
        if (actual.some((a) => a && a.kind === exp.kind)) matched.push(exp);
        else missing.push(exp);
    }
    return { matched, missing, ok: missing.length === 0 };
}

// ── Synthetic doc from constraints ──────────────────────────────────────────

/**
 * Build a minimal doc the invariant runner can chew on. Each `dimension` /
 * `material` / `part_selection` constraint group becomes a synthetic feature
 * with the fields invariants look for.
 *
 * The synthetic doc is intentionally narrow — most invariants will return
 * "not applicable" because there's no kernel geometry, and that's the
 * point: we measure the invariants that *can* fire on spec-level info.
 */
export function synthesiseDoc(constraints) {
    const features = {};
    const components = { 'comp-root': { id: 'comp-root', parentId: null, featureIds: [] } };

    let nextFid = 1;
    const newFid = () => `f-${nextFid++}`;

    // One root feature representing the body, gathering dimensions + material.
    const bodyFid = newFid();
    const bodyFeature = {
        id: bodyFid,
        type: 'body',
        enabled: true,
        params: {},
        outputs: { bodies: [{ id: 'b-1' }] },
    };
    features[bodyFid] = bodyFeature;
    components['comp-root'].featureIds.push(bodyFid);

    for (const c of constraints) {
        if (c._c === 'material') {
            bodyFeature.material = c.material;
            bodyFeature.params.material = c.material;
        } else if (c._c === 'dimension') {
            bodyFeature.params[c.axis] = c.value;
        } else if (c._c === 'part_selection') {
            const fid = newFid();
            features[fid] = {
                id: fid,
                type: 'standardPart',
                enabled: true,
                partRef: {
                    catalogPrefix: c.catalogPrefix,
                    nominalSize: c.nominalSize,
                    qty: c.qty,
                    role: c.role,
                    length: c.length,
                },
                params: { qty: c.qty || 1 },
                outputs: { bodies: [] },
            };
            components['comp-root'].featureIds.push(fid);
        }
    }

    return {
        id: 'doc-eval',
        features,
        components,
        rootComponentId: 'comp-root',
        process: { profile: '3d-print' },
        parameters: {},
    };
}

// ── Per-entry runner ────────────────────────────────────────────────────────

/**
 * Run a single corpus entry. Returns the per-entry record.
 */
export async function runEntry(entry) {
    const extracted = extract(entry.spec);
    const constraints = compareConstraints(entry.expectedConstraints, extracted.constraints);
    const assumptions = compareAssumptions(entry.expectedAssumptions, extracted.ambiguities);

    const doc = synthesiseDoc(extracted.constraints);
    const inv = await runAllInvariants({ doc, profile: doc.process.profile });

    // Per-invariant pass map — id → boolean. Per-feature scope: a single
    // failure of any feature for that invariant counts as a fail.
    const perInvariant = {};
    for (const def of INVARIANTS) perInvariant[def.id] = true;

    for (const scope of [SCOPE.PER_FEATURE, SCOPE.PER_COMPONENT]) {
        const tree = inv.byScope[scope] || {};
        for (const targetId of Object.keys(tree)) {
            const agg = tree[targetId];
            for (const [iid, r] of Object.entries(agg.results || {})) {
                if (r.severity === 'error' || r.severity === 'warning') {
                    perInvariant[iid] = false;
                }
            }
        }
    }
    const docAgg = inv.byScope[SCOPE.PER_DOCUMENT];
    if (docAgg) {
        for (const [iid, r] of Object.entries(docAgg.results || {})) {
            if (r.severity === 'error' || r.severity === 'warning') {
                perInvariant[iid] = false;
            }
        }
    }

    const expectedInvariants = entry.expectedInvariants || null;
    let expectedInvariantsOk = true;
    if (expectedInvariants) {
        for (const iid of expectedInvariants) {
            if (!perInvariant[iid]) { expectedInvariantsOk = false; break; }
        }
    }

    const ok = constraints.ok && assumptions.ok && expectedInvariantsOk;

    return {
        id: entry.id,
        category: entry.category || 'uncategorized',
        ok,
        constraints,
        assumptions,
        perInvariant,
        expectedInvariantsOk,
        notes: entry.notes,
    };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function aggregate(results) {
    const total = results.length;
    const passed = results.filter((r) => r.ok).length;
    const overallPassRate = total ? passed / total : 0;

    const byCategory = {};
    for (const r of results) {
        const c = r.category;
        if (!byCategory[c]) byCategory[c] = { total: 0, passed: 0 };
        byCategory[c].total += 1;
        if (r.ok) byCategory[c].passed += 1;
    }
    for (const c of Object.keys(byCategory)) {
        const v = byCategory[c];
        v.passRate = v.total ? v.passed / v.total : 0;
    }

    const perInvariant = {};
    for (const def of INVARIANTS) perInvariant[def.id] = { total: 0, passed: 0 };
    for (const r of results) {
        for (const iid of Object.keys(r.perInvariant)) {
            if (!perInvariant[iid]) perInvariant[iid] = { total: 0, passed: 0 };
            perInvariant[iid].total += 1;
            if (r.perInvariant[iid]) perInvariant[iid].passed += 1;
        }
    }
    for (const iid of Object.keys(perInvariant)) {
        const v = perInvariant[iid];
        v.passRate = v.total ? v.passed / v.total : 0;
    }

    return { total, passed, overallPassRate, byCategory, perInvariant };
}

// ── Regression gate ─────────────────────────────────────────────────────────

/**
 * Compare current aggregate against baseline. Returns:
 *   { ok, overallDelta, regressions: [{ invariantId, base, now, delta }] }
 *
 * `ok = false` if any per-invariant pass-rate dropped more than the
 * threshold (default 5%), or overall dropped more than the threshold.
 */
export function detectRegressions(now, baseline, threshold = REGRESSION_THRESHOLD) {
    const regressions = [];
    if (!baseline || !baseline.perInvariant) {
        return { ok: true, overallDelta: 0, regressions, baselineMissing: true };
    }
    for (const iid of Object.keys(baseline.perInvariant)) {
        const base = baseline.perInvariant[iid].passRate ?? 0;
        const cur = now.perInvariant[iid]?.passRate ?? 0;
        const delta = cur - base;
        if (delta < -threshold) {
            regressions.push({ invariantId: iid, base, now: cur, delta });
        }
    }
    const overallDelta = (now.overallPassRate ?? 0) - (baseline.overallPassRate ?? 0);
    const ok = regressions.length === 0 && overallDelta >= -threshold;
    return { ok, overallDelta, regressions, baselineMissing: false };
}

// ── Pretty summary ──────────────────────────────────────────────────────────

function fmtPct(x) { return `${(x * 100).toFixed(1)}%`; }

export function summarise(aggregate, gate) {
    const lines = [];
    lines.push('');
    lines.push('=== ParaForm eval — phase 2.6 ===');
    lines.push(`corpus:        ${aggregate.total} entries`);
    lines.push(`overall pass:  ${aggregate.passed}/${aggregate.total} (${fmtPct(aggregate.overallPassRate)})`);
    lines.push('');
    lines.push('by category:');
    for (const cat of Object.keys(aggregate.byCategory).sort()) {
        const v = aggregate.byCategory[cat];
        lines.push(`  ${cat.padEnd(14)} ${v.passed}/${v.total}  ${fmtPct(v.passRate)}`);
    }
    lines.push('');

    const ranked = Object.entries(aggregate.perInvariant)
        .filter(([, v]) => v.total > 0)
        .sort((a, b) => a[1].passRate - b[1].passRate);
    lines.push('weakest invariants (top 5):');
    for (const [iid, v] of ranked.slice(0, 5)) {
        lines.push(`  ${iid.padEnd(40)} ${v.passed}/${v.total}  ${fmtPct(v.passRate)}`);
    }
    lines.push('');

    if (gate) {
        if (gate.baselineMissing) {
            lines.push('baseline: missing — first run will seed tests/eval/baseline.json');
        } else if (gate.ok) {
            lines.push(`baseline: OK (overall Δ ${fmtPct(gate.overallDelta)})`);
        } else {
            lines.push(`baseline: REGRESSION (overall Δ ${fmtPct(gate.overallDelta)})`);
            for (const r of gate.regressions) {
                lines.push(`  ${r.invariantId}: ${fmtPct(r.base)} → ${fmtPct(r.now)} (Δ ${fmtPct(r.delta)})`);
            }
        }
    }
    lines.push('');
    return lines.join('\n');
}

// ── Baseline I/O ────────────────────────────────────────────────────────────

export function loadBaseline(p = BASELINE_PATH) {
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); }
    catch { return null; }
}

export function writeBaseline(aggregate, p = BASELINE_PATH) {
    mkdirSync(path.dirname(p), { recursive: true });
    const baseline = {
        createdAt: new Date().toISOString(),
        overallPassRate: aggregate.overallPassRate,
        perInvariant: aggregate.perInvariant,
        byCategory: aggregate.byCategory,
    };
    writeFileSync(p, JSON.stringify(baseline, null, 2));
    return baseline;
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runAll(corpusDir = CORPUS_DIR) {
    const corpus = loadCorpus(corpusDir);
    const results = [];
    for (const entry of corpus) {
        const r = await runEntry(entry);
        results.push(r);
    }
    const agg = aggregate(results);
    return { results, aggregate: agg };
}

async function main() {
    const { results, aggregate: agg } = await runAll();

    let baseline = loadBaseline();
    if (!baseline || UPDATE_BASELINE) {
        baseline = writeBaseline(agg);
        if (!JSON_ONLY) {
            console.log(`\n[eval] baseline ${UPDATE_BASELINE ? 'updated' : 'seeded'} at ${path.relative(process.cwd(), BASELINE_PATH)}`);
        }
    }

    const gate = detectRegressions(agg, baseline);

    const report = {
        runAt: new Date().toISOString(),
        aggregate: agg,
        gate,
        results,
    };
    mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    if (JSON_ONLY) {
        console.log(JSON.stringify({ ok: gate.ok, aggregate: agg, gate }, null, 2));
    } else {
        console.log(summarise(agg, gate));
        console.log(`report: ${path.relative(process.cwd(), REPORT_PATH)}`);
    }

    process.exit(gate.ok ? 0 : 1);
}

// Only run main when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
    main().catch((e) => {
        console.error('[eval] runner crashed:', e);
        process.exit(2);
    });
}
