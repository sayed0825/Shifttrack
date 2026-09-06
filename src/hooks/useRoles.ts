import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient';

export interface Role {
  id: string;
  org_id: string;
  name: string;
  sort_order: number;
  is_protected: boolean;
  can_view_map: boolean;
}

interface RolesState {
  roles: Role[];
  loading: boolean;
  error: string | null;
}

// Module-scoped store shared by every useRoles() consumer. Several
// components mount this hook at once, and a Supabase realtime channel
// throws "cannot add postgres_changes callbacks ... after subscribe()" if a
// second caller tries to attach a handler to an already-subscribed channel —
// so there is exactly one channel and one cached snapshot for the whole app,
// not one per component.
let state: RolesState = { roles: [], loading: true, error: null };
let channel: RealtimeChannel | null = null;
let hasFetched = false;
const listeners = new Set<(next: RolesState) => void>();

function setState(patch: Partial<RolesState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

async function load(): Promise<void> {
  setState({ error: null });
  const { data, error: queryError } = await supabase
    .from('roles')
    .select('id, org_id, name, sort_order, is_protected, can_view_map')
    .order('sort_order', { ascending: true })
    .returns<Role[]>();

  if (queryError) {
    setState({ error: 'Roles could not be loaded.', loading: false });
  } else {
    setState({ roles: data ?? [], loading: false });
  }
}

function subscribe(listener: (next: RolesState) => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1) {
    // Roles change rarely — fetch once and rely on the realtime channel for
    // updates from then on, rather than refetching every time the last
    // consumer unmounts and a new one takes its place.
    if (!hasFetched) {
      hasFetched = true;
      void load();
    }
    channel = supabase
      .channel('roles-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'roles' }, () => void load())
      .subscribe();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && channel) {
      void supabase.removeChannel(channel);
      channel = null;
    }
  };
}

/**
 * Roles are per-organisation rows in `roles`, ordered by sort_order. RLS
 * scopes the select to the caller's org, so no org_id filter is needed here.
 */
export function useRoles(): {
  roles: Role[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [local, setLocal] = useState<RolesState>(state);

  useEffect(() => {
    setLocal(state);
    return subscribe(setLocal);
  }, []);

  return { roles: local.roles, loading: local.loading, error: local.error, refresh: load };
}
