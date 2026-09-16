import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin, Location, CallbackError } from '@capacitor-community/background-geolocation';

// @capacitor-community/background-geolocation ships no JS entry point —
// only type definitions (see its package.json) — so every consumer is
// expected to register the plugin itself. Doing it once here, rather than
// at each call site, keeps that a plugin-loading detail this module owns.
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

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
 * over navigator.geolocation at all.
 */
export function addBackgroundLocationWatcher(
  callback: (location: Location | undefined, error: CallbackError | undefined) => void
): Promise<string> {
  return BackgroundGeolocation.addWatcher(
    {
      backgroundTitle: 'ShiftTrack is tracking your location',
      backgroundMessage: 'Your location is shared with your manager while you are clocked in.',
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
