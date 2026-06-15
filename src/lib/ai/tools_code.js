/**
 * Code escape-hatch tools — let the model write/edit raw build123d Python when
 * (and ONLY when) the typed-op surface genuinely can't express the geometry.
 *
 * The typed tools (addBox, addExtrude, addGear, placeLibraryPart, …) remain the
 * default and the safety rail; they are deterministic, undoable, and verifiable.
 * A hand-written script is the last resort for things the typed ops can't reach:
 * complex lofts/sweeps along math curves, equation-driven surfaces, algorithmic
 * lattices, text, and other generative geometry.
 *
 * Both tools map onto the existing BuildScript feature via addBuildScript /
 * updateBuildScript (lib/document/operations.js). They follow the standard tool
 * contract: never throw, return a JSON-serialisable result with an `ok` field,
 * and on a create return the standard write-op envelope so the agent can chain
 * on the featureId.
 *
 * THE `result =` CONTRACT (pinned — the rest of the system relies on it): a
 * BuildScript's code must assign the final build123d body to a variable named
 * exactly `result` to render anything. A script that assigns no `result` is
 * "helper-only" and produces no geometry. Both tool descriptions teach this so
 * the model never writes a script that silently renders nothing.
 *
 * Every script is run through guardScript() FIRST — a fast static pre-check that
 * rejects filesystem/network/process imports and reflection escapes before
 * anything is committed. It is not a security boundary (the kernel sandbox is);
 * it just gives the model immediate, specific feedback.
 */

import { addBuildScript, updateBuildScript } from '../../../lib/document/index.js';
import { guardScript } from './script_guard.js';
import { S } from './tools_util.js';

export const CODE_TOOLS = [
    {
        name: 'writeBuildScript',
        description:
            'ESCAPE HATCH — create a new body from raw build123d Python. PREFER THE TYPED OPS (addBox/addExtrude/addRevolve/addSketch/addGear/placeLibraryPart/…) and the part library; drop to a script ONLY for geometry the typed ops genuinely cannot express: lofts/sweeps along math curves, equation-driven surfaces, algorithmic lattices/voronoi, text, parametric generative shapes. ' +
            'The code is build123d 0.10, world Z-UP, millimetres. You MUST `from build123d import *` and assign the final body to a variable named exactly `result` (e.g. `result = part.part` or `result = my_solid`) — a script that assigns no `result` renders NOTHING. ' +
            'After writing, the system auto-compiles the model; if it fails you get the kernel error back and must repair your own script (call editBuildScript). ' +
            'SANDBOX: filesystem, network, and process access are blocked — do NOT import os/sys/subprocess/socket/shutil/pathlib/requests/etc.; only build123d, math, and numpy are available. ' +
            'To give your custom part snap points, use declareConnector after it compiles (create-only / immutable).',
        input_schema: {
            type: 'object',
            properties: {
                code: S('The full build123d Python source. MUST `from build123d import *` and assign `result = <final body>` to render. Z-up, mm. No filesystem/network/process imports.'),
                name: S('Optional display name for the scripted body'),
                componentId: S('Target component id (default: active / root)'),
            },
            required: ['code'],
        },
        handler: (i) => {
            const code = String(i.code || '');
            const g = guardScript(code);
            if (!g.ok) return { ok: false, error: g.error };
            const f = addBuildScript({ code, name: i.name, componentId: i.componentId });
            if (!f || !f.id) return { ok: false, error: 'addBuildScript did not return a feature' };
            return { ok: true, featureId: f.id, name: f.name, summary: `BuildScript ${f.name}` };
        },
    },
    {
        name: 'editBuildScript',
        description:
            'Replace the Python source of an existing scripted-body feature (a BuildScript created with writeBuildScript). Use this to REPAIR a script the auto-compile flagged, or to revise custom geometry — pass the featureId and the complete new code. ' +
            'Same rules as writeBuildScript: build123d 0.10, Z-up, mm, MUST `from build123d import *` and assign `result = <final body>` to render, no filesystem/network/process imports. ' +
            'For typed features (boxes, extrudes, fillets, …) use setFeatureParams instead — editBuildScript only edits BuildScript features.',
        input_schema: {
            type: 'object',
            properties: {
                featureId: S('Id of the BuildScript feature to edit'),
                code: S('The full replacement build123d Python source. MUST `from build123d import *` and assign `result = <final body>` to render.'),
                name: S('Optional new display name'),
            },
            required: ['featureId', 'code'],
        },
        handler: (i) => {
            const code = String(i.code || '');
            const g = guardScript(code);
            if (!g.ok) return { ok: false, error: g.error };
            const f = updateBuildScript(i.featureId, { code, name: i.name });
            if (!f) return { ok: false, error: `no BuildScript feature with id ${i.featureId}` };
            return { ok: true, featureId: i.featureId, summary: `Edited script ${i.featureId}` };
        },
    },
];

export default CODE_TOOLS;
