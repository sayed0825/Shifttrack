import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

interface LateGraceState {
  graceMinutes: number;
  loading: boolean;
}

// Module-scoped, shared across every useLateGrace() consumer — the grace
// period changes almost never, so there's no need for each mounted
// component (manager timesheets, employee timesheets, the settings card) to
// fetch it independently. Mirrors the caching approach in useRoles.ts,
// minus a realtime channel: nothing pushes changes here, so a manager's
// save calls refresh() directly to update every consumer.
let state: LateGraceState = { graceMinutes: 0, loading: true };
// True only once a real, session-backed fetch has succeeded. A missing
// session or an RPC error must never set this — otherwise a fetch that ran
// before the Supabase session finished restoring (RLS sees an anonymous
// caller, the RPC 401s) would freeze the cache on 0 forever, indistinguishable
// from a real org that has no grace period configured.
let hasLoaded = false;
let inFlight: Promise<void> | null = null;
let authListenerAttached = false;
const listeners = new Set<(next: LateGraceState) => void>();

function setState(patch: Partial<LateGraceState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    // Not signed in (yet) — don't call the RPC at all. Firing it with no
    // token is what produced the 401 this cache used to lock in as 0. The
    // auth-state listener below retries once SIGNED_IN fires.
    if (!session) return;

    const { data, error } = await supabase.rpc('my_late_grace_minutes');

    if (error || typeof data !== 'number') {
      // Never cache a failure — hasLoaded stays false so the next attempt retries.
      setState({ graceMinutes: 0, loading: false });
      return;
    }

    hasLoaded = true;
    setState({ graceMinutes: data, loading: false });
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

function resetForNewSession(): void {
  hasLoaded = false;
  state = { graceMinutes: 0, loading: true };
  for (const listener of listeners) listener(state);
}

function ensureAuthListener(): void {
  if (authListenerAttached) return;
  authListenerAttached = true;

  supabase.auth.onAuthStateChange((event) => {
    if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') return;

    // Defer out of the listener's own synchronous dispatch — calling an
    // auth method (getSession, inside load()) directly from within
    // onAuthStateChange can deadlock the client.
    setTimeout(() => {
      // A different user may just have signed in (or out), possibly for a
      // different org — the previous org's cached grace period must never
      // leak into their session.
      resetForNewSession();
      void load();
    }, 0);
  });
}

function subscribe(listener: (next: LateGraceState) => void): () => void {
  listeners.add(listener);
  ensureAuthListener();
  if (!hasLoaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

/** The org's late clock-in grace period, in minutes, via my_late_grace_minutes(). */
export function useLateGrace(): { graceMinutes: number; loading: boolean; refresh: () => Promise<void> } {
  const [local, setLocal] = useState<LateGraceState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return { graceMinutes: local.graceMinutes, loading: local.loading, refresh: load };
}
