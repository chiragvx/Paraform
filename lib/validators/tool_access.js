/**
 * Tool-access corridor validator — updatex.md §5B + M3.
 *
 * For every fastener_m*_cap() call that supplies an access_depth argument,
 * generate the matching tool-access cylinder and intersection-test it against
 * every other part in the assembly. A non-empty result means the corridor is
 * physically blocked — the driver can't reach the fastener.
 */

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { scoreboard } from './scoreboard.js';
import { validationPool } from '../worker_pool.js';

let _counter = 6_000_000;
const _loader = new STLLoader();

// Outer tool-corridor diameter by bolt size (M2–M5), mm
const CORRIDOR_D = { 2: 4.4, 3: 7.0, 4: 9.0, 5: 11.0 };

const FASTENER_RE = /\b(fastener_m(\d+)_cap)\s*\(\s*([^)]*)\)/g;
const DEPTH_RE    = /access_depth\s*=\s*([\d.]+)/;

function parseFasteners(partId, source) {
    const hits = [];
    let m;
    const re = new RegExp(FASTENER_RE.source, 'g');
    while ((m = re.exec(source)) !== null) {
        const dm = DEPTH_RE.exec(m[3]);
        if (!dm) continue;
        hits.push({
            partId,
            fn:    m[1],
            size:  parseInt(m[2], 10),
            depth: parseFloat(dm[1]),
        });
    }
    return hits;
}

function buildCorridorClashSource(corridorD, accessDepth, otherSrc) {
    const lines    = otherSrc.split('\n');
    const useLines = lines.filter(l => /^\s*(use|include)\s*</.test(l));
    const body     = lines.filter(l => !/^\s*(use|include)\s*</.test(l)).join('\n');
    return [
        '$fn = 16;',
        ...useLines,
        `module _corridor() { cylinder(d=${corridorD}, h=${accessDepth + 2}, $fn=16); }`,
        `module _other()    { ${body} }`,
        `intersection() { _corridor(); _other(); }`,
    ].join('\n');
}

/**
 * @param {Map<string, string>} partSources - partId → SCAD source
 * @param {Function}            onDone      - called with { blocked: [{partId, fastener, blocker}] }
 */
export function runToolAccessTests(partSources, onDone) {
    const fasteners = [];
    for (const [partId, src] of partSources) {
        fasteners.push(...parseFasteners(partId, src));
    }

    if (fasteners.length === 0) {
        scoreboard.mark('toolPath', true);
        onDone({ blocked: [] });
        return;
    }

    const partIds = [...partSources.keys()];
    const jobs = fasteners.flatMap(f =>
        partIds
            .filter(id => id !== f.partId)
            .map(otherId => ({ ...f, otherId }))
    );

    if (jobs.length === 0) {
        scoreboard.mark('toolPath', true);
        onDone({ blocked: [] });
        return;
    }

    let pending = jobs.length;
    const blocked = [];

    jobs.forEach(({ partId, fn, size, depth, otherId }) => {
        const d   = CORRIDOR_D[size] ?? 7.0;
        const src = buildCorridorClashSource(d, depth, partSources.get(otherId) || '');

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
                    blocked.push({ partId, fastener: fn, blocker: otherId });
                }
            }
            if (--pending === 0) {
                scoreboard.mark('toolPath', blocked.length === 0, blocked.length ? blocked : null);
                onDone({ blocked });
            }
        });
    });
}
