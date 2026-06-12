#!/usr/bin/env node
/**
 * UI validation bot.
 *
 *   - Launches the kernel + Vite if they aren't already running.
 *   - Opens the app in Chromium via Playwright.
 *   - Runs scenarios from `validators/ui/*.mjs`. Each scenario is a list of
 *     steps; each step optionally runs code inside the page (against
 *     `window.__pf4`), waits for the next kernel render, then captures a
 *     PNG of the viewport canvas.
 *   - Writes `screenshots/<scenario>/<NN-step>.png` and a top-level
 *     `screenshots/index.html` for visual review.
 *
 * Usage:
 *   npm run ui:validate                       # all scenarios
 *   npm run ui:validate -- --only=fillet      # one scenario
 *   npm run ui:validate -- --headed           # show the browser
 *   npm run ui:validate -- --url=http://...   # use a running dev server
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright';

const ROOT      = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCEN_DIR  = path.join(ROOT, 'validators', 'ui');
const OUT_DIR   = path.join(ROOT, 'screenshots');
const VITE_PORT = 1420;
const KERNEL_PORT = 7823;

const ARGS = parseArgs(process.argv.slice(2));
const URL  = ARGS.url || `http://127.0.0.1:${VITE_PORT}`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const spawned = [];
    try {
        await ensureKernel(spawned);
        await ensureVite(spawned);

        const scenarios = await loadScenarios();
        if (!scenarios.length) {
            console.error('No scenarios found under validators/ui/');
            process.exit(2);
        }

        if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
        fs.mkdirSync(OUT_DIR, { recursive: true });

        const browser = await chromium.launch({ headless: !ARGS.headed });
        const ctx     = await browser.newContext({
            viewport: { width: 1600, height: 1000 },
            deviceScaleFactor: 1,
        });

        const report = { startedAt: new Date().toISOString(), scenarios: [] };

        for (const sc of scenarios) {
            if (sc.skip) {
                report.scenarios.push({
                    slug: sc.slug, name: sc.name, status: 'skip',
                    skipReason: sc.skip, steps: [], durationMs: 0,
                });
                console.log(`  ⊝ ${sc.name.padEnd(50)} skipped — ${sc.skip}`);
                continue;
            }
            const t0 = Date.now();
            const result = await runScenario(ctx, sc);
            result.durationMs = Date.now() - t0;
            report.scenarios.push(result);

            const mark = result.status === 'pass' ? '✓' : '✗';
            const ms = `${result.durationMs} ms`;
            console.log(`  ${mark} ${sc.name.padEnd(50)} ${result.steps.length}/${sc.steps.length} steps  ${ms}`);
            if (result.status === 'fail') {
                console.log(`      ${result.failedStep || '?'}: ${result.error}`);
            }

        }

        await browser.close();

        writeIndexHtml(report);
        writeJsonReport(report);

        const failed = report.scenarios.filter(s => s.status === 'fail').length;
        const total  = report.scenarios.length;
        console.log(`\n${total - failed}/${total} scenarios passed`);
        console.log(`Report: ${path.join(OUT_DIR, 'index.html')}`);
        process.exit(failed ? 1 : 0);
    } finally {
        for (const child of spawned) {
            try { child.kill(); } catch {}
        }
    }
}

// ── Scenario loading ──────────────────────────────────────────────────────────

async function loadScenarios() {
    if (!fs.existsSync(SCEN_DIR)) return [];
    const files = fs.readdirSync(SCEN_DIR)
        .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
        .sort();

    const onlySet = ARGS.only ? new Set(ARGS.only.split(',').map(s => s.trim())) : null;
    const out = [];
    for (const file of files) {
        const slug = file.replace(/\.mjs$/, '');
        if (onlySet && !onlySet.has(slug)) continue;
        const mod = await import(pathToFileURL(path.join(SCEN_DIR, file)).href);
        const sc = mod.default;
        if (!sc || !Array.isArray(sc.steps)) {
            console.warn(`Skipping ${file} — no default export with steps[]`);
            continue;
        }
        out.push({ slug, name: sc.name || slug, steps: sc.steps, skip: sc.skip || null,
                   cameraDir: sc.cameraDir || null, wireframe: !!sc.wireframe,
                   sectionAxis: sc.sectionAxis || null });
    }
    return out;
}

// ── Per-scenario runner ───────────────────────────────────────────────────────

async function runScenario(ctx, sc) {
    const scDir = path.join(OUT_DIR, sc.slug);
    fs.mkdirSync(scDir, { recursive: true });

    const page = await ctx.newPage();
    const result = {
        slug: sc.slug, name: sc.name, status: 'pass',
        steps: [], error: null, failedStep: null,
    };

    page.on('pageerror', err => {
        console.warn(`  [pageerror] ${sc.slug}: ${err.message}`);
    });
    page.on('console', msg => {
        if (msg.type() === 'error') console.warn(`  [console.error] ${sc.slug}: ${msg.text()}`);
    });

    try {
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Wipe persisted v4 documents from the previous session before the
        // app gets a chance to restore them, so every scenario starts on a
        // truly empty document. Reload to re-init the panel + store.
        await page.evaluate(() => {
            try { localStorage.clear(); sessionStorage.clear(); } catch {}
        });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await waitForAppReady(page);
        await ensureViewportSized(page);
        // Plant the scenario's preferred camera direction so every step's
        // screenshot uses it. Default iso (slightly top-heavy) when null.
        await page.evaluate(({ dir, wireframe, sectionAxis }) => {
            window.__paraform_cam_dir__ = dir;
            window.__paraform_wireframe__ = wireframe;
            window.__paraform_section__ = sectionAxis;
        }, { dir: sc.cameraDir, wireframe: sc.wireframe, sectionAxis: sc.sectionAxis });

        for (let i = 0; i < sc.steps.length; i++) {
            const step = sc.steps[i];
            const stepResult = await runStep(page, step, i, scDir, sc);
            result.steps.push(stepResult);
            if (stepResult.status === 'fail') {
                result.status = 'fail';
                result.failedStep = step.label;
                result.error = stepResult.error;
                break;
            }
        }
    } catch (err) {
        result.status = 'fail';
        result.error = err.message;
    } finally {
        await page.close();
    }
    return result;
}

async function runStep(page, step, idx, scDir, sc) {
    const stepResult = {
        label: step.label || `step ${idx + 1}`,
        status: 'pass',
        screenshot: null,
        topology: null,
        error: null,
    };

    try {
        // Execute the step's code inside the page if provided.
        if (typeof step.run === 'function') {
            const src = step.run.toString();
            await page.evaluate(async (fnSrc) => {
                const fn = eval(`(${fnSrc})`);
                const pf4 = window.__pf4;
                const refs = await import('/lib/picking/refs.js');
                const picking = await import('/lib/picking/selection.js');
                const picker = await import('/lib/picking/face_picker.js');
                const ctx = {
                    ops: pf4.ops,
                    sketch: pf4.sketch,
                    store: pf4.store,
                    bridge: pf4.bridge,
                    picking: picking.getPickingSelection(),
                    refs,
                    pickNearestEdge: picker.pickNearestEdge,
                    pickNearestFace: picker.pickNearestFace,
                    getLastTopology: () => (pf4.bridge.lastResult && pf4.bridge.lastResult.topology) || null,
                };
                await fn(ctx);
            }, src);
        }

        // Wait for the kernel render unless explicitly skipped. A render
        // timeout isn't fatal — some steps (bare sketches, parameter
        // declarations, selection-only mutations) legitimately don't
        // produce geometry. We just screenshot whatever's on screen and
        // continue; assertions decide whether that's a real failure.
        const shouldWait = step.waitRender !== false && typeof step.run === 'function';
        if (shouldWait) {
            try {
                const kernelErr = await waitForNextRender(page, step.timeoutMs || 6_000);
                if (kernelErr) stepResult.kernelError = kernelErr;
            } catch (err) {
                stepResult.note = String(err.message || err);
            }
        }

        // Tiny settle for the GLB→three.js mesh swap inside the bridge.
        await page.waitForTimeout(120);

        // Capture topology snapshot for the report.
        stepResult.topology = await page.evaluate(() => {
            const r = window.__pf4 && window.__pf4.bridge && window.__pf4.bridge.lastResult;
            const t = r && r.topology;
            if (!t || !Array.isArray(t.nodes) || !t.nodes.length) return null;
            const leaf = t.nodes[t.nodes.length - 1];
            return {
                features: Object.keys(window.__pf4.store.doc.features || {}).length,
                faces:    (leaf.faces || []).length,
                edges:    (leaf.edges || []).length,
            };
        });

        // Screenshot the canvas via Three.js toDataURL (preserveDrawingBuffer
        // is on, so the last frame is still in the back-buffer). Composite a
        // title bar on top so the exported PNG is self-describing.
        const title = {
            scenario: sc?.name ?? '',
            step: stepResult.label,
            topo: stepResult.topology,
        };
        // Snap the camera to a canonical iso framed on the current body
        // AND screenshot in the same evaluate, so no animation tick or
        // controls damping can drift the camera between the two.
        const composed = await page.evaluate(({ titleText, subText, topoText }) => {
            const view = window.__PARAFORM_VIEWPORT__;
            const bridge = window.__pf4 && window.__pf4.bridge;
            if (!view || !view.camera || !view.controls) return;
            const THREE = view.scene && view.scene.isObject3D ? view.scene.constructor.prototype.__three || null : null;
            const target = view.controls.target;
            // Compute world-space AABB of the body group.
            const body = bridge && bridge.bodyTransform;
            let cx = 0, cy = 0, cz = 0, maxDim = 50;
            if (body) {
                const box = { min: { x: +Infinity, y: +Infinity, z: +Infinity },
                              max: { x: -Infinity, y: -Infinity, z: -Infinity }, empty: true };
                body.updateMatrixWorld(true);
                body.traverse(o => {
                    if (!o.geometry || !o.geometry.boundingBox) {
                        if (o.geometry && o.geometry.computeBoundingBox) o.geometry.computeBoundingBox();
                    }
                    const bb = o.geometry && o.geometry.boundingBox;
                    if (!bb) return;
                    // Transform the local bbox corners to world.
                    const corners = [
                        [bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z],
                        [bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z],
                        [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z],
                        [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z],
                    ];
                    const m = o.matrixWorld.elements;
                    for (const [x, y, z] of corners) {
                        const wx = m[0]*x + m[4]*y + m[8] *z + m[12];
                        const wy = m[1]*x + m[5]*y + m[9] *z + m[13];
                        const wz = m[2]*x + m[6]*y + m[10]*z + m[14];
                        if (wx < box.min.x) box.min.x = wx; if (wx > box.max.x) box.max.x = wx;
                        if (wy < box.min.y) box.min.y = wy; if (wy > box.max.y) box.max.y = wy;
                        if (wz < box.min.z) box.min.z = wz; if (wz > box.max.z) box.max.z = wz;
                        box.empty = false;
                    }
                });
                if (!box.empty) {
                    cx = (box.min.x + box.max.x) / 2;
                    cy = (box.min.y + box.max.y) / 2;
                    cz = (box.min.z + box.max.z) / 2;
                    maxDim = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) || 50;
                }
            }
            // Iso direction (+X, -Y, +Z) normalized — gives the SolidWorks
            // front-right-top view. Aspect-aware distance so wide bodies
            // (like a 30×30×3 slab) still fit, and a fat 2.5× safety
            // multiplier so the body always sits comfortably inside the
            // frame rather than clipping at the edges.
            const aspect = view.camera.aspect || 1.6;
            const fovV = ((view.camera.fov || 50) * Math.PI) / 180;
            const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
            const fitV = (maxDim / 2) / Math.tan(fovV / 2);
            const fitH = (maxDim / 2) / Math.tan(fovH / 2);
            const dist = Math.max(fitV, fitH) * 2.5;
            // Steepened iso (1, -1, 1.7) gives a more top-heavy view so
            // features cut into the top face (holes, slots) are visible
            // rather than hidden behind the upper edge. A scenario may
            // override this with `cameraDir: [x, y, z]` for top/front/etc.
            const DIR = window.__paraform_cam_dir__ || [1, -1, 1.7];
            const dirLen = Math.hypot(...DIR);
            const ux = DIR[0] / dirLen, uy = DIR[1] / dirLen, uz = DIR[2] / dirLen;
            view.camera.position.set(cx + ux * dist, cy + uy * dist, cz + uz * dist);
            view.camera.up.set(0, 0, 1);
            target.set(cx, cy, cz);
            view.camera.lookAt(cx, cy, cz);
            // Re-fit near/far so the body isn't clipped by tight planes.
            view.camera.near = Math.max(0.1, dist / 100);
            view.camera.far  = dist * 10;
            view.camera.updateProjectionMatrix();
            if (view.controls.update) view.controls.update();
            const r = view.renderer;
            // Re-compute world AABB summary for the report (this is the
            // same body we used above, just exposed for debugging).
            const dbgBox = { min: [+Infinity, +Infinity, +Infinity], max: [-Infinity, -Infinity, -Infinity] };
            if (body) {
                body.traverse(o => {
                    if (!o.geometry) return;
                    if (o.geometry.computeBoundingBox && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
                    const bb = o.geometry.boundingBox; if (!bb) return;
                    const m = o.matrixWorld.elements;
                    const cs = [
                        [bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z],
                        [bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z],
                        [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z],
                        [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z],
                    ];
                    for (const [x, y, z] of cs) {
                        const wx = m[0]*x + m[4]*y + m[8] *z + m[12];
                        const wy = m[1]*x + m[5]*y + m[9] *z + m[13];
                        const wz = m[2]*x + m[6]*y + m[10]*z + m[14];
                        if (wx < dbgBox.min[0]) dbgBox.min[0] = wx; if (wx > dbgBox.max[0]) dbgBox.max[0] = wx;
                        if (wy < dbgBox.min[1]) dbgBox.min[1] = wy; if (wy > dbgBox.max[1]) dbgBox.max[1] = wy;
                        if (wz < dbgBox.min[2]) dbgBox.min[2] = wz; if (wz > dbgBox.max[2]) dbgBox.max[2] = wz;
                    }
                });
            }
            // Pump up the directional/dir lighting contrast for screenshots
            // by temporarily dimming the hemisphere fill. With the default
            // 1.2 hemi the ambient floods cavities and the inside of a
            // blind hole reads as the same light grey as the top face.
            // We restore intensities after rendering so live use is
            // untouched.
            const lightState = [];
            view.scene.traverse(o => {
                if (o.isLight && o.intensity != null) {
                    lightState.push({ light: o, prev: o.intensity });
                    if (o.type === 'HemisphereLight') o.intensity *= 0.15;
                    else if (o.type === 'DirectionalLight') o.intensity *= 1.6;
                }
            });
            // Optional section view — slice the body along the requested
            // axis through the AABB center so blind cavities are exposed
            // in cross-section. Axis is `'x'|'-x'|'y'|'-y'|'z'|'-z'`.
            // We install per-material clippingPlanes so the cut only
            // affects body meshes, not axes/grid/widgets.
            const sectionState = [];
            if (window.__paraform_section__ && window.__PARAFORM_THREE__ && body) {
                const T = window.__PARAFORM_THREE__;
                const ax = String(window.__paraform_section__).toLowerCase();
                const sign = ax.startsWith('-') ? -1 : 1;
                const a = ax.replace('-', '');
                const n = a === 'x' ? new T.Vector3(sign, 0, 0)
                        : a === 'y' ? new T.Vector3(0, sign, 0)
                        :             new T.Vector3(0, 0, sign);
                // Plane passing through the body's AABB centre with the
                // chosen outward normal; positive side is kept.
                const constant = -(a === 'x' ? cx * sign : a === 'y' ? cy * sign : cz * sign);
                const plane = new T.Plane(n, constant);
                view.renderer.localClippingEnabled = true;
                body.traverse(o => {
                    if (o.isMesh && o.material) {
                        sectionState.push({ mat: o.material, prev: o.material.clippingPlanes });
                        o.material.clippingPlanes = [plane];
                        o.material.clipShadows = false;
                        o.material.needsUpdate = true;
                    }
                });
            }
            // Optional wireframe pass — toggle every body mesh material to
            // wireframe so the bot can verify the underlying tessellation
            // includes features the lit render appears to be hiding (e.g.
            // blind-hole rims that vanish under uniform shading).
            if (window.__paraform_wireframe__ && body) {
                body.traverse(o => {
                    if (o.isMesh && o.material) {
                        o.userData.__wf_prev = o.material.wireframe;
                        o.material.wireframe = true;
                        o.material.needsUpdate = true;
                    }
                });
            }
            // Render with the freshly-set camera in this same evaluate so
            // CADCameraControls can't tick + drift before the screenshot.
            try { view.renderer.render(view.scene, view.camera); } catch {}
            // Restore the live-use light intensities + clipping state.
            for (const { light, prev } of lightState) light.intensity = prev;
            for (const { mat, prev } of sectionState) {
                mat.clippingPlanes = prev || null;
                mat.needsUpdate = true;
            }
            // Compose title bar + canvas into a new canvas and return PNG.
            const src = r.domElement;
            const W = src.width, H = src.height;
            const BAR = 64;
            const out = document.createElement('canvas');
            out.width = W; out.height = H + BAR;
            const g = out.getContext('2d');
            // Title bar
            g.fillStyle = '#0c0c10';
            g.fillRect(0, 0, W, BAR);
            g.fillStyle = '#6e7681';
            g.font = '14px -apple-system, "Segoe UI", Roboto, sans-serif';
            g.textBaseline = 'top';
            g.fillText(titleText, 16, 10);
            g.fillStyle = '#e6edf3';
            g.font = '600 22px -apple-system, "Segoe UI", Roboto, sans-serif';
            g.fillText(subText, 16, 28);
            if (topoText) {
                g.fillStyle = '#9aa4b2';
                g.font = '13px ui-monospace, "JetBrains Mono", Menlo, monospace';
                g.textAlign = 'right';
                g.fillText(topoText, W - 16, 24);
                g.textAlign = 'left';
            }
            // Hairline divider
            g.fillStyle = '#222';
            g.fillRect(0, BAR - 1, W, 1);
            // Canvas underneath
            g.drawImage(src, 0, BAR);
            return {
                dataUrl: out.toDataURL('image/png'),
                dbg: {
                    maxDim,
                    pos: [+view.camera.position.x.toFixed(2), +view.camera.position.y.toFixed(2), +view.camera.position.z.toFixed(2)],
                    bodyAabb: dbgBox.min[0] === Infinity ? null
                        : { min: dbgBox.min.map(v => +v.toFixed(2)), max: dbgBox.max.map(v => +v.toFixed(2)) },
                },
            };
        }, {
            titleText: title.scenario,
            subText: title.step,
            topoText: title.topo
                ? `${title.topo.features}F · ${title.topo.faces}f · ${title.topo.edges}e`
                : '',
        });
        const dataUrl = composed && composed.dataUrl;
        if (dataUrl) {
            const png = Buffer.from(dataUrl.split(',')[1], 'base64');
            const fileName = `${String(idx).padStart(2, '0')}-${slugify(step.label)}.png`;
            fs.writeFileSync(path.join(scDir, fileName), png);
            // Also drop a flat copy under screenshots/all/ so the user can
            // browse every step from one folder.
            const allDir = path.join(path.dirname(scDir), 'all');
            fs.mkdirSync(allDir, { recursive: true });
            const flatName = `${slugify(sc.slug)}__${String(idx).padStart(2, '0')}-${slugify(step.label)}.png`;
            fs.writeFileSync(path.join(allDir, flatName), png);
            stepResult.screenshot = fileName;
        }

        // A kernel error always fails the step, even if no other assertion fires.
        if (stepResult.kernelError) {
            throw new Error(`kernel: ${stepResult.kernelError}`);
        }

        // Optional declarative assertions.
        if (step.expect) {
            const e = step.expect;
            const t = stepResult.topology || {};
            if (typeof e.faces === 'number' && t.faces !== e.faces) {
                throw new Error(`expected ${e.faces} faces, got ${t.faces}`);
            }
            if (typeof e.minFaces === 'number' && (t.faces ?? 0) < e.minFaces) {
                throw new Error(`expected ≥${e.minFaces} faces, got ${t.faces}`);
            }
            if (typeof e.edges === 'number' && t.edges !== e.edges) {
                throw new Error(`expected ${e.edges} edges, got ${t.edges}`);
            }
            if (typeof e.features === 'number' && t.features !== e.features) {
                throw new Error(`expected ${e.features} features, got ${t.features}`);
            }
        }
    } catch (err) {
        stepResult.status = 'fail';
        stepResult.error = err.message;
    }
    return stepResult;
}

// ── Page-side helpers ─────────────────────────────────────────────────────────

async function waitForAppReady(page) {
    // The app exposes __pf4 only after the viewport scene exists and the v4
    // bridge has been instantiated. Polling for both is the cleanest signal
    // that the page is fully initialised and the kernel client is wired.
    await page.waitForFunction(
        () => window.__pf4 && window.__pf4.bridge && window.__PARAFORM_VIEWPORT__,
        { timeout: 45_000 },
    );
}

async function ensureViewportSized(page) {
    // The studio panel is gated behind hash-routing — navigate so the
    // viewport canvas is visible and sized > 0.
    await page.evaluate(() => {
        if (location.hash !== '#/create') location.hash = '#/create';
    });
    await page.waitForFunction(() => {
        const v = window.__PARAFORM_VIEWPORT__;
        const c = v && v.renderer && v.renderer.domElement;
        return c && c.width > 100 && c.height > 100;
    }, { timeout: 15_000 });
}

/**
 * Wait for the next bridge render OR error. Returns null on render,
 * the kernel's error message on onError, or throws on timeout.
 */
async function waitForNextRender(page, timeoutMs) {
    return await page.evaluate((tMs) => new Promise((resolve, reject) => {
        const bridge = window.__pf4.bridge;
        let renderOff = null, errorOff = null;
        const tid = setTimeout(() => {
            renderOff?.(); errorOff?.();
            reject(new Error(`waitForNextRender: no render within ${tMs} ms`));
        }, tMs);
        renderOff = bridge.onRender(() => {
            clearTimeout(tid); renderOff?.(); errorOff?.();
            resolve(null);
        });
        errorOff = bridge.onError(({ error }) => {
            clearTimeout(tid); renderOff?.(); errorOff?.();
            // Trim the verbose Python traceback to the headline so the
            // step report stays readable.
            let msg = String(error || 'kernel error');
            const m = msg.match(/^HTTP \d+:\s*(\{[\s\S]*\})$/);
            if (m) { try { msg = JSON.parse(m[1]).error || msg; } catch {} }
            resolve(msg.split('\n').slice(-3).join(' | ').slice(0, 240));
        });
    }), timeoutMs);
}

// ── Process spawning ──────────────────────────────────────────────────────────

async function ensureKernel(spawned) {
    if (await portInUse(KERNEL_PORT)) return;
    console.log('• Starting Python kernel…');
    const child = spawn('python', [path.join(ROOT, 'b123d_server', 'server.py')], {
        cwd: ROOT, shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(child);
    child.stdout.on('data', d => process.stdout.write(`  [kernel] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`  [kernel] ${d}`));
    await waitForPort(KERNEL_PORT, 45_000, 'kernel');
}

async function ensureVite(spawned) {
    if (await portInUse(VITE_PORT)) return;
    console.log('• Starting Vite dev server…');
    const child = spawn('npm', ['run', 'kernel:dev'], {
        cwd: ROOT, shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VITE_ENGINE_URL: `http://localhost:${KERNEL_PORT}` },
    });
    spawned.push(child);
    child.stdout.on('data', d => process.stdout.write(`  [vite] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`  [vite] ${d}`));
    await waitForPort(VITE_PORT, 45_000, 'vite');
}

function portInUse(port) {
    return new Promise(resolve => {
        const sock = net.connect(port, '127.0.0.1');
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error',   () => resolve(false));
    });
}

/** True if the kernel responds to /health inside `timeoutMs`. */
async function pingKernel(timeoutMs) {
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        const res = await fetch(`http://127.0.0.1:${KERNEL_PORT}/health`, { signal: ac.signal });
        clearTimeout(t);
        return res.ok;
    } catch {
        return false;
    }
}

async function waitForPort(port, timeoutMs, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (await portInUse(port)) return;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`Timed out waiting for ${label} on :${port}`);
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeJsonReport(report) {
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
}

function writeIndexHtml(report) {
    const total   = report.scenarios.length;
    const passed  = report.scenarios.filter(s => s.status === 'pass').length;
    const skipped = report.scenarios.filter(s => s.status === 'skip').length;
    const items = report.scenarios.map(sc => {
        if (sc.status === 'skip') {
            return `
            <section class="scen skip">
                <h2>${escapeHtml(sc.name)} <span class="status">skipped</span></h2>
                <div class="skip-reason">${escapeHtml(sc.skipReason || 'skipped')}</div>
            </section>`;
        }
        const stepCards = sc.steps.map(s => {
            const topo = s.topology
                ? `${s.topology.features}F · ${s.topology.faces}f · ${s.topology.edges}e`
                : '—';
            const errBadge = s.status === 'fail'
                ? `<div class="err">${escapeHtml(s.error || 'failed')}</div>`
                : (s.note ? `<div class="note">${escapeHtml(s.note)}</div>` : '');
            const img = s.screenshot
                ? `<img src="${sc.slug}/${s.screenshot}" loading="lazy" />`
                : `<div class="noimg">no screenshot</div>`;
            return `
                <div class="step ${s.status}">
                    <div class="head"><span class="label">${escapeHtml(s.label)}</span><span class="topo">${topo}</span></div>
                    ${img}
                    ${errBadge}
                </div>`;
        }).join('');
        return `
            <section class="scen ${sc.status}">
                <h2>${escapeHtml(sc.name)} <span class="status">${sc.status}</span> <span class="dur">${sc.durationMs ?? '?'} ms</span></h2>
                <div class="strip">${stepCards}</div>
            </section>`;
    }).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>UI validation — ${passed}/${total}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
       background: #111; color: #ddd; }
header { padding: 16px 24px; border-bottom: 1px solid #222; display: flex; align-items: baseline; gap: 16px; }
header h1 { margin: 0; font-size: 18px; }
header .meta { color: #888; font-size: 12px; }
.scen { padding: 16px 24px; border-bottom: 1px solid #1c1c1c; }
.scen h2 { margin: 0 0 12px 0; font-size: 16px; display: flex; gap: 12px; align-items: baseline; }
.scen.fail h2 { color: #ff6868; }
.scen.skip h2 { color: #888; }
.scen .status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #5fcf6d; }
.scen.fail .status { color: #ff6868; }
.scen.skip .status { color: #888; }
.skip-reason { color: #999; font-family: ui-monospace, monospace; font-size: 12px; padding: 6px 0; }
.scen .dur { color: #777; font-size: 12px; font-weight: normal; }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.step { background: #1a1a1a; border: 1px solid #222; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }
.step.fail { border-color: #803030; }
.step .head { padding: 8px 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.step .label { font-weight: 600; font-size: 13px; }
.step .topo { color: #888; font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 11px; }
.step img { width: 100%; height: auto; display: block; background: #000; }
.step .noimg { padding: 40px; text-align: center; color: #555; background: #0a0a0a; }
.step .err { padding: 8px 10px; color: #ff8a8a; background: #2a1010; font-family: ui-monospace, monospace; font-size: 12px; }
.step .note { padding: 8px 10px; color: #d6b04c; background: #2a2010; font-family: ui-monospace, monospace; font-size: 11px; }
</style></head><body>
<header>
  <h1>UI validation</h1>
  <span class="meta">${passed}/${total} scenarios passed${skipped ? ` · ${skipped} skipped` : ''} · ${escapeHtml(report.startedAt)}</span>
</header>
${items}
</body></html>`;
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
}

// ── Misc ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = {};
    for (const a of argv) {
        if (a === '--headed') out.headed = true;
        else if (a.startsWith('--only=')) out.only = a.slice(7);
        else if (a.startsWith('--url='))  out.url  = a.slice(6);
    }
    return out;
}

function slugify(s) {
    return String(s || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

await main();
