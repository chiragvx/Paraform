/**
 * Tests for lib/document/exporter.js and the kernel-client `formats` plumbing.
 *
 *   exportDocumentAs(format)        → resolves the bytes (no DOM side-effects)
 *   downloadDocumentAs(format)      → wraps a browser download (skipped in node)
 *   HttpKernelClient.executeCode    → passes through `formats` in the request body
 *
 * Run via:  node lib/document/__tests__/exporter.mjs
 */

import assert from 'node:assert/strict';
import { exportDocumentAs, downloadDocumentAs } from '../exporter.js';
import { HttpKernelClient } from '../kernel_client.js';
import { resetDocumentStore } from '../store.js';
import { addBox } from '../operations.js';

const _tests = [];
let _suite = '';
function suite(name, fn) { _suite = name; fn(); _suite = ''; }
function test(name, fn)  { _tests.push({ suite: _suite, name, fn }); }
async function runAll() {
    let pass = 0, fail = 0;
    for (const t of _tests) {
        try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); }
        catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.suite ? t.suite + ' › ' : ''}${t.name}`); console.log(`    ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

const utf8 = (str) => new Uint8Array(Buffer.from(str, 'utf8')).buffer;
const b64 = (str) => Buffer.from(str, 'utf8').toString('base64');

// ── exporter happy path ─────────────────────────────────────────────────────
suite('exportDocumentAs', () => {
    test('returns the kernel bytes plus a sensible filename + mime', async () => {
        resetDocumentStore();
        addBox();
        const fakeBytes = utf8('STEP-FILE-MARKER');
        const client = {
            async executeCode(code, opts) {
                assert.ok(code.includes('Box('), `expected emit, got: ${code.slice(0, 80)}`);
                assert.deepEqual(opts.formats, ['step']);
                return { ok: true, step: fakeBytes, glb: new ArrayBuffer(0) };
            },
        };
        const res = await exportDocumentAs('step', { client });
        assert.equal(res.ok, true);
        assert.equal(res.bytes, fakeBytes);
        assert.equal(res.mime, 'application/step');
        assert.match(res.filename, /\.step$/);
    });

    test('STL request asks for stl and returns the matching blob + mime', async () => {
        resetDocumentStore();
        addBox();
        const fakeBytes = utf8('solid mesh');
        let requestedFormats = null;
        const client = {
            async executeCode(code, opts) {
                requestedFormats = opts.formats;
                return { ok: true, stl: fakeBytes };
            },
        };
        const res = await exportDocumentAs('stl', { client });
        assert.deepEqual(requestedFormats, ['stl']);
        assert.equal(res.bytes, fakeBytes);
        assert.equal(res.mime, 'model/stl');
        assert.match(res.filename, /\.stl$/);
    });

    test('honours a caller-supplied filename', async () => {
        resetDocumentStore();
        addBox();
        const client = {
            async executeCode() { return { ok: true, step: utf8('x') }; },
        };
        const res = await exportDocumentAs('step', { client, filename: 'my-bracket.step' });
        assert.equal(res.filename, 'my-bracket.step');
    });

    test('unsupported format short-circuits with an error', async () => {
        resetDocumentStore();
        addBox();
        const res = await exportDocumentAs('iges', { client: { async executeCode() { return { ok: true }; } } });
        assert.equal(res.ok, false);
        assert.match(res.error, /Unsupported export format/);
    });

    test('kernel error propagates as ok:false with the kernel message', async () => {
        resetDocumentStore();
        addBox();
        const client = {
            async executeCode() { return { ok: false, error: 'build123d crashed' }; },
        };
        const res = await exportDocumentAs('step', { client });
        assert.equal(res.ok, false);
        assert.match(res.error, /build123d crashed/);
    });

    test('empty payload reports the kernel side-band error if present', async () => {
        resetDocumentStore();
        addBox();
        const client = {
            async executeCode() { return { ok: true, step_error: 'no shape to export' }; },
        };
        const res = await exportDocumentAs('step', { client });
        assert.equal(res.ok, false);
        assert.match(res.error, /no shape to export/);
    });
});

// ── downloadDocumentAs ──────────────────────────────────────────────────────
suite('downloadDocumentAs', () => {
    test('in a non-DOM environment, returns the bytes for the caller', async () => {
        resetDocumentStore();
        addBox();
        const fakeBytes = utf8('STEP-FILE');
        const client = {
            async executeCode() { return { ok: true, step: fakeBytes }; },
        };
        // node test runtime → no global `document`, so the helper returns bytes.
        const res = await downloadDocumentAs('step', { client });
        assert.equal(res.ok, true);
        assert.equal(res.bytes, fakeBytes);
    });

    test('failed exports surface ok:false without throwing', async () => {
        resetDocumentStore();
        addBox();
        const client = {
            async executeCode() { return { ok: false, error: 'kernel down' }; },
        };
        const res = await downloadDocumentAs('step', { client });
        assert.equal(res.ok, false);
        assert.match(res.error, /kernel down/);
    });
});

// ── kernel client `formats` plumbing ────────────────────────────────────────
suite('HttpKernelClient › formats', () => {
    function recordingFetch(responseBody) {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            return {
                ok: true,
                headers: { get: () => 'application/json' },
                json: async () => responseBody,
                text: async () => '',
            };
        };
        return { fetchImpl, calls };
    }

    test('omits `formats` from the body when none were requested', async () => {
        const { fetchImpl, calls } = recordingFetch({ ok: true });
        const c = new HttpKernelClient({ endpoint: 'http://kernel.example', fetchImpl });
        await c.executeCode('# noop');
        const body = JSON.parse(calls[0].init.body);
        assert.equal('formats' in body, false);
    });

    test('passes `formats` through to the kernel request body', async () => {
        const { fetchImpl, calls } = recordingFetch({ ok: true });
        const c = new HttpKernelClient({ endpoint: 'http://kernel.example', fetchImpl });
        await c.executeCode('# noop', { formats: ['step', 'stl'] });
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(body.formats, ['step', 'stl']);
    });

    test('decodes base64 step/stl/brep blobs into ArrayBuffers in the response', async () => {
        const { fetchImpl } = recordingFetch({
            ok: true,
            step: b64('S'),
            stl:  b64('M'),
            brep: b64('B'),
        });
        const c = new HttpKernelClient({ endpoint: 'http://kernel.example', fetchImpl });
        const res = await c.executeCode('# noop', { formats: ['step','stl','brep'] });
        assert.ok(res.step instanceof ArrayBuffer);
        assert.ok(res.stl  instanceof ArrayBuffer);
        assert.ok(res.brep instanceof ArrayBuffer);
        // Verify the decoded byte (single-char) round-trips correctly.
        assert.equal(new Uint8Array(res.step)[0], 'S'.charCodeAt(0));
        assert.equal(new Uint8Array(res.stl)[0],  'M'.charCodeAt(0));
        assert.equal(new Uint8Array(res.brep)[0], 'B'.charCodeAt(0));
    });

    test('non-string format fields are left alone (defensive against schema drift)', async () => {
        const { fetchImpl } = recordingFetch({
            ok: true,
            step: null,
            stl_error: 'cannot export',
        });
        const c = new HttpKernelClient({ endpoint: 'http://kernel.example', fetchImpl });
        const res = await c.executeCode('# noop', { formats: ['step','stl'] });
        assert.equal(res.step, null);
        assert.equal(res.stl_error, 'cannot export');
    });
});

await runAll();
