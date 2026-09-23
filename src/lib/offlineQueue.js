/*
 * Offline clock-in queue.
 *
 * Clocking in is the only genuinely time-critical action in this app: if it
 * fails, the hours worked are simply lost. Every other screen can wait for a
 * connection. So a failed clock-in is stored on the device and replayed when
 * the network returns, rather than shown as an error the employee can do
 * nothing about. clock_out and delivery_run_complete (step 4 of the driver
 * pay engine) reuse the exact same pattern for the same reason — a driver's
 * mileage or hours lost to a dropped connection is money they didn't get
 * paid, not just an inconvenience.
 */

const QUEUE_KEY = 'shifttrack.pending';
const EVENT = 'shifttrack:queue-changed';

function read() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function write(entries) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
  } catch {
    // Private browsing or a full disk. Nothing useful to do here — the
    // in-memory attempt already failed, so the caller shows an error.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function getQueue() {
  return read();
}

export function pendingCount() {
  return read().length;
}

export function onQueueChange(handler) {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

export function enqueue(entry) {
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  write([...read(), { ...entry, localId, queuedAt: new Date().toISOString() }]);
  return localId;
}

export function clearQueue() {
  write([]);
}

/** Great-circle distance in metres. Mirrors the server's haversine_meters. */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const CLOCK_OUT_REVIEW_THRESHOLD_MS = 5 * 60_000;

/**
 * clock_out is always server time now (tg_protect_own_time_log, 0041) —
 * the device's own clock is never trusted as fact, whether the request
 * went through immediately or had to queue offline and replay later.
 * This compares what the device claimed at tap time against what the
 * server actually recorded and, if they differ by more than a few
 * minutes, flags it for a manager exactly the way an employee's own
 * overtime claim already gets reviewed: same overtime_claims table
 * (claimed_clock_out is the column that already exists for exactly this
 * "asserted time differs from the recorded time" shape), same
 * decide_overtime_claim() RPC, same OvertimeApprovals screen, same
 * notify-managers-on-insert trigger. No separate review mechanism to
 * build or maintain.
 *
 * Best-effort: called after the clock-out itself has already succeeded,
 * so a failure here never loses the clock-out — it just means this one
 * shift doesn't get flagged, same tolerance as everything else in this
 * file that isn't the primary write.
 */
export async function flagClockOutDiscrepancy(supabase, userId, timeLogId, claimedIso, recordedIso) {
  try {
    const diffMs = Math.abs(new Date(recordedIso).getTime() - new Date(claimedIso).getTime());
    if (diffMs <= CLOCK_OUT_REVIEW_THRESHOLD_MS) return;
    await supabase.from('overtime_claims').insert({
      user_id: userId,
      time_log_id: timeLogId,
      claimed_clock_out: claimedIso,
      reason: 'Recorded automatically — the device and server clock-out times differed by more than a few minutes.',
    });
  } catch {
    // Best-effort — see the comment above.
  }
}

/**
 * Replays queued entries in order. Returns { synced, failed }.
 *
 * Order matters: a clock-out may refer to a clock-in that is itself still
 * queued, so real row ids are mapped as they come back from the insert.
 */
export async function flushQueue(supabase) {
  const entries = read();
  if (entries.length === 0) return { synced: 0, failed: 0 };

  const localToReal = new Map();
  const remaining = [];
  let synced = 0;

  for (const entry of entries) {
    try {
      if (entry.type === 'clock_in') {
        const { data, error } = await supabase
          .from('time_logs')
          .insert(entry.payload)
          .select('id')
          .single();

        // A duplicate open shift means the server already has this one.
        if (error && error.code !== '23505') throw error;
        if (data?.id) localToReal.set(entry.localId, data.id);
        synced += 1;
      } else if (entry.type === 'clock_out') {
        const logId = entry.logId ?? localToReal.get(entry.localRef);
        if (!logId) {
          // Its clock-in has not synced yet. Keep it for the next attempt.
          remaining.push(entry);
          continue;
        }
        // .select() (an array, not .single()) preserves the same
        // zero-row-tolerant behaviour as before when the shift is
        // already closed (e.g. a remote clock-out beat this replay to
        // it) — data is just [] then, not an error — while still
        // letting this read back the ACTUAL clock_out the server set
        // (entry.clock_out is only ever a claim now, see 0041) whenever
        // a row genuinely was updated.
        const { data, error } = await supabase
          .from('time_logs')
          .update({ clock_out: entry.clock_out })
          .eq('id', logId)
          .is('clock_out', null)
          .select('clock_out, user_id');

        if (error) throw error;
        synced += 1;
        if (data?.[0]?.clock_out) {
          void flagClockOutDiscrepancy(supabase, data[0].user_id, logId, entry.clock_out, data[0].clock_out);
        }
      } else if (entry.type === 'delivery_run_complete') {
        // Same local-id correlation as clock_out — a run may belong to a
        // shift that itself hasn't synced yet. Queued ahead of that
        // shift's own clock_out entry when both happened offline in the
        // same session (see finalizeRun in EmployeeDashboard.tsx), so by
        // the time this runs the shift is still open server-side, which
        // record_delivery_run's own RLS requires.
        const logId = entry.logId ?? localToReal.get(entry.localTimeLogRef);
        if (!logId) {
          remaining.push(entry);
          continue;
        }
        const { error } = await supabase.rpc('record_delivery_run', {
          p_time_log_id: logId,
          p_started_at: entry.started_at,
          p_ended_at: entry.ended_at,
          p_one_way_miles: entry.one_way_miles,
          p_drops: entry.drops,
        });

        if (error) throw error;
        synced += 1;
      }
    } catch {
      // Still offline, or the server rejected it. Keep it and retry later —
      // dropping the entry would lose the hours, which is the whole point.
      remaining.push(entry);
    }
  }

  write(remaining);
  return { synced, failed: remaining.length };
}
