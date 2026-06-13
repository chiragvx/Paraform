<script>
  import { onMount } from 'svelte';
  import TopBar from '$lib/components/studio/TopBar.svelte';
  import Toolbar from '$lib/components/studio/Toolbar.svelte';
  import SketchToolbar from '$lib/components/studio/SketchToolbar.svelte';
  import Sidebar from '$lib/components/studio/Sidebar.svelte';
  import Viewport from '$lib/components/studio/Viewport.svelte';
  import Inspector from '$lib/components/studio/Inspector.svelte';
  import ChatPanel from '$lib/components/studio/ChatPanel.svelte';
  import PanelRail from '$lib/components/studio/PanelRail.svelte';
  import { panels, togglePanel } from '$lib/studio/panels.svelte.js';
  import StatusBar from '$lib/components/studio/StatusBar.svelte';
  import CommandPalette from '$lib/components/studio/CommandPalette.svelte';
  import ExportDialog from '$lib/components/studio/ExportDialog.svelte';
  import SettingsDialog from '$lib/components/studio/SettingsDialog.svelte';
  import ParametersDialog from '$lib/components/studio/ParametersDialog.svelte';
  import FeatureFormDialog from '$lib/components/studio/FeatureFormDialog.svelte';
  import CodeEditorDialog from '$lib/components/studio/CodeEditorDialog.svelte';
  import ExtraDialogs from '$lib/components/studio/ExtraDialogs.svelte';
  import NewDocumentDialog from '$lib/components/studio/NewDocumentDialog.svelte';
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte';
  import AppLoader from '$lib/components/studio/AppLoader.svelte';
  import GlobalNav from '$lib/components/studio/GlobalNav.svelte';
  import LandingView from '$lib/components/views/LandingView.svelte';
  import ManageView from '$lib/components/views/ManageView.svelte';
  import AuthView from '$lib/components/views/AuthView.svelte';
  import PricingView from '$lib/components/views/PricingView.svelte';
  import { palette } from '$lib/commands/palette.svelte.js';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { NUMERIC_VIEW_KEYS } from '$lib/viewport/views.js';
  import { COMMANDS, pickedFeatureIds } from '$lib/commands/registry.js';
  import { loadShortcuts, matchCombo, subscribeShortcuts } from '$lib/viewport/shortcuts.js';
  import { getDocumentStore, deleteFeatureCascade, setFeatureEnabled } from '../lib/document/index.js';
  import { getPickingSelection } from '../lib/picking/selection.js';
  import { isSketchActive } from '$lib/sketch/boot.js';
  import { router, navigate } from '$lib/router.svelte.js';
  import { session, isAuthConfigured, refreshAccount } from '$lib/auth/session.svelte.js';

  // Route gating. Login is mandatory in any real (Supabase-configured)
  // deployment. Set VITE_REQUIRE_AUTH=0 to force it off (e.g. a local
  // kernel-only demo); when Supabase is unconfigured (dev/tests) the gate is
  // naturally inert. When on, the studio route requires a signed-in session:
  // while the session is still loading we render nothing for that route (no
  // flash-of-studio), and once it resolves signed-out we bounce to #/auth.
  const _authFlag = String(import.meta.env.VITE_REQUIRE_AUTH ?? '').toLowerCase();
  const _authDisabled = _authFlag === '0' || _authFlag === 'false';
  const REQUIRE_AUTH = isAuthConfigured() && !_authDisabled;
  const studioAllowed = $derived(!REQUIRE_AUTH || !!session.user);

  $effect(() => {
    if (REQUIRE_AUTH && router.route === 'studio' && !session.loading && !session.user) {
      navigate('auth');
    }
  });

  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  // Post-checkout return. Stripe's success_url is `.../#/studio?checkout=success`.
  // Refresh the account (so the new plan/usage lands) and strip the query so
  // a reload/back doesn't re-fire it.
  onMount(() => {
    const hash = typeof window !== 'undefined' ? (window.location.hash || '') : '';
    if (hash.includes('checkout=success')) {
      refreshAccount?.();
      window.location.hash = '#/studio';
    }
  });

  onMount(() => {
    const store = getDocumentStore();

    // E6.3 — custom shortcuts. v2: live-reload. `shortcuts` is a mutable ref
    // updated by subscribeShortcuts() whenever the Settings panel writes new
    // bindings; the dispatcher reads it on every keydown. Single listener,
    // no rebuild churn, so no double-firing.
    let shortcuts = loadShortcuts();
    const unsubShortcuts = subscribeShortcuts((next) => { shortcuts = next; });
    const cmdById = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

    function tryDispatchCustom(e) {
      for (const [cmdId, combo] of Object.entries(shortcuts)) {
        if (!combo) continue;
        if (!matchCombo(e, combo)) continue;
        const cmd = cmdById[cmdId];
        if (!cmd) continue;
        if (cmd.enabled && !cmd.enabled({ store })) continue;
        e.preventDefault();
        try { cmd.run({ store }); } catch (err) { console.warn('[keymap]', err); }
        return true;
      }
      return false;
    }

    function onKeydown(e) {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        palette.toggle();
        return;
      }

      if (palette.open) return;
      if (isTypingTarget(e.target)) return;
      // While the legacy sketcher owns the canvas, let its hotkeys run
      // without our keymap firing alongside (W, F, etc. would collide).
      if (isSketchActive()) return;

      // First try a custom binding; fall back to built-in defaults below.
      if (tryDispatchCustom(e)) return;

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        store.redo();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Multi-delete from the picking selection (shift-click stacks)
        // with single-select fallback to the doc store's selectedFeatureId.
        const ids = pickedFeatureIds(store);
        if (ids.length) {
          e.preventDefault();
          // Cascade: deleting a placed part's body also removes its wrapping
          // component (child components survive — first child is promoted).
          for (const id of ids) { try { deleteFeatureCascade(id); } catch {} }
        }
        return;
      }

      if (e.key.toLowerCase() === 'f' && !mod) {
        e.preventDefault();
        studio.views?.fit();
        return;
      }

      if (e.key.toLowerCase() === 'w' && !mod) {
        e.preventDefault();
        studio.displayMode = studio.displayMode === 'wireframe' ? 'shaded' : 'wireframe';
        return;
      }

      if (e.key.toLowerCase() === 'h' && !mod) {
        e.preventDefault();
        const picking = getPickingSelection();
        const ids = new Set();
        for (const entry of picking.toArray()) {
          const fid = entry.payload?.featureId || entry.descriptor?.featureId;
          if (fid) ids.add(fid);
        }
        if (ids.size === 0) {
          const sid = store.selectedFeatureId();
          if (sid) ids.add(sid);
        }
        for (const id of ids) setFeatureEnabled(id, false);
        return;
      }

      // Ctrl+1..7 → named views (SolidWorks convention).
      if (mod && NUMERIC_VIEW_KEYS[e.key]) {
        e.preventDefault();
        studio.views?.toNamed(NUMERIC_VIEW_KEYS[e.key]);
      }
    }

    window.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('keydown', onKeydown);
      unsubShortcuts();
    };
  });
</script>

{#if router.route === 'studio'}
  <AppLoader />
{/if}

{#if router.route === 'studio' && studioAllowed}
  <div class="flex h-full flex-col">
    <TopBar />
    <Toolbar />
    <SketchToolbar />
    <main class="flex flex-1 min-h-0">
      {#if panels.left}
        <PanelRail side="left" label="Browser" onexpand={() => togglePanel('left')} />
      {:else}
        <Sidebar />
      {/if}
      <Viewport />
      {#if panels.inspector}
        <PanelRail side="right" label="Inspector" onexpand={() => togglePanel('inspector')} />
      {:else}
        <Inspector />
      {/if}
      {#if panels.chat}
        <PanelRail side="right" label="AI" onexpand={() => togglePanel('chat')} />
      {:else}
        <ChatPanel />
      {/if}
    </main>
    <StatusBar />
  </div>

  <CommandPalette />
  <ExportDialog />
  <SettingsDialog />
  <ParametersDialog />
  <FeatureFormDialog />
  <CodeEditorDialog />
  <ExtraDialogs />
  <NewDocumentDialog />
  <ConfirmDialog />
{:else if router.route === 'studio'}
  <!-- Gated studio: session still loading or signed out. Render a blank
       frame (no flash of studio or landing) — the $effect above redirects
       to #/auth as soon as the session resolves signed-out. -->
  <div class="flex h-full items-center justify-center bg-background"></div>
{:else}
  <div class="flex h-full flex-col">
    <GlobalNav />
    <main class="flex-1 min-h-0">
      {#if router.route === 'manage'}
        <ManageView />
      {:else if router.route === 'pricing'}
        <PricingView />
      {:else if router.route === 'auth'}
        <AuthView />
      {:else}
        <LandingView />
      {/if}
    </main>
  </div>
{/if}
