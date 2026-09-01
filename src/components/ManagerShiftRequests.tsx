import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftRight, CalendarPlus, Check, Loader2, Trash2, UserCheck } from 'lucide-react';
import { supabase } from '../supabaseClient';

const ROLES = [
  'Driver', 'FOH', 'KA', 'Head Chef', 'Second Chef',
  'Cook', 'Tandoori Chef', 'Kitchen Porter',
];

interface ShiftLite {
  id: string;
  title: string | null;
  start_time: string;
  end_time: string;
  required_role: string | null;
  locations: { name: string } | null;
  profiles: { id: string; first_name: string | null; full_name: string | null } | null;
}

interface SwapRow {
  id: string;
  requester_shift: ShiftLite | null;
  target_shift: ShiftLite | null;
}

interface ApplicationRow {
  id: string;
  shift_id: string;
  profiles: { id: string; first_name: string | null; full_name: string | null } | null;
}

const SHIFT_FIELDS =
  'id, title, start_time, end_time, required_role, locations ( name ), profiles:assigned_user_id ( id, first_name, full_name )';

function when(shift: ShiftLite | null): string {
  if (!shift) return '—';
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${new Date(shift.start_time).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric',
  })} · ${time(shift.start_time)}–${time(shift.end_time)}`;
}

function nameOf(p: { first_name: string | null; full_name: string | null } | null): string {
  return p?.full_name ?? p?.first_name ?? 'Unknown';
}

function toUtcIso(dateKey: string, hhmm: string, dayOffset = 0): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d + dayOffset, hh, mm, 0, 0).toISOString();
}

export default function ManagerShiftRequests({
  locations,
}: {
  locations: Array<{ id: string; name: string }>;
}): ReactNode {
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [openShifts, setOpenShifts] = useState<ShiftLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [role, setRole] = useState(ROLES[0]);
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('17:00');
  const [endTime, setEndTime] = useState('22:00');

  const load = useCallback(async () => {
    setFault(null);
    const nowIso = new Date().toISOString();

    const [swapRes, appRes, openRes] = await Promise.all([
      supabase
        .from('shift_swaps')
        .select(
          `id,
           requester_shift:requester_shift_id ( ${SHIFT_FIELDS} ),
           target_shift:target_shift_id ( ${SHIFT_FIELDS} )`
        )
        .eq('status', 'pending_manager')
        .order('created_at'),
      supabase
        .from('shift_applications')
        .select('id, shift_id, profiles:user_id ( id, first_name, full_name )')
        .order('created_at'),
      supabase
        .from('shifts')
        .select(SHIFT_FIELDS)
        .is('assigned_user_id', null)
        .gte('start_time', nowIso)
        .order('start_time'),
    ]);

    setSwaps((swapRes.data ?? []) as unknown as SwapRow[]);
    setApplications((appRes.data ?? []) as unknown as ApplicationRow[]);
    setOpenShifts((openRes.data ?? []) as unknown as ShiftLite[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applicantsByShift = useMemo(() => {
    const map = new Map<string, ApplicationRow[]>();
    for (const app of applications) {
      const list = map.get(app.shift_id) ?? [];
      list.push(app);
      map.set(app.shift_id, list);
    }
    return map;
  }, [applications]);

  const run = async (id: string, fn: () => Promise<{ error: unknown }>) => {
    setBusyId(id);
    setFault(null);
    const { error } = await fn();
    if (error) {
      const message =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message: string }).message)
          : 'That did not go through.';
      setFault(message);
    } else {
      await load();
    }
    setBusyId(null);
  };

  const postOpenShift = async () => {
    if (!locationId || !date) {
      setFault('Pick a location and a date.');
      return;
    }
    if (startTime === endTime) {
      setFault('Start and end times cannot be the same.');
      return;
    }
    const location = locations.find((l) => l.id === locationId);
    const overnight = endTime <= startTime;

    await run('new-open', async () =>
      supabase.from('shifts').insert({
        title: `${startTime}–${endTime} · ${location?.name ?? 'Site'}`,
        start_time: toUtcIso(date, startTime),
        end_time: toUtcIso(date, endTime, overnight ? 1 : 0),
        location_id: locationId,
        assigned_user_id: null,
        required_role: role,
        is_recurring: false,
        series_id: null,
      })
    );
    setDate('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading requests…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {fault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

      {/* Swaps awaiting approval */}
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Swap requests</h3>
          {swaps.length > 0 && (
            <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">
              {swaps.length}
            </span>
          )}
        </div>

        {swaps.length === 0 ? (
          <p className="mt-3 text-sm text-ink/60">Nothing waiting on you.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {swaps.map((swap) => (
              <li key={swap.id} className="rounded-lg border border-border p-3">
                <p className="text-sm text-ink">
                  Both employees have agreed. Approving moves each shift to the other person.
                </p>
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="truncate text-ink/60">{nameOf(swap.requester_shift?.profiles ?? null)}</dt>
                    <dd className="text-right font-medium text-ink">{when(swap.requester_shift)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="truncate text-ink/60">{nameOf(swap.target_shift?.profiles ?? null)}</dt>
                    <dd className="text-right font-medium text-ink">{when(swap.target_shift)}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busyId === swap.id}
                    onClick={() =>
                      void run(swap.id, async () => supabase.rpc('approve_shift_swap', { p_swap_id: swap.id }))
                    }
                    className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Approve swap
                  </button>
                  <button
                    type="button"
                    disabled={busyId === swap.id}
                    onClick={() =>
                      void run(swap.id, async () =>
                        supabase.from('shift_swaps').update({ status: 'denied' }).eq('id', swap.id)
                      )
                    }
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Post an open shift */}
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <CalendarPlus className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Post an open shift</h3>
        </div>
        <p className="mt-2 text-sm text-ink/60">Only staff with the chosen role will see it.</p>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="open-location" className="block text-sm font-medium text-ink">Location</label>
              <select
                id="open-location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="open-role" className="block text-sm font-medium text-ink">Role needed</label>
              <select
                id="open-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="open-date" className="block text-sm font-medium text-ink">Date</label>
              <input
                id="open-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="open-start" className="block text-sm font-medium text-ink">Start</label>
              <input
                id="open-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="open-end" className="block text-sm font-medium text-ink">End</label>
              <input
                id="open-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void postOpenShift()}
            disabled={busyId === 'new-open' || !date}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {busyId === 'new-open' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            )}
            Post shift
          </button>
        </div>
      </section>

      {/* Open shifts and their applicants */}
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <UserCheck className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Open shifts</h3>
        </div>

        {openShifts.length === 0 ? (
          <p className="mt-3 text-sm text-ink/60">No shifts are currently open.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {openShifts.map((shift) => {
              const applicants = applicantsByShift.get(shift.id) ?? [];
              return (
                <li key={shift.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{when(shift)}</p>
                      <p className="truncate text-xs text-ink/60">
                        {shift.locations?.name ?? 'No location'} · {shift.required_role ?? 'Any role'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void run(shift.id, async () => supabase.from('shifts').delete().eq('id', shift.id))
                      }
                      aria-label="Delete open shift"
                      className="shrink-0 rounded p-1.5 text-ink/40 hover:bg-danger-bg hover:text-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>

                  {applicants.length === 0 ? (
                    <p className="mt-2 text-xs text-ink/60">No applicants yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
                      {applicants.map((app) => (
                        <li key={app.id} className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-sm text-ink">
                            {nameOf(app.profiles)}
                          </span>
                          <button
                            type="button"
                            disabled={busyId === app.id}
                            onClick={() =>
                              void run(app.id, async () =>
                                supabase.rpc('approve_shift_application', { p_application_id: app.id })
                              )
                            }
                            className="min-h-[44px] shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-dark"
                          >
                            {busyId === app.id ? '…' : 'Give shift'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
