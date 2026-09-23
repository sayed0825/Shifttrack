import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

function lastSeenKey(viewerId: string, locationId: string | null, orgId: string): string {
  return `dispatch-chat-seen-${viewerId}-${locationId ?? `org-${orgId}`}`;
}

/**
 * A header icon (matching NotificationBell's own — same size, same
 * badge, same "always reachable, costs no screen space" placement, not
 * a floating/draggable button) that expands into a full-screen dispatch
 * chat feed. Used identically by FOH (their own open shift's location,
 * never null) and managers (the dashboard's existing locationFilter: a
 * specific id, or null for "all locations I manage", matching that
 * filter's own 'all' option). RLS (dispatch_messages_select) is what
 * actually scopes which rows come back either way; this component never
 * applies its own visibility rule beyond the query filter below.
 *
 * "Unread" here is inherently viewer-local, not a server column the way
 * notifications.is_read is — this feed has no per-recipient row, every
 * viewer at a location sees the same messages. Tracked client-side only
 * (localStorage, per viewer + scope, same keying pattern as
 * locationConsent/drivingMode elsewhere): a message posted after the
 * last time this viewer opened the panel counts as unread. Only
 * `created_at` counts, not `updated_at` — an ETA refreshing every ~90s
 * would otherwise keep inflating the badge for a message the viewer
 * already saw.
 */
export default function DispatchChat({
  locationId,
  orgId,
  viewerId,
}: {
  /** null = no single-location filter — the manager view's "all locations". */
  locationId: string | null;
  orgId: string;
  viewerId: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<DispatchMessageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenRef = useRef(0);

  useEffect(() => {
    try {
      lastSeenRef.current = Number(localStorage.getItem(lastSeenKey(viewerId, locationId, orgId)) ?? 0);
    } catch {
      lastSeenRef.current = 0;
    }
  }, [viewerId, locationId, orgId]);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('dispatch_messages')
      .select('id, status, eta_minutes, drop_sequence, created_at, updated_at, sender_id, profiles:sender_id ( full_name, first_name )')
      .order('created_at', { ascending: false })
      .limit(100);
    query = locationId ? query.eq('location_id', locationId) : query.eq('org_id', orgId);
    const { data } = await query;
    const rows = (data ?? []) as unknown as DispatchMessageRow[];
    setMessages(rows);
    setUnreadCount(rows.filter((row) => new Date(row.created_at).getTime() > lastSeenRef.current).length);
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

  const handleOpen = () => {
    setExpanded(true);
    const now = Date.now();
    lastSeenRef.current = now;
    setUnreadCount(0);
    try {
      localStorage.setItem(lastSeenKey(viewerId, locationId, orgId), String(now));
    } catch {
      // Best-effort — the in-memory ref above still governs this session.
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={`Dispatch chat${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        className="relative rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <MessageCircle className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
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
