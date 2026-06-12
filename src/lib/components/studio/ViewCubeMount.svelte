<script>
  import { onMount } from 'svelte';
  import { studio } from '$lib/studio/runtime.svelte.js';
  import { dialogs } from '$lib/dialogs/dialogs.svelte.js';
  import { ViewCube } from '../../../../app/viewport/view_cube.js';
  import {
    addBookmark, listBookmarks, removeBookmark, renameBookmark, snapshotCamera,
  } from '$lib/viewport/bookmarks.js';
  import { tweenTo } from '../../../../lib/viewport/view_animator.js';
  import { getDocumentStore } from '../../../../lib/document/index.js';
  import { mountAxisTriad, getAxisTriad } from '../../../../app/viewport/axis_triad.js';
  import * as THREE from 'three';
  import Plus from '@lucide/svelte/icons/plus';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import House from '@lucide/svelte/icons/house';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  let host;              // outer 170×170 container (cube + arrows + triad + home)
  let cubeHost;          // inner div that ViewCube mounts into
  let triadHost;         // bottom-left mini triad host
  let menuOpen = $state(false);
  let bookmarks = $state([]);

  function refreshBookmarks() {
    try { bookmarks = listBookmarks(docId()); } catch { bookmarks = []; }
  }

  function docId() {
    try { return getDocumentStore().doc?.metadata?.id || 'default'; }
    catch { return 'default'; }
  }

  function saveCurrentView() {
    const cam = studio.viewport?.camera;
    const controls = studio.viewport?.controls;
    if (!cam || !controls) return;
    const snap = snapshotCamera(cam, controls);
    const def = `View ${Date.now().toString(36).slice(-4)}`;
    const name = window.prompt('Name this view', def);
    if (!name || !name.trim()) return;
    addBookmark({ docId: docId(), name: name.trim(), ...snap });
    refreshBookmarks();
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: 'paraform_view_bookmarks_v1' }));
    } catch {}
  }

  function restoreBookmark(b) {
    const camera = studio.viewport?.camera;
    const controls = studio.viewport?.controls;
    if (!camera || !controls) return;
    const targetPos = new THREE.Vector3(...b.position);
    const targetTarget = new THREE.Vector3(...b.target);
    const targetUp = new THREE.Vector3(...b.up);
    try {
      tweenTo({ camera, controls, targetPos, targetTarget, targetUp, durationMs: 280 });
    } catch (err) {
      camera.position.copy(targetPos);
      camera.up.copy(targetUp);
      controls.target.copy(targetTarget);
      controls.update?.();
      console.warn('[view-cube bookmarks] tween failed, hard-set instead:', err);
    }
    menuOpen = false;
  }

  async function delBookmark(b) {
    const ok = await dialogs.askConfirm({
      title: 'Delete bookmark?',
      message: `"${b.name}" will be removed.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    removeBookmark(b.id, docId());
    refreshBookmarks();
  }

  function renameBookmarkLocal(b) {
    const next = window.prompt('Rename bookmark', b.name);
    if (!next || !next.trim()) return;
    renameBookmark(b.id, next.trim(), docId());
    refreshBookmarks();
  }

  function goHome() {
    // Match the old behaviour — fit-to-body brings the user back to a
    // sane iso framing. Triggered by the house icon at the cube's bottom-right.
    studio.views?.fit();
  }

  function handleCommand(name) {
    if (!name) return;
    if (name === 'home') { goHome(); return; }
    if (
      name === 'front' ||
      name === 'back' ||
      name === 'left' ||
      name === 'right' ||
      name === 'top' ||
      name === 'bottom' ||
      name === 'iso'
    ) {
      studio.views?.toNamed(name);
      return;
    }
    // edge:* / corner:* — future enhancement; no-op for now.
  }

  // ── Orbit-arrow nudges ─────────────────────────────────────────────────
  // Rotate the camera 90° around `controls.target` about an axis we pick to
  // feel natural in Z-up:
  //   left / right  → rotate about world +Z (the "up" pole)
  //   up   / down   → rotate about the camera's local right vector
  //
  // The camera's right vector is `cross(forward, up)`. When the view is
  // already near top/bottom, world-Z would be parallel to forward — but
  // for left/right that's the *intended* axis (no rotation degeneracy
  // because the camera is on the pole), and for up/down we use the camera
  // right vector which is always perpendicular to forward.
  function orbitNudge(dir) {
    const camera = studio.viewport?.camera;
    const controls = studio.viewport?.controls;
    if (!camera || !controls) return;
    const target = controls.target.clone();
    const offset = camera.position.clone().sub(target);
    const upWorld = new THREE.Vector3(0, 0, 1);

    let axis;
    let angle;
    const ANGLE = Math.PI / 2;
    if (dir === 'left')  { axis = upWorld.clone(); angle = -ANGLE; }
    else if (dir === 'right') { axis = upWorld.clone(); angle =  ANGLE; }
    else {
      // For up/down we rotate around the camera's right vector.
      const forward = offset.clone().multiplyScalar(-1).normalize();
      // Use the camera's actual up to compute right; fall back to world Z
      // when forward is degenerate.
      const camUp = camera.up.clone().lengthSq() > 1e-6 ? camera.up.clone() : upWorld.clone();
      const right = new THREE.Vector3().crossVectors(forward, camUp).normalize();
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      axis = right;
      angle = dir === 'up' ? -ANGLE : ANGLE;
    }

    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const newOffset = offset.clone().applyQuaternion(q);
    const newPos = target.clone().add(newOffset);
    const newUp = camera.up.clone().applyQuaternion(q);
    // Snap drift back toward world Z when we're close — keeps the cube
    // labels upright after consecutive nudges.
    if (Math.abs(newUp.z) > 0.85) newUp.set(0, 0, Math.sign(newUp.z) || 1);

    try {
      tweenTo({
        camera, controls,
        toPosition: newPos.toArray(),
        toTarget:   target.toArray(),
        toUp:       newUp.toArray(),
        durationMs: 280,
      });
    } catch (err) {
      camera.position.copy(newPos);
      camera.up.copy(newUp);
      controls.target.copy(target);
      controls.update?.();
    }
  }

  onMount(() => {
    refreshBookmarks();
    const docStore = getDocumentStore();
    const offDoc = docStore.subscribe(() => refreshBookmarks());
    let cube = null;
    let renderer = null;
    let origRender = null;
    let cancelled = false;
    let rafId = 0;
    let triad = null;
    const startedAt = performance.now();

    function attach() {
      const viewport = studio.viewport;
      if (!viewport || !viewport.renderer || !viewport.camera || !viewport.scene) return false;

      renderer = viewport.renderer;
      const mainScene = viewport.scene;

      cube = new ViewCube({
        renderer,
        mainCamera: viewport.camera,
        onCommand: (name) => handleCommand(name),
        // Drag the cube (or double-tap to latch free-look) → orbit the main
        // camera. Pixel deltas map straight onto the controls' orbit.
        onOrbit: (dx, dy) => {
          try { viewport.controls?.orbitBy?.(dx, dy); } catch {}
        },
      });
      cube.mount(cubeHost);

      // Mount the embedded axis triad into the bottom-left corner of this
      // widget. We retire any pre-existing instance (the previous bottom-
      // left viewport gnomon) so the mount-once guard in axis_triad.js
      // doesn't reject us.
      try { getAxisTriad()?.destroy?.(); } catch {}
      triad = mountAxisTriad({ host: triadHost, getCamera: () => viewport.camera });

      // Patch renderer.render so the cube draws after the main scene pass.
      origRender = renderer.render.bind(renderer);
      let inside = false;
      renderer.render = function patchedRender(s, c) {
        const out = origRender(s, c);
        if (!inside && s === mainScene) {
          inside = true;
          try { cube.render(); } catch (err) { console.warn('[ViewCube] render error:', err); }
          inside = false;
        }
        return out;
      };
      return true;
    }

    function tick() {
      if (cancelled) return;
      if (attach()) return;
      if (performance.now() - startedAt > 1000) return; // give up after ~1s
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    function onDocClick(ev) {
      if (!menuOpen) return;
      if (host && host.contains(ev.target)) return;
      menuOpen = false;
    }
    window.addEventListener('mousedown', onDocClick, true);

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (renderer && origRender) {
        renderer.render = origRender;
      }
      try { offDoc?.(); } catch {}
      try { cube?.dispose(); } catch {}
      try { triad?.destroy?.(); } catch {}
      window.removeEventListener('mousedown', onDocClick, true);
      cube = null;
      renderer = null;
      origRender = null;
    };
  });
</script>

<!-- Outer host: 190×190 widget anchored top-right. Light card surface,
     thin border, subtle shadow — Autodesk/Fusion ViewCube look. -->
<div
  bind:this={host}
  class="pointer-events-auto absolute right-3 top-3 z-10 size-[120px]"
>
  <!-- The Three.js cube fills the inner 60% of this box (see ViewCube
       container styling — inset: 20%). -->
  <div bind:this={cubeHost} class="absolute inset-0"></div>

  <!-- Orbit arrows on the cardinal rim. Faint by default, opaque on hover.
       Sized so they sit just outside the cube's inset(20%) zone. -->
  <button
    type="button"
    class="vc-arrow vc-arrow-top"
    onclick={(e) => { e.stopPropagation(); orbitNudge('up'); }}
    title="Orbit up 90°"
    aria-label="Orbit up"
  >
    <ChevronUp class="size-3" />
  </button>
  <button
    type="button"
    class="vc-arrow vc-arrow-bottom"
    onclick={(e) => { e.stopPropagation(); orbitNudge('down'); }}
    title="Orbit down 90°"
    aria-label="Orbit down"
  >
    <ChevronDown class="size-3" />
  </button>
  <button
    type="button"
    class="vc-arrow vc-arrow-left"
    onclick={(e) => { e.stopPropagation(); orbitNudge('left'); }}
    title="Orbit left 90°"
    aria-label="Orbit left"
  >
    <ChevronLeft class="size-3" />
  </button>
  <button
    type="button"
    class="vc-arrow vc-arrow-right"
    onclick={(e) => { e.stopPropagation(); orbitNudge('right'); }}
    title="Orbit right 90°"
    aria-label="Orbit right"
  >
    <ChevronRight class="size-3" />
  </button>

  <!-- Bottom-left: embedded axis triad. The AxisTriad widget uses its own
       absolute positioning (left/bottom CSS); we override with a wrapper
       so it lives INSIDE this widget instead of viewport-wide. -->
  <div
    bind:this={triadHost}
    class="absolute left-1 bottom-1 size-7 pointer-events-none"
    style="--pf-triad-host: 1;"
  ></div>

  <!-- Bottom-right: home + menu chevron. -->
  <div class="absolute right-0.5 bottom-0.5 flex items-center gap-0.5">
    <button
      type="button"
      class="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      onclick={(e) => { e.stopPropagation(); goHome(); }}
      title="Home — fit view"
      aria-label="Home view"
    >
      <House class="size-3" />
    </button>
    <button
      type="button"
      class="inline-flex size-3 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}
      title="View options"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
    >
      <ChevronDown class="size-2.5" />
    </button>
  </div>
</div>

{#if menuOpen}
  <!-- Anchored just below the widget (which is ~96px tall, top-3 → bottom
       at top:[108px]). Contains Save view + bookmarks list. -->
  <div class="pointer-events-auto absolute right-3 top-[132px] z-30 w-64 rounded border border-border bg-card/95 p-2 shadow-sm backdrop-blur-sm">
    <button
      type="button"
      onclick={saveCurrentView}
      class="mb-2 inline-flex w-full items-center gap-1 rounded border border-border bg-card/90 px-2 py-1 text-[11px] text-foreground hover:bg-accent"
      title="Save current view as a named bookmark"
    >
      <Plus class="size-3" /> Save current view
    </button>
    <div class="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Saved views</div>
    {#if bookmarks.length === 0}
      <div class="px-2 py-3 text-center text-[11px] text-muted-foreground/70">
        No saved views yet.
      </div>
    {:else}
      <ul class="max-h-64 space-y-0.5 overflow-y-auto">
        {#each bookmarks as b (b.id)}
          <li class="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/40">
            <button
              type="button"
              onclick={() => restoreBookmark(b)}
              ondblclick={() => renameBookmarkLocal(b)}
              class="flex flex-1 items-center gap-1 text-left text-xs text-foreground"
              title={`Restore "${b.name}" — double-click to rename`}
            >
              <Bookmark class="size-3 shrink-0 text-muted-foreground" />
              <span class="truncate">{b.name}</span>
            </button>
            <button
              type="button"
              onclick={() => delBookmark(b)}
              class="rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
              title="Delete bookmark"
              aria-label="Delete bookmark"
            >
              <Trash2 class="size-3" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  :global(.vc-arrow) {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    color: rgb(55, 65, 81);
    opacity: 0.55;
    transition: opacity 0.12s ease, background-color 0.12s ease;
    background: transparent;
    cursor: pointer;
    z-index: 6;
  }
  :global(.vc-arrow:hover) {
    opacity: 1;
    background: rgba(0, 0, 0, 0.06);
  }
  :global(.vc-arrow-top)    { top: 2px;    left: 50%; transform: translateX(-50%); }
  :global(.vc-arrow-bottom) { bottom: 22px; left: 50%; transform: translateX(-50%); }
  :global(.vc-arrow-left)   { left: 1px;   top: 50%; transform: translateY(-50%); }
  :global(.vc-arrow-right)  { right: 1px;  top: 50%; transform: translateY(-50%); }

  /* AxisTriad's stock CSS pins it to viewport bottom-left at fixed coords —
     override when it's mounted inside our cube widget so it sits in the
     reserved bottom-left corner instead. */
  :global(div[style*="--pf-triad-host"] .pf4-vp-triad) {
    position: absolute !important;
    inset: 0 !important;
    left: 0 !important;
    bottom: 0 !important;
    width: 100% !important;
    height: 100% !important;
    opacity: 0.95 !important;
    filter: none !important;
  }
</style>
