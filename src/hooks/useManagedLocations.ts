import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

interface ManagedLocationsState {
  locationIds: string[];
  loading: boolean;
  error: string | null;
}

// Module-scoped, shared across every useManagedLocations() consumer.
// Mirrors the caching approach in useRoles.ts. Wraps my_managed_locations(),
// the same SECURITY DEFINER function the manages_person() RLS check (used
// by employee_notes and elsewhere) evaluates against — for an Administrator
// that's every location in the org, for a location-scoped Manager it's just
// the locations in their own profile_locations rows. Reading it here lets
// the UI hide controls for people RLS would refuse anyway, instead of
// offering them and surfacing a raw policy error.
let state: ManagedLocationsState = { locationIds: [], loading: true, error: null };
// True only once a real, session-backed fetch has succeeded. A missing
// session or an RPC error must never set this — otherwise a fetch that ran
// before the Supabase session finished restoring (RLS sees an anonymous
// caller, the RPC 401s) would freeze the cache on an empty list forever,
// which reads identically to "manages nothing" and would hide every staff
// member from a Manager who actually manages plenty of them.
let hasLoaded = false;
let inFlight: Promise<void> | null = null;
let authListenerAttached = false;
const listeners = new Set<(next: ManagedLocationsState) => void>();

function setState(patch: Partial<ManagedLocationsState>): void {
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
    // token is what would produce a 401 this cache could otherwise lock in
    // as an empty list. The auth-state listener below retries once
    // SIGNED_IN fires.
    if (!session) return;

    const { data, error } = await supabase.rpc('my_managed_locations');

    if (error) {
      // Never cache a failure — hasLoaded stays false so the next attempt retries.
      setState({ error: 'Managed locations could not be loaded.', loading: false });
      return;
    }

    hasLoaded = true;
    setState({ locationIds: (data ?? []) as string[], loading: false, error: null });
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

function resetForNewSession(): void {
  hasLoaded = false;
  state = { locationIds: [], loading: true, error: null };
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
      // A different user may just have signed in (or out), possibly
      // managing a different set of locations — the previous user's cached
      // list must never leak into their session.
      resetForNewSession();
      void load();
    }, 0);
  });
}

function subscribe(listener: (next: ManagedLocationsState) => void): () => void {
  listeners.add(listener);
  ensureAuthListener();
  if (!hasLoaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Location ids the signed-in user manages, via my_managed_locations(): every
 * org location for an Administrator, or just their own profile_locations
 * for a location-scoped Manager.
 */
export function useManagedLocations(): {
  locationIds: string[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [local, setLocal] = useState<ManagedLocationsState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return { locationIds: local.locationIds, loading: local.loading, error: local.error, refresh: load };
}
