import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { proxyHandler } from './api/proxy.js';

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      // ── occt-import-js browser shim (E5.3) ──────────────────────────────
      // occt-import-js's Emscripten glue statically `require()`s a few
      // Node-only modules (`path`, `crypto`, `fs`) inside a guarded
      // `ENVIRONMENT_IS_NODE` branch. The branch never fires in the
      // browser, but Vite's bundler still has to resolve those specifiers
      // at build time. Alias them to tiny browser stubs in src/lib/import/.
      //
      // Safe to alias globally because nothing else in the browser bundle
      // imports `path` / `crypto` / `fs` directly (.mjs test files run
      // under raw Node and ignore Vite resolution).
      path:   fileURLToPath(new URL('./src/lib/import/_occt_shim_path.js',   import.meta.url)),
      crypto: fileURLToPath(new URL('./src/lib/import/_occt_shim_crypto.js', import.meta.url)),
      fs:     fileURLToPath(new URL('./src/lib/import/_occt_shim_fs.js',     import.meta.url)),
    },
  },
  optimizeDeps: {
    // occt-import-js loads its WASM via fetch() at instantiation time; pre-
    // bundling the JS glue is fine, but exclude the .wasm so Vite doesn't
    // try to inline it.
    exclude: ['occt-import-js'],
  },
  plugins: [
    svelte(),
    tailwindcss(),
    {
      name: 'api-proxy',
      configureServer(server) {
        server.middlewares.use('/api/proxy', proxyHandler);
      },
    },
  ],
  server: {
    // Tauri dev pipeline expects a fixed port. We use 1420 (Tauri's
    // traditional default) so the browser-only `vite` and the Tauri-launched
    // `vite` don't fight over a single port when both are open.
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Don't pre-clear the terminal so Rust panics from `tauri dev` stay visible.
  clearScreen: false,
});
