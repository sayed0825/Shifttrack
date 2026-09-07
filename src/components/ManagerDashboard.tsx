import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  Edit3,
  FileSpreadsheet,
  Filter,
  Loader2,
  MapPin,
  LogOut,
  MoreHorizontal,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles } from '../hooks/useRoles';
import { useOrganisation } from '../hooks/useOrganisation';
import { useLateGrace } from '../hooks/useLateGrace';
import { isLate, minutesLate } from '../lib/lateness';
import FilterButton from './FilterButton';
import LiveMap from './LiveMap';
import ManagerScheduler from './ManagerScheduler';
import ManagerTasks from './ManagerTasks';
import NotificationBell from './NotificationBell';
import ManagerMoreTab from './ManagerMoreTab';
import PayrollReportModal from './PayrollReportModal';

/*
 * LiveMap and ManagerScheduler are JS modules. Add src/components/legacy.d.ts:
 *
 *   declare module './LiveMap' {
 *     const LiveMap: React.FC<{ height?: string; locationFilter?: string }>;
 *     export default LiveMap;
 *   }
 *   declare module './ManagerScheduler' {
 *     const ManagerScheduler: React.FC;
 *     export default ManagerScheduler;
 *   }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Roles are per-organisation data now (see src/hooks/useRoles.ts), not a
// fixed set — this stays a plain string rather than a union.
export type UserRole = string;

export interface Profile {
  id: string;
  first_name: string | null;
  full_name: string | null;
  email: string | null;
  role: UserRole | null;
  is_active: boolean;
}

export interface LocationRow {
  id: string;
  name: string;
}

export interface ShiftRow {
  id: string;
  assigned_user_id: string | null;
  location_id: string | null;
  start_time: string;
  end_time: string;
  profiles: Profile | null;
}

export interface TimeLogRow {
  id: string;
  user_id: string;
  location_id: string | null;
  shift_id: string | null;
  clock_in: string;
  clock_out: string | null;
  notes: string | null;
  profiles: Profile | null;
}

export interface RosterEntry {
  shift: ShiftRow;
  profile: Profile | null;
  openLog: TimeLogRow | null;
}

/** A time log joined with its shift's start_time, for late detection. */
export interface TimeLogWithShift extends TimeLogRow {
  shifts: { start_time: string } | null;
}

export interface TimesheetSummary {
  userId: string;
  profile: Profile | null;
  logs: TimeLogWithShift[];
  totalHours: number;
  hasOpenLog: boolean;
}

type TabId = 'map' | 'scheduler' | 'tasks' | 'timesheets' | 'more';
type RoleFilter = 'all' | string;
type LocationFilter = 'all' | string;

const TABS: ReadonlyArray<{ id: TabId; label: string; Icon: typeof MapPin }> = [
  { id: 'map', label: 'Live map', Icon: MapPin },
  { id: 'scheduler', label: 'Schedule', Icon: Calendar },
  { id: 'tasks', label: 'Tasks', Icon: CheckSquare },
  { id: 'timesheets', label: 'Timesheets', Icon: Clock },
  { id: 'more', label: 'More', Icon: MoreHorizontal },
];

const AUTO_CLOCK_OUT_NOTE = 'Auto clocked-out at shift end';

/** Muted "No role" label for anywhere a role is displayed. */
function roleLabel(role: string | null | undefined): ReactNode {
  return role ?? <span className="italic text-ink/50">No role</span>;
}

// ---------------------------------------------------------------------------
// Date + duration helpers
// ---------------------------------------------------------------------------

function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7)); // Monday-first
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatWeekRange(from: Date): string {
  const to = addDays(from, 6);
  return `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${to.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })}`;
}

/** Hours between two instants. Open logs are measured to now. */
function durationHours(clockIn: string, clockOut: string | null): number {
  const end = clockOut ? new Date(clockOut).getTime() : Date.now();
  return Math.max(0, (end - new Date(clockIn).getTime()) / 3_600_000);
}

function formatHours(hours: number): string {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return `${whole}h ${String(minutes).padStart(2, '0')}m`;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Auto clock-out
// ---------------------------------------------------------------------------

/**
 * Closes shifts left open past their scheduled end. Runs client-side as a
 * fallback; a scheduled Postgres job is the durable version of this, since a
 * dashboard that nobody opens never runs the sweep.
 */
async function runAutoClockOut(viewer: Profile): Promise<number> {
  const nowIso = new Date().toISOString();

  let query = supabase
    .from('time_logs')
    .select('id, user_id, location_id, shift_id, clock_in, clock_out, notes')
    .is('clock_out', null);

  if (viewer.role !== 'Manager') query = query.eq('user_id', viewer.id);

  const { data: openLogs, error } = await query.returns<Omit<TimeLogRow, 'profiles'>[]>();
  if (error || !openLogs?.length) return 0;

  const userIds = Array.from(new Set(openLogs.map((log) => log.user_id)));
  const earliest = openLogs.reduce(
    (min, log) => (log.clock_in < min ? log.clock_in : min),
    openLogs[0].clock_in
  );

  const { data: endedShifts } = await supabase
    .from('shifts')
    .select('id, assigned_user_id, location_id, start_time, end_time')
    .in('assigned_user_id', userIds)
    .gte('start_time', startOfDay(new Date(earliest)).toISOString())
    .lt('end_time', nowIso)
    .returns<Omit<ShiftRow, 'profiles'>[]>();

  if (!endedShifts?.length) return 0;

  const updates = openLogs
    .map((log) => {
      const match =
        endedShifts.find((shift) => shift.id === log.shift_id) ??
        endedShifts
          .filter(
            (shift) =>
              shift.assigned_user_id === log.user_id &&
              sameDay(new Date(shift.start_time), new Date(log.clock_in))
          )
          .sort((a, b) => b.end_time.localeCompare(a.end_time))[0];

      if (!match) return null;
      // The time_logs_time_order CHECK rejects clock_out <= clock_in.
      if (new Date(match.end_time) <= new Date(log.clock_in)) return null;

      return { id: log.id, clock_out: match.end_time };
    })
    .filter((update): update is { id: string; clock_out: string } => update !== null);

  if (!updates.length) return 0;

  const results = await Promise.all(
    updates.map((update) =>
      supabase
        .from('time_logs')
        .update({ clock_out: update.clock_out, notes: AUTO_CLOCK_OUT_NOTE })
        .eq('id', update.id)
        .is('clock_out', null) // no-op if the user clocked out in the meantime
    )
  );

  return results.filter((result) => !result.error).length;
}

// ===========================================================================
// Root
// ===========================================================================

export default function ManagerDashboard(): ReactNode {
  const [viewer, setViewer] = useState<Profile | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [tab, setTab] = useState<TabId>('map');
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { roles } = useRoles();
  const { organisation } = useOrganisation();

  const sweepRan = useRef(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) throw new Error('Your session has expired. Sign in again to continue.');

        const [profileResult, locationResult] = await Promise.all([
          supabase
            .from('profiles')
            .select('id, first_name, full_name, email, role, is_active')
            .eq('id', user.id)
            .single<Profile>(),
          supabase.from('locations').select('id, name').eq('is_active', true).order('name').returns<LocationRow[]>(),
        ]);

        if (profileResult.error) throw profileResult.error;
        if (cancelled) return;

        if (profileResult.data.is_active === false) {
          await supabase.auth.signOut();
          setError('This account has been deactivated. Contact your manager.');
          return;
        }

        const profile: Profile = profileResult.data;
        setViewer(profile);
        setLocations(locationResult.data ?? []);
        setTab(profile.role === 'Manager' ? 'map' : 'timesheets');

        if (!sweepRan.current) {
          sweepRan.current = true;
          const closed = await runAutoClockOut(profile);
          if (!cancelled && closed > 0) {
            setNotice(
              `${closed} shift${closed === 1 ? '' : 's'} left open past the scheduled end were closed automatically.`
            );
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'The dashboard could not load.');
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const isManager = viewer?.role === 'Manager';
  const visibleTabs = useMemo(() => (isManager ? TABS : TABS.filter((entry) => entry.id === 'timesheets')), [isManager]);

  if (booting) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading dashboard…
      </div>
    );
  }

  if (error || !viewer) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm gap-3 rounded-lg border border-border bg-surface p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold text-ink">Dashboard unavailable</p>
            <p className="mt-1 text-ink/80">{error ?? 'No profile is linked to this account.'}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="bg-primary text-white">
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex min-w-0 shrink-0 items-center">
            {organisation?.logo_url ? (
              <img
                src={organisation.logo_url}
                alt={organisation.name}
                className="h-8 max-w-[9rem] shrink-0 object-contain object-left"
              />
            ) : (
              <span className="truncate text-lg font-semibold text-white">
                {organisation?.name ?? ' '}
              </span>
            )}
          </div>

          <nav className="hidden gap-1 rounded-lg bg-white/10 p-1 md:flex" aria-label="Dashboard sections">
            {visibleTabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${
                  tab === id ? 'bg-white text-primary' : 'text-white/70 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <NotificationBell />

            {/* The week selector only drives the timesheet query. */}
            {tab === 'timesheets' && <WeekSelector weekStart={weekStart} onChange={setWeekStart} />}

            {/* The scheduler has its own location + role filter, so these are
                map and timesheets only. */}
            {(tab === 'map' || tab === 'timesheets') && (
              <FilterButton
                variant="inverted"
                activeCount={(locationFilter !== 'all' ? 1 : 0) + (roleFilter !== 'all' ? 1 : 0)}
              >
                <FilterSelect
                  id="dash-location-filter"
                  label="Location"
                  value={locationFilter}
                  onChange={setLocationFilter}
                  Icon={MapPin}
                  fullWidth
                  options={[
                    { value: 'all', label: 'All locations' },
                    ...locations.map((location) => ({ value: location.id, label: location.name })),
                  ]}
                />

                <FilterSelect
                  id="dash-role-filter"
                  label="Role"
                  value={roleFilter}
                  onChange={setRoleFilter}
                  Icon={Filter}
                  fullWidth
                  options={[
                    { value: 'all', label: 'All roles' },
                    ...roles.map((r) => ({ value: r.name, label: r.name })),
                  ]}
                />
              </FilterButton>
            )}

            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.reload();
              }}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Log out</span>
            </button>
          </div>
        </div>

        {notice && (
          <div className="flex items-center gap-2 border-t border-white/20 bg-secondary px-4 py-2 text-xs text-white">
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="rounded-lg p-0.5 hover:bg-white/20"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'map' && isManager && (
          <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[1fr_20rem]">
            {/* isolate contains Leaflet's internal z-index (panes/controls go up to
                1000) so it can never compete with page-level chrome like a modal. */}
            <div className="relative z-0 min-h-[24rem] isolate">
              <LiveMap locationFilter={locationFilter} />
            </div>
            <RosterSidebar locationFilter={locationFilter} roleFilter={roleFilter} />
          </div>
        )}

        {tab === 'scheduler' && isManager && <ManagerScheduler />}

        {tab === 'tasks' && isManager && <ManagerTasks locations={locations} />}

        {tab === 'timesheets' && (
          <TimesheetsPanel
            viewer={viewer}
            weekStart={weekStart}
            locationFilter={locationFilter}
            roleFilter={roleFilter}
            locations={locations}
          />
        )}

        {tab === 'more' && isManager && (
          <ManagerMoreTab profile={viewer} locations={locations} viewerId={viewer.id} />
        )}
      </main>

      {/* Bottom nav for mobile */}
      <nav
        className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Dashboard sections"
      >
        {visibleTabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={`flex flex-1 flex-col items-center gap-1 px-2 py-2.5 text-xs font-medium transition min-h-[44px] justify-center ${
              tab === id ? 'text-primary' : 'text-ink/60'
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ===========================================================================
// Header controls
// ===========================================================================

function WeekSelector({
  weekStart,
  onChange,
}: {
  weekStart: Date;
  onChange: Dispatch<SetStateAction<Date>>;
}): ReactNode {
  const isCurrent = weekStart.getTime() === startOfWeek(new Date()).getTime();

  return (
    <div className="flex items-center rounded-lg border border-white/20 bg-white/10">
      <button
        type="button"
        onClick={() => onChange(addDays(weekStart, -7))}
        aria-label="Previous week"
        className="p-2 text-white/80 hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onChange(startOfWeek(new Date()))}
        className="border-x border-white/20 px-3 py-1.5 text-sm font-medium tabular-nums text-white hover:bg-white/20"
      >
        {isCurrent ? 'This week' : formatWeekRange(weekStart)}
      </button>
      <button
        type="button"
        onClick={() => onChange(addDays(weekStart, 7))}
        aria-label="Next week"
        className="p-2 text-white/80 hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

interface FilterSelectProps<T extends string> {
  id: string;
  label: string;
  value: T;
  onChange: Dispatch<SetStateAction<T>>;
  Icon: typeof MapPin;
  options: ReadonlyArray<{ value: T; label: string }>;
  fullWidth?: boolean;
}

function FilterSelect<T extends string>({
  id,
  label,
  value,
  onChange,
  Icon,
  options,
  fullWidth,
}: FilterSelectProps<T>): ReactNode {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-ink/60">
        {label}
      </label>
      <div className="relative mt-1.5">
        <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50" aria-hidden="true" />
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          className={`min-h-[44px] appearance-none rounded-lg border border-border bg-surface py-2 pl-9 pr-8 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${fullWidth ? 'w-full' : ''}`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 1 sidebar — today's roster
// ===========================================================================

function RosterSidebar({
  locationFilter,
  roleFilter,
}: {
  locationFilter: LocationFilter;
  roleFilter: RoleFilter;
}): ReactNode {
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const dayStart = startOfDay(new Date());
    const dayEnd = addDays(dayStart, 1);

    let shiftQuery = supabase
      .from('shifts')
      .select(
        'id, assigned_user_id, location_id, start_time, end_time, profiles:assigned_user_id ( id, first_name, full_name, role )'
      )
      .gte('start_time', dayStart.toISOString())
      .lt('start_time', dayEnd.toISOString())
      .order('start_time');

    if (locationFilter !== 'all') shiftQuery = shiftQuery.eq('location_id', locationFilter);

    const [shiftResult, logResult] = await Promise.all([
      shiftQuery.returns<ShiftRow[]>(),
      supabase
        .from('time_logs')
        .select(
          'id, user_id, location_id, shift_id, clock_in, clock_out, notes, profiles:user_id ( id, first_name, full_name, role )'
        )
        .is('clock_out', null)
        .returns<TimeLogRow[]>(),
    ]);

    if (shiftResult.error) {
      setError('Today’s roster could not be loaded.');
      setLoading(false);
      return;
    }

    const openByUser = new Map((logResult.data ?? []).map((log) => [log.user_id, log]));

    setEntries(
      (shiftResult.data ?? [])
        .filter((shift) => roleFilter === 'all' || shift.profiles?.role === roleFilter)
        .map((shift) => ({
          shift,
          profile: shift.profiles,
          openLog: shift.assigned_user_id ? (openByUser.get(shift.assigned_user_id) ?? null) : null,
        }))
    );
    setLoading(false);
  }, [locationFilter, roleFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Clock-ins land while the manager is watching; keep the badges honest.
  useEffect(() => {
    const channel = supabase
      .channel('roster-sidebar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_logs' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const clockedIn = entries.filter((entry) => entry.openLog).length;

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-ink/50">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Today’s roster
        </div>
        <p className="mt-1 text-sm text-ink/80">
          <span className="font-semibold tabular-nums text-ink">{clockedIn}</span> of{' '}
          <span className="tabular-nums">{entries.length}</span> clocked in
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink/60">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading roster…
          </div>
        )}

        {!loading && error && <p className="px-4 py-10 text-center text-sm text-danger">{error}</p>}

        {!loading && !error && entries.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-ink/60">
            Nobody is scheduled today for this filter.
          </p>
        )}

        <ul className="divide-y divide-border">
          {entries.map(({ shift, profile, openLog }) => (
            <li key={shift.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  profile?.role === 'Driver' ? 'bg-success' : 'bg-secondary'
                }`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {profile?.full_name ?? profile?.first_name ?? 'Unassigned'}
                </p>
                <p className="text-xs tabular-nums text-ink/60">
                  {formatClock(shift.start_time)} – {formatClock(shift.end_time)}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  openLog ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning'
                }`}
              >
                {openLog ? `Clocked in ${formatClock(openLog.clock_in)}` : 'Not clocked in'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

// ===========================================================================
// Tab 3 — timesheets
// ===========================================================================

function TimesheetsPanel({
  viewer,
  weekStart,
  locationFilter,
  roleFilter,
  locations,
}: {
  viewer: Profile;
  weekStart: Date;
  locationFilter: LocationFilter;
  roleFilter: RoleFilter;
  locations: LocationRow[];
}): ReactNode {
  const [logs, setLogs] = useState<TimeLogWithShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TimeLogRow | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const isManager = viewer.role === 'Manager';
  const { graceMinutes } = useLateGrace();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    let query = supabase
      .from('time_logs')
      .select(
        'id, user_id, location_id, shift_id, clock_in, clock_out, notes, profiles:user_id ( id, first_name, full_name, role ), shifts:shift_id ( start_time )'
      )
      .gte('clock_in', weekStart.toISOString())
      .lt('clock_in', addDays(weekStart, 7).toISOString())
      .order('clock_in', { ascending: false });

    // RLS already scopes staff to their own rows; the explicit filter keeps the
    // query cheap and makes the intent readable.
    if (!isManager) query = query.eq('user_id', viewer.id);
    if (locationFilter !== 'all') query = query.eq('location_id', locationFilter);

    const { data, error: queryError } = await query.returns<TimeLogWithShift[]>();

    if (queryError) setError('Timesheets could not be loaded. Refresh to try again.');
    else setLogs((data ?? []).filter((log) => roleFilter === 'all' || log.profiles?.role === roleFilter));

    setLoading(false);
  }, [viewer.id, isManager, weekStart, locationFilter, roleFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const summaries = useMemo<TimesheetSummary[]>(() => {
    const grouped = new Map<string, TimesheetSummary>();

    for (const log of logs) {
      const existing = grouped.get(log.user_id);
      const entry: TimesheetSummary = existing ?? {
        userId: log.user_id,
        profile: log.profiles,
        logs: [],
        totalHours: 0,
        hasOpenLog: false,
      };

      entry.logs.push(log);
      entry.totalHours += durationHours(log.clock_in, log.clock_out);
      entry.hasOpenLog ||= log.clock_out === null;
      grouped.set(log.user_id, entry);
    }

    return Array.from(grouped.values()).sort((a, b) => b.totalHours - a.totalHours);
  }, [logs]);

  const weekTotal = summaries.reduce((sum, entry) => sum + entry.totalHours, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading timesheets…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-danger bg-danger-bg p-4 text-sm text-danger">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isManager && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <FileSpreadsheet className="h-4 w-4 text-ink/50" aria-hidden="true" />
            Generate report
          </button>
        </div>
      )}

      {/* Weekly summary */}
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Week of" value={formatWeekRange(weekStart)} Icon={Calendar} />
        <SummaryCard label="Total hours" value={formatHours(weekTotal)} Icon={Clock} />
        <SummaryCard
          label={isManager ? 'Staff with hours' : 'Entries'}
          value={String(isManager ? summaries.length : logs.length)}
          Icon={Users}
        />
      </div>

      {summaries.length === 0 && (
        <p className="rounded-lg border border-border bg-surface py-12 text-center text-sm text-ink/60">
          No time was logged in this week for the current filter.
        </p>
      )}

      {summaries.map((summary) => (
        <section key={summary.userId} className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                summary.profile?.role === 'Driver' ? 'bg-success' : 'bg-secondary'
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">
                {summary.profile?.full_name ?? summary.profile?.first_name ?? 'Unknown'}
              </p>
              <p className="text-xs text-ink/60">{roleLabel(summary.profile?.role)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums text-ink">{formatHours(summary.totalHours)}</p>
              <p className="text-xs text-ink/60">
                {summary.logs.length} entr{summary.logs.length === 1 ? 'y' : 'ies'}
                {summary.hasOpenLog && <span className="text-success"> · on shift</span>}
              </p>
            </div>
          </div>

          {/* Below sm: stacked cards, no sideways scroll. sm and up: a real table. */}
          <ul className="divide-y divide-border sm:hidden">
            {summary.logs.map((log) => {
              const shiftStart = log.shifts?.start_time ?? null;
              const late = isLate(log.clock_in, shiftStart, graceMinutes);

              return (
                <li key={log.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-ink/80">
                      {formatDay(log.clock_in)}
                      {log.notes === AUTO_CLOCK_OUT_NOTE && (
                        <span className="ml-2 rounded-lg bg-bg px-1.5 py-0.5 text-[11px] text-ink/60">auto</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs tabular-nums text-ink">
                      {formatClock(log.clock_in)} –{' '}
                      {log.clock_out ? formatClock(log.clock_out) : <span className="text-success">open</span>}
                    </p>
                    {late && shiftStart && (
                      <span className="mt-1 inline-flex items-center rounded-lg bg-danger-bg px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                        LATE · {minutesLate(log.clock_in, shiftStart)} min
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-sm font-medium tabular-nums text-ink">
                      {formatHours(durationHours(log.clock_in, log.clock_out))}
                    </span>
                    {isManager && (
                      <button
                        type="button"
                        onClick={() => setEditing(log)}
                        aria-label={`Edit ${formatDay(log.clock_in)} entry`}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-ink/50 hover:bg-bg hover:text-ink"
                      >
                        <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <table className="hidden w-full text-sm sm:table">
            <thead className="sr-only">
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Clock in</th>
                <th scope="col">Clock out</th>
                <th scope="col">Hours</th>
                {isManager && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.logs.map((log) => {
                const shiftStart = log.shifts?.start_time ?? null;
                const late = isLate(log.clock_in, shiftStart, graceMinutes);

                return (
                  <tr key={log.id}>
                  <td className="px-4 py-2.5 text-ink/80">
                    {formatDay(log.clock_in)}
                    {log.notes === AUTO_CLOCK_OUT_NOTE && (
                      <span className="ml-2 rounded-lg bg-bg px-1.5 py-0.5 text-[11px] text-ink/60">
                        auto
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums text-ink">
                    {formatClock(log.clock_in)}
                    {late && shiftStart && (
                      <span className="ml-2 inline-flex items-center rounded-lg bg-danger-bg px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                        LATE · {minutesLate(log.clock_in, shiftStart)} min
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums text-ink">
                    {log.clock_out ? (
                      formatClock(log.clock_out)
                    ) : (
                      <span className="text-success">open</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums font-medium text-ink">
                    {formatHours(durationHours(log.clock_in, log.clock_out))}
                  </td>
                  {isManager && (
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setEditing(log)}
                        aria-label={`Edit ${formatDay(log.clock_in)} entry`}
                        className="rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      {editing && (
        <EditLogModal
          log={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {reportOpen && <PayrollReportModal locations={locations} onClose={() => setReportOpen(false)} />}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  Icon,
}: {
  label: string;
  value: string;
  Icon: typeof Clock;
}): ReactNode {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink/50">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-1.5 text-xl font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

// ===========================================================================
// Manager edit modal
// ===========================================================================

function EditLogModal({
  log,
  onClose,
  onSaved,
}: {
  log: TimeLogRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [clockIn, setClockIn] = useState(() => toLocalInput(log.clock_in));
  const [clockOut, setClockOut] = useState(() => toLocalInput(log.clock_out));
  const [notes, setNotes] = useState(log.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const inIso = fromLocalInput(clockIn);
  const outIso = fromLocalInput(clockOut);
  const invalidOrder = Boolean(inIso && outIso && new Date(outIso) <= new Date(inIso));
  const preview = inIso ? durationHours(inIso, outIso) : 0;

  const handleSave = async () => {
    if (!inIso) {
      setFault('A clock-in time is required.');
      return;
    }
    if (invalidOrder) {
      setFault('Clock out must be later than clock in.');
      return;
    }

    setSaving(true);
    setFault(null);

    const { error } = await supabase
      .from('time_logs')
      .update({ clock_in: inIso, clock_out: outIso, notes: notes.trim() || null })
      .eq('id', log.id);

    if (error) {
      setFault(
        error.code === '23514'
          ? 'The database rejected that range. Clock out must be later than clock in.'
          : 'The entry could not be saved. Check your connection and try again.'
      );
      setSaving(false);
      return;
    }

    await onSaved();
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-log-title"
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 id="edit-log-title" className="text-base font-semibold text-ink">
              Edit time entry
            </h2>
            <p className="text-xs text-ink/60">
              {log.profiles?.full_name ?? log.profiles?.first_name ?? 'Staff member'} ·{' '}
              {formatDay(log.clock_in)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink/80"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="edit-clock-in" className="block text-sm font-medium text-ink">
                Clock in
              </label>
              <input
                id="edit-clock-in"
                type="datetime-local"
                value={clockIn}
                onChange={(event) => setClockIn(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
            <div>
              <label htmlFor="edit-clock-out" className="block text-sm font-medium text-ink">
                Clock out
              </label>
              <input
                id="edit-clock-out"
                type="datetime-local"
                value={clockOut}
                onChange={(event) => setClockOut(event.target.value)}
                className={`mt-1.5 w-full rounded-lg border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  invalidOrder
                    ? 'border-danger focus-visible:outline-danger'
                    : 'border-border focus-visible:outline-primary'
                }`}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-bg px-4 py-3">
            <span className="text-sm text-ink/80">Duration</span>
            <span
              className={`text-lg font-semibold tabular-nums ${invalidOrder ? 'text-danger' : 'text-ink'}`}
            >
              {invalidOrder ? 'Invalid' : formatHours(preview)}
            </span>
          </div>

          {!outIso && (
            <p className="text-xs text-ink/60">
              Leaving clock out empty keeps this shift open and the duration counting from now.
            </p>
          )}

          <div>
            <label htmlFor="edit-notes" className="block text-sm font-medium text-ink">
              Note
            </label>
            <input
              id="edit-notes"
              type="text"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Why this entry was changed"
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          {fault && (
            <div className="flex gap-2 rounded-lg bg-warning-bg p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <p className="text-warning">{fault}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || invalidOrder || !inIso}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4" aria-hidden="true" />
            )}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
