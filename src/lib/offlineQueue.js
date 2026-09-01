/*
 * Offline clock-in queue.
 *
 * Clocking in is the only genuinely time-critical action in this app: if it
 * fails, the hours worked are simply lost. Every other screen can wait for a
 * connection. So a failed clock-in is stored on the device and replayed when
 * the network returns, rather than shown as an error the employee can do
 * nothing about.
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
        const { error } = await supabase
          .from('time_logs')
          .update({ clock_out: entry.clock_out })
          .eq('id', logId)
          .is('clock_out', null);

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
