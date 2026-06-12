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

// matchMedia handle + listener for the 'system' theme. We attach the listener
// only while 'system' is the active choice so OS changes track live; switching
// away from 'system' detaches it.
let _mql = null;
let _onSystemChange = null;

function prefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve a theme choice to the concrete mode the DOM should reflect. */
function resolveMode(t) {
  if (t === 'system') return prefersDark() ? 'dark' : 'light';
  return t === 'dark' ? 'dark' : 'light';
}

function applyToDom(t) {
  if (typeof document === 'undefined') return;
  const cl = document.documentElement.classList;
  if (resolveMode(t) === 'dark') cl.add('dark');
  else cl.remove('dark');
}

/**
 * Attach/detach the prefers-color-scheme listener so 'system' tracks the OS
 * live. Re-applies the resolved mode whenever the OS preference flips.
 */
function syncSystemListener(t) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (t === 'system') {
    if (_mql) return; // already listening
    _mql = window.matchMedia('(prefers-color-scheme: dark)');
    _onSystemChange = () => applyToDom('system');
    // addEventListener is the modern API; older Safari only has addListener.
    if (typeof _mql.addEventListener === 'function') _mql.addEventListener('change', _onSystemChange);
    else if (typeof _mql.addListener === 'function') _mql.addListener(_onSystemChange);
  } else if (_mql) {
    if (typeof _mql.removeEventListener === 'function') _mql.removeEventListener('change', _onSystemChange);
    else if (typeof _mql.removeListener === 'function') _mql.removeListener(_onSystemChange);
    _mql = null;
    _onSystemChange = null;
  }
}

/** Set theme: update state, mutate DOM, persist. */
export function setTheme(t) {
  theme.value = t;
  syncSystemListener(t);
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
  syncSystemListener(t);
  applyToDom(t);
}

// Apply persisted theme as soon as this module is imported so the
// initial paint already has the correct `.dark` class on <html>.
loadTheme();
