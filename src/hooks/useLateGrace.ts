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
let hasFetched = false;
const listeners = new Set<(next: LateGraceState) => void>();

function setState(patch: Partial<LateGraceState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  const { data, error } = await supabase.rpc('my_late_grace_minutes');
  setState({ graceMinutes: error || typeof data !== 'number' ? 0 : data, loading: false });
}

function subscribe(listener: (next: LateGraceState) => void): () => void {
  listeners.add(listener);
  if (!hasFetched) {
    hasFetched = true;
    void load();
  }
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
