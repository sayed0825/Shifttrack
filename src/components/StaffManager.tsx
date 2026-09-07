import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Check, Filter, Loader2, MapPin,
  Search, Trash2, UserMinus, UserPlus, Users,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles } from '../hooks/useRoles';
import EmployeeNotes from './EmployeeNotes';

interface StaffRow {
  id: string;
  first_name: string | null;
  full_name: string | null;
  email: string | null;
  role: string | null;
  is_active: boolean;
}

interface UpcomingShift {
  id: string;
  start_time: string;
}

function startOfWeek(date: Date): Date {
  const r = new Date(date);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

function addDays(date: Date, days: number): Date {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function formatHours(hours: number): string {
  const whole = Math.floor(hours);
  return `${whole}h ${String(Math.round((hours - whole) * 60)).padStart(2, '0')}m`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function StaffManager({
  locations,
  viewerId,
}: {
  locations: Array<{ id: string; name: string }>;
  viewerId: string;
}): ReactNode {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [assigned, setAssigned] = useState<Record<string, { id: string; isPrimary: boolean }[]>>({});
  const [hours, setHours] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const { roles, loading: rolesLoading, error: rolesError } = useRoles();

  const [confirming, setConfirming] = useState<{
    person: StaffRow;
    shifts: UpcomingShift[];
    mode: 'deactivate' | 'delete';
  } | null>(null);

  const load = useCallback(async () => {
    const weekStart = startOfWeek(new Date());

    const [staffRes, locRes, logRes] = await Promise.all([
      supabase.from('profiles').select('id, first_name, full_name, email, role, is_active').order('full_name'),
      supabase.from('profile_locations').select('profile_id, location_id, is_primary'),
      supabase
        .from('time_logs')
        .select('user_id, clock_in, clock_out')
        .gte('clock_in', weekStart.toISOString())
        .lt('clock_in', addDays(weekStart, 7).toISOString()),
    ]);

    setStaff((staffRes.data ?? []) as StaffRow[]);

    const locMap: Record<string, { id: string; isPrimary: boolean }[]> = {};
    for (const row of locRes.data ?? []) {
      (locMap[row.profile_id] ??= []).push({ id: row.location_id, isPrimary: row.is_primary });
    }
    setAssigned(locMap);

    const hourMap: Record<string, number> = {};
    for (const log of logRes.data ?? []) {
      const end = log.clock_out ? new Date(log.clock_out).getTime() : Date.now();
      hourMap[log.user_id] =
        (hourMap[log.user_id] ?? 0) + Math.max(0, (end - new Date(log.clock_in).getTime()) / 3_600_000);
    }
    setHours(hourMap);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return staff.filter((p) => {
      if (roleFilter !== 'all' && p.role !== roleFilter) return false;
      if (locationFilter !== 'all' && !(assigned[p.id] ?? []).some((l) => l.id === locationFilter)) {
        return false;
      }
      if (!needle) return true;
      return `${p.full_name ?? ''} ${p.first_name ?? ''} ${p.role ?? ''} ${p.email ?? ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [staff, query, roleFilter, locationFilter, assigned]);

  const run = async (id: string, fn: () => Promise<{ error: unknown }>) => {
    setBusyId(id);
    setFault(null);
    const { error } = await fn();
    if (error) {
      const message =
        typeof error === 'object' && error && 'message' in error
          ? String((error as { message: string }).message)
          : 'That change did not save.';
      setFault(message);
    } else {
      await load();
    }
    setBusyId(null);
  };

  const setRole = (person: StaffRow, role: string | null) =>
    run(person.id, async () => supabase.from('profiles').update({ role }).eq('id', person.id));

  const toggleLocation = async (person: StaffRow, locationId: string) => {
    const current = assigned[person.id] ?? [];
    const existing = current.find((l) => l.id === locationId);

    if (!existing) {
      await run(person.id, async () =>
        supabase
          .from('profile_locations')
          .insert({ profile_id: person.id, location_id: locationId, is_primary: current.length === 0 })
      );
      return;
    }

    await run(person.id, async () =>
      supabase.from('profile_locations').delete().eq('profile_id', person.id).eq('location_id', locationId)
    );

    // Removing the primary leaves nobody flagged, so promote the next one.
    const remaining = current.filter((l) => l.id !== locationId);
    if (existing.isPrimary && remaining.length > 0) {
      await supabase
        .from('profile_locations')
        .update({ is_primary: true })
        .eq('profile_id', person.id)
        .eq('location_id', remaining[0].id);
      await load();
    }
  };

  const openDialog = async (person: StaffRow, mode: 'deactivate' | 'delete') => {
    setBusyId(person.id);
    setFault(null);
    const { data } = await supabase
      .from('shifts')
      .select('id, start_time')
      .eq('assigned_user_id', person.id)
      .gte('start_time', new Date().toISOString())
      .order('start_time');
    setBusyId(null);
    setConfirming({ person, shifts: (data ?? []) as UpcomingShift[], mode });
  };

  const finishDeactivate = async (cancelShifts: boolean) => {
    if (!confirming) return;
    const { person, shifts } = confirming;
    setBusyId(person.id);
    setFault(null);

    // Shifts first: if this fails, nothing changes at all, rather than
    // leaving someone deactivated with shifts you thought were cancelled.
    if (cancelShifts && shifts.length > 0) {
      const { error } = await supabase.from('shifts').delete().in('id', shifts.map((s) => s.id));
      if (error) {
        setFault('Could not cancel their shifts. Nothing has changed.');
        setBusyId(null);
        return;
      }
    }

    const { error } = await supabase.from('profiles').update({ is_active: false }).eq('id', person.id);
    if (error) setFault('Could not deactivate.');
    else await load();

    setConfirming(null);
    setBusyId(null);
  };

  const finishDelete = async () => {
    if (!confirming) return;
    setBusyId(confirming.person.id);
    setFault(null);

    const { error } = await supabase.rpc('delete_staff_member', { p_user_id: confirming.person.id });
    if (error) setFault(error.message);
    else await load();

    setConfirming(null);
    setBusyId(null);
  };

  const reactivate = (person: StaffRow) =>
    run(person.id, async () => supabase.from('profiles').update({ is_active: true }).eq('id', person.id));

  const activeFilters = (locationFilter !== 'all' ? 1 : 0) + (roleFilter !== 'all' ? 1 : 0);

  return (
    <>
    <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, or role"
              aria-label="Search staff"
              className="min-h-[44px] w-full rounded-lg border border-border py-2 pl-9 pr-3 text-sm"
            />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="relative">
              <MapPin
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
                aria-hidden="true"
              />
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                aria-label="Filter by location"
                className="min-h-[44px] w-full appearance-none rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-ink"
              >
                <option value="all">All locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div className="relative">
              <Filter
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
                aria-hidden="true"
              />
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                aria-label="Filter by role"
                className="min-h-[44px] w-full appearance-none rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-ink"
              >
                <option value="all">All roles</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.name}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>

          {activeFilters > 0 && (
            <button
              type="button"
              onClick={() => {
                setLocationFilter('all');
                setRoleFilter('all');
              }}
              className="mt-2 text-xs font-medium text-ink/60 underline underline-offset-2"
            >
              Clear filters · showing {filtered.length} of {staff.length}
            </button>
          )}

          {fault && <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}
          {rolesError && (
            <p className="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
              {rolesError} Role editing is unavailable until this loads.
            </p>
          )}

          {loading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading staff…
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-6 text-center text-sm text-ink/60">Nobody matches those filters.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {filtered.map((person) => {
                const open = editing === person.id;
                const theirs = assigned[person.id] ?? [];
                const isSelf = person.id === viewerId;

                return (
                  <li key={person.id} className="py-3">
                    <button
                      type="button"
                      onClick={() => setEditing(open ? null : person.id)}
                      className="flex w-full items-center gap-3 text-left"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${person.is_active ? 'bg-success' : 'bg-border'}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">
                          {person.full_name ?? person.first_name ?? 'Unnamed'}
                          {isSelf && <span className="ml-1 text-xs text-ink/50">(you)</span>}
                        </span>
                        {person.email && (
                          <span className="block truncate text-xs text-ink/50">{person.email}</span>
                        )}
                        <span className="block truncate text-xs text-ink/60">
                          {person.role ? person.role : <span className="italic text-ink/40">No role</span>}
                          {!person.is_active && ' · deactivated'}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-medium tabular-nums text-ink">
                          {formatHours(hours[person.id] ?? 0)}
                        </span>
                        <span className="block text-xs text-ink/50">this week</span>
                      </span>
                    </button>

                    {!person.role && (
                      <div className="mt-1.5 flex items-start gap-1.5 pl-5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                        <p className="text-xs font-medium text-warning">
                          No role assigned — they cannot be scheduled or see open shifts until one is set.
                        </p>
                      </div>
                    )}

                    {theirs.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
                        {theirs.map((entry) => (
                          <span
                            key={entry.id}
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              entry.isPrimary ? 'bg-primary/10 text-primary' : 'bg-bg text-ink/80'
                            }`}
                          >
                            {locations.find((l) => l.id === entry.id)?.name ?? 'Unknown'}
                            {entry.isPrimary && <span className="ml-1 text-[10px]">primary</span>}
                          </span>
                        ))}
                      </div>
                    )}

                    {open && (
                      <div className="mt-3 space-y-3 rounded-lg bg-bg p-3">
                        {person.email && (
                          <p className="break-all text-xs text-ink/70">{person.email}</p>
                        )}
                        <div>
                          <label htmlFor={`role-${person.id}`} className="block text-xs font-medium text-ink/60">
                            Job role
                          </label>
                          <select
                            id={`role-${person.id}`}
                            value={person.role ?? ''}
                            onChange={(e) => void setRole(person, e.target.value || null)}
                            disabled={busyId === person.id || rolesLoading}
                            className="mt-1 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                          >
                            <option value="">No role</option>
                            {roles.map((r) => (
                              <option key={r.id} value={r.name}>{r.name}</option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <p className="text-xs font-medium text-ink/60">Locations</p>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {locations.map((location) => {
                              const on = theirs.some((l) => l.id === location.id);
                              return (
                                <button
                                  key={location.id}
                                  type="button"
                                  onClick={() => void toggleLocation(person, location.id)}
                                  disabled={busyId === person.id}
                                  aria-pressed={on}
                                  className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                                    on
                                      ? 'border-primary bg-primary text-white'
                                      : 'border-border text-ink hover:border-primary/40'
                                  }`}
                                >
                                  {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                                  {location.name}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-1.5 text-xs text-ink/50">
                            The first location added is their primary site.
                          </p>
                        </div>

                        {!isSelf && (
                          <div className="space-y-2">
                            <button
                              type="button"
                              onClick={() =>
                                person.is_active
                                  ? void openDialog(person, 'deactivate')
                                  : void reactivate(person)
                              }
                              disabled={busyId === person.id}
                              className={`inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                                person.is_active
                                  ? 'border border-border text-ink hover:bg-surface'
                                  : 'bg-primary text-white hover:bg-primary-dark'
                              }`}
                            >
                              {busyId === person.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : person.is_active ? (
                                <UserMinus className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <UserPlus className="h-4 w-4" aria-hidden="true" />
                              )}
                              {person.is_active ? 'Deactivate' : 'Reactivate'}
                            </button>

                            <button
                              type="button"
                              onClick={() => void openDialog(person, 'delete')}
                              disabled={busyId === person.id}
                              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-danger px-3 py-2 text-sm font-semibold text-danger hover:bg-danger-bg"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              Delete permanently
                            </button>
                          </div>
                        )}

                        <EmployeeNotes
                          employeeId={person.id}
                          employeeName={person.full_name ?? person.first_name ?? 'Unnamed'}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
    </div>

      {/* Confirmation */}
      {confirming && (
        <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="staff-dialog-title"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-2xl"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className={`mt-0.5 h-5 w-5 shrink-0 ${
                  confirming.mode === 'delete' ? 'text-danger' : 'text-warning'
                }`}
                aria-hidden="true"
              />
              <div>
                <h4 id="staff-dialog-title" className="text-base font-semibold text-ink">
                  {confirming.mode === 'delete' ? 'Delete' : 'Deactivate'}{' '}
                  {confirming.person.full_name ?? confirming.person.first_name}?
                </h4>
                <p className="mt-1 text-sm text-ink/60">
                  {confirming.mode === 'delete'
                    ? 'This erases their account, every shift, and their whole timesheet history. It cannot be undone, and the hours will not be recoverable for payroll.'
                    : 'They will not be able to sign in, and they will disappear from staff lists. Their timesheet history is kept.'}
                </p>
              </div>
            </div>

            {confirming.shifts.length > 0 && (
              <div className="mt-4 rounded-lg bg-warning-bg p-3 text-sm">
                <p className="font-medium text-warning">
                  They have {confirming.shifts.length} upcoming shift
                  {confirming.shifts.length === 1 ? '' : 's'}
                </p>
                <p className="mt-1 text-xs text-warning">
                  {shortDate(confirming.shifts[0].start_time)}
                  {confirming.shifts.length > 1 &&
                    ` through ${shortDate(confirming.shifts[confirming.shifts.length - 1].start_time)}`}
                </p>
              </div>
            )}

            <div className="mt-4 space-y-2">
              {confirming.mode === 'delete' ? (
                <button
                  type="button"
                  onClick={() => void finishDelete()}
                  disabled={busyId === confirming.person.id}
                  className="min-h-[44px] w-full rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                >
                  {busyId === confirming.person.id ? 'Deleting…' : 'Delete permanently'}
                </button>
              ) : confirming.shifts.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => void finishDeactivate(true)}
                    disabled={busyId === confirming.person.id}
                    className="min-h-[44px] w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
                  >
                    Cancel their shifts and deactivate
                  </button>
                  <button
                    type="button"
                    onClick={() => void finishDeactivate(false)}
                    disabled={busyId === confirming.person.id}
                    className="min-h-[44px] w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-bg disabled:opacity-60"
                  >
                    Keep the shifts and deactivate
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void finishDeactivate(false)}
                  disabled={busyId === confirming.person.id}
                  className="min-h-[44px] w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
                >
                  Deactivate
                </button>
              )}

              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="min-h-[44px] w-full rounded-lg px-4 py-2 text-sm font-medium text-ink/60 hover:bg-bg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
