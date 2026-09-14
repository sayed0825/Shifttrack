import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

interface OrderRateState {
  orderRate: number;
  loading: boolean;
}

// Module-scoped, shared across every useOrderRate() consumer — mirrors the
// caching approach in useLateGrace.ts (same organisations-settings shape,
// same reason: this changes almost never, so every mounted consumer sharing
// one fetch beats each doing its own).
let state: OrderRateState = { orderRate: 1, loading: true };
// True only once a real, session-backed fetch has succeeded. A missing
// session or an RPC error must never set this — otherwise a fetch that ran
// before the Supabase session finished restoring (RLS sees an anonymous
// caller, the RPC 401s) would freeze the cache on 1 forever, indistinguishable
// from a real org whose rate happens to be 1.
let hasLoaded = false;
let inFlight: Promise<void> | null = null;
let authListenerAttached = false;
const listeners = new Set<(next: OrderRateState) => void>();

function setState(patch: Partial<OrderRateState>): void {
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
    // token is what produced the 401 this cache used to lock in as failed.
    // The auth-state listener below retries once SIGNED_IN fires.
    if (!session) return;

    const { data, error } = await supabase.rpc('my_order_rate');

    if (error || typeof data !== 'number') {
      // Never cache a failure — hasLoaded stays false so the next attempt retries.
      setState({ orderRate: 1, loading: false });
      return;
    }

    hasLoaded = true;
    setState({ orderRate: data, loading: false });
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

function resetForNewSession(): void {
  hasLoaded = false;
  state = { orderRate: 1, loading: true };
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
      // different org — the previous org's cached rate must never leak
      // into their session.
      resetForNewSession();
      void load();
    }, 0);
  });
}

function subscribe(listener: (next: OrderRateState) => void): () => void {
  listeners.add(listener);
  ensureAuthListener();
  if (!hasLoaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

/** The org's pay-per-completed-order rate, via my_order_rate(). */
export function useOrderRate(): { orderRate: number; loading: boolean; refresh: () => Promise<void> } {
  const [local, setLocal] = useState<OrderRateState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return { orderRate: local.orderRate, loading: local.loading, refresh: load };
}
