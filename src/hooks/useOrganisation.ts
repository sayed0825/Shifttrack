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
let hasFetched = false;
const listeners = new Set<(next: OrganisationState) => void>();

function setState(patch: Partial<OrganisationState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  setState({ error: null });

  const { data: orgId, error: orgIdError } = await supabase.rpc('my_org_id');
  if (orgIdError || !orgId) {
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
  } else {
    setState({ organisation: data, loading: false });
  }
}

function subscribe(listener: (next: OrganisationState) => void): () => void {
  listeners.add(listener);
  if (!hasFetched) {
    hasFetched = true;
    void load();
  }
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
