#!/usr/bin/env node
/**
 * author_part.mjs — AI part-authoring pipeline (Phase 4).
 *
 * Turn a compact datasheet/connector-intent spec into a validated PartRecord
 * JSON file dropped into src/lib/library/parts/, and (for standard-part
 * sources) print the kernel builder stub + catalog entry to add.
 *
 * The model (or a human) writes a small spec; this script:
 *   1. expands it into a full PartRecord (filling parent ids, defaults),
 *   2. runs validatePartRecord and REFUSES to write an invalid record,
 *   3. appends to the target parts/*.json array (creating it if absent),
 *   4. for source:"standard-part", prints the kernel builder/catalog snippet.
 *
 * Usage:
 *   node scripts/author_part.mjs <spec.json> [--file servos.json] [--dry-run]
 *   node scripts/author_part.mjs --example        # print an example spec
 *
 * Spec shape (see --example):
 *   {
 *     "id": "lib-part-...", "name": "...", "category": "<PART_CATEGORIES>",
 *     "source": "parametric" | "standard-part" | "glb" | "composite",
 *     "catalogId": "...",            // standard-part only
 *     "dims": { ... },               // standard-part only — printed in stub
 *     "snippet": "build123d code",   // parametric only (optional)
 *     "boundingBox": { "min":[x,y,z], "max":[x,y,z] },
 *     "tags": [...], "keywords": [...],
 *     "connectors": [
 *       { "id","kind","gender","axis":[...],"origin":[...],"size":{"nominal","unit"},
 *         "mates_with":[...],"inducedJoint":"fixed|revolute|prismatic",
 *         "role":"...", "interfaceId":"..." }
 *     ]
 *   }
 *
 * The script imports validatePartRecord from the real schema so the record is
 * checked against exactly the loader's contract — no drift.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PARTS_DIR = path.join(REPO, 'src', 'lib', 'library', 'parts');

const { validatePartRecord } = await import(
    url.pathToFileURL(path.join(REPO, 'src', 'lib', 'library', 'schema.js')).href
);

const EXAMPLE = {
    id: 'lib-part-servo-example',
    name: 'Example Servo',
    category: 'misc',
    source: 'standard-part',
    catalogId: 'servo-example',
    dims: { bodyL: 22.8, bodyW: 12.2, bodyH: 22.5, flangeEar: 4.6, flangeT: 2.5, flangeZ: 15.9, bossR: 5.5, bossH: 4, shaftR: 2.4, shaftH: 6, shaftX: -5.5 },
    boundingBox: { min: [-16, -6.1, 0], max: [16, 6.1, 32.5] },
    tags: ['servo', 'example'],
    keywords: ['servo', 'example'],
    connectors: [
        { id: 'mount', kind: 'planar', gender: 'neutral', role: 'servo-mount', interfaceId: 'servo-mount-9g',
          size: { nominal: '9g', unit: 'mm' }, axis: [0, 0, 1], origin: [0, 0, 16.5], mates_with: ['planar'], inducedJoint: 'fixed' },
        { id: 'shaft', kind: 'shaft', gender: 'male', role: 'output-shaft', interfaceId: 'spline-SG90',
          size: { nominal: 4.8, unit: 'mm' }, axis: [0, 0, 1], origin: [-5.5, 0, 31.5], mates_with: ['bore'], inducedJoint: 'revolute' },
    ],
};

/** Expand a compact spec into a full PartRecord. */
export function buildPartRecord(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
    if (!spec.id) throw new Error('spec.id required');

    const connectors = (spec.connectors || []).map((c) => {
        const out = {
            id: c.id,
            parent: spec.id,                       // auto-fill parent id
            kind: c.kind,
            gender: c.gender || 'neutral',
            size: c.size || { nominal: 'auto', unit: 'mm' },
            axis: c.axis || [0, 0, 1],
            origin: c.origin || [0, 0, 0],
            mates_with: c.mates_with || [c.kind],
            inducedJoint: c.inducedJoint || 'fixed',
            metadata: c.metadata || {},
        };
        if (c.role !== undefined) out.role = c.role;
        if (c.interfaceId !== undefined) out.interfaceId = c.interfaceId;
        return out;
    });

    let build;
    if (spec.source === 'standard-part') {
        build = { type: 'standard-part', catalogId: spec.catalogId, params: spec.params || {} };
    } else if (spec.source === 'parametric') {
        build = { type: 'parametric', snippet: spec.snippet || `# TODO ${spec.id}\nfrom build123d import Box\nbody = Box(10, 10, 10)` };
    } else if (spec.source === 'composite') {
        build = null;
    } else {
        build = spec.build || null;
    }

    const rec = {
        id: spec.id,
        name: spec.name || spec.id,
        category: spec.category,
        source: spec.source,
        build,
        connectors,
        tags: spec.tags || [],
        keywords: spec.keywords || [],
        boundingBox: spec.boundingBox || null,
    };
    if (spec.source === 'composite' && spec.members) rec.members = spec.members;
    if (spec.manufacturer) rec.manufacturer = spec.manufacturer;
    return rec;
}

/** Print the kernel builder + catalog stub for a standard-part spec. */
function printKernelStub(spec) {
    if (spec.source !== 'standard-part') return;
    const dims = JSON.stringify(spec.dims || {}, null, 2).replace(/\n/g, '\n  ');
    console.log('\n── Kernel-side TODO (b123d_server/standard_parts/) ──');
    console.log(`Add this catalog entry (e.g. in a *.json registered by catalog.py):`);
    console.log(JSON.stringify({
        id: spec.catalogId,
        standard: spec.standard || 'generic',
        category: spec.kernelCategory || 'Servo',
        nominalSize: spec.nominalSize || spec.catalogId,
        name: spec.name,
        dims: spec.dims || {},
        bbox: spec.boundingBox || null,
    }, null, 2));
    console.log(`\nEnsure build.py's _BUILDERS maps category "${spec.kernelCategory || 'Servo'}" to a builder`);
    console.log(`(build_servo / build_standoff / build_horn / build_keepout in mechatronic.py).`);
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--example')) {
        console.log(JSON.stringify(EXAMPLE, null, 2));
        return;
    }
    const specPath = argv.find((a) => !a.startsWith('--'));
    if (!specPath) {
        console.error('usage: node scripts/author_part.mjs <spec.json> [--file <name>.json] [--dry-run]');
        console.error('       node scripts/author_part.mjs --example');
        process.exit(2);
    }
    const dryRun = argv.includes('--dry-run');
    const fileFlagIdx = argv.indexOf('--file');
    const targetFile = fileFlagIdx >= 0 ? argv[fileFlagIdx + 1] : null;

    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    const specs = Array.isArray(spec) ? spec : [spec];

    // Group by target file (default: <category>s.json).
    const byFile = new Map();
    for (const s of specs) {
        const rec = buildPartRecord(s);
        const v = validatePartRecord(rec);
        if (!v.ok) {
            console.error(`REFUSING to write ${rec.id}: invalid record — ${v.errors.join('; ')}`);
            process.exit(1);
        }
        const fname = targetFile || `${rec.category}s.json`;
        if (!byFile.has(fname)) byFile.set(fname, []);
        byFile.get(fname).push(rec);
        printKernelStub(s);
    }

    if (dryRun) {
        for (const [fname, recs] of byFile) {
            console.log(`\n── ${fname} (dry-run, would write ${recs.length} record(s)) ──`);
            console.log(JSON.stringify(recs, null, 2));
        }
        return;
    }

    if (!existsSync(PARTS_DIR)) await mkdir(PARTS_DIR, { recursive: true });
    for (const [fname, recs] of byFile) {
        const full = path.join(PARTS_DIR, fname);
        let existing = [];
        if (existsSync(full)) {
            const txt = await readFile(full, 'utf8');
            const parsed = JSON.parse(txt);
            existing = Array.isArray(parsed) ? parsed : [parsed];
        }
        const ids = new Set(existing.map((r) => r.id));
        let added = 0;
        for (const rec of recs) {
            if (ids.has(rec.id)) {
                console.warn(`skip ${rec.id}: already present in ${fname}`);
                continue;
            }
            existing.push(rec);
            ids.add(rec.id);
            added++;
        }
        await writeFile(full, JSON.stringify(existing, null, 2) + '\n');
        console.log(`wrote ${added} record(s) to ${path.relative(REPO, full)} (now ${existing.length} total)`);
    }
}

// Only run main() when invoked as a script (not when imported by a test).
if (import.meta.url === url.pathToFileURL(process.argv[1] || '').href) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
