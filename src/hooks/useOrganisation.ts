import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface Organisation {
  id: string;
  name: string;
  logo_url: string | null;
  primary_colour: string | null;
}

interface OrganisationState {
  organisation: Organisation | null;
  loading: boolean;
  error: string | null;
}

// Module-scoped, shared across every useOrganisation() consumer — both
// dashboard headers and the Branding section all want the same row.
// Mirrors the caching approach in useRoles.ts; changes here are rare and
// always made by the viewer themselves, so a save calls refresh() directly
// rather than needing a realtime channel.
let state: OrganisationState = { organisation: null, loading: true, error: null };
// True only once a real, session-backed fetch has succeeded. A missing
// session or a query error must never set this — otherwise a fetch that ran
// before the Supabase session finished restoring (RLS sees an anonymous
// caller, my_org_id()/the select 401s) would freeze the cache on a null
// organisation forever, with no way for the app to ever learn the real one.
let hasLoaded = false;
let inFlight: Promise<void> | null = null;
let authListenerAttached = false;
const listeners = new Set<(next: OrganisationState) => void>();

function setState(patch: Partial<OrganisationState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    // Not signed in (yet) — don't call the RPC/query at all. Firing them
    // with no token is what produced the 401 this cache used to lock in as
    // failed. The auth-state listener below retries once SIGNED_IN fires.
    if (!session) return;

    setState({ error: null });

    const { data: orgId, error: orgIdError } = await supabase.rpc('my_org_id');
    if (orgIdError || !orgId) {
      // Never cache a failure — hasLoaded stays false so the next attempt retries.
      setState({ error: 'Organisation could not be loaded.', loading: false });
      return;
    }

    const { data, error: queryError } = await supabase
      .from('organisations')
      .select('id, name, logo_url, primary_colour')
      .eq('id', orgId)
      .single<Organisation>();

    if (queryError) {
      setState({ error: 'Organisation could not be loaded.', loading: false });
      return;
    }

    hasLoaded = true;
    setState({ organisation: data, loading: false });
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

function resetForNewSession(): void {
  hasLoaded = false;
  state = { organisation: null, loading: true, error: null };
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
      // different org — the previous org's cached row must never leak into
      // their session.
      resetForNewSession();
      void load();
    }, 0);
  });
}

function subscribe(listener: (next: OrganisationState) => void): () => void {
  listeners.add(listener);
  ensureAuthListener();
  if (!hasLoaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

/** The current org's name, logo_url and primary_colour, via my_org_id(). */
export function useOrganisation(): {
  organisation: Organisation | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [local, setLocal] = useState<OrganisationState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return { organisation: local.organisation, loading: local.loading, error: local.error, refresh: load };
}
