/**
 * Corpus-driven test runner for the deterministic spec extractor.
 *
 * Loads every JSON file under `tests/extractor/corpus/`, runs each entry
 * through `extract()`, and asserts:
 *
 *   - For every `expected.constraints[i]`, an actual constraint with the
 *     same `_c` and matching key fields exists. Order doesn't matter.
 *   - Every `expected.ambiguities[i].kind` shows up in the actual
 *     ambiguities list. Extras are allowed (parser may flag more).
 *
 * Per-subparser hit-rate is computed by mapping each expected constraint
 * to the subparser that "owns" it (by `_c` kind) and counting matches.
 *
 * Run via:
 *   node src/lib/extractor/__tests__/extractor.mjs
 *
 * Exit code: 0 if every subparser >= 80%, 1 otherwise.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { extract } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CORPUS_DIR = path.resolve(__dirname, '../../../../tests/extractor/corpus');

/** Map a constraint kind to the subparser responsible. */
const KIND_TO_SUBPARSER = {
    'dimension':       'dimension',
    'part_selection':  'iso_part',
    'fit_class':       'fit_class',
    'material':        'material',
    'spatial':         'spatial',
    'tolerance':       'tolerance',
    'process':         'process',
    'kinematic':       'kinematic',
    'load':            'kinematic',  // load is emitted by kinematic.js
};

/** Comparators per constraint kind. Each returns `true` if `actual`
 * satisfies `expected` (expected is a partial — undefined keys ignored). */
function matchesConstraint(expected, actual) {
    if (expected._c !== actual._c) return false;
    for (const k of Object.keys(expected)) {
        if (k === '_c') continue;
        if (k === 'ambiguities') continue;
        const ev = expected[k];
        const av = actual[k];
        if (ev !== av) return false;
    }
    return true;
}

/** Find the first actual constraint matching expected; null if none. */
function findMatch(expected, actuals, used) {
    for (let i = 0; i < actuals.length; i++) {
        if (used[i]) continue;
        if (matchesConstraint(expected, actuals[i])) return i;
    }
    return -1;
}

function loadCorpus() {
    const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json'));
    const all = [];
    for (const f of files) {
        const cat = f.replace(/\.json$/, '');
        const entries = JSON.parse(readFileSync(path.join(CORPUS_DIR, f), 'utf8'));
        for (const e of entries) all.push({ ...e, category: cat });
    }
    return all;
}

function runOne(entry) {
    const result = extract(entry.text);
    const expected = entry.expected.constraints || [];
    const expectedAmbig = entry.expected.ambiguities || [];

    const used = new Array(result.constraints.length).fill(false);
    const constraintHits = [];
    const constraintMisses = [];

    for (const ec of expected) {
        const idx = findMatch(ec, result.constraints, used);
        if (idx >= 0) {
            used[idx] = true;
            constraintHits.push({ expected: ec, actual: result.constraints[idx] });
        } else {
            constraintMisses.push(ec);
        }
    }

    const ambigKinds = new Set(result.ambiguities.map((a) => a.kind));
    const ambigMisses = expectedAmbig.filter((a) => !ambigKinds.has(a.kind));

    return {
        entry, result,
        hits: constraintHits, misses: constraintMisses,
        ambigMisses,
        pass: constraintMisses.length === 0 && ambigMisses.length === 0,
    };
}

function main() {
    const corpus = loadCorpus();
    console.log(`Loaded ${corpus.length} corpus entries`);

    const subTotals = {};   // { [sub]: { hits, total } }
    const failures = [];
    let entriesPassed = 0;

    for (const entry of corpus) {
        if (entry.xfail) continue;
        const r = runOne(entry);

        // count per-subparser
        for (const h of r.hits) {
            const sub = KIND_TO_SUBPARSER[h.expected._c] || 'other';
            subTotals[sub] ??= { hits: 0, total: 0 };
            subTotals[sub].hits++;
            subTotals[sub].total++;
        }
        for (const m of r.misses) {
            const sub = KIND_TO_SUBPARSER[m._c] || 'other';
            subTotals[sub] ??= { hits: 0, total: 0 };
            subTotals[sub].total++;
        }

        if (r.pass) entriesPassed++;
        else failures.push(r);
    }

    console.log('\n=== Per-subparser accuracy ===');
    let minAccuracy = 1;
    const tableRows = [];
    for (const [sub, t] of Object.entries(subTotals)) {
        const acc = t.total === 0 ? 0 : t.hits / t.total;
        minAccuracy = Math.min(minAccuracy, acc);
        tableRows.push([sub, t.hits, t.total, (acc * 100).toFixed(1) + '%']);
    }
    tableRows.sort((a, b) => a[0].localeCompare(b[0]));
    for (const row of tableRows) {
        console.log(`  ${row[0].padEnd(14)} ${String(row[1]).padStart(3)} / ${String(row[2]).padEnd(3)}  ${row[3]}`);
    }

    console.log(`\nEntries passed: ${entriesPassed} / ${corpus.length}`);

    if (failures.length) {
        console.log('\n=== Failures ===');
        for (const f of failures.slice(0, 20)) {
            console.log(`\n[${f.entry.category}/${f.entry.id}]  "${f.entry.text}"`);
            if (f.misses.length) {
                console.log('  MISSING constraints:');
                for (const m of f.misses) console.log('   -', JSON.stringify(m));
            }
            if (f.ambigMisses.length) {
                console.log('  MISSING ambiguities:');
                for (const m of f.ambigMisses) console.log('   -', JSON.stringify(m));
            }
            console.log('  Actual constraints:');
            for (const c of f.result.constraints) console.log('   +', JSON.stringify(c));
            console.log('  Residual:', JSON.stringify(f.result.residualText));
        }
        if (failures.length > 20) console.log(`\n  ... and ${failures.length - 20} more failures`);
    }

    // Worked example sanity check
    console.log('\n=== Worked example ===');
    const ex = extract('60×40×3 mm aluminum plate with four M3 clearance holes at the corners, 5 mm from each edge');
    console.log('Constraints:');
    for (const c of ex.constraints) console.log('  ', JSON.stringify(c));
    console.log('Ambiguities:', JSON.stringify(ex.ambiguities));
    console.log('Residual:', JSON.stringify(ex.residualText));

    const THRESHOLD = 0.80;
    if (minAccuracy < THRESHOLD) {
        console.log(`\nFAIL — min subparser accuracy ${(minAccuracy*100).toFixed(1)}% < ${THRESHOLD*100}%`);
        process.exit(1);
    } else {
        console.log(`\nOK — all subparsers at or above ${THRESHOLD*100}%`);
    }
}

main();
