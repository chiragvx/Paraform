#!/usr/bin/env node
/**
 * Live-kernel validation harness for ParaForm v4.
 *
 * Loads every fixture under `./validators/*.mjs`, drives each case through:
 *   resetDocumentStore() → fixture.build(store) → emitDocument(doc)
 *     → HttpKernelClient.executeCode(code) → assertion engine → row of output
 *
 * Usage:
 *   npm run validate
 *   VALIDATE_KERNEL=http://127.0.0.1:7823 npm run validate
 *   npm run validate -- --json
 *   npm run validate -- --markdown
 *   npm run validate -- --only=primitives,sketch-based
 *   npm run validate -- --grep=Fillet
 *
 * Exits 0 if every non-stub case passed, 1 otherwise. Stub-skipped cases
 * never fail the run; they exist so we can flag intentionally-no-op kernel
 * functions (Thread / Draft / push_pull_face).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resetDocumentStore, getDocumentStore } from '../lib/document/store.js';
import { emitDocument } from '../lib/document/emit.js';
import { HttpKernelClient } from '../lib/document/kernel_client.js';

// ── Setup ───────────────────────────────────────────────────────────────────

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VALIDATORS_DIR = path.join(ROOT, 'validators');

const ARGS = parseArgs(process.argv.slice(2));
const ENDPOINT = process.env.VALIDATE_KERNEL
    || extractTunnelFromIndex(path.join(ROOT, 'index.html'))
    || 'http://127.0.0.1:7823';

const CLIENT = new HttpKernelClient({ endpoint: ENDPOINT, timeout: 60_000 });

const COLOR = process.stdout.isTTY && !ARGS.json && !ARGS.markdown;
const C = (code) => COLOR ? `\x1b[${code}m` : '';
const GREEN  = C('32'), RED   = C('31'), YELLOW = C('33');
const GREY   = C('90'), DIM   = C('2'),  BOLD   = C('1'), RESET = C('0');

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    if (!ARGS.json && !ARGS.markdown) banner();

    const fixtures = await loadFixtures();
    const onlySet  = ARGS.only ? new Set(ARGS.only.split(',').map(s => s.trim())) : null;
    const grep     = ARGS.grep ? new RegExp(ARGS.grep, 'i') : null;

    const runs = [];
    for (const fixture of fixtures) {
        if (onlySet && !onlySet.has(fixture.category)) continue;
        const cases = await fixture.load();
        for (const c of cases) {
            const fullName = `${fixture.category} · ${c.name}`;
            if (grep && !grep.test(fullName)) continue;
            const result = await runCase(c, fixture.category);
            runs.push({ ...result, name: c.name, category: fixture.category, fixtureFile: fixture.file });
            if (!ARGS.json && !ARGS.markdown) printRow(result, c.name, fixture.category);
        }
    }

    if (ARGS.json) {
        process.stdout.write(JSON.stringify({ endpoint: ENDPOINT, runs }, null, 2) + '\n');
    } else if (ARGS.markdown) {
        writeMarkdown(runs);
    } else {
        printSummary(runs);
    }

    const failed = runs.filter(r => r.status === 'fail').length;
    process.exit(failed === 0 ? 0 : 1);
}

// ── Fixture discovery ───────────────────────────────────────────────────────

async function loadFixtures() {
    if (!fs.existsSync(VALIDATORS_DIR)) {
        console.error(`${RED}No validators/ directory at ${VALIDATORS_DIR}${RESET}`);
        process.exit(2);
    }
    const files = fs.readdirSync(VALIDATORS_DIR)
        .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
        .sort();
    if (!files.length) {
        console.error(`${YELLOW}validators/ is empty — nothing to run.${RESET}`);
        process.exit(0);
    }
    return files.map(file => {
        const category = file.replace(/\.mjs$/, '');
        const full = path.join(VALIDATORS_DIR, file);
        return {
            category,
            file,
            load: async () => {
                const mod = await import(pathToFileURL(full).href);
                const cases = mod.default;
                if (!Array.isArray(cases)) {
                    throw new Error(`${file} must default-export an array of cases`);
                }
                return cases;
            },
        };
    });
}

// ── Per-case runner ─────────────────────────────────────────────────────────

async function runCase(c, category) {
    const t0 = Date.now();
    let store, code, result;

    try {
        store = resetDocumentStore();
        c.build(store);
    } catch (err) {
        return { status: 'fail', stage: 'build', reason: err.message, durationMs: Date.now() - t0 };
    }

    try {
        const out = emitDocument(store.doc);
        code = out.code;
    } catch (err) {
        return { status: 'fail', stage: 'emit', reason: err.message, durationMs: Date.now() - t0 };
    }

    // Python regex pre-check before paying for a kernel round-trip.
    const pyExpect = c.expect && c.expect.python;
    if (pyExpect) {
        const ok = (typeof pyExpect === 'function') ? !!pyExpect(code) : pyExpect.test(code);
        if (!ok) {
            return {
                status: 'fail', stage: 'python', reason: 'python emit did not match expectation',
                detail: code.split('\n').slice(0, 6).join('\n'),
                durationMs: Date.now() - t0,
            };
        }
    }

    // Stub assertion: expects the case NOT to change the body. We still hit
    // the kernel so we know the Python at least executes without error.
    const isStub = !!(c.expect && c.expect.stub);

    try {
        result = await CLIENT.executeCode(code);
    } catch (err) {
        return { status: 'fail', stage: 'kernel', reason: err.message, durationMs: Date.now() - t0 };
    }

    if (!result || !result.ok) {
        if (isStub) return { status: 'stub', reason: result && result.error, durationMs: Date.now() - t0 };
        return {
            status: 'fail', stage: 'kernel',
            reason: (result && result.error) || 'kernel returned !ok',
            detail: code.split('\n').slice(0, 6).join('\n'),
            durationMs: Date.now() - t0,
        };
    }

    // Per-feature assertions
    try {
        const assertions = c.expect || {};
        if (assertions.featureType) {
            const types = Object.values(store.doc.features || {}).map(f => f.type);
            if (!types.includes(assertions.featureType)) {
                return {
                    status: 'fail', stage: 'feature',
                    reason: `expected feature type "${assertions.featureType}" — got [${types.join(', ')}]`,
                    durationMs: Date.now() - t0,
                };
            }
        }
        if (assertions.topology) {
            const detail = assertTopology(result.topology, assertions.topology);
            if (detail) {
                return { status: 'fail', stage: 'topology', reason: detail, durationMs: Date.now() - t0 };
            }
        }
        // Custom hook: receives the live topology + the document and
        // returns null on success or an error string. Used for things
        // that can't be expressed as a simple shape match — e.g. running
        // the JS picker against the live topology to confirm a known
        // query point resolves to the expected descriptor.
        if (typeof assertions.custom === 'function') {
            const detail = await assertions.custom({
                topology: result.topology,
                doc:      store.doc,
                code,
            });
            if (detail) {
                return { status: 'fail', stage: 'custom', reason: detail, durationMs: Date.now() - t0 };
            }
        }
        if (isStub) {
            return { status: 'stub', durationMs: Date.now() - t0, topology: summariseTopology(result.topology) };
        }
        return { status: 'pass', durationMs: Date.now() - t0, topology: summariseTopology(result.topology) };
    } catch (err) {
        return { status: 'fail', stage: 'assert', reason: err.message, durationMs: Date.now() - t0 };
    }
}

// ── Assertions ──────────────────────────────────────────────────────────────

/**
 * Normalise the two topology shapes the kernel might emit into a single
 * `{ faces, edges }` view per node:
 *   - v4 (Phase 1B):  `{ featureId, faces: [{ centerRounded, normalRounded, area, surfaceType }], edges: [...] }`
 *   - v3 (legacy):    `{ nodeId, bodies: [{ faces: [{ center, normal, area }], edges: [...] }] }`
 */
function leafNodeView(topology) {
    if (!topology || !Array.isArray(topology.nodes) || !topology.nodes.length) return null;
    const node = topology.nodes[topology.nodes.length - 1];
    const faces = node.faces ?? node.bodies?.[0]?.faces ?? [];
    const edges = node.edges ?? node.bodies?.[0]?.edges ?? [];
    return { node, faces, edges };
}

function assertTopology(topology, want) {
    if (!topology) return 'kernel response had no topology';
    const view = leafNodeView(topology);
    if (!view) return 'topology.nodes is empty';
    const { faces, edges } = view;

    if (typeof want.faces === 'number' && faces.length !== want.faces) {
        return `expected ${want.faces} faces, got ${faces.length}`;
    }
    if (typeof want.edges === 'number' && edges.length !== want.edges) {
        return `expected ${want.edges} edges, got ${edges.length}`;
    }
    if (want.minFaces != null && faces.length < want.minFaces) {
        return `expected ≥${want.minFaces} faces, got ${faces.length}`;
    }
    if (want.minEdges != null && edges.length < want.minEdges) {
        return `expected ≥${want.minEdges} edges, got ${edges.length}`;
    }
    if (want.face) {
        const matched = faces.find(f => matchFace(f, want.face));
        if (!matched) return `no face matched ${JSON.stringify(want.face)}`;
    }
    return null;
}

function matchFace(face, want) {
    if (!face) return false;
    if (want.normal) {
        const n = normaliseDirection(face.normalRounded || face.normal);
        if (n !== want.normal) return false;
    }
    // Only enforce surfaceType when the face entry actually carries one.
    // The legacy v3 topology shape doesn't expose surfaceType — silently
    // accept rather than failing every face on an older kernel.
    if (want.surfaceType && face.surfaceType && face.surfaceType !== want.surfaceType) return false;
    if (want.minArea != null && (face.area || 0) < want.minArea) return false;
    if (want.maxArea != null && (face.area || 0) > want.maxArea) return false;
    return true;
}

function normaliseDirection(v) {
    if (!Array.isArray(v) || v.length < 3) return '?';
    const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
    if (ax >= ay && ax >= az) return v[0] >= 0 ? '+X' : '-X';
    if (ay >= ax && ay >= az) return v[1] >= 0 ? '+Y' : '-Y';
    return v[2] >= 0 ? '+Z' : '-Z';
}

function summariseTopology(topology) {
    const view = leafNodeView(topology);
    if (!view) return null;
    return { faces: view.faces.length, edges: view.edges.length };
}

// ── Reporters ───────────────────────────────────────────────────────────────

function banner() {
    process.stdout.write(`${BOLD}ParaForm v4 Validation${RESET}\n`);
    process.stdout.write(`  ${DIM}kernel:${RESET} ${ENDPOINT}\n\n`);
}

const _state = { lastCategory: null };
function printRow(result, name, category) {
    if (category !== _state.lastCategory) {
        process.stdout.write(`\n${BOLD}${category}${RESET}\n`);
        _state.lastCategory = category;
    }
    const mark = result.status === 'pass'
        ? `${GREEN}✓${RESET}`
        : result.status === 'stub'
            ? `${YELLOW}○${RESET}`
            : `${RED}✗${RESET}`;
    const topo = result.topology
        ? `${DIM}${result.topology.faces}F · ${result.topology.edges}E${RESET}`
        : '';
    const ms = `${DIM}${String(result.durationMs).padStart(5)} ms${RESET}`;
    process.stdout.write(`  ${mark} ${name.padEnd(40)} ${topo.padEnd(30)} ${ms}\n`);
    if (result.status === 'fail') {
        process.stdout.write(`      ${RED}${result.stage}:${RESET} ${result.reason}\n`);
        if (result.detail) {
            for (const line of String(result.detail).split('\n')) {
                process.stdout.write(`      ${DIM}${line}${RESET}\n`);
            }
        }
    }
}

function printSummary(runs) {
    const pass = runs.filter(r => r.status === 'pass').length;
    const fail = runs.filter(r => r.status === 'fail').length;
    const stub = runs.filter(r => r.status === 'stub').length;
    const totalMs = runs.reduce((acc, r) => acc + r.durationMs, 0);
    process.stdout.write('\n');
    const colour = fail === 0 ? GREEN : RED;
    process.stdout.write(`${colour}${pass} passed${RESET}, `);
    process.stdout.write(`${fail ? RED : DIM}${fail} failed${RESET}, `);
    process.stdout.write(`${stub ? YELLOW : DIM}${stub} stub-skipped${RESET}`);
    process.stdout.write(`${DIM} — ${(totalMs / 1000).toFixed(1)}s${RESET}\n`);
}

function writeMarkdown(runs) {
    const lines = [];
    lines.push('# ParaForm v4 Validation', '');
    lines.push(`- kernel: \`${ENDPOINT}\``);
    lines.push(`- run at: ${new Date().toISOString()}`);
    lines.push('');
    const byCat = new Map();
    for (const r of runs) {
        if (!byCat.has(r.category)) byCat.set(r.category, []);
        byCat.get(r.category).push(r);
    }
    for (const [cat, list] of byCat) {
        lines.push(`## ${cat}`, '');
        for (const r of list) {
            const mark = r.status === 'pass' ? '✅' : r.status === 'stub' ? '⏸️' : '❌';
            const topo = r.topology ? ` — ${r.topology.faces}F / ${r.topology.edges}E` : '';
            lines.push(`- ${mark} **${r.name}**${topo}`);
            if (r.status === 'fail') {
                lines.push(`    - \`${r.stage}\`: ${r.reason}`);
            }
        }
        lines.push('');
    }
    const out = path.join(VALIDATORS_DIR, 'last-run.md');
    fs.writeFileSync(out, lines.join('\n'));
    process.stdout.write(`Wrote ${out}\n`);
}

// ── Small helpers ───────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = {};
    for (const a of argv) {
        if (a === '--json') out.json = true;
        else if (a === '--markdown') out.markdown = true;
        else if (a.startsWith('--only=')) out.only = a.slice('--only='.length);
        else if (a.startsWith('--grep=')) out.grep = a.slice('--grep='.length);
    }
    return out;
}

function extractTunnelFromIndex(file) {
    try {
        const html = fs.readFileSync(file, 'utf8');
        const m = html.match(/__PARAFORM_ENGINE_URL__\s*=\s*['"]([^'"]+)['"]/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

// All declarations are now initialised — kick off the run.
await main();
