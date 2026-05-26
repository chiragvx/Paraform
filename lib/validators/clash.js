/**
 * Exact WASM clash validator — updatex.md §5A + M3.
 *
 * Takes the candidate pairs that survived the Box3 broad-phase filter
 * (computed in finalizeMultiPartRender) and runs precise OpenSCAD
 * intersection() compiles through the validation worker pool.
 * A returned STL with > 0 triangles means the two parts physically overlap.
 *
 * use <…> directives are extracted from each part source and hoisted to
 * top-level (they are not valid inside a module body in OpenSCAD).
 */

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { scoreboard } from './scoreboard.js';
import { validationPool } from '../worker_pool.js';

let _counter = 5_000_000;
const _loader = new STLLoader();

/** Strip `use`/`include` lines from source; return them separately. */
function hoistDirectives(source) {
    const lines  = source.split('\n');
    const use    = lines.filter(l => /^\s*(use|include)\s*</.test(l));
    const body   = lines.filter(l => !/^\s*(use|include)\s*</.test(l));
    return { use, body: body.join('\n') };
}

function buildIntersectionSource(idA, srcA, idB, srcB) {
    const mA = `_ca_${idA.replace(/\W/g, '_')}`;
    const mB = `_cb_${idB.replace(/\W/g, '_')}`;
    const hA = hoistDirectives(srcA);
    const hB = hoistDirectives(srcB);

    // De-duplicate use lines from both parts
    const useBlock = [...new Set([...hA.use, ...hB.use])].filter(Boolean).join('\n');

    return [
        '$fn = 24;',
        useBlock,
        `module ${mA}() {\n${hA.body}\n}`,
        `module ${mB}() {\n${hB.body}\n}`,
        `intersection() { ${mA}(); ${mB}(); }`,
    ].join('\n');
}

/**
 * Run exact WASM intersection tests for the candidate pairs.
 *
 * @param {[string, string][]} pairs      - Part ID pairs from broad-phase
 * @param {Map<string, string>} sources   - partId → full SCAD source
 * @param {Function}            onDone    - called with Set<string> of exact clashers
 */
export function runExactClashTests(pairs, sources, onDone) {
    if (pairs.length === 0) {
        scoreboard.mark('clash', true);
        onDone(new Set());
        return;
    }

    let pending = pairs.length;
    const clashers = new Set();

    pairs.forEach(([idA, idB]) => {
        const src = buildIntersectionSource(idA, sources.get(idA) || '', idB, sources.get(idB) || '');

        validationPool.dispatch({
            jobId:      ++_counter,
            sourceCode: src,
            format:     'stl',
            isFinal:    true,
            mode:       'clash_test',
            context:    'clash',
        }, (data) => {
            if (data.ok && data.buffer) {
                const geom = _loader.parse(data.buffer);
                if ((geom.attributes?.position?.count ?? 0) > 0) {
                    clashers.add(idA);
                    clashers.add(idB);
                }
            }
            if (--pending === 0) {
                scoreboard.mark('clash', clashers.size === 0);
                onDone(clashers);
            }
        });
    });
}
