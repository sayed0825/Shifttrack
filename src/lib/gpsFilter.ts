// GPS filtering and per-run odometer accumulation for the driver mileage
// engine (step 4 of the driver pay engine). Pure functions only — no
// Capacitor/Supabase imports here, so this can be reasoned about (and, if
// this repo ever grows a unit-test runner beyond the live-DB RLS suite,
// tested) independent of a device or a network connection.
//
// Every threshold lives here, named, per the spec — nowhere else in the
// app should hardcode one of these numbers.

/** Reject a fix whose reported accuracy is worse (a larger radius) than this. */
export const MIN_FIX_ACCURACY_M = 20;

/** Reject a fix reporting a speed below this — stationary drift at the
 *  store or a red light. Only applied when the device actually reports a
 *  speed; when it's null, this check is skipped and the displacement
 *  check below is the only gate. */
export const MIN_MOVING_SPEED_MPS = 1.5;

/** Reject a fix whose implied speed from the last ACCEPTED point (distance
 *  / elapsed time) exceeds this — a GPS jump, not real travel. */
export const MAX_IMPLIED_SPEED_MPS = 40;

/** Only accumulate distance once it reaches this much from the last
 *  accepted point. A fix that doesn't cross this is neither accumulated
 *  nor promoted to the new reference point — the same anchor keeps being
 *  tested until a real move away from it registers, so small back-and-
 *  forth jitter around one spot can never compound into distance. */
export const MIN_ACCUMULATE_DISPLACEMENT_M = 15;

const METERS_PER_MILE = 1609.344;

export interface GpsFix {
  latitude: number;
  longitude: number;
  /** Metres, per the plugin's own Location type. */
  accuracy: number;
  /** Metres/second, or null when the device doesn't report one. */
  speed: number | null;
  /** Milliseconds since the epoch. */
  time: number;
}

/** Great-circle distance in metres. Same formula as offlineQueue.js's
 *  haversineMeters (which mirrors the server's haversine_meters) — not
 *  reused directly since that file is JS with no types, and this module
 *  is meant to stay dependency-free; kept in exact numeric agreement with
 *  it deliberately, not just coincidentally similar. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isInsideGeofence(
  fixLatitude: number,
  fixLongitude: number,
  siteLatitude: number,
  siteLongitude: number,
  radiusMeters: number
): boolean {
  return haversineMeters(fixLatitude, fixLongitude, siteLatitude, siteLongitude) <= radiusMeters;
}

export interface RunTrackState {
  /** The last fix distance/time was actually measured from — null at the
   *  start of a run, before any fix has been accepted. */
  referencePoint: { latitude: number; longitude: number; time: number } | null;
  odometerMiles: number;
}

export function initialRunTrackState(): RunTrackState {
  return { referencePoint: null, odometerMiles: 0 };
}

/**
 * Feeds one fix through every filter in order, returning the (possibly
 * unchanged) next state. Rejecting a fix means returning `state` as-is —
 * the reference point is never advanced by a fix that didn't pass, so a
 * bad reading can never become the new anchor everything after it is
 * measured against.
 */
export function applyFix(state: RunTrackState, fix: GpsFix): RunTrackState {
  if (fix.accuracy > MIN_FIX_ACCURACY_M) return state;
  if (fix.speed !== null && fix.speed < MIN_MOVING_SPEED_MPS) return state;

  if (!state.referencePoint) {
    // First fix to pass the filters this run — seeds the reference. There
    // is no prior point yet, so nothing to accumulate from it.
    return { referencePoint: { latitude: fix.latitude, longitude: fix.longitude, time: fix.time }, odometerMiles: state.odometerMiles };
  }

  const distanceMeters = haversineMeters(
    state.referencePoint.latitude,
    state.referencePoint.longitude,
    fix.latitude,
    fix.longitude
  );
  const elapsedSeconds = (fix.time - state.referencePoint.time) / 1000;
  // elapsedSeconds <= 0 (a stale or out-of-order fix) can't imply a real
  // speed — treat it as an infinite jump, i.e. reject.
  const impliedSpeedMps = elapsedSeconds > 0 ? distanceMeters / elapsedSeconds : Infinity;

  if (impliedSpeedMps > MAX_IMPLIED_SPEED_MPS) return state;
  if (distanceMeters < MIN_ACCUMULATE_DISPLACEMENT_M) return state;

  return {
    referencePoint: { latitude: fix.latitude, longitude: fix.longitude, time: fix.time },
    odometerMiles: state.odometerMiles + distanceMeters / METERS_PER_MILE,
  };
}
