// OCCT Import Worker — converts STEP/IGES files to Three.js-compatible mesh data
// Uses occt-import-js (OpenCASCADE WASM) for parsing, lazy-loaded on first use.

let occt = null;

async function initOcct() {
    if (occt) return occt;
    const { default: initOpenCascade } = await import('occt-import-js');
    occt = await initOpenCascade();
    return occt;
}

self.addEventListener('message', async (e) => {
    const { type, fileBuffer, extension, jobId } = e.data;

    if (type !== 'import') return;

    try {
        const oc = await initOcct();

        // Write file to OCCT's virtual filesystem
        const fileName = `input.${extension}`;
        oc.FS.createDataFile('/', fileName, new Uint8Array(fileBuffer), true, true);

        // Parse the file
        const result = oc.ReadStepFile('/' + fileName, null);

        // Clean up VFS
        try { oc.FS.unlink('/' + fileName); } catch (_) {}

        if (!result || !result.success) {
            self.postMessage({ type: 'error', jobId, message: 'OCCT failed to parse file' });
            return;
        }

        // Extract meshes from all shapes
        const meshes = [];
        for (let i = 0; i < result.meshes.length; i++) {
            const mesh = result.meshes[i];
            meshes.push({
                name: mesh.name || `Shape ${i + 1}`,
                vertices: Array.from(mesh.attributes.position.array),
                normals: mesh.attributes.normal ? Array.from(mesh.attributes.normal.array) : null,
                indices: mesh.index ? Array.from(mesh.index.array) : null,
            });
        }

        self.postMessage({ type: 'result', jobId, meshes, extension });
    } catch (err) {
        self.postMessage({ type: 'error', jobId, message: err.message || 'OCCT import failed' });
    }
});
