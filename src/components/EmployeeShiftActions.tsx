import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftRight, CalendarPlus, Check, Loader2, Send, X } from 'lucide-react';
import { supabase } from '../supabaseClient';

interface ShiftLite {
  id: string;
  title: string | null;
  start_time: string;
  end_time: string;
  assigned_user_id: string | null;
  locations: { name: string } | null;
  profiles: { id: string; first_name: string | null; full_name: string | null } | null;
}

interface SwapRow {
  id: string;
  requester_id: string;
  target_id: string;
  status: 'pending_peer' | 'pending_manager' | 'denied';
  requester_shift: ShiftLite | null;
  target_shift: ShiftLite | null;
}

const SHIFT_FIELDS =
  'id, title, start_time, end_time, assigned_user_id, locations ( name ), profiles:assigned_user_id ( id, first_name, full_name )';

function when(shift: ShiftLite | null): string {
  if (!shift) return '—';
  const start = new Date(shift.start_time);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${start.toLocaleDateString([], opts)} · ${time(shift.start_time)}–${time(shift.end_time)}`;
}

function personName(shift: ShiftLite | null): string {
  return shift?.profiles?.full_name ?? shift?.profiles?.first_name ?? 'Colleague';
}

export default function EmployeeShiftActions({
  profile,
}: {
  profile: { id: string; role: string };
}): ReactNode {
  const [myShifts, setMyShifts] = useState<ShiftLite[]>([]);
  const [peerShifts, setPeerShifts] = useState<ShiftLite[]>([]);
  const [openShifts, setOpenShifts] = useState<ShiftLite[]>([]);
  const [myApplications, setMyApplications] = useState<Record<string, string>>({});
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const [mine, setMine] = useState('');
  const [theirs, setTheirs] = useState('');

  const load = useCallback(async () => {
    setFault(null);
    const nowIso = new Date().toISOString();

    const [shiftRes, openRes, appRes, swapRes] = await Promise.all([
      supabase.from('shifts').select(SHIFT_FIELDS).gte('start_time', nowIso).order('start_time'),
      supabase
        .from('shifts')
        .select(SHIFT_FIELDS)
        .is('assigned_user_id', null)
        .gte('start_time', nowIso)
        .order('start_time'),
      supabase.from('shift_applications').select('id, shift_id').eq('user_id', profile.id),
      supabase
        .from('shift_swaps')
        .select(
          `id, requester_id, target_id, status,
           requester_shift:requester_shift_id ( ${SHIFT_FIELDS} ),
           target_shift:target_shift_id ( ${SHIFT_FIELDS} )`
        )
        .order('created_at', { ascending: false }),
    ]);

    // RLS returns my shifts and same-role colleagues' together.
    const all = (shiftRes.data ?? []) as unknown as ShiftLite[];
    setMyShifts(all.filter((s) => s.assigned_user_id === profile.id));
    setPeerShifts(all.filter((s) => s.assigned_user_id && s.assigned_user_id !== profile.id));

    setOpenShifts((openRes.data ?? []) as unknown as ShiftLite[]);
    setMyApplications(
      Object.fromEntries((appRes.data ?? []).map((a: { id: string; shift_id: string }) => [a.shift_id, a.id]))
    );
    setSwaps((swapRes.data ?? []) as unknown as SwapRow[]);
    setLoading(false);
  }, [profile.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const incoming = useMemo(
    () => swaps.filter((s) => s.target_id === profile.id && s.status === 'pending_peer'),
    [swaps, profile.id]
  );
  const outgoing = useMemo(() => swaps.filter((s) => s.requester_id === profile.id), [swaps, profile.id]);

  const run = async (id: string, fn: () => Promise<{ error: unknown }>) => {
    setBusyId(id);
    setFault(null);
    const { error } = await fn();
    if (error) setFault(error instanceof Error ? error.message : 'That did not go through. Try again.');
    else await load();
    setBusyId(null);
  };

  const requestSwap = async () => {
    const target = peerShifts.find((s) => s.id === theirs);
    if (!mine || !target?.assigned_user_id) return;
    await run('new-swap', async () =>
      supabase.from('shift_swaps').insert({
        requester_id: profile.id,
        requester_shift_id: mine,
        target_id: target.assigned_user_id,
        target_shift_id: target.id,
      })
    );
    setMine('');
    setTheirs('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {fault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

      {/* Open shifts */}
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <CalendarPlus className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Open shifts</h3>
        </div>
        <p className="mt-2 text-sm text-ink/60">
          Shifts your manager has posted for {profile.role}s. Applying does not guarantee it.
        </p>

        {openShifts.length === 0 ? (
          <p className="mt-4 text-sm text-ink/60">Nothing open right now.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {openShifts.map((shift) => {
              const applicationId = myApplications[shift.id];
              return (
                <li
                  key={shift.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{when(shift)}</p>
                    <p className="truncate text-xs text-ink/60">{shift.locations?.name ?? 'No location'}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busyId === shift.id}
                    onClick={() =>
                      void run(shift.id, async () =>
                        applicationId
                          ? supabase.from('shift_applications').delete().eq('id', applicationId)
                          : supabase.from('shift_applications').insert({ shift_id: shift.id, user_id: profile.id })
                      )
                    }
                    className={`min-h-[44px] shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                      applicationId
                        ? 'border border-border text-ink/80 hover:bg-bg'
                        : 'bg-primary text-white hover:bg-primary-dark'
                    }`}
                  >
                    {busyId === shift.id ? '…' : applicationId ? 'Withdraw' : 'Apply'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Swap requests waiting on me */}
      {incoming.length > 0 && (
        <section className="rounded-2xl border border-secondary/40 bg-secondary/5 p-5">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-secondary" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-ink">Swap requests for you</h3>
          </div>

          <ul className="mt-4 space-y-3">
            {incoming.map((swap) => (
              <li key={swap.id} className="rounded-lg border border-border bg-surface p-3">
                <p className="text-sm text-ink">
                  <span className="font-medium">{personName(swap.requester_shift)}</span> wants your shift.
                </p>
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/60">You give up</dt>
                    <dd className="text-right font-medium text-ink">{when(swap.target_shift)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/60">You take</dt>
                    <dd className="text-right font-medium text-ink">{when(swap.requester_shift)}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busyId === swap.id}
                    onClick={() =>
                      void run(swap.id, async () =>
                        supabase.from('shift_swaps').update({ status: 'pending_manager' }).eq('id', swap.id)
                      )
                    }
                    className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Accept
                  </button>
                  <button
                    type="button"
                    disabled={busyId === swap.id}
                    onClick={() =>
                      void run(swap.id, async () =>
                        supabase.from('shift_swaps').update({ status: 'denied' }).eq('id', swap.id)
                      )
                    }
                    className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    Decline
                  </button>
                </div>
                <p className="mt-2 text-xs text-ink/60">Your manager still has to approve it.</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Request a swap */}
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Send className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Request a swap</h3>
        </div>
        <p className="mt-2 text-sm text-ink/60">
          You can only swap with other {profile.role}s. They accept first, then your manager.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="swap-mine" className="block text-sm font-medium text-ink">
              Your shift
            </label>
            <select
              id="swap-mine"
              value={mine}
              onChange={(e) => setMine(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">Choose one of yours</option>
              {myShifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {when(s)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="swap-theirs" className="block text-sm font-medium text-ink">
              Shift you want
            </label>
            <select
              id="swap-theirs"
              value={theirs}
              onChange={(e) => setTheirs(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">Choose a colleague&rsquo;s shift</option>
              {peerShifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {personName(s)} — {when(s)}
                </option>
              ))}
            </select>
          </div>

          {myShifts.length === 0 && (
            <p className="text-xs text-ink/60">You have no upcoming shifts to offer.</p>
          )}

          <button
            type="button"
            onClick={() => void requestSwap()}
            disabled={!mine || !theirs || busyId === 'new-swap'}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {busyId === 'new-swap' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            )}
            Send request
          </button>
        </div>

        {outgoing.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-border pt-4">
            {outgoing.map((swap) => (
              <li key={swap.id} className="flex items-center gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ink">{when(swap.requester_shift)}</p>
                  <p className="truncate text-xs text-ink/60">
                    with {personName(swap.target_shift)} · {when(swap.target_shift)}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    swap.status === 'denied'
                      ? 'bg-danger-bg text-danger'
                      : swap.status === 'pending_manager'
                        ? 'bg-secondary/10 text-secondary'
                        : 'bg-warning-bg text-warning'
                  }`}
                >
                  {swap.status === 'denied'
                    ? 'Declined'
                    : swap.status === 'pending_manager'
                      ? 'With manager'
                      : 'Awaiting colleague'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void run(swap.id, async () => supabase.from('shift_swaps').delete().eq('id', swap.id))
                  }
                  aria-label="Remove request"
                  className="shrink-0 rounded p-1.5 text-ink/40 hover:bg-danger-bg hover:text-danger"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
