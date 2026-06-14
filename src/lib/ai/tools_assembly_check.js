/**
 * Assembly-constraint analysis tool — a thin, READ-ONLY AI surface over the
 * global DOF / mobility layer in src/lib/library/assembly_constraints.js.
 *
 *   ASSEMBLY_CHECK_TOOLS — array of { name, description, input_schema, handler }
 *
 * The mate solver places one part at a time (independent pairwise SE(3) solves
 * with no global accounting). This tool answers the questions a per-mate solve
 * can't: is the whole assembly rigid, free to move, fighting itself, or are
 * parts floating unattached? It is pure analysis — it never mutates the
 * document or a connector, so it is connector-contract-safe and lives in
 * NON_MUTATING_TOOLS (agent.js): calling it does not trip the self-repair
 * compile-check.
 *
 * Handler obeys the standard contract: NEVER throws → { ok:false, error }.
 */

import { fail } from './tools_util.js';
import { getDocumentStore } from '../../../lib/document/index.js';
import {
    buildMateGraph,
    classifyConstraint,
    countDOF,
} from '../library/assembly_constraints.js';

const TOOLS = [
    {
        name: 'check_assembly_constraints',
        description:
            'Analyse the WHOLE assembly at once: its mobility (degrees of freedom), any kinematic loops, whether it is under- / exactly- / over-constrained, and which parts are floating (unattached to the grounded root). Use this before declaring a multi-part assembly done — a per-part mate solve cannot tell you the assembly fights itself or that a part never got mated. Read-only.',
        input_schema: { type: 'object', properties: {} },
        handler: () => {
            try {
                const store = getDocumentStore();
                const doc = store && store.doc;
                if (!doc) return fail('no document loaded');
                const graph = buildMateGraph(doc.components, doc.mates, { connectors: doc.connectors });
                const cls = classifyConstraint(graph);
                const dof = countDOF(graph);
                return {
                    ok: true,
                    status: cls.status,            // under- / exactly- / over-constrained
                    mobility: cls.mobility,        // assembly DOF (0 = rigid)
                    reason: cls.reason,
                    floating: cls.floating || [],  // parts with no path to ground
                    loops: (cls.loops || []).map((l) => l.components),
                    offenders: cls.offenders || null,
                    dof,
                };
            } catch (e) {
                return fail(e);
            }
        },
    },
];

export const ASSEMBLY_CHECK_TOOLS = TOOLS;
