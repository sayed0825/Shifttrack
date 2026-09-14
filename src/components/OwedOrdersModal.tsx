import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Loader2, Package } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles } from '../hooks/useRoles';
import { friendlyError } from '../lib/friendlyError';
import { logNeedsOrdersReport, orgTracksOrders, tracksOrdersRoleNames } from '../lib/tracksOrders';
import type { Profile } from './ManagerDashboard';

interface OwedLog {
  id: string;
  clock_in: string;
  clock_out: string;
  role_at_clock_in: string | null;
  locations: { name: string } | null;
}

function formatShiftLabel(log: OwedLog): string {
  const day = new Date(log.clock_in).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const site = log.locations?.name ? ` · ${log.locations.name}` : '';
  return `${day} · ${time(log.clock_in)}–${time(log.clock_out)}${site}`;
}

/**
 * Blocks the app until every closed shift the driver owes an orders entry
 * for has one. Mounted once at the dashboard root so it fires on login
 * regardless of which tab last persisted, and re-checked whenever `checkSignal`
 * changes (the Clock/Tasks tabs becoming active, or right after a clock-out).
 */
export default function OwedOrdersModal({
  profile,
  checkSignal,
}: {
  profile: Profile;
  checkSignal: number;
}): ReactNode {
  const { roles } = useRoles();
  const [queue, setQueue] = useState<OwedLog[]>([]);
  const [orders, setOrders] = useState('');
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const trackedRoleNames = useMemo(() => tracksOrdersRoleNames(roles), [roles]);

  const load = useCallback(async () => {
    if (roles.length === 0 || !orgTracksOrders(roles)) return;

    const { data, error } = await supabase
      .from('time_logs')
      .select('id, clock_in, clock_out, role_at_clock_in, locations ( name )')
      .eq('user_id', profile.id)
      .not('clock_out', 'is', null)
      .is('orders_count', null)
      .order('clock_in', { ascending: true })
      .returns<OwedLog[]>();

    if (error || !data) return;

    setQueue(
      data.filter((log) => logNeedsOrdersReport(log.role_at_clock_in, profile.role, trackedRoleNames))
    );
  }, [profile.id, profile.role, roles, trackedRoleNames]);

  useEffect(() => {
    void load();
  }, [load, checkSignal]);

  const current = queue[0] ?? null;

  const handleSubmit = async () => {
    if (!current) return;
    setFault(null);

    const trimmedOrders = orders.trim();
    const parsedOrders = Number(trimmedOrders);
    if (trimmedOrders === '' || !Number.isInteger(parsedOrders) || parsedOrders < 0) {
      setFault('Enter the number of orders completed — 0 or more.');
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('time_logs')
      .update({ orders_count: parsedOrders })
      .eq('id', current.id);
    setSaving(false);

    if (error) {
      console.error(error);
      setFault(friendlyError(error, 'Could not save. Check your connection and try again.'));
      return;
    }

    setOrders('');
    setQueue((q) => q.slice(1));
  };

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[1300] flex items-end justify-center bg-primary/60 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="owed-orders-title"
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-2xl"
      >
        <div className="flex items-start gap-3">
          <Package className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="owed-orders-title" className="text-base font-semibold text-ink">
              Report your shift
            </h2>
            <p className="mt-1 text-sm text-ink/60">{formatShiftLabel(current)}</p>
            {queue.length > 1 && (
              <p className="mt-1 text-xs text-ink/50">
                {queue.length} shifts need this — you'll go through them one at a time.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="owed-orders-count" className="block text-sm font-medium text-ink">
              Orders completed
            </label>
            <input
              id="owed-orders-count"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={orders}
              onChange={(e) => setOrders(e.target.value)}
              autoFocus
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          {fault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
