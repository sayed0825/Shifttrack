import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MapPinned, MessageCircle, Minimize2, Navigation, WifiOff, CheckCircle2 } from 'lucide-react';
import { supabase } from '../supabaseClient';

interface DispatchMessageRow {
  id: string;
  status: 'delivered' | 'returning' | 'arrived' | 'stale';
  eta_minutes: number | null;
  drop_sequence: number | null;
  created_at: string;
  updated_at: string;
  sender_id: string;
  profiles: { full_name: string | null; first_name: string | null } | null;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function driverName(row: DispatchMessageRow): string {
  return row.profiles?.first_name ?? row.profiles?.full_name ?? 'A driver';
}

function MessageLine({ row }: { row: DispatchMessageRow }): ReactNode {
  const name = driverName(row);

  if (row.status === 'delivered') {
    return (
      <div className="flex items-start gap-2.5 py-2.5">
        <MapPinned className="mt-0.5 h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            <span className="font-semibold">{name}</span> · Delivered
            {row.drop_sequence != null && <span className="text-ink/60"> · drop {row.drop_sequence}</span>}
          </p>
          <p className="text-xs text-ink/50">{formatRelative(row.created_at)}</p>
        </div>
      </div>
    );
  }

  if (row.status === 'arrived') {
    return (
      <div className="flex items-start gap-2.5 py-2.5">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-active" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            <span className="font-semibold">{name}</span> · Arrived
          </p>
          <p className="text-xs text-ink/50">{formatRelative(row.updated_at)}</p>
        </div>
      </div>
    );
  }

  // returning or stale
  const isStale = row.status === 'stale';
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      {isStale ? (
        <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <Navigation className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">
          <span className="font-semibold">{name}</span> · Returning
          {row.eta_minutes != null && ` (${row.eta_minutes} min${row.eta_minutes === 1 ? '' : 's'})`}
        </p>
        <p className={`text-xs ${isStale ? 'text-warning' : 'text-ink/50'}`}>
          {isStale ? `Signal lost · last update ${formatRelative(row.updated_at)}` : `Updated ${formatRelative(row.updated_at)}`}
        </p>
      </div>
    </div>
  );
}

/**
 * A compact trigger that expands into a full-screen dispatch chat feed —
 * used identically by FOH (their own open shift's location, never null)
 * and managers (the dashboard's existing locationFilter: a specific id,
 * or null for "all locations I manage", matching that filter's own 'all'
 * option). RLS (dispatch_messages_select) is what actually scopes which
 * rows come back either way; this component never applies its own
 * visibility rule beyond the query filter below.
 */
export default function DispatchChat({
  locationId,
  orgId,
}: {
  /** null = no single-location filter — the manager view's "all locations". */
  locationId: string | null;
  orgId: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<DispatchMessageRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('dispatch_messages')
      .select('id, status, eta_minutes, drop_sequence, created_at, updated_at, sender_id, profiles:sender_id ( full_name, first_name )')
      .order('created_at', { ascending: false })
      .limit(100);
    query = locationId ? query.eq('location_id', locationId) : query.eq('org_id', orgId);
    const { data } = await query;
    setMessages((data ?? []) as unknown as DispatchMessageRow[]);
    setLoading(false);
  }, [locationId, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Table-wide (no per-row filter beyond location/org, matching the
  // channel-per-scope + refetch-on-any-event pattern already used
  // throughout this app — see roster-sidebar/manager-tasks-review).
  useEffect(() => {
    const channel = supabase
      .channel(`dispatch-chat-${locationId ?? `org-${orgId}`}`)
      .on(
        'postgres_changes',
        locationId
          ? { event: '*', schema: 'public', table: 'dispatch_messages', filter: `location_id=eq.${locationId}` }
          : { event: '*', schema: 'public', table: 'dispatch_messages', filter: `org_id=eq.${orgId}` },
        () => void load()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [locationId, orgId, load]);

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-bg"
      >
        <MessageCircle className="h-4 w-4 text-ink/60" aria-hidden="true" />
        Dispatch chat
      </button>

      {expanded && (
        <div className="fixed inset-0 z-[1400] flex flex-col bg-bg">
          <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
            <h2 className="flex items-center gap-2 font-display text-lg tracking-tight text-ink">
              <MessageCircle className="h-5 w-5 text-primary" aria-hidden="true" />
              Dispatch chat
            </h2>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Minimise dispatch chat"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-ink/60 hover:bg-bg"
            >
              <Minimize2 className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-[env(safe-area-inset-bottom)]">
            {loading && messages.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink/50">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink/50">Nothing yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {messages.map((row) => (
                  <MessageLine key={row.id} row={row} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
