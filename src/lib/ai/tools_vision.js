/**
 * Vision tools — let the model SEE.
 *
 *   capture_views    — render the current model from named camera angles and
 *                      return the images for the model to inspect (it "cannot
 *                      see" otherwise). The agent loop pulls the `_images` field
 *                      off the result and feeds them to the vision model.
 *   image_to_sketch  — vectorize the user's most-recently attached image into a
 *                      2D profile (closed polylines) and commit it as a sketch
 *                      the model can then extrude/revolve.
 *
 * Both browser-only paths degrade gracefully (clear ok:false) when there is no
 * viewport / no attachment / no DOM.
 */

import { captureSnapshots, hasSnapshotProvider } from '../../../lib/viewport/snapshot.js';
import { newSketch } from '../../../lib/document/index.js';
import { vectorizeImage, profilesToSketchEntities } from '../sketch/vectorize.js';
import { getLastAttachedImage } from './attachments.js';
import { N, S, B, fail, num } from './tools_util.js';

const VIEW_NAMES = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'isoBack'];

/** Split a data URL into { mediaType, dataBase64 }. */
function splitDataUrl(u) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(u || '');
    if (!m) return null;
    return { mediaType: m[1] || 'image/jpeg', dataBase64: m[2] || '' };
}

/** Decode an attached image (data) into raw RGBA pixels via a canvas. Browser only. */
function decodeImageToPixels(img) {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve(null); return; }
        try {
            const el = new Image();
            el.onload = () => {
                try {
                    const maxSide = 512; // cap tracing resolution for speed
                    const scale = Math.min(1, maxSide / Math.max(el.width || 1, el.height || 1));
                    const w = Math.max(1, Math.round((el.width || 1) * scale));
                    const h = Math.max(1, Math.round((el.height || 1) * scale));
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    if (!ctx) { resolve(null); return; }
                    ctx.drawImage(el, 0, 0, w, h);
                    const id = ctx.getImageData(0, 0, w, h);
                    resolve({ data: id.data, width: w, height: h });
                } catch { resolve(null); }
            };
            el.onerror = () => resolve(null);
            el.src = `data:${img.mediaType || 'image/png'};base64,${img.dataBase64}`;
        } catch { resolve(null); }
    });
}

export const VISION_TOOLS = [
    {
        name: 'capture_views',
        description: [
            'Render the CURRENT model from multiple camera angles and look at the images — you cannot see the geometry otherwise, so use this to VERIFY what was actually built (orientation, proportions, parts clipping, ugly fillets) that numbers alone would not reveal.',
            'Call it after building/editing, or whenever the user asks "does it look right?". Default views are front, right, top, iso. The images are attached to the conversation for you to inspect on your next step.',
        ].join(' '),
        input_schema: {
            type: 'object',
            properties: {
                views: { type: 'array', items: { type: 'string', enum: VIEW_NAMES }, description: 'Named views to render (default: front, right, top, iso)' },
            },
        },
        handler: async (i) => {
            if (!hasSnapshotProvider()) return { ok: false, error: 'No live viewport to capture — the 3D studio viewport is not open.' };
            const views = Array.isArray(i.views) ? i.views.filter((v) => VIEW_NAMES.includes(v)) : undefined;
            const shots = await captureSnapshots(views);
            if (!shots.length) return { ok: false, error: 'Nothing to capture — the model is empty or could not be rendered.' };
            const images = [];
            for (const s of shots) {
                const parsed = splitDataUrl(s.dataUrl);
                if (parsed && parsed.dataBase64) images.push({ view: s.view, mediaType: parsed.mediaType, dataBase64: parsed.dataBase64 });
            }
            if (!images.length) return { ok: false, error: 'Captured views but could not encode the images.' };
            // `_images` is consumed by the agent loop and injected as a vision
            // message; it is stripped from the textual tool result.
            return { ok: true, views: images.map((x) => x.view), note: `Captured ${images.length} view(s); inspect them on your next step.`, _images: images };
        },
    },
    {
        name: 'image_to_sketch',
        description: 'Turn the user\'s most recently ATTACHED image (a hand sketch, logo, silhouette) into a 2D profile and commit it as a sketch you can then extrude/revolve. Trace works best on a high-contrast image (dark shape on light background); set invert:true for a light shape on dark. Returns sketchFeatureId.',
        input_schema: {
            type: 'object',
            properties: {
                plane: S('Plane to place the sketch on', { enum: ['XY', 'XZ', 'YZ'] }),
                sizeMm: N('Fit the longest side of the traced shape to this many mm (default 100)'),
                threshold: N('Brightness cutoff 0-255 for foreground (default 128)'),
                invert: B('Treat the lighter pixels as the shape (for a light shape on a dark background)'),
                name: S('Optional sketch name'),
            },
        },
        handler: async (i) => {
            const img = getLastAttachedImage();
            if (!img || !img.dataBase64) return { ok: false, error: 'No image is attached. Ask the user to attach an image to the chat, then call image_to_sketch.' };
            const px = await decodeImageToPixels(img);
            if (!px) return { ok: false, error: 'Could not decode the attached image (image_to_sketch needs the browser viewport).' };
            let v;
            try {
                v = vectorizeImage({
                    data: px.data, width: px.width, height: px.height,
                    threshold: num(i.threshold, 128), invert: !!i.invert, targetSizeMm: num(i.sizeMm, 100),
                });
            } catch (e) { return fail(e); }
            if (!v || !v.ok) return { ok: false, error: (v && v.error) || 'could not vectorize the image' };
            if (!v.profiles.length) return { ok: false, error: 'No shape found in the image. Try a higher-contrast image, adjust threshold, or set invert.' };
            const entities = profilesToSketchEntities(v.profiles);
            try {
                const plane = ['XY', 'XZ', 'YZ'].includes(i.plane) ? i.plane : 'XY';
                const b = newSketch(plane, { name: i.name || 'TracedSketch' });
                for (const e of entities) {
                    const pts = e.points || [];
                    if (pts.length < 3) continue;
                    for (let j = 0; j < pts.length - 1; j++) b.line(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
                    b.line(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]); // close the loop
                }
                const f = b.commit();
                return { ok: true, featureId: f.id, sketchFeatureId: f.id, profiles: v.profiles.length, summary: `Traced ${v.profiles.length} profile(s) from the image into a sketch on ${plane} — extrude it to make a solid.` };
            } catch (e) { return fail(e); }
        },
    },
];

export default VISION_TOOLS;
