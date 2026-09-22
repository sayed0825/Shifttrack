import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin, Location, CallbackError } from '@capacitor-community/background-geolocation';

// @capacitor-community/background-geolocation ships no JS entry point —
// only type definitions (see its package.json) — so every consumer is
// expected to register the plugin itself. Doing it once here, rather than
// at each call site, keeps that a plugin-loading detail this module owns.
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

// Persisted across app launches/process death — a watcher started before a
// crash or force-quit has no live JS context left to call removeWatcher on
// it, and this plugin exposes no "stop everything" API, only
// removeWatcher(id). Recording the id here is what makes the app-launch
// stale-watcher check (see EmployeeDashboard's ClockInTab) possible at all:
// without it, an id lost to process death is simply unrecoverable.
const WATCHER_ID_KEY = 'shifttrack-location-watcher-id';

export function getPersistedWatcherId(): string | null {
  try {
    return localStorage.getItem(WATCHER_ID_KEY);
  } catch {
    return null;
  }
}

export function setPersistedWatcherId(id: string): void {
  try {
    localStorage.setItem(WATCHER_ID_KEY, id);
  } catch {
    // Best-effort — a failed write here only degrades the stale-watcher
    // check on a future launch, never the current session's tracking.
  }
}

export function clearPersistedWatcherId(): void {
  try {
    localStorage.removeItem(WATCHER_ID_KEY);
  } catch {
    // See setPersistedWatcherId.
  }
}

/**
 * Starts a background-capable location watcher — native (iOS/Android) only.
 * Unlike navigator.geolocation, this keeps delivering updates while the
 * screen is locked or the app is backgrounded, which is the entire reason
 * to use it: a driver stays clocked in with the phone in a pocket for a
 * whole shift. Never call this on web — check Capacitor.isNativePlatform()
 * at the call site first; on web there is no such thing as this plugin.
 *
 * `backgroundMessage` is required for the watcher to keep reporting once
 * backgrounded (see the plugin's README) — without it, updates are only
 * guaranteed in the foreground, silently defeating the point of using this
 * over navigator.geolocation at all. The same "background" flag is also
 * what makes the plugin's iOS side set `showsBackgroundLocationIndicator`
 * (see its Plugin.swift) — that's automatic, not something configured
 * from here.
 *
 * Only ever call this for a role with tracks_orders — a front-of-house
 * employee clocking in must never be tracked in the background. See the
 * gate at the call site (EmployeeDashboard's ClockInTab), not here — this
 * module has no way to enforce it itself.
 */
export function addBackgroundLocationWatcher(
  callback: (location: Location | undefined, error: CallbackError | undefined) => void
): Promise<string> {
  return BackgroundGeolocation.addWatcher(
    {
      // Exact wording requested: a real Android foreground-service
      // notification splits title/body, so "Shift active" / "measuring
      // delivery mileage" together read as the single intended phrase.
      // The notification itself is non-dismissible while the shift is
      // open — inherent to a foreground service, nothing to set here.
      backgroundTitle: 'Shift active',
      backgroundMessage: 'Measuring delivery mileage',
      requestPermissions: true,
      stale: false,
      // Distance-based, not time-based — there is no polling interval to
      // tune here, the OS delivers a callback whenever the device has
      // moved this far. 50m mirrors the plugin's own documented example
      // and keeps updates frequent enough for dispatch without firing on
      // every few-metre jitter.
      distanceFilter: 50,
    },
    callback
  );
}

export function removeBackgroundLocationWatcher(id: string): Promise<void> {
  return BackgroundGeolocation.removeWatcher({ id });
}
