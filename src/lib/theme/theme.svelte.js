/**
 * Theme helper — single source of truth for the app's light/dark mode.
 *
 * Owns the reactive `theme` state, the DOM mutation (toggling the `.dark`
 * class on `<html>`) and persistence via the general-settings store.
 *
 * The General settings panel imports `setTheme` so a user picking a new
 * theme in the UI both saves AND applies live without a page reload.
 *
 * `loadTheme()` is invoked once at module load so simply importing this
 * file from `main.js` is enough to apply the persisted theme before any
 * component mounts.
 */

import { loadAllSettings, saveSetting } from '../settings/schema.js';

// Svelte 5 doesn't allow exporting a reassigned $state directly — wrap in
// an object whose property we mutate instead.
export const theme = $state({ value: 'dark' });

function applyToDom(t) {
  if (typeof document === 'undefined') return;
  const cl = document.documentElement.classList;
  if (t === 'dark') cl.add('dark');
  else cl.remove('dark');
}

/** Set theme: update state, mutate DOM, persist. */
export function setTheme(t) {
  theme.value = t;
  applyToDom(t);
  try { saveSetting('general', 'theme', t); }
  catch (e) { console.warn('[theme] save failed:', e); }
}

/** Read the persisted theme and apply it. */
export function loadTheme() {
  let t = 'dark';
  try {
    const all = loadAllSettings();
    if (all?.general?.theme) t = all.general.theme;
  } catch (e) {
    console.warn('[theme] load failed:', e);
  }
  theme.value = t;
  applyToDom(t);
}

// Apply persisted theme as soon as this module is imported so the
// initial paint already has the correct `.dark` class on <html>.
loadTheme();
