import { createOpenSCAD } from 'openscad-wasm';

let isRendering = false;
let currentJobId = null;

// G5 — per-job stderr capture. Reset at the start of every processJob.
let stderrBuffer = [];
let assertMessages = [];

async function getEngine() {
    // No caching — fresh engine every job for memory stability.
    const engine = await createOpenSCAD({
        print: (text) => {
            self.postMessage({ type: 'log', text });
        },
        printErr: (text) => {
            // Always tee into the per-job buffer for G5 surfacing.
            stderrBuffer.push(text);

            // Heuristic: OpenSCAD assertion failures look like
            //   "ERROR: Assertion failed:" or "ERROR: ... in file input.scad"
            if (/assertion failed/i.test(text) || /^ERROR:/i.test(text)) {
                assertMessages.push(text);
            }

            if (text.startsWith('ECHO:') || text.includes('Fontconfig') || text.includes('CGAL')) {
                self.postMessage({ type: 'log', text });
                return;
            }
            console.warn('OpenSCAD Worker:', text);
            self.postMessage({ type: 'log', text, level: 'warn' });
        }
    });
    return engine;
}

self.onmessage = async (e) => {
    const { type } = e.data;

    if (type === 'init') {
        await getEngine();
        self.postMessage({ type: 'ready' });
        return;
    }

    if (isRendering) return;
    await processJob(e.data);
};

// G2 — ensure all parent directories exist in the Emscripten VFS before
// FS.writeFile (which requires them). Walks the path and creates each segment.
function ensureDir(FS, dirPath) {
    const parts = dirPath.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p;
        try { FS.mkdir(cur); } catch (e) { /* already exists */ }
    }
}

function writeVfsFile(FS, path, content) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) ensureDir(FS, path.slice(0, slash));
    FS.writeFile(path, content);
}

async function processJob(jobData) {
    isRendering = true;
    stderrBuffer = [];
    assertMessages = [];

    const { jobId, sourceCode, format, files, mode } = jobData;
    currentJobId = jobId;

    try {
        const engine = await getEngine();
        const instance = engine.getInstance();

        // G2 — write dependency closure (lib/*, assets/*, etc.) into the VFS.
        if (files) {
            for (const [path, content] of Object.entries(files)) {
                try {
                    writeVfsFile(instance.FS, path, content);
                } catch (e) {
                    console.error('FS Write Error:', path, e);
                }
            }
        }

        const outName = `output_${jobId}.${format}`;

        // M3 hook: when mode === 'clash_test', the source has already been
        // wrapped in intersection() {…} by the caller (clash.js).
        // We still compile it as a normal job.
        instance.FS.writeFile("input.scad", sourceCode);

        const startTime = Date.now();

        try {
            const args = ["-o", outName, "input.scad", "--quiet"];
            const exitCode = instance.callMain(args);
            if (exitCode !== 0) throw new Error(`OpenSCAD exited with code ${exitCode}`);
        } catch (execError) {
            console.error('WASM Execution Crash:', execError);
            setTimeout(() => self.close(), 100);
            throw execError;
        }

        const buffer = instance.FS.readFile(outName);
        const bufferCopy = new Uint8Array(buffer).slice().buffer;

        try { instance.FS.unlink(outName); } catch (e) {}

        self.postMessage({
            type: 'result',
            jobId,
            ok: true,
            buffer: bufferCopy,
            renderTime: Date.now() - startTime,
            // G5 — surface the structured stderr / assert list to the main thread.
            stderr: stderrBuffer.slice(),
            assertMessages: assertMessages.slice(),
            mode: mode || 'normal'
        }, [bufferCopy]);

    } catch (err) {
        self.postMessage({
            type: 'result',
            jobId,
            ok: false,
            error: String(err),
            stderr: stderrBuffer.slice(),
            assertMessages: assertMessages.slice(),
            mode: mode || 'normal'
        });
    } finally {
        isRendering = false;
        currentJobId = null;
    }
}
