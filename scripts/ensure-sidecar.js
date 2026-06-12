#!/usr/bin/env node
// Make `npm run tauri:dev` / `npm run tauri:build` self-bootstrapping.
//
// On any platform, before `tauri` itself runs we make sure the PyInstaller
// b123d sidecar exists for the current target triple. If it doesn't exist we
// build it once (~5 minutes the first time). Subsequent runs are a no-op
// fast-path: a single `fs.existsSync` check.
//
// This is what keeps "no manual server" promise from the plan: dev and ship
// both go through the same bootstrap, neither us nor a future contributor
// needs to remember to run `python build_sidecar.py` separately.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const binDir = join(repoRoot, 'src-tauri', 'binaries');

function targetTriple() {
    if (process.env.TARGET_TRIPLE) return process.env.TARGET_TRIPLE;
    // Ask rustc — same source of truth that PyInstaller wrapper uses.
    const res = spawnSync('rustc', ['-Vv'], { encoding: 'utf8' });
    if (res.status !== 0) {
        console.error('[ensure-sidecar] rustc not found on PATH. Install Rust (https://rustup.rs).');
        process.exit(1);
    }
    const line = res.stdout.split(/\r?\n/).find(l => l.startsWith('host:'));
    if (!line) {
        console.error('[ensure-sidecar] could not parse `rustc -Vv` host triple:\n' + res.stdout);
        process.exit(1);
    }
    return line.slice('host:'.length).trim();
}

function sidecarPath(triple) {
    const exe = process.platform === 'win32' ? '.exe' : '';
    return join(binDir, `b123d_server-${triple}${exe}`);
}

function buildSidecar() {
    console.log('[ensure-sidecar] sidecar missing — invoking PyInstaller (one-time, ~5 min)…');
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const r = spawnSync(pyCmd, [join(repoRoot, 'b123d_server', 'build_sidecar.py')], {
        stdio: 'inherit',
        cwd: repoRoot,
    });
    if (r.status !== 0) {
        console.error('[ensure-sidecar] PyInstaller build failed.');
        console.error('  Make sure Python 3.11+ is installed with: pip install build123d flask flask-cors pyinstaller');
        process.exit(r.status ?? 1);
    }
}

const triple = targetTriple();
const out = sidecarPath(triple);
if (existsSync(out)) {
    // Fast path — already built.
    process.exit(0);
}
buildSidecar();
if (!existsSync(out)) {
    console.error(`[ensure-sidecar] PyInstaller succeeded but expected file is missing: ${out}`);
    process.exit(1);
}
console.log(`[ensure-sidecar] sidecar ready at ${out}`);
