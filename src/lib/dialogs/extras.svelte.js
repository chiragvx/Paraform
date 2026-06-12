/**
 * Extras dialog runtime — mirrors the pattern in `dialogs.svelte.js` for the
 * library / diff / custom-model modals. Kept in a separate module so the core
 * `dialogs` runtime stays focused on its original set.
 *
 * Each dialog has a boolean flag; the dialog components bind their `open`
 * prop to the matching field. The `openX()` / `closeX()` helpers are sugar
 * so callers (command palette entries, menus) don't need to touch the
 * underlying state object.
 */

export const extras = $state({
  library: false,
  diff: false,
  customModel: false,
});

export function openLibrary() { extras.library = true; }
export function closeLibrary() { extras.library = false; }

export function openDiff() { extras.diff = true; }
export function closeDiff() { extras.diff = false; }

export function openCustomModel() { extras.customModel = true; }
export function closeCustomModel() { extras.customModel = false; }
