import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

interface PermissionsState {
  canManage: boolean;
  isAdmin: boolean;
  loading: boolean;
}

// Module-scoped, shared across every usePermissions() consumer — mirrors the
// caching approach in useRoles.ts, minus a realtime channel (a sign-out
// always does a window.location.reload(), so there's no risk of one user's
// cached flags leaking into another's session). Deliberately calls
// is_manager()/is_admin() rather than matching profiles.role against the
// cached roles list: those functions are exactly what RLS itself enforces,
// so the UI can't drift from the database — a role rename or a flag change
// on `roles` takes effect without the client reasoning about names at all.
let state: PermissionsState = { canManage: false, isAdmin: false, loading: true };
let hasFetched = false;
const listeners = new Set<(next: PermissionsState) => void>();

function setState(patch: Partial<PermissionsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  const [managerResult, adminResult] = await Promise.all([
    supabase.rpc('is_manager'),
    supabase.rpc('is_admin'),
  ]);

  setState({
    canManage: managerResult.data === true,
    isAdmin: adminResult.data === true,
    loading: false,
  });
}

function subscribe(listener: (next: PermissionsState) => void): () => void {
  listeners.add(listener);
  if (!hasFetched) {
    hasFetched = true;
    void load();
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Capability flags for the signed-in user: canManage (Manager or
 * Administrator — decides dashboard routing) and isAdmin (Administrator
 * only — gates admin-only UI like Roles, Branding and the grace period).
 */
export function usePermissions(): PermissionsState {
  const [local, setLocal] = useState<PermissionsState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return local;
}
