import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  AlertCircle,
  Banknote,
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
  Plus,
  Route,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles, type Role } from '../hooks/useRoles';
import { useOrganisation } from '../hooks/useOrganisation';
import { useLateGrace } from '../hooks/useLateGrace';
import { usePermissions } from '../hooks/usePermissions';
import { useManagedLocations } from '../hooks/useManagedLocations';
import { isLate, minutesLate } from '../lib/lateness';
import { friendlyError } from '../lib/friendlyError';
import { logNeedsOrdersReport, ordersCellText, ORDERS_NOT_YET_REPORTED, orgTracksOrders, tracksOrdersRoleNames } from '../lib/tracksOrders';
import { loadPersistedTab, savePersistedTab } from '../lib/persistedTab';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';
import { formatCurrencyAmount } from '../lib/wageRates';

// The one and only shape of a shift's pay -- always sourced from
// shift_pay()/shift_pay_range(), never recomputed client-side. See
// migrations 0028/0029: two implementations of the same formula can only
// ever drift apart from each other.
interface ShiftPayBreakdown {
  hours: number;
  hourly_rate: number | null;
  hours_pay: number;
  orders_count: number;
  order_rate: number;
  orders_pay: number;
  total_miles: number;
  mileage_pay: number;
  total_pay: number;
}

interface ShiftPayRangeRow {
  time_log_id: string;
  breakdown: ShiftPayBreakdown;
}
import DispatchChat from './DispatchChat';
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
  locations?: { name: string } | null;
  shift_id: string | null;
  clock_in: string;
  clock_out: string | null;
  notes: string | null;
  profiles: Profile | null;
  orders_count?: number | null;
  role_at_clock_in?: string | null;
  reopened_by?: string | null;
  reopened_at?: string | null;
  reopened_by_profile?: { first_name: string | null; full_name: string | null } | null;
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
  // Sourced from shift_pay_range() — admin-only: stays 0 for anyone else,
  // since TimesheetsPanel never calls it for them.
  totalCost: number;
  totalMileagePay: number;
  hasOpenLog: boolean;
}

type TabId = 'map' | 'scheduler' | 'tasks' | 'timesheets' | 'more';
type RoleFilter = 'all' | string;
type LocationFilter = 'all' | string;

const TAB_STORAGE_KEY = 'shifttrack:manager-tab';
const TAB_IDS: readonly TabId[] = ['map', 'scheduler', 'tasks', 'timesheets', 'more'];

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

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
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

// Auto clock-out is server-side only now (pg_cron's sweep_open_shifts(),
// every 15 minutes) -- a client-side fallback used to run here too, but it
// closed a shift by writing the shift's own (already-past) end_time as
// clock_out, running AS the viewer. tg_protect_own_time_log's clock-out
// window (own row, open -> closed, within 5 minutes of now) correctly
// rejects that for an employee's own shift or a manager's own -- a
// forgotten shift more than a few minutes overdue can never close through
// this path by construction, mistaken timestamp or not. Restricting the
// fallback to "managers closing someone else's shift" would still leave a
// manager's own forgotten shift stuck until the cron caught up, so removed
// outright rather than patched -- the cron already runs independent of
// whether any dashboard is ever opened, which was the original rationale
// for having a client-side version at all.

// ===========================================================================
// Root
// ===========================================================================

export default function ManagerDashboard(): ReactNode {
  const [viewer, setViewer] = useState<Profile | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [tab, setTab] = useState<TabId>(() => loadPersistedTab(TAB_STORAGE_KEY, TAB_IDS) ?? 'map');
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { roles } = useRoles();
  const { organisation } = useOrganisation();
  const { canManage, isAdmin } = usePermissions();
  const { locationIds: managedLocationIds } = useManagedLocations();
  const managedLocationSet = useMemo(() => new Set(managedLocationIds), [managedLocationIds]);
  // What the location filter/pickers can offer — never a location the
  // database would reject the viewer for choosing. An Administrator manages
  // every org location, so this is a no-op for them.
  const visibleLocations = useMemo(
    () => locations.filter((l) => managedLocationSet.has(l.id)),
    [locations, managedLocationSet]
  );

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
      } catch (cause) {
        if (!cancelled) setError(friendlyError(cause, 'The dashboard could not load.'));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleTabs = useMemo(() => (canManage ? TABS : TABS.filter((entry) => entry.id === 'timesheets')), [canManage]);

  useEffect(() => {
    savePersistedTab(TAB_STORAGE_KEY, tab);
    resetDocumentScroll();
  }, [tab]);

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
      <header className="bg-primary pt-[env(safe-area-inset-top)] text-white">
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center">
            {organisation?.logo_url ? (
              <img
                src={organisation.logo_url}
                alt={organisation.name}
                className="h-8 max-w-[9rem] shrink-0 object-contain object-left"
              />
            ) : (
              <span className="truncate font-display text-lg tracking-tight text-white">
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
                map and timesheets only. The map only ever shows drivers, so
                a role filter there would have nothing to do — location-only. */}
            {(tab === 'map' || tab === 'timesheets') && (
              <FilterButton
                variant="inverted"
                activeCount={(locationFilter !== 'all' ? 1 : 0) + (tab === 'timesheets' && roleFilter !== 'all' ? 1 : 0)}
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
                    ...visibleLocations.map((location) => ({ value: location.id, label: location.name })),
                  ]}
                />

                {tab === 'timesheets' && (
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
                )}
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
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'map' && canManage && (
          <div className="flex h-full min-h-0 flex-col gap-4">
            {/* Same locationFilter as the map/roster below — 'all' becomes
                null (every location this manager manages), a specific id
                filters to just that one. RLS itself is what actually
                scopes the rows either way. */}
            {organisation?.id && (
              <DispatchChat locationId={locationFilter === 'all' ? null : locationFilter} orgId={organisation.id} />
            )}
            <div className="grid h-full min-h-0 flex-1 gap-4 md:grid-cols-[1fr_16rem] lg:grid-cols-[1fr_20rem]">
              {/* isolate contains Leaflet's internal z-index (panes/controls go up to
                  1000) so it can never compete with page-level chrome like a modal. */}
              <div className="relative z-0 min-h-[24rem] isolate">
                <LiveMap locationFilter={locationFilter} />
              </div>
              {/* No role filter control on this tab (see header) — always unfiltered by role. */}
              <RosterSidebar locationFilter={locationFilter} roleFilter="all" />
            </div>
          </div>
        )}

        {tab === 'scheduler' && canManage && <ManagerScheduler />}

        {tab === 'tasks' && canManage && <ManagerTasks locations={locations} />}

        {tab === 'timesheets' && (
          <TimesheetsPanel
            viewer={viewer}
            canManage={canManage}
            isAdmin={isAdmin}
            weekStart={weekStart}
            locationFilter={locationFilter}
            roleFilter={roleFilter}
            locations={locations}
            roles={roles}
          />
        )}

        {tab === 'more' && canManage && (
          <ManagerMoreTab profile={viewer} locations={locations} viewerId={viewer.id} isAdmin={isAdmin} />
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
          className={`min-h-[44px] appearance-none rounded-lg border border-border bg-surface py-2 pl-9 pr-8 text-base sm:text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${fullWidth ? 'w-full' : ''}`}
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
  canManage,
  isAdmin,
  weekStart,
  locationFilter,
  roleFilter,
  locations,
  roles,
}: {
  viewer: Profile;
  canManage: boolean;
  isAdmin: boolean;
  weekStart: Date;
  locationFilter: LocationFilter;
  roleFilter: RoleFilter;
  locations: LocationRow[];
  roles: Role[];
}): ReactNode {
  const [logs, setLogs] = useState<TimeLogWithShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TimeLogRow | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [payByLog, setPayByLog] = useState<Map<string, ShiftPayBreakdown>>(new Map());

  const { graceMinutes } = useLateGrace();
  const trackedRoleNames = useMemo(() => tracksOrdersRoleNames(roles), [roles]);
  const showOrdersColumns = orgTracksOrders(roles);

  // Pay for the whole week in one call — never fetched for anyone but an
  // Administrator, since shift_pay_range() returns nothing to anyone else
  // anyway (see migration 0029), but this also skips the request entirely
  // rather than firing it and discarding an empty result.
  useEffect(() => {
    if (!isAdmin) {
      setPayByLog(new Map());
      return undefined;
    }
    let cancelled = false;

    (async () => {
      const { data } = await supabase.rpc('shift_pay_range', {
        p_from: localDateKey(weekStart),
        p_to: localDateKey(addDays(weekStart, 6)),
        p_location_ids: null,
        p_roles: null,
      });
      if (cancelled) return;
      const map = new Map<string, ShiftPayBreakdown>();
      for (const row of (data ?? []) as ShiftPayRangeRow[]) map.set(row.time_log_id, row.breakdown);
      setPayByLog(map);
    })();

    return () => {
      cancelled = true;
    };
  }, [isAdmin, weekStart]);

  const costForLog = useCallback((log: TimeLogWithShift): number | null => payByLog.get(log.id)?.hours_pay ?? null, [payByLog]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    let query = supabase
      .from('time_logs')
      .select(
        'id, user_id, location_id, shift_id, clock_in, clock_out, notes, orders_count, role_at_clock_in, reopened_by, reopened_at, profiles:user_id ( id, first_name, full_name, role ), locations:location_id ( name ), shifts:shift_id ( start_time ), reopened_by_profile:reopened_by ( first_name, full_name )'
      )
      .gte('clock_in', weekStart.toISOString())
      .lt('clock_in', addDays(weekStart, 7).toISOString())
      .order('clock_in', { ascending: false });

    // RLS already scopes staff to their own rows; the explicit filter keeps the
    // query cheap and makes the intent readable.
    if (!canManage) query = query.eq('user_id', viewer.id);
    if (locationFilter !== 'all') query = query.eq('location_id', locationFilter);

    const { data, error: queryError } = await query.returns<TimeLogWithShift[]>();

    if (queryError) setError('Timesheets could not be loaded. Refresh to try again.');
    else setLogs((data ?? []).filter((log) => roleFilter === 'all' || log.profiles?.role === roleFilter));

    setLoading(false);
  }, [viewer.id, canManage, weekStart, locationFilter, roleFilter]);

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
        totalCost: 0,
        totalMileagePay: 0,
        hasOpenLog: false,
      };

      entry.logs.push(log);
      entry.totalHours += durationHours(log.clock_in, log.clock_out);
      entry.totalCost += costForLog(log) ?? 0;
      entry.totalMileagePay += payByLog.get(log.id)?.mileage_pay ?? 0;
      entry.hasOpenLog ||= log.clock_out === null;
      grouped.set(log.user_id, entry);
    }

    return Array.from(grouped.values()).sort((a, b) => b.totalHours - a.totalHours);
  }, [logs, costForLog, payByLog]);

  const weekTotal = summaries.reduce((sum, entry) => sum + entry.totalHours, 0);
  const weekTotalCost = summaries.reduce((sum, entry) => sum + entry.totalCost, 0);
  const weekTotalMileagePay = summaries.reduce((sum, entry) => sum + entry.totalMileagePay, 0);

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
      {canManage && (
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
      <div className={`grid gap-3 sm:grid-cols-3 ${isAdmin ? 'lg:grid-cols-4' : ''}`}>
        <SummaryCard label="Week of" value={formatWeekRange(weekStart)} Icon={Calendar} />
        <SummaryCard label="Total hours" value={formatHours(weekTotal)} Icon={Clock} />
        <SummaryCard
          label={canManage ? 'Staff with hours' : 'Entries'}
          value={String(canManage ? summaries.length : logs.length)}
          Icon={Users}
        />
        {isAdmin && (
          <SummaryCard label="Total cost" value={formatCurrencyAmount(weekTotalCost)} Icon={Banknote} />
        )}
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
              {isAdmin && (
                <p className="text-xs font-medium tabular-nums text-ink/70">
                  {formatCurrencyAmount(summary.totalCost)}
                  {summary.totalMileagePay > 0 && ` +${formatCurrencyAmount(summary.totalMileagePay)} mi`}
                </p>
              )}
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
              const needsReport = logNeedsOrdersReport(log.role_at_clock_in, summary.profile?.role, trackedRoleNames);

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
                    {log.locations?.name && (
                      <p className="mt-0.5 truncate text-xs text-ink/50">{log.locations.name}</p>
                    )}
                    {late && shiftStart && (
                      <span className="mt-1 inline-flex items-center rounded-lg bg-danger-bg px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                        LATE · {minutesLate(log.clock_in, shiftStart)} min
                      </span>
                    )}
                    {needsReport && (
                      <p className={`mt-1 text-xs ${log.orders_count == null ? 'font-medium text-warning' : 'text-ink/60'}`}>
                        {log.orders_count == null ? ORDERS_NOT_YET_REPORTED : `${log.orders_count} orders`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-right">
                      <span className="block text-sm font-medium tabular-nums text-ink">
                        {formatHours(durationHours(log.clock_in, log.clock_out))}
                      </span>
                      {isAdmin && (() => {
                        const pay = payByLog.get(log.id);
                        if (!pay) return <span className="block text-xs tabular-nums text-ink/60">—</span>;
                        return (
                          <>
                            <span className="block text-xs tabular-nums text-ink/60">
                              {formatCurrencyAmount(pay.hours_pay)} hrs
                              {pay.orders_pay > 0 && ` + ${formatCurrencyAmount(pay.orders_pay)} ord`}
                              {pay.mileage_pay > 0 && ` + ${formatCurrencyAmount(pay.mileage_pay)} mi`}
                            </span>
                            <span className="block text-xs font-semibold tabular-nums text-ink">
                              {formatCurrencyAmount(pay.total_pay)}
                            </span>
                          </>
                        );
                      })()}
                    </span>
                    {canManage && (
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
                <th scope="col">Location</th>
                {showOrdersColumns && <th scope="col">Orders</th>}
                <th scope="col">Hours</th>
                {isAdmin && <th scope="col">Pay</th>}
                {isAdmin && <th scope="col">Total</th>}
                {canManage && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.logs.map((log) => {
                const shiftStart = log.shifts?.start_time ?? null;
                const late = isLate(log.clock_in, shiftStart, graceMinutes);
                const needsReport = logNeedsOrdersReport(log.role_at_clock_in, summary.profile?.role, trackedRoleNames);

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
                  <td className="px-2 py-2.5 text-ink/70">{log.locations?.name ?? '—'}</td>
                  {showOrdersColumns && (
                    <td
                      className={`px-2 py-2.5 tabular-nums ${
                        needsReport && log.orders_count == null ? 'font-medium text-warning' : 'text-ink'
                      }`}
                    >
                      {ordersCellText(needsReport, log.orders_count ?? null)}
                    </td>
                  )}
                  <td className="px-2 py-2.5 text-right tabular-nums font-medium text-ink">
                    {formatHours(durationHours(log.clock_in, log.clock_out))}
                  </td>
                  {isAdmin && (() => {
                    const pay = payByLog.get(log.id);
                    if (!pay) {
                      return (
                        <>
                          <td className="px-2 py-2.5 text-right tabular-nums text-ink">—</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-ink">—</td>
                        </>
                      );
                    }
                    return (
                      <>
                        <td className="px-2 py-2.5 text-right text-xs tabular-nums text-ink/70">
                          {formatCurrencyAmount(pay.hours_pay)} hrs
                          {pay.orders_pay > 0 && <><br />+{formatCurrencyAmount(pay.orders_pay)} ord</>}
                          {pay.mileage_pay > 0 && <><br />+{formatCurrencyAmount(pay.mileage_pay)} mi</>}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums font-medium text-ink">
                          {formatCurrencyAmount(pay.total_pay)}
                        </td>
                      </>
                    );
                  })()}
                  {canManage && (
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
          trackedRoleNames={trackedRoleNames}
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
  trackedRoleNames,
  onClose,
  onSaved,
}: {
  log: TimeLogRow;
  trackedRoleNames: Set<string>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [clockIn, setClockIn] = useState(() => toLocalInput(log.clock_in));
  const [clockOut, setClockOut] = useState(() => toLocalInput(log.clock_out));
  const [notes, setNotes] = useState(log.notes ?? '');
  const [orders, setOrders] = useState(() => log.orders_count?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const showOrdersFields = logNeedsOrdersReport(log.role_at_clock_in, log.profiles?.role, trackedRoleNames);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => resetDocumentScroll, []);

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

    let ordersValue: number | null = null;

    if (showOrdersFields) {
      const trimmedOrders = orders.trim();
      if (trimmedOrders !== '') {
        const parsedOrders = Number(trimmedOrders);
        if (!Number.isInteger(parsedOrders) || parsedOrders < 0) {
          setFault('Orders completed must be a whole number, zero or more.');
          return;
        }
        ordersValue = parsedOrders;
      }
    }

    setSaving(true);
    setFault(null);

    const { error } = await supabase
      .from('time_logs')
      .update({
        clock_in: inIso,
        clock_out: outIso,
        notes: notes.trim() || null,
        ...(showOrdersFields ? { orders_count: ordersValue } : {}),
      })
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
          {/* Reopening a shift is pay-affecting and must never be
              invisible — reopened_by/reopened_at are force-derived
              server-side (0043) whenever a manager/admin clears clock_out
              on someone else's row, never client-supplied. */}
          {log.reopened_at && (
            <div className="flex items-center gap-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Reopened by{' '}
                {log.reopened_by_profile?.first_name ?? log.reopened_by_profile?.full_name ?? 'a manager'} ·{' '}
                {formatDay(log.reopened_at)}, {formatClock(log.reopened_at)}
              </span>
            </div>
          )}

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
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
                className={`mt-1.5 w-full rounded-lg border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 ${
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

          {showOrdersFields && (
            <div>
              <label htmlFor="edit-orders" className="block text-sm font-medium text-ink">
                Orders completed
              </label>
              <input
                id="edit-orders"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={orders}
                onChange={(event) => setOrders(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
          )}

          {showOrdersFields && <RunsSection timeLogId={log.id} />}

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
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

// ===========================================================================
// Delivery runs — manager editing (step 2: web-testable, no GPS yet). A
// manually-added drop has no real device reading, so latitude/longitude/
// odometer_miles are placeholder zeros — the count is what matters for
// orders_pay at this stage, not the individual GPS fields, which land in
// a later step.
// ===========================================================================

interface DeliveryDropRow {
  id: string;
  sequence: number;
}

interface DeliveryRunRow {
  id: string;
  one_way_miles: number | null;
  gps_one_way_miles: number | null;
  mileage_source: string | null;
  delivery_drops: DeliveryDropRow[];
}

const RUN_FIELDS = 'id, one_way_miles, gps_one_way_miles, mileage_source, delivery_drops ( id, sequence )';

function RunsSection({ timeLogId }: { timeLogId: string }): ReactNode {
  const [runs, setRuns] = useState<DeliveryRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fault, setFault] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [milesDraft, setMilesDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('delivery_runs')
      .select(RUN_FIELDS)
      .eq('time_log_id', timeLogId)
      .order('started_at')
      .returns<DeliveryRunRow[]>();
    if (!error) setRuns(data ?? []);
    setLoading(false);
  }, [timeLogId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Local drafts so typing doesn't fight a mid-edit refetch — one_way_miles
  // only actually saves on blur.
  useEffect(() => {
    setMilesDraft((prev) => {
      const next = { ...prev };
      for (const run of runs) if (next[run.id] === undefined) next[run.id] = run.one_way_miles?.toString() ?? '';
      return next;
    });
  }, [runs]);

  const addRun = async () => {
    setFault(null);
    const { error } = await supabase
      .from('delivery_runs')
      .insert({ time_log_id: timeLogId, started_at: new Date().toISOString() });
    if (error) setFault(friendlyError(error, 'Could not add a run.'));
    else await load();
  };

  // tg_protect_delivery_run (0028) stamps mileage_source='manager' and the
  // edit-audit fields server-side the moment one_way_miles actually
  // changes — nothing to set from here.
  const saveMiles = async (runId: string) => {
    const raw = milesDraft[runId]?.trim() ?? '';
    const value = raw === '' ? null : Number(raw);
    if (raw !== '' && (!Number.isFinite(value) || (value as number) < 0)) {
      setFault('One-way miles must be zero or more.');
      return;
    }
    setBusyId(runId);
    setFault(null);
    const { error } = await supabase.from('delivery_runs').update({ one_way_miles: value }).eq('id', runId);
    setBusyId(null);
    if (error) setFault(friendlyError(error, 'Could not save one-way miles.'));
    else await load();
  };

  const deleteRun = async (runId: string) => {
    setBusyId(runId);
    setFault(null);
    const { error } = await supabase.from('delivery_runs').delete().eq('id', runId);
    setBusyId(null);
    if (error) setFault(friendlyError(error, 'Could not delete the run.'));
    else await load();
  };

  const addDrop = async (run: DeliveryRunRow) => {
    setBusyId(run.id);
    setFault(null);
    const nextSequence = run.delivery_drops.length > 0 ? Math.max(...run.delivery_drops.map((d) => d.sequence)) + 1 : 1;
    const { error } = await supabase
      .from('delivery_drops')
      .insert({ run_id: run.id, sequence: nextSequence, latitude: 0, longitude: 0, odometer_miles: 0 });
    setBusyId(null);
    if (error) setFault(friendlyError(error, 'Could not add a drop.'));
    else await load();
  };

  const removeDrop = async (dropId: string, runId: string) => {
    setBusyId(runId);
    setFault(null);
    const { error } = await supabase.from('delivery_drops').delete().eq('id', dropId);
    setBusyId(null);
    if (error) setFault(friendlyError(error, 'Could not remove the drop.'));
    else await load();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading runs…
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink">Delivery runs</p>
        <button
          type="button"
          onClick={() => void addRun()}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-dark"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add run
        </button>
      </div>

      {fault && <p className="mt-1.5 text-xs text-danger">{fault}</p>}

      {runs.length === 0 ? (
        <p className="mt-1.5 text-xs text-ink/50">No runs recorded for this shift.</p>
      ) : (
        <ul className="mt-1.5 space-y-2">
          {runs.map((run) => (
            <li key={run.id} className="rounded-lg border border-border p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Route className="h-3.5 w-3.5 shrink-0 text-ink/40" aria-hidden="true" />
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  value={milesDraft[run.id] ?? ''}
                  onChange={(e) => setMilesDraft((prev) => ({ ...prev, [run.id]: e.target.value }))}
                  onBlur={() => void saveMiles(run.id)}
                  placeholder="One-way miles"
                  disabled={busyId === run.id}
                  aria-label="One-way miles"
                  className="w-24 rounded-lg border border-border px-2 py-1 text-sm tabular-nums disabled:opacity-60"
                />
                <span className="text-xs text-ink/50">mi</span>
                {/* The original device reading, kept visible alongside any
                    manager edit — see tg_protect_delivery_run, which never
                    lets this value itself change once set. */}
                {run.gps_one_way_miles !== null && (
                  <span className="text-xs text-ink/40">(GPS: {run.gps_one_way_miles} mi)</span>
                )}
                {run.mileage_source === 'manager' && (
                  <span className="rounded-full bg-bg px-1.5 py-0.5 text-[10px] font-medium text-ink/50">
                    edited
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void deleteRun(run.id)}
                  disabled={busyId === run.id}
                  aria-label="Delete run"
                  className="ml-auto shrink-0 rounded-lg p-1.5 text-ink/40 hover:bg-danger-bg hover:text-danger disabled:opacity-60"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {run.delivery_drops
                  .slice()
                  .sort((a, b) => a.sequence - b.sequence)
                  .map((drop) => (
                    <span
                      key={drop.id}
                      className="inline-flex items-center gap-1 rounded-full bg-bg px-2 py-1 text-xs text-ink/70"
                    >
                      Drop {drop.sequence}
                      <button
                        type="button"
                        onClick={() => void removeDrop(drop.id, run.id)}
                        disabled={busyId === run.id}
                        aria-label={`Remove drop ${drop.sequence}`}
                        className="text-ink/40 hover:text-danger disabled:opacity-60"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                <button
                  type="button"
                  onClick={() => void addDrop(run)}
                  disabled={busyId === run.id}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-xs text-ink/60 hover:border-primary/40 disabled:opacity-60"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Drop
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
