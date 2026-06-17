/**
 * Desktop auto-update (Tauri updater plugin).
 *
 * On startup the native app asks the GitHub release feed (see tauri.conf.json
 * plugins.updater.endpoints) whether a newer signed build exists. If so it
 * downloads + installs it and relaunches. Signature is verified against the
 * embedded pubkey, so a tampered artifact is rejected.
 *
 * No-op in the browser build, non-blocking, never throws. All Tauri plugin
 * imports are dynamic + guarded by isDesktop() so the web bundle never loads
 * them.
 */

import { isDesktop } from '../../../lib/platform/runtime.js';

let _checked = false;

/**
 * Check for an update and, if one is available, install it and relaunch.
 * Idempotent within a session. Returns a small status object for logging/UI.
 *
 * @param {{ onStatus?: (s: string) => void }} [opts]
 */
export async function checkForUpdatesAndInstall({ onStatus } = {}) {
  if (!isDesktop() || _checked) return { checked: false };
  _checked = true;
  const say = (s) => { try { onStatus?.(s); } catch { /* ignore */ } };
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) { say('up-to-date'); return { checked: true, available: false }; }

    say(`downloading ${update.version}`);
    // downloadAndInstall streams the artifact; for NSIS this runs the installer.
    await update.downloadAndInstall();

    say('restarting');
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
    return { checked: true, available: true, installed: true, version: update.version };
  } catch (e) {
    console.warn('[updater] update check failed:', e?.message || e);
    return { checked: true, error: String(e?.message || e) };
  }
}
