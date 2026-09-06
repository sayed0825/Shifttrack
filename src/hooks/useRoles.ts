import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface Role {
  id: string;
  org_id: string;
  name: string;
  sort_order: number;
  is_protected: boolean;
  can_view_map: boolean;
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
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data, error: queryError } = await supabase
      .from('roles')
      .select('id, org_id, name, sort_order, is_protected, can_view_map')
      .order('sort_order', { ascending: true })
      .returns<Role[]>();

    if (queryError) {
      setError('Roles could not be loaded.');
    } else {
      setRoles(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Roles are managed from ManagerMoreTab but read from several other
  // components at once — keep everyone in sync when they change.
  useEffect(() => {
    const channel = supabase
      .channel('roles-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'roles' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  return { roles, loading, error, refresh: load };
}
