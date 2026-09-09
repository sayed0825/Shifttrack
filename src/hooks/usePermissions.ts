import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

interface PermissionsState {
  canManage: boolean;
  isAdmin: boolean;
  loading: boolean;
}

// Module-scoped, shared across every usePermissions() consumer — mirrors the
// caching approach in useRoles.ts. Deliberately calls is_manager()/is_admin()
// rather than matching profiles.role against the cached roles list: those
// functions are exactly what RLS itself enforces, so the UI can't drift from
// the database — a role rename or a flag change on `roles` takes effect
// without the client reasoning about names at all.
let state: PermissionsState = { canManage: false, isAdmin: false, loading: true };
// True only once a real, session-backed answer has been cached. A missing
// session or an RPC error must never set this — otherwise a fetch that ran
// before the Supabase session finished restoring (RLS sees an anonymous
// caller, the RPC 401s) would freeze the cache on canManage/isAdmin: false
// forever, with no way for the app to ever learn the real answer.
let hasLoaded = false;
let inFlight: Promise<void> | null = null;
let authListenerAttached = false;
const listeners = new Set<(next: PermissionsState) => void>();

function setState(patch: Partial<PermissionsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    // Not signed in (yet) — don't call the RPCs at all. Firing them with no
    // token is what produced the 401 this cache used to lock in as `false`.
    // The auth-state listener below retries once SIGNED_IN fires.
    if (!session) return;

    const [managerResult, adminResult] = await Promise.all([
      supabase.rpc('is_manager'),
      supabase.rpc('is_admin'),
    ]);

    // Never cache a failure — leave `hasLoaded`/`loading` untouched so the
    // next attempt (a remount, or the next auth event) retries instead of
    // the UI ever seeing a stale, wrong `false`.
    if (managerResult.error || adminResult.error) return;

    hasLoaded = true;
    setState({
      canManage: managerResult.data === true,
      isAdmin: adminResult.data === true,
      loading: false,
    });
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

function resetForNewSession(): void {
  hasLoaded = false;
  state = { canManage: false, isAdmin: false, loading: true };
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
      // A different user may just have signed in (or out) — the previous
      // user's cached flags must never leak into their session.
      resetForNewSession();
      void load();
    }, 0);
  });
}

function subscribe(listener: (next: PermissionsState) => void): () => void {
  listeners.add(listener);
  ensureAuthListener();
  if (!hasLoaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Capability flags for the signed-in user: canManage (Manager or
 * Administrator — decides dashboard routing) and isAdmin (Administrator
 * only — gates admin-only UI like Roles, Branding and the grace period).
 * `loading` stays true until a real, session-backed answer is in hand, so
 * callers like App.tsx never route on an unknown or default-false result.
 */
export function usePermissions(): PermissionsState {
  const [local, setLocal] = useState<PermissionsState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return local;
}
