import { createOpenSCAD } from 'openscad-wasm';

let isRendering = false;
let currentJobId = null;
let cachedEngine = null;

async function getEngine() {
    // Disable caching to ensure maximum memory stability for every job
    const engine = await createOpenSCAD({
        print: (text) => {
            self.postMessage({ type: 'log', text });
        }, 
        printErr: (text) => {
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
    const { type, jobId, sourceCode, format, files } = e.data;

    if (type === 'init') {
        await getEngine();
        self.postMessage({ type: 'ready' });
        return;
    }

    if (isRendering) {
        // This shouldn't happen if the pool is managed correctly, 
        // but if it does, we ignore or we could handle it.
        return;
    }

    await processJob(e.data);
};

async function processJob(jobData) {
    isRendering = true;
    const { jobId, sourceCode, format, files } = jobData;
    currentJobId = jobId;
    
    try {
        const engine = await getEngine();
        const instance = engine.getInstance();
        
        // Write virtual files if provided
        if (files) {
            for (const [path, content] of Object.entries(files)) {
                try {
                    instance.FS.writeFile(path, content);
                } catch (e) {
                    console.error('FS Write Error:', path, e);
                }
            }
        }

        const outName = `output_${jobId}.${format}`;
        instance.FS.writeFile("input.scad", sourceCode);
        
        const startTime = Date.now();
        
        try {
            // Using -D to override variables can be faster than string concatenation sometimes
            // but we are already doing concatenation in main.js.
            // Using --quiet to reduce IO
            const { isFinal } = jobData;
            const args = ["-o", outName, "input.scad", "--quiet"];
            
            const exitCode = instance.callMain(args);
            if (exitCode !== 0) throw new Error(`OpenSCAD exited with code ${exitCode}`);
        } catch (execError) {
            console.error('WASM Execution Crash:', execError);
            // Self-terminate on crash to ensure fresh memory next time
            setTimeout(() => self.close(), 100);
            throw execError;
        }

        const buffer = instance.FS.readFile(outName);
        const bufferCopy = new Uint8Array(buffer).slice().buffer;
        
        // Cleanup FS
        try { instance.FS.unlink(outName); } catch(e) {}

        self.postMessage({ 
            type: 'result',
            jobId, 
            ok: true, 
            buffer: bufferCopy,
            renderTime: Date.now() - startTime
        }, [bufferCopy]);

    } catch (err) {
        self.postMessage({ type: 'result', jobId, ok: false, error: String(err) });
    } finally {
        isRendering = false;
        currentJobId = null;
    }
}
