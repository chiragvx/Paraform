import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { loadAndApplySettings } from './lib/settings/boot.js';
import { loadAllSettings } from './lib/settings/schema.js';
import { loadTheme } from './lib/theme/theme.svelte.js';
import { restoreDocument, startAutosave } from './lib/document/persistence.svelte.js';
import { ensureHydrated as ensureLibraryHydrated, startActiveDocSync, adoptWorkingDocIfUnbound } from './lib/document/library.svelte.js';
import * as v4 from '../lib/document/index.js';
import { studio } from './lib/studio/runtime.svelte.js';
import { COMMANDS } from './lib/commands/registry.js';
import { palette } from './lib/commands/palette.svelte.js';
import { dialogs } from './lib/dialogs/dialogs.svelte.js';
import { initSession } from './lib/auth/session.svelte.js';
import { getPlanGraph as _planGraph } from './lib/ai/plan/graph.js';
import { refreshPlan as _refreshPlan, approvePlan as _approvePlan } from './lib/ai/plan/plan_store.svelte.js';

// Boot the Supabase auth session (non-blocking — the network round-trip runs
// in the background; the store's `loading` flag gates auth-required routes).
// Also registers the token provider so kernel/AI requests carry the JWT.
try { initSession(); } catch (e) { console.warn('[main] auth init failed:', e); }

// Apply the persisted theme BEFORE the viewport/settings boot so the first
// paint already has the correct `.dark` class on <html>. `loadTheme()` reads
// `general.theme` from localStorage and toggles the class accordingly.
loadTheme();

// Apply persisted settings (tessellation deflection on the executor) before
// the viewport boots so the first compile uses the right quality.
try { loadAndApplySettings(); } catch (e) { console.warn('[main] settings boot failed:', e); }

// Honor the user's launch-view preference. `restore` (default) loads the last
// document from localStorage; anything else ('landing'/'library') means
// "always start with a fresh seed" — skip the restore so bootDocument drops a
// default primitive in the scene instead — AND navigate accordingly:
//   - 'landing' → route to the landing page (#/)
//   - 'library' → stay in the studio but pop the part-library dialog on boot
let launchView = 'restore';
try { launchView = loadAllSettings().general?.launchView ?? 'restore'; }
catch (e) { console.warn('[main] launchView read failed:', e); }

if (launchView === 'restore') {
  try { restoreDocument(); } catch (e) { console.warn('[main] restore failed:', e); }
} else if (launchView === 'landing') {
  // Force the landing route regardless of any persisted/last hash.
  try {
    if (typeof window !== 'undefined' && window.location.hash !== '#/') {
      window.location.hash = '#/';
    }
  } catch (e) { console.warn('[main] landing nav failed:', e); }
} else if (launchView === 'library') {
  // Open the studio library dialog once the app has mounted.
  import('./lib/dialogs/extras.svelte.js')
    .then((m) => queueMicrotask(() => { try { m.openLibrary(); } catch (e) { console.warn('[main] openLibrary failed:', e); } }))
    .catch((e) => console.warn('[main] library import failed:', e));
}

// Autosave runs in both modes — even on a blank launch the user will commit
// features that should be persisted for next time.
try { startAutosave(); } catch (e) { console.warn('[main] autosave failed:', e); }

// Multi-document layer: hydrate the library store NOW (so library.currentId —
// the active document — is known before the first edit) and mirror every
// commit back into the bound library entry. This makes the library the durable,
// switchable document set rather than a manual snapshot archive.
try { ensureLibraryHydrated(); adoptWorkingDocIfUnbound(); startActiveDocSync(); }
catch (e) { console.warn('[main] active-doc sync failed:', e); }

const app = mount(App, {
  target: document.getElementById('app'),
});

// Desktop only: check the release feed for a newer signed build and
// self-update. Non-blocking and a no-op in the browser.
import('./lib/updater/check.js')
  .then((m) => m.checkForUpdatesAndInstall({ onStatus: (s) => console.info('[updater]', s) }))
  .catch((e) => console.warn('[main] updater init failed:', e));

// Test hook — exposes the studio runtime + document store + command registry
// to the smoke harness (tests/smoke/). Always on for now (the surface is
// read-mostly + the same things power the dev console anyway); flip behind
// import.meta.env.DEV once we wire production builds.
if (typeof window !== 'undefined') {
  window.__paraform__ = {
    ready: false,
    v4,
    studio,
    COMMANDS,
    palette,
    dialogs,
    // Run a command by id with optional params context. Mirrors the
    // CommandPalette's run() path.
    runCommand(id, params) {
      const cmd = COMMANDS.find((c) => c.id === id);
      if (!cmd) throw new Error(`unknown command: ${id}`);
      const store = v4.getDocumentStore();
      if (cmd.enabled && !cmd.enabled({ store })) {
        throw new Error(`command not enabled: ${id}`);
      }
      return cmd.run({ store, params });
    },
    getStore() { return v4.getDocumentStore(); },
    getBridge() { return studio.bridge; },
    // Plan-graph (design-intent) hook for smoke tests. Reaches the SAME module
    // singleton + reactive store the PlanMap panel renders, so a test can seed a
    // plan and exercise the approval gate / clickable parts in the real UI.
    plan: {
      graph: () => _planGraph(),
      refresh: () => _refreshPlan(),
      approve: () => _approvePlan(),
    },
  };
  queueMicrotask(() => { window.__paraform__.ready = true; });
}

export default app;
