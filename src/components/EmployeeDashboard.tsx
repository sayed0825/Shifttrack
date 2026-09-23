import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeftRight,
  Calendar,
  CalendarDays,
  CalendarX,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  Loader2,
  LogIn,
  LogOut,
  MapPin,
  MapPinned,
  MoreHorizontal,
  Navigation,
  Radio,
  RefreshCw,
  User,
  X,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import {
  enqueue,
  flagClockOutDiscrepancy,
  flushQueue,
  haversineMeters,
  onQueueChange,
  pendingCount,
} from '../lib/offlineQueue';
import {
  addBackgroundLocationWatcher,
  removeBackgroundLocationWatcher,
  getPersistedWatcherId,
  setPersistedWatcherId,
  clearPersistedWatcherId,
} from '../lib/backgroundGeolocation';
import { applyFix, initialRunTrackState, isInsideGeofence, MIN_MOVING_SPEED_MPS, type RunTrackState } from '../lib/gpsFilter';
import { supabase, pushLiveLocation, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabaseClient';
import { useRoles } from '../hooks/useRoles';
import { useOrganisation } from '../hooks/useOrganisation';
import { useLateGrace } from '../hooks/useLateGrace';
import { isLate, minutesLate } from '../lib/lateness';
import {
  logNeedsOrdersReport,
  ordersCellText,
  ORDERS_NOT_YET_REPORTED,
  orgTracksOrders,
  tracksOrdersRoleNames,
} from '../lib/tracksOrders';
import { friendlyError } from '../lib/friendlyError';
import DispatchChat from './DispatchChat';
import LiveMap from './LiveMap';
import LocationConsentModal from './LocationConsentModal';
import NotificationBell from './NotificationBell';
import EmployeeShiftActions from './EmployeeShiftActions';
import EmployeeTasks from './EmployeeTasks';
import MoreTabSections, { type MoreTabSection } from './MoreTabSections';
import OvertimeClaim from './OvertimeClaim';
import OwedOrdersModal from './OwedOrdersModal';
import ProfileSettingsCard from './ProfileSettingsCard';
import ReminderAcknowledgeModal from './ReminderAcknowledgeModal';
import { loadPersistedTab, savePersistedTab } from '../lib/persistedTab';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';
import type { Profile } from './ManagerDashboard';

type TabId = 'clock' | 'schedule' | 'shifts' | 'tasks' | 'timesheets' | 'more';

const TAB_STORAGE_KEY = 'shifttrack:employee-tab';
const TAB_IDS: readonly TabId[] = ['clock', 'schedule', 'shifts', 'tasks', 'timesheets', 'more'];

const TABS: ReadonlyArray<{ id: TabId; label: string; Icon: typeof Clock }> = [
  { id: 'clock', label: 'Clock-In', Icon: LogIn },
  { id: 'schedule', label: 'My Schedule', Icon: CalendarDays },
  { id: 'shifts', label: 'Shifts', Icon: ArrowLeftRight },
  { id: 'tasks', label: 'Tasks', Icon: CheckSquare },
  { id: 'timesheets', label: 'My Timesheets', Icon: Clock },
  { id: 'more', label: 'More', Icon: MoreHorizontal },
];

const LATE_THRESHOLD_MS = 5 * 60 * 1000;
// Mid-delivery auto clock-out: sweep_open_shifts() (pg_cron) can close a
// shift while a driver is still out on a run. Tracking continues past
// that until they're back at the store or this much time has passed,
// whichever is first — the client targets exactly this figure; the
// actual server-side hard cap (0042, time_log_accepts_drops()) adds a
// little slack on top for request latency, not an extension of this.
const POST_CLOCK_OUT_GRACE_MS = 2 * 60 * 60 * 1000;

/** Muted "No role" label for anywhere a role is displayed. */
function roleLabel(role: string | null | undefined): ReactNode {
  return role ?? <span className="italic text-ink/50">No role</span>;
}

interface LocationRow {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

interface ShiftRow {
  id: string;
  title: string | null;
  start_time: string;
  end_time: string;
  location_id: string | null;
  locations: LocationRow | null;
}

interface TimeLogRow {
  id: string;
  clock_in: string;
  clock_out: string | null;
  notes: string | null;
  location_id: string | null;
  locations?: { name: string } | null;
  orders_count?: number | null;
  role_at_clock_in?: string | null;
  // Hours, drops and miles are the driver's own -- never money, matching
  // shift_pay()'s own gating (a driver's RPC call always returns null).
  delivery_runs?: { one_way_miles: number | null }[];
}

/** One Delivered tap, held in memory for the run's whole duration —
 *  nothing is written to delivery_drops until the run ends (see
 *  record_delivery_run, migration 0032), so this is also how "recorded
 *  locally" while offline is satisfied: there is no per-tap network call
 *  to fail in the first place. */
interface DropDraft {
  sequence: number;
  delivered_at: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  odometer_miles: number;
}

interface ActiveRun {
  startedAt: string;
  drops: DropDraft[];
}

/** A time log joined with its shift's start_time, for late detection. */
interface TimeLogWithShift extends TimeLogRow {
  shifts: { start_time: string } | null;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
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

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatWeekRange(from: Date): string {
  const to = addDays(from, 6);
  return `${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${to.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function durationHours(clockIn: string, clockOut: string | null): number {
  const end = clockOut ? new Date(clockOut).getTime() : Date.now();
  return Math.max(0, (end - new Date(clockIn).getTime()) / 3_600_000);
}

function formatHours(hours: number): string {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return `${whole}h ${String(minutes).padStart(2, '0')}m`;
}

function formatElapsed(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function formatDistance(meters: number | null | undefined): string {
  if (meters == null) return '—';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

// ===========================================================================
// Root
// ===========================================================================

export default function EmployeeDashboard({ profile }: { profile: Profile }): ReactNode {
  const [tab, setTab] = useState<TabId>(() => loadPersistedTab(TAB_STORAGE_KEY, TAB_IDS) ?? 'clock');
  const { roles } = useRoles();
  const { organisation } = useOrganisation();
  const canViewMap = roles.find((r) => r.name === profile.role)?.can_view_map ?? false;
  // Background location is gated on this flag, never a role NAME — an org
  // can call its delivery role anything. A front-of-house employee whose
  // role doesn't track orders is never tracked in the background, full
  // stop; this is the check the DPIA (and the store submissions) rest on.
  const tracksLocation = roles.find((r) => r.name === profile.role)?.tracks_orders ?? false;

  // Bumped on mount (checks "on login" regardless of which tab last
  // persisted), whenever the Clock or Tasks tab becomes active, and right
  // after a successful clock-out — each forces OwedOrdersModal to re-check.
  const [ordersCheckSignal, setOrdersCheckSignal] = useState(0);
  const recheckOwedOrders = useCallback(() => setOrdersCheckSignal((n) => n + 1), []);

  // Bumped on mount and whenever a 'reminder' notification is tapped, so
  // ReminderAcknowledgeModal surfaces immediately rather than waiting for
  // the next app open — same pattern as ordersCheckSignal above.
  const [remindersCheckSignal, setRemindersCheckSignal] = useState(0);
  const recheckReminders = useCallback(() => setRemindersCheckSignal((n) => n + 1), []);

  useEffect(() => {
    savePersistedTab(TAB_STORAGE_KEY, tab);
    resetDocumentScroll();
  }, [tab]);

  useEffect(() => {
    if (tab === 'clock' || tab === 'tasks') recheckOwedOrders();
  }, [tab, recheckOwedOrders]);

  if (profile.is_active === false) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <div className="flex max-w-sm gap-3 rounded-lg border border-border bg-surface p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold text-ink">Account deactivated</p>
            <p className="mt-1 text-ink/80">This account has been deactivated. Contact your manager.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="bg-primary pt-[env(safe-area-inset-top)] text-white">
        <div className="flex flex-wrap items-center gap-4 px-3 py-2">
          <div className="flex min-w-0 items-center">
            {organisation?.logo_url ? (
              <img
                src={organisation.logo_url}
                alt={organisation.name}
                className="h-7 max-w-[8rem] shrink-0 object-contain object-left"
              />
            ) : (
              <span className="truncate font-display text-lg tracking-tight text-white">
                {organisation?.name ?? ' '}
              </span>
            )}
          </div>

          <nav className="hidden gap-1 rounded-lg bg-white/10 p-1 md:flex" aria-label="Dashboard sections">
            {TABS.map(({ id, label, Icon }) => (
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

          <div className="ml-auto flex items-center gap-2">
            <NotificationBell onReminderTap={recheckReminders} />
            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.reload();
              }}
              aria-label="Log out"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white hover:bg-white/20"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <OwedOrdersModal profile={profile} checkSignal={ordersCheckSignal} />
      <ReminderAcknowledgeModal checkSignal={remindersCheckSignal} />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md px-4 py-4 pb-[calc(4rem+env(safe-area-inset-bottom))] md:max-w-3xl md:px-6 md:pb-6 lg:max-w-4xl">
          {/* Always mounted, hidden via CSS rather than conditionally
              rendered like every other tab below — ClockInTab owns the
              background watcher and, since step 4, a run's drops held
              only in its own component state until the run ends.
              Unmounting on every tab switch would tear both down: the
              driver checking Tasks or Timesheets mid-run would silently
              lose everything recorded since the last Delivered tap. */}
          <div className={tab === 'clock' ? '' : 'hidden'}>
            <ClockInTab
              profile={profile}
              canViewMap={canViewMap}
              tracksLocation={tracksLocation}
              orgId={organisation?.id ?? null}
              onClockedOut={recheckOwedOrders}
            />
          </div>
          {tab === 'schedule' && <MyScheduleTab />}
          {tab === 'shifts' && <EmployeeShiftActions profile={profile} />}
          {tab === 'tasks' && <EmployeeTasks profile={profile} />}
          {tab === 'timesheets' && <MyTimesheetsTab profile={profile} />}
          {tab === 'more' && <EmployeeMoreTab profile={profile} />}
        </div>
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-[1100] border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Dashboard sections"
      >
        <div className="flex h-16">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 px-2 text-xs font-medium transition ${
                tab === id ? 'text-primary' : 'text-ink/60'
              }`}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ===========================================================================
// Tab 1 — Clock-In
// ===========================================================================

function ClockInTab({
  profile,
  canViewMap,
  tracksLocation,
  orgId,
  onClockedOut,
}: {
  profile: Profile;
  canViewMap: boolean;
  tracksLocation: boolean;
  orgId: string | null;
  onClockedOut: () => void;
}): ReactNode {
  const [shift, setShift] = useState<ShiftRow | null>(null);
  const [openLog, setOpenLog] = useState<TimeLogRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fence, setFence] = useState<{ inRange: boolean; distance: number | null; radius: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<string | null>(null);
  const [pending, setPending] = useState(pendingCount());
  const [locationConsent, setLocationConsent] = useState(() => {
    try {
      return localStorage.getItem(`location-consent-${profile.id}`) === 'granted';
    } catch {
      return false;
    }
  });
  const [showLocationConsentDismissed, setShowLocationConsentDismissed] = useState(false);

  // The mileage engine's own state — refs, not useState, because the
  // native watcher's callback is a long-lived closure (set up once per
  // tracking effect run, firing on every GPS fix for the rest of the
  // shift) and reading React state from inside it would capture a stale
  // snapshot from whenever the effect last ran, not the latest value.
  // dropCount is the one piece mirrored into real state, purely so the
  // Delivered button's count re-renders.
  const activeRunRef = useRef<ActiveRun | null>(null);
  const trackStateRef = useRef<RunTrackState>(initialRunTrackState());
  const insideGeofenceRef = useRef(true);
  const lastFixRef = useRef<{ latitude: number; longitude: number; accuracy: number | null } | null>(null);
  const [dropCount, setDropCount] = useState(0);
  const [showDeliveredButton, setShowDeliveredButton] = useState(false);

  // Dispatch chat / driving mode — dispatchMessageIdRef mirrors the state
  // below so the watcher's long-lived closure (see the tracking effect
  // further down) can read the current 'returning' message id without
  // capturing a stale snapshot from whenever that effect last ran, same
  // reasoning as activeRunRef/trackStateRef above. isMoving/etaMinutes are
  // never read from inside that closure, only written to it, so a plain
  // ref isn't needed for them.
  const dispatchMessageIdRef = useRef<string | null>(null);
  const [dispatchMessageId, setDispatchMessageIdState] = useState<string | null>(null);
  const setDispatchMessageId = (id: string | null) => {
    dispatchMessageIdRef.current = id;
    setDispatchMessageIdState(id);
  };
  const lastEtaCallRef = useRef(0);
  // Driver-toggled only — never set from a geofence crossing or any other
  // automatic condition (see the tracking effect below). Persisted, same
  // pattern as locationConsent above: switching to Google Maps/Waze for
  // the actual driving is the normal case for a delivery driver, and the
  // OS reclaiming a backgrounded WebView for memory (more likely, not
  // less, with a heavy app like Maps now in the foreground) must not
  // silently drop this — it resumes in the same state instead of
  // reverting to the ordinary dashboard.
  const [drivingMode, setDrivingModeState] = useState(() => {
    try {
      return localStorage.getItem(`driving-mode-${profile.id}`) === 'on';
    } catch {
      return false;
    }
  });
  const setDrivingMode = (on: boolean) => {
    setDrivingModeState(on);
    try {
      localStorage.setItem(`driving-mode-${profile.id}`, on ? 'on' : 'off');
    } catch {
      // Best-effort — the in-memory state above still governs this session.
    }
  };
  const [isMoving, setIsMoving] = useState(false);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [chatPostFailures, setChatPostFailures] = useState(0);

  // Mid-delivery auto clock-out — set when the remote-clock-out listener
  // (below) detects the shift closing WHILE a run is still active.
  // openLog deliberately stays set for the rest of the grace period (see
  // that listener) so `tracking` below stays true and the watcher effect
  // keeps running — this is the whole mechanism that lets tracking
  // continue past the shift's own end. Ref mirrors state the same way as
  // dispatchMessageId above, for the same reason: the watcher's
  // long-lived closure needs to read the current value, not a stale one.
  const postClockOutRef = useRef<{ timeLogId: string; isLocalTimeLog: boolean; deadline: number } | null>(null);
  const [postClockOut, setPostClockOutState] = useState<{ timeLogId: string; isLocalTimeLog: boolean; deadline: number } | null>(null);
  const setPostClockOut = (value: { timeLogId: string; isLocalTimeLog: boolean; deadline: number } | null) => {
    postClockOutRef.current = value;
    setPostClockOutState(value);
  };

  const tracking = Boolean(openLog);

  // Best-effort, not queued through offlineQueue — dispatch chat isn't a
  // system of record the way clock-in/out and the run itself are, so a
  // failed post is surfaced to the driver (chatPostFailures, shown as a
  // small marker in driving mode) rather than retried. They can say so
  // over the radio or by phone instead.
  const postDispatchMessage = useCallback(async (status: 'delivered' | 'returning'): Promise<string | null> => {
    try {
      const { data, error } = await supabase.from('dispatch_messages').insert({ status }).select('id').single();
      if (error || !data) {
        setChatPostFailures((n) => n + 1);
        return null;
      }
      return data.id;
    } catch {
      setChatPostFailures((n) => n + 1);
      return null;
    }
  }, []);

  // Calls the ETA Edge Function (holds the Mapbox token — never the
  // client bundle). Best-effort like the post above: a failed refresh
  // just means the ETA on screen goes stale a little longer, caught by
  // the 15-minute server-side sweep (0040) either way.
  const callEtaUpdate = useCallback(async (messageId: string, latitude: number, longitude: number): Promise<number | null> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;
      const response = await fetch(`${SUPABASE_URL}/functions/v1/dispatch-eta`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ message_id: messageId, latitude, longitude }),
      });
      if (!response.ok) return null;
      const result = await response.json();
      return typeof result.eta_minutes === 'number' ? result.eta_minutes : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) { setLoading(false); return; }

      const dayStart = startOfDay(new Date());
      const dayEnd = addDays(dayStart, 1);

      const [shiftResult, logResult] = await Promise.all([
        supabase
          .from('shifts')
          .select('id, title, start_time, end_time, location_id, locations ( id, name, address, latitude, longitude, radius_meters )')
          .eq('assigned_user_id', user.id)
          .gte('start_time', dayStart.toISOString())
          .lt('start_time', dayEnd.toISOString())
          .order('start_time', { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('time_logs')
          .select('id, clock_in, clock_out, notes, location_id')
          .eq('user_id', user.id)
          .is('clock_out', null)
          .maybeSingle(),
      ]);

      if (cancelled) return;
      setShift(shiftResult.data ?? null);
      setOpenLog(logResult.data ?? null);
      setLoading(false);

      // Hard stop, part 1: a watcher started before a crash or force-quit
      // has no live JS context left to clean it up, and the plugin has no
      // "stop everything" API, only removeWatcher(id) — so the id is
      // persisted (see backgroundGeolocation.ts) specifically so this
      // check can find it again. If there's no open shift on this fresh
      // launch, any leftover watcher is for a shift that's already
      // closed, full stop, regardless of how it got left running.
      if (Capacitor.isNativePlatform() && !logResult.data) {
        const staleWatcherId = getPersistedWatcherId();
        if (staleWatcherId) {
          void removeBackgroundLocationWatcher(staleWatcherId).finally(clearPersistedWatcherId);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!openLog) { setElapsed(null); return; }
    setElapsed(formatElapsed(openLog.clock_in));
    const id = setInterval(() => setElapsed(formatElapsed(openLog.clock_in)), 30_000);
    return () => clearInterval(id);
  }, [openLog]);

  // A "Not now" only defers the current shift's prompt — the next
  // clock-in asks again, since tracking is what the mileage pay this
  // role earns is actually based on.
  useEffect(() => {
    if (!tracking) setShowLocationConsentDismissed(false);
  }, [tracking]);

  // Hard stop, part 2: the manager-side auto clock-out sweep
  // (ManagerDashboard's checkAndCloseEndedShifts) closes an open log from
  // a DIFFERENT browser/device entirely — this driver's own app has no
  // other way to learn its shift just ended. Without this, tracking would
  // keep running in the background until the driver happened to reopen
  // the tab. Scoped to this user's own rows; RLS would block anyone
  // else's anyway.
  // Ends a run: a run with no drops pays nothing and is discarded outright
  // (nothing to write — it never existed as far as pay is concerned).
  // Otherwise its one_way_miles is the odometer reading at the LAST
  // drop — the drive back is excluded automatically, since nothing after
  // that last tap is ever recorded. Writes both one_way_miles and
  // gps_one_way_miles together, source 'gps', in one RPC
  // (record_delivery_run, migration 0032) that inserts the run and all
  // its drops in a single statement — not two separate requests, so a
  // connection drop between them can never leave an orphaned run with no
  // drops or a duplicate on retry.
  //
  // Called from three places, same function every time — "end the run at
  // the last drop" doesn't distinguish how the run ended: geofence
  // re-entry, clock-out without returning (handleClockOut), and a remote
  // clock-out (the realtime listener just below — the manager-side auto
  // clock-out sweep can close an overdue shift mid-run just as easily as
  // the driver's own button can).
  const finalizeRun = useCallback(
    async (timeLogId: string, isLocalTimeLog: boolean, run: ActiveRun) => {
      if (run.drops.length === 0) return;
      const lastDrop = run.drops[run.drops.length - 1];
      const endedAt = new Date().toISOString();
      const payload = {
        started_at: run.startedAt,
        ended_at: endedAt,
        one_way_miles: lastDrop.odometer_miles,
        drops: run.drops,
      };

      // The shift itself may still be queued (never synced) — same
      // local-id correlation clock_out already uses, so a run can attach
      // to a clock-in that hasn't reached the server yet.
      if (isLocalTimeLog) {
        enqueue({ type: 'delivery_run_complete', logId: null, localTimeLogRef: timeLogId, ...payload });
        return;
      }

      try {
        const { error } = await supabase.rpc('record_delivery_run', {
          p_time_log_id: timeLogId,
          p_started_at: payload.started_at,
          p_ended_at: payload.ended_at,
          p_one_way_miles: payload.one_way_miles,
          p_drops: payload.drops,
        });
        if (error) throw error;
      } catch {
        // Still offline, or the server rejected it — keep it for the next
        // flushQueue attempt, same as a failed clock_out. Queued this way
        // (rather than left in native GPS-engine state) so a route that
        // clocks out right after is guaranteed to enqueue AFTER this run,
        // preserving flushQueue's in-order replay — the run then lands on
        // the server while the shift is still open, before the clock-out
        // entry right behind it closes it.
        enqueue({ type: 'delivery_run_complete', logId: timeLogId, localTimeLogRef: null, ...payload });
      }
    },
    []
  );

  // Ends the current run — geofence re-entry (the normal case) or a
  // mid-delivery-auto-clock-out grace period reaching its own end (2
  // hours, or this same re-entry, whichever came first). If the shift
  // itself had already ended (postClockOutRef.current set), this is also
  // the end of the whole tracking session, not just the run — there's
  // nothing left to keep tracking. If it hadn't, only the run ends; the
  // shift carries on exactly as before.
  const endRunAndMaybeShift = useCallback(
    (timeLogId: string, isLocalTimeLog: boolean) => {
      insideGeofenceRef.current = true;
      const finishedRun = activeRunRef.current;
      activeRunRef.current = null;
      trackStateRef.current = initialRunTrackState();
      setShowDeliveredButton(false);
      setDropCount(0);
      if (dispatchMessageIdRef.current) {
        const arrivingMessageId = dispatchMessageIdRef.current;
        dispatchMessageIdRef.current = null;
        void supabase.rpc('mark_dispatch_message_arrived', { p_message_id: arrivingMessageId });
      }
      setDispatchMessageId(null);
      setEtaMinutes(null);

      if (postClockOutRef.current) {
        setDrivingMode(false);
        setPostClockOut(null);
        setOpenLog(null);
      }

      if (finishedRun) void finalizeRun(timeLogId, isLocalTimeLog, finishedRun);
    },
    [finalizeRun]
  );

  // The setTimeout supplement below exists because the native watcher is
  // distance-filtered (50m, backgroundGeolocation.ts), not time-filtered —
  // a driver stationary near the 2-hour mark generates no new fix at all,
  // so the deadline check inside the watcher's own callback (see the
  // tracking effect further down) would never run. This is a genuine
  // second mechanism, not a redundant one, though both call the same
  // function and activeRunRef.current being nulled by whichever fires
  // first makes the second a harmless no-op.
  useEffect(() => {
    if (!postClockOut) return undefined;
    const msRemaining = postClockOut.deadline - Date.now();
    if (msRemaining <= 0) {
      endRunAndMaybeShift(postClockOut.timeLogId, postClockOut.isLocalTimeLog);
      return undefined;
    }
    const id = setTimeout(() => endRunAndMaybeShift(postClockOut.timeLogId, postClockOut.isLocalTimeLog), msRemaining);
    return () => clearTimeout(id);
  }, [postClockOut, endRunAndMaybeShift]);

  // Hard stop, part 2 of step 3 — extended here for two different cases.
  // A remote clock-out (the manager-side auto clock-out sweep) can close
  // an overdue shift mid-run just as easily as the driver's own
  // clock-out button can, and the run's drops are only sitting in this
  // tab's own memory until then.
  //
  // No run in progress: stop tracking immediately, exactly as before.
  //
  // A run IS in progress (mid-delivery auto clock-out): tracking
  // continues rather than losing the final drop, that leg's mileage and
  // its order pay. openLog deliberately stays set — this is the whole
  // mechanism: `tracking` below stays true, so the watcher effect keeps
  // running, keeps accepting Delivered taps, keeps accumulating mileage —
  // until the driver is back at the store or POST_CLOCK_OUT_GRACE_MS
  // passes, whichever is first (endRunAndMaybeShift above, called from
  // both the watcher's own geofence-re-entry branch and the setTimeout
  // effect above it). The drops/mileage recorded in this window still
  // attach to THIS shift (time_logs.clock_out itself is never touched
  // again), never a later one.
  useEffect(() => {
    if (!openLog) return undefined;
    const channel = supabase
      .channel(`clock-in-tab-${profile.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'time_logs', filter: `user_id=eq.${profile.id}` },
        (payload: { new: { id: string; clock_out: string | null } }) => {
          const row = payload.new;
          if (row.id !== openLog.id || row.clock_out === null) return;

          if (activeRunRef.current) {
            setPostClockOut({
              timeLogId: openLog.id,
              isLocalTimeLog: openLog.id.startsWith('local-'),
              deadline: Date.now() + POST_CLOCK_OUT_GRACE_MS,
            });
            return;
          }

          insideGeofenceRef.current = true;
          trackStateRef.current = initialRunTrackState();
          setShowDeliveredButton(false);
          setDropCount(0);
          // A still-open 'returning' message from this trip is left as
          // is, not resolved here — there's no way to know whether they
          // actually arrived. The 15-minute staleness sweep (0040)
          // catches it.
          setDrivingMode(false);
          setDispatchMessageId(null);
          setEtaMinutes(null);
          setChatPostFailures(0);
          setOpenLog(null);
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [openLog, profile.id, finalizeRun]);

  // Only a role with tracks_orders is ever tracked, and only while on
  // shift, and only once the in-app disclosure has been agreed to (see
  // LocationConsentModal below) — that ordering, disclosure before the
  // system prompt, is what "prominent disclosure" means to both stores.
  //
  // Native (iOS/Android): a background-capable watcher via
  // @capacitor-community/background-geolocation. navigator.geolocation's
  // getCurrentPosition/setInterval polling is suspended the moment the
  // WebView loses focus — the screen locking, or switching apps — which
  // is exactly when a driver's phone spends most of a shift. The native
  // watcher keeps delivering updates through that.
  //
  // Web: unchanged — navigator.geolocation polling, 90s. A deliberate
  // compromise: fresh enough for dispatch, light enough not to drain a
  // phone across a five-hour evening.
  useEffect(() => {
    if (!tracking || !tracksLocation || !locationConsent) return undefined;
    let cancelled = false;

    // A fresh tracking session always starts inside the geofence — the
    // clock-in flow itself already required being within it.
    insideGeofenceRef.current = true;
    activeRunRef.current = null;
    trackStateRef.current = initialRunTrackState();
    lastFixRef.current = null;
    setShowDeliveredButton(false);
    setDropCount(0);
    setDrivingMode(false);
    setDispatchMessageId(null);
    setEtaMinutes(null);
    setIsMoving(false);
    setChatPostFailures(0);
    setPostClockOut(null);

    if (Capacitor.isNativePlatform()) {
      // ONE watcher drives both the live map and the mileage engine — the
      // live map already had drivers reporting position; adding a second,
      // competing watcher here would mean two separate native location
      // subscriptions running at once for no reason.
      const timeLogId = openLog?.id ?? null;
      const isLocalTimeLog = timeLogId?.startsWith('local-') ?? false;
      const siteLocation = shift?.locations ?? null;

      const watcherPromise = addBackgroundLocationWatcher((location, error) => {
        if (cancelled || error || !location) return;
        void pushLiveLocation({
          userId: profile.id,
          latitude: location.latitude,
          longitude: location.longitude,
          heading: location.bearing ?? null,
          speed: location.speed ?? null,
          accuracy: location.accuracy,
        });

        // The Delivered button always uses the freshest position
        // available, whatever its accuracy — it's recorded alongside the
        // drop for anyone reviewing to judge, not silently dropped. Only
        // the mileage accumulation below is accuracy-gated.
        lastFixRef.current = { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy };

        if (!timeLogId || !siteLocation) return;

        const fixTime = location.time ?? Date.now();
        const nowInsideGeofence = isInsideGeofence(
          location.latitude,
          location.longitude,
          siteLocation.latitude,
          siteLocation.longitude,
          siteLocation.radius_meters
        );
        // Mid-delivery auto clock-out's other trigger, alongside the
        // setTimeout effect above — a fix arriving here is the earliest
        // point this closure can notice the deadline passed, since the
        // watcher is distance-filtered, not time-filtered. Checked
        // regardless of geofence state, same as the setTimeout.
        const deadlineReached = postClockOutRef.current != null && Date.now() >= postClockOutRef.current.deadline;

        if (insideGeofenceRef.current && !nowInsideGeofence) {
          // Left the store — a run starts. Reset accumulation so this
          // run's odometer measures only the distance driven on it, not
          // carried over from whatever the driver did before clocking in.
          insideGeofenceRef.current = false;
          activeRunRef.current = { startedAt: new Date().toISOString(), drops: [] };
          trackStateRef.current = initialRunTrackState();
          setShowDeliveredButton(true);
          setDropCount(0);
          // Driving mode itself is untouched by this — driver-toggled
          // only, never opened or closed by a geofence crossing. It must
          // not fight the driver for the screen; if they're already
          // showing turn-by-turn from Maps/Waze, leaving the geofence
          // popping this open on top of it would do exactly that.
          setDispatchMessageId(null);
          setEtaMinutes(null);
          setIsMoving(false);
          setChatPostFailures(0);
        } else if (!insideGeofenceRef.current && (nowInsideGeofence || deadlineReached)) {
          // Back at the store, or the mid-delivery-auto-clock-out grace
          // period's own cap reached first — either way the run ends
          // here, same as clocking out without returning (handleClockOut)
          // ends it at the last drop. endRunAndMaybeShift also ends the
          // whole tracking session, not just the run, if the shift itself
          // had already closed underneath this one.
          endRunAndMaybeShift(timeLogId, isLocalTimeLog);
        }

        if (!insideGeofenceRef.current) {
          const currentSpeed = location.speed ?? 0;
          setIsMoving(currentSpeed >= MIN_MOVING_SPEED_MPS);

          if (dispatchMessageIdRef.current && Date.now() - lastEtaCallRef.current >= 90_000) {
            lastEtaCallRef.current = Date.now();
            const returningMessageId = dispatchMessageIdRef.current;
            void callEtaUpdate(returningMessageId, location.latitude, location.longitude).then((eta) => {
              if (eta != null && dispatchMessageIdRef.current === returningMessageId) setEtaMinutes(eta);
            });
          }

          trackStateRef.current = applyFix(trackStateRef.current, {
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy,
            speed: location.speed,
            time: fixTime,
          });
        }
      });
      void watcherPromise.then((watcherId) => {
        if (!cancelled) setPersistedWatcherId(watcherId);
      });
      return () => {
        cancelled = true;
        // Always await the watcher's own ID before removing it, even if
        // cleanup runs before addWatcher's promise has resolved — losing
        // that race would leak a watcher no cleanup ever reaches. This
        // fires immediately on clock-out (openLog -> null, via either the
        // driver's own button or the realtime listener above) and on
        // unmount — the hard stop this effect exists to guarantee.
        void watcherPromise
          .then((watcherId) => removeBackgroundLocationWatcher(watcherId))
          .finally(clearPersistedWatcherId);
      };
    }

    const push = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
          if (cancelled) return;
          await pushLiveLocation({
            userId: profile.id,
            latitude: coords.latitude,
            longitude: coords.longitude,
            heading: coords.heading ?? null,
            speed: coords.speed ?? null,
            accuracy: coords.accuracy ?? null,
          });
        },
        () => {},
        { enableHighAccuracy: true, timeout: 30_000, maximumAge: 60_000 }
      );
    };
    push();
    const id = setInterval(push, 90_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tracking, tracksLocation, locationConsent, profile.id, openLog?.id, shift?.locations?.id, finalizeRun, endRunAndMaybeShift]);

  const checkFence = useCallback(async () => {
    if (!shift?.locations) return;
    setChecking(true);
    setFault(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('This browser does not support location.'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 30_000,
          maximumAge: 60_000,
        });
      });
      const { data, error } = await supabase.rpc('verify_geofenced_clock_in', {
        p_user_id: user.id,
        p_lat: position.coords.latitude,
        p_long: position.coords.longitude,
        p_location_id: shift.locations!.id,
      });
      if (error) throw error;
      if (data?.error) {
        setFault(`Site check failed: ${data.error}`);
        return;
      }
      setFence({
        inRange: Boolean(data?.success),
        distance: data?.distance_meters ?? null,
        radius: data?.allowed_radius ?? shift.locations!.radius_meters,
      });
    } catch (err) {
      const geoError = err as GeolocationPositionError;
      if (geoError?.code === 1) {
        setFault('Location access is blocked. Allow it for this site in your browser settings.');
      } else if (geoError?.code === 3) {
        setFault('Location timed out. Try again near a window or outside.');
      } else {
        setFault(friendlyError(err, 'Could not verify your location.'));
      }
    } finally {
      setChecking(false);
    }
  }, [shift]);

  useEffect(() => {
    if (shift?.locations && !tracking) {
      void checkFence();
    }
  }, [shift, tracking, checkFence]);

  useEffect(() => {
    const sync = async () => {
      const { synced } = await flushQueue(supabase);
      setPending(pendingCount());
      if (synced > 0) window.location.reload();
    };
    void sync();
    window.addEventListener('online', () => void sync());
    const off = onQueueChange(() => setPending(pendingCount()));
    return () => {
      window.removeEventListener('online', () => void sync());
      off();
    };
  }, []);

  const handleClockIn = async () => {
    if (!shift?.locations) return;
    setBusy(true);
    setFault(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 30_000,
          maximumAge: 60_000,
        })
      );

      const site = shift.locations!;
      const payload = {
        user_id: user.id,
        location_id: site.id,
        shift_id: shift.id,
        clock_in: new Date().toISOString(),
        clock_in_latitude: position.coords.latitude,
        clock_in_longitude: position.coords.longitude,
        // Captured now, not read back from the profile at report time — a
        // later promotion must not rewrite which role earned these hours.
        role_at_clock_in: profile.role,
      };

      try {
        const { data: verified, error: verifyError } = await supabase.rpc(
          'verify_geofenced_clock_in',
          {
            p_user_id: user.id,
            p_lat: position.coords.latitude,
            p_long: position.coords.longitude,
            p_location_id: site.id,
          }
        );
        if (verifyError) throw verifyError;

        if (!verified?.success) {
          setFault(
            `You are ${formatDistance(verified?.distance_meters)} from ${site.name}. Move within ${formatDistance(verified?.allowed_radius ?? site.radius_meters)} to clock in.`
          );
          setBusy(false);
          return;
        }

        const { data, error } = await supabase
          .from('time_logs')
          .insert({
            ...payload,
            is_geofenced_valid: true,
            clock_in_distance_m: verified?.distance_meters,
          })
          .select('id, clock_in, clock_out, notes, location_id')
          .single();

        if (error) throw error;
        setOpenLog(data);
      } catch {
        // Server unreachable. Verify against the shift's cached
        // coordinates so an out-of-range clock-in is still refused,
        // then queue the record rather than losing the hours.
        const distance = haversineMeters(
          position.coords.latitude,
          position.coords.longitude,
          site.latitude,
          site.longitude
        );

        if (distance > site.radius_meters) {
          setFault(
            `You are ${formatDistance(distance)} from ${site.name}. Move within ${formatDistance(site.radius_meters)} to clock in.`
          );
          setBusy(false);
          return;
        }

        const localId = enqueue({
          type: 'clock_in',
          payload: { ...payload, is_geofenced_valid: true, clock_in_distance_m: distance },
        });

        setPending(pendingCount());
        setOpenLog({
          id: localId,
          clock_in: payload.clock_in,
          clock_out: null,
          notes: null,
          location_id: site.id,
        });
      }
    } catch (err) {
      setFault(friendlyError(err, 'Clock in failed.'));
    } finally {
      setBusy(false);
    }
  };

  const handleClockOut = async () => {
    if (!openLog) return;

    // The shift already ended server-side (mid-delivery auto clock-out —
    // see postClockOut above) — a real clock-out attempt would just be
    // rejected (0041: the shift is already closed). Tapping this here
    // means "I'm done, stop tracking now" instead.
    if (postClockOutRef.current) {
      endRunAndMaybeShift(postClockOutRef.current.timeLogId, postClockOutRef.current.isLocalTimeLog);
      return;
    }

    setBusy(true);
    setFault(null);
    const clockOut = new Date().toISOString();
    const isLocal = openLog.id.startsWith('local-');

    // Clocking out without returning to the store ends any run at its
    // last drop, same as a geofence re-entry would — awaited before the
    // clock-out request/enqueue below runs, so if this itself has to
    // queue (offline), it queues AHEAD of the clock_out entry right after
    // it. flushQueue replays in order, so the run reaches the server
    // while the shift is still open, before the clock-out entry behind it
    // closes it — delivery_runs_insert_own requires that.
    if (activeRunRef.current) {
      const runToFinalize = activeRunRef.current;
      activeRunRef.current = null;
      insideGeofenceRef.current = true;
      trackStateRef.current = initialRunTrackState();
      setShowDeliveredButton(false);
      setDropCount(0);
      // Same as the remote-clock-out listener above: a still-open
      // 'returning' message is left for the staleness sweep, not
      // resolved here — clocking out without returning doesn't mean
      // they arrived.
      setDrivingMode(false);
      setDispatchMessageId(null);
      setEtaMinutes(null);
      setChatPostFailures(0);
      await finalizeRun(openLog.id, isLocal, runToFinalize);
    }

    try {
      if (isLocal) throw new Error('queued');
      // clockOut is sent but never trusted server-side — 0041 forces the
      // server's own now() instead, whatever this says. .select() (an
      // array, not .single()) so a zero-row match (already closed by
      // something else) stays a no-op here rather than an error, same
      // tolerance as the offline replay path in offlineQueue.js.
      const { data, error } = await supabase
        .from('time_logs')
        .update({ clock_out: clockOut })
        .eq('id', openLog.id)
        .select('clock_out');
      if (error) throw error;
      setOpenLog(null);
      // Closed for real (not just queued) — an orders entry may now be
      // owed for this shift.
      onClockedOut();
      // A slow request can land well after the tap — flag it for review
      // the same way an offline replay does if the server's actual time
      // differs meaningfully from what was attempted.
      if (data?.[0]?.clock_out) {
        void flagClockOutDiscrepancy(supabase, profile.id, openLog.id, clockOut, data[0].clock_out);
      }
    } catch {
      enqueue({
        type: 'clock_out',
        clock_out: clockOut,
        logId: isLocal ? null : openLog.id,
        localRef: isLocal ? openLog.id : null,
      });
      setPending(pendingCount());
      setOpenLog(null);
    } finally {
      setBusy(false);
    }
  };

  // The drop itself is recorded entirely in memory — see DropDraft's own
  // comment for why that's also what makes THAT part work offline with no
  // special-casing: there is no network call to fail for pay purposes.
  // The chat post alongside it is a separate, best-effort side effect —
  // see postDispatchMessage's own comment.
  const handleDelivered = () => {
    if (isMoving) return; // defense in depth — the button is also disabled while moving
    const run = activeRunRef.current;
    const fix = lastFixRef.current;
    if (!run || !fix) return;

    const drop: DropDraft = {
      sequence: run.drops.length + 1,
      delivered_at: new Date().toISOString(),
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      odometer_miles: trackStateRef.current.odometerMiles,
    };
    activeRunRef.current = { ...run, drops: [...run.drops, drop] };
    setDropCount(activeRunRef.current.drops.length);
    void postDispatchMessage('delivered');
  };

  // Posts the one 'returning' message for this trip and kicks off the
  // first ETA lookup immediately, rather than waiting up to 90s for the
  // next qualifying fix — dispatchMessageIdRef is what the watcher's
  // periodic update (see the tracking effect above) then keeps refreshing.
  const handleReturning = () => {
    if (isMoving || dispatchMessageIdRef.current) return;
    const fix = lastFixRef.current;
    if (!fix) return;
    void postDispatchMessage('returning').then((id) => {
      if (!id) return;
      setDispatchMessageId(id);
      lastEtaCallRef.current = Date.now();
      void callEtaUpdate(id, fix.latitude, fix.longitude).then((eta) => {
        if (eta != null && dispatchMessageIdRef.current === id) setEtaMinutes(eta);
      });
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your shift…
      </div>
    );
  }

  const now = new Date();
  const isLate = shift && !tracking && new Date(shift.start_time).getTime() + LATE_THRESHOLD_MS < now.getTime();
  const inRange = Boolean(fence?.inRange);
  const radius = fence?.radius ?? shift?.locations?.radius_meters ?? 100;
  const barPercent = fence?.distance == null ? 0 : Math.min(100, (fence.distance / (radius * 2)) * 100);
  const railColor = tracking ? 'bg-secondary' : inRange ? 'bg-active' : 'bg-danger';

  return (
    <div className="space-y-4">
      {/* Date + shift summary */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <p className="text-xs font-medium text-ink/50">{formatFullDate(now)}</p>

        {shift ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-display text-lg tracking-tight text-ink">{shift.title ?? 'Shift'}</h2>
                <p className="mt-0.5 text-sm text-ink/60">
                  {shift.locations?.name ?? 'No location assigned'}
                </p>
                {shift.locations?.address && (
                  <p className="text-xs text-ink/50">{shift.locations.address}</p>
                )}
              </div>
              {isLate && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  LATE
                </span>
              )}
            </div>

            <dl className="flex items-center justify-between border-t border-border pt-3 text-sm">
              <div>
                <dt className="text-xs text-ink/50">Start</dt>
                <dd className="font-medium tabular-nums text-ink">{formatClock(shift.start_time)}</dd>
              </div>
              <div className="text-right">
                <dt className="text-xs text-ink/50">End</dt>
                <dd className="font-medium tabular-nums text-ink">{formatClock(shift.end_time)}</dd>
              </div>
            </dl>

            <div className="flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm">
              <User className="h-4 w-4 text-ink/50" aria-hidden="true" />
              <span className="text-ink/80">Your role:</span>
              <span className="font-medium text-ink">{roleLabel(profile.role)}</span>
            </div>
          </div>
        ) : (
          <div className="mt-3 text-center py-6">
            <Calendar className="mx-auto h-8 w-8 text-ink/40" aria-hidden="true" />
            <p className="mt-2 text-sm font-semibold text-ink">No shift scheduled today</p>
            <p className="mt-1 text-xs text-ink/60">Enjoy your day off.</p>
          </div>
        )}
      </div>

      {/* Geofence + clock controls */}
      {shift?.locations && (
        <div className="relative overflow-hidden rounded-2xl border border-border bg-surface">
          <div className={`absolute inset-y-0 left-0 w-1.5 ${railColor}`} aria-hidden="true" />

          <div className="p-5 pl-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-ink/50">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  Assigned site
                </div>
                <h3 className="mt-1 text-base font-semibold text-ink">{shift.locations.name}</h3>
              </div>

              <span
                role="status"
                aria-live="polite"
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                  tracking
                    ? 'bg-secondary/10 text-secondary'
                    : inRange
                      ? 'bg-active-bg text-active'
                      : 'bg-danger-bg text-danger'
                }`}
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : tracking ? (
                  <Radio className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
                ) : (
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {tracking ? 'On shift' : inRange ? 'In range' : 'Out of range'}
              </span>
            </div>

            {/* Distance + bar */}
            {!tracking && (
              <div className="mt-4 rounded-lg bg-bg p-4">
                <div className="flex items-baseline justify-between">
                  <div>
                    <span className="text-xl font-semibold tabular-nums text-ink">
                      {fence?.distance == null ? '––' : Math.round(fence.distance)}
                    </span>
                    <span className="ml-1 text-sm font-medium text-ink/60">m from site</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void checkFence()}
                    disabled={checking || busy}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-ink/80 hover:bg-border disabled:opacity-40"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
                    Check again
                  </button>
                </div>
                <div className="relative mt-3 h-2 rounded-full bg-border">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${inRange ? 'bg-active' : 'bg-danger'}`}
                    style={{ width: `${barPercent}%` }}
                  />
                  <div className="absolute inset-y-0 left-1/2 w-px bg-border" aria-hidden="true" />
                </div>
                <p className="mt-2 text-xs text-ink/60">
                  Clock in allowed within {formatDistance(radius)}
                </p>
              </div>
            )}

            {/* Elapsed timer */}
            {tracking && (
              <div className="mt-4 flex items-center justify-between rounded-lg bg-secondary/10 px-4 py-3">
                <span className="text-sm text-secondary">On shift for</span>
                <span className="text-lg font-semibold tabular-nums text-secondary">{elapsed}</span>
              </div>
            )}

            {/* Mid-delivery auto clock-out — the driver must always know
                tracking is still running once the shift itself has ended.
                Shown regardless of driving mode being open (see its own
                header) or not. */}
            {postClockOut && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-warning-bg px-4 py-3">
                <Radio className="h-4 w-4 shrink-0 animate-pulse text-warning" aria-hidden="true" />
                <p className="text-sm font-medium text-warning">
                  Shift ended. Still recording until you are back at the store.
                </p>
              </div>
            )}

            {pending > 0 && (
              <div className="mt-4 flex gap-2 rounded-lg bg-secondary/10 p-3 text-sm">
                <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
                <p className="text-secondary">
                  {pending} entr{pending === 1 ? 'y' : 'ies'} saved on this device. They will
                  sync automatically when you are back online.
                </p>
              </div>
            )}

            {/* Fault */}
            {fault && (
              <div className="mt-4 flex gap-2 rounded-lg bg-warning-bg p-3 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <p className="text-warning">{fault}</p>
              </div>
            )}

            {/* Shown while clocked in and outside the store on a delivery
                shift, whenever driving mode isn't currently showing — the
                driver turns it on themselves; it's never opened
                automatically (see the tracking effect above). Full
                Delivered/Returning taps only ever happen inside driving
                mode itself (see DrivingMode below), never here. Native
                only; web drivers keep entering mileage manually (see
                OwedOrdersModal), since mobile Safari suspends location the
                moment the screen locks. */}
            {tracking && showDeliveredButton && !drivingMode && (
              <button
                type="button"
                onClick={() => setDrivingMode(true)}
                className="mt-5 flex h-16 w-full items-center justify-center gap-2 rounded-lg bg-secondary text-lg font-semibold text-white transition active:scale-[0.99]"
              >
                <Navigation className="h-6 w-6" aria-hidden="true" />
                Driving mode
                <span className="ml-1 rounded-full bg-white/20 px-2.5 py-0.5 text-sm tabular-nums">{dropCount}</span>
              </button>
            )}

            {/* Action button */}
            {tracking ? (
              <button
                type="button"
                onClick={() => void handleClockOut()}
                disabled={busy}
                className={`${showDeliveredButton ? 'mt-3' : 'mt-5'} flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-primary text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-60`}
              >
                {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <LogOut className="h-5 w-5" aria-hidden="true" />}
                Clock out
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void handleClockIn()}
                  disabled={busy || !inRange || checking}
                  className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-success text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
                >
                  {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <LogIn className="h-5 w-5" aria-hidden="true" />}
                  Clock in
                </button>
                {!inRange && !fault && (
                  <p className="mt-2 text-center text-xs text-ink/60">
                    {fence?.distance == null
                      ? 'Waiting for a GPS fix.'
                      : `Move ${formatDistance(Math.max(0, (fence.distance ?? 0) - radius))} closer to clock in.`}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Dispatch chat — visible to anyone on an open shift at a location
          (FOH and drivers alike; RLS itself is what actually scopes the
          content), not just canViewMap roles. */}
      {tracking && openLog?.location_id && orgId && (
        <DispatchChat locationId={openLog.location_id} orgId={orgId} />
      )}

      {/* Conditional LiveMap for FOH and KA */}
      {canViewMap && (
        <div className="rounded-2xl border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <MapPin className="h-4 w-4 text-ink/50" aria-hidden="true" />
              Live map
            </h3>
          </div>
          {/* isolate contains Leaflet's internal z-index (panes/controls go up to
              1000) so it can never compete with page-level chrome like the
              fixed bottom nav or a modal. */}
          <div className="relative z-0 h-[min(20rem,55dvh)] isolate">
            <LiveMap height="100%" />
          </div>
        </div>
      )}

      {tracking && tracksLocation && !locationConsent && !showLocationConsentDismissed && (
        <LocationConsentModal
          onAgree={() => {
            try {
              localStorage.setItem(`location-consent-${profile.id}`, 'granted');
            } catch {
              // Best-effort — tracking still starts this session either way;
              // a failed write just means asking again next session.
            }
            setLocationConsent(true);
          }}
          onDismiss={() => setShowLocationConsentDismissed(true)}
        />
      )}

      {/* Portalled to document.body, not rendered inline here — this whole
          card sits inside EmployeeDashboard's tab === 'clock' ? '' :
          'hidden' wrapper, which is display:none the moment any other tab
          is selected. A portal is the only way this can never be hidden
          by that, or by anything else in the ancestor chain, regardless
          of which tab is nominally active underneath. */}
      {drivingMode &&
        createPortal(
          <DrivingMode
            dropCount={dropCount}
            isMoving={isMoving}
            isReturning={dispatchMessageId != null}
            etaMinutes={etaMinutes}
            chatPostFailures={chatPostFailures}
            shiftEnded={postClockOut != null}
            onDelivered={handleDelivered}
            onReturning={handleReturning}
            onExit={() => setDrivingMode(false)}
          />,
          document.body
        )}
    </div>
  );
}

/** Full-screen, three large buttons, nothing else. Driver-toggled only —
 *  never opened automatically by a geofence crossing or any other run
 *  state (see the parent's setDrivingMode calls, all driver-initiated).
 *  Switching to Google Maps/Waze for the actual turn-by-turn is the
 *  normal case, and this must not fight the driver for the screen — Exit
 *  means exit until they turn it back on themselves. The two action
 *  buttons disable themselves the instant GPS speed crosses
 *  MIN_MOVING_SPEED_MPS. A driver tapping either while the vehicle is
 *  moving is a phone-at-the-wheel offence; the app should not invite it,
 *  so Exit is the only thing ever tappable while in motion. */
function DrivingMode({
  dropCount,
  isMoving,
  isReturning,
  etaMinutes,
  chatPostFailures,
  shiftEnded,
  onDelivered,
  onReturning,
  onExit,
}: {
  dropCount: number;
  isMoving: boolean;
  isReturning: boolean;
  etaMinutes: number | null;
  chatPostFailures: number;
  shiftEnded: boolean;
  onDelivered: () => void;
  onReturning: () => void;
  onExit: () => void;
}): ReactNode {
  return (
    // Higher than DispatchChat's own expanded overlay (z-[1400]) — if a
    // driver had the chat feed open when they left the geofence, driving
    // mode (safety-critical) must still win and cover it, not the other
    // way round.
    <div className="fixed inset-0 z-[1450] flex flex-col bg-ink text-white">
      <div className="flex items-center justify-between px-5 pt-[calc(env(safe-area-inset-top)+1rem)] pb-2">
        <span
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
            isMoving ? 'bg-warning-bg text-warning' : 'bg-white/10 text-white/70'
          }`}
        >
          {isMoving ? 'Vehicle moving — buttons locked' : 'Stopped'}
        </span>
        {chatPostFailures > 0 && (
          <span className="text-xs font-medium text-warning">
            {chatPostFailures} not sent — tell dispatch by radio or phone
          </span>
        )}
      </div>

      {/* Mid-delivery auto clock-out — the driver must always know
          tracking is still running once the shift itself has ended,
          whether they're looking at this screen or the normal one. */}
      {shiftEnded && (
        <div className="mx-5 mt-1 flex items-center gap-2 rounded-lg bg-warning-bg px-3 py-2">
          <Radio className="h-4 w-4 shrink-0 animate-pulse text-warning" aria-hidden="true" />
          <p className="text-sm font-medium text-warning">
            Shift ended. Still recording until you are back at the store.
          </p>
        </div>
      )}

      <div className="flex flex-1 flex-col justify-center gap-4 px-5 pb-[env(safe-area-inset-bottom)]">
        <button
          type="button"
          onClick={onDelivered}
          disabled={isMoving}
          className="flex h-28 w-full flex-col items-center justify-center gap-1 rounded-2xl bg-secondary text-2xl font-bold text-white transition active:scale-[0.98] disabled:opacity-40"
        >
          <MapPinned className="h-8 w-8" aria-hidden="true" />
          Delivered
          <span className="text-sm font-medium opacity-80">{dropCount} so far</span>
        </button>

        {isReturning ? (
          <div className="flex h-28 w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-primary bg-primary/20 text-2xl font-bold text-white">
            <Navigation className="h-8 w-8" aria-hidden="true" />
            Returning
            <span className="text-sm font-medium opacity-80">
              {etaMinutes != null ? `ETA ${etaMinutes} min${etaMinutes === 1 ? '' : 's'}` : 'Calculating ETA…'}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onReturning}
            disabled={isMoving}
            className="flex h-28 w-full flex-col items-center justify-center gap-1 rounded-2xl bg-primary text-2xl font-bold text-white transition active:scale-[0.98] disabled:opacity-40"
          >
            <Navigation className="h-8 w-8" aria-hidden="true" />
            Returning
          </button>
        )}

        <button
          type="button"
          onClick={onExit}
          className="flex h-20 w-full items-center justify-center gap-2 rounded-2xl border border-white/20 text-lg font-semibold text-white/80 transition active:scale-[0.98]"
        >
          <X className="h-6 w-6" aria-hidden="true" />
          Exit
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 2 — My Schedule
// ===========================================================================

function MyScheduleTab(): ReactNode {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data } = await supabase
      .from('shifts')
      .select('id, title, start_time, end_time, location_id, locations ( id, name, address, latitude, longitude, radius_meters )')
      .eq('assigned_user_id', user.id)
      .gte('start_time', weekStart.toISOString())
      .lt('start_time', addDays(weekStart, 7).toISOString())
      .order('start_time');

    setShifts((data ?? []) as unknown as ShiftRow[]);
    setLoading(false);
  }, [weekStart]);

  useEffect(() => { void load(); }, [load]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const shiftsByDay = useMemo(() => {
    const map = new Map<string, ShiftRow[]>();
    for (const shift of shifts) {
      const key = new Date(shift.start_time).toDateString();
      (map.get(key) ?? map.set(key, []).get(key)!).push(shift);
    }
    return map;
  }, [shifts]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg tracking-tight text-ink">My schedule</h2>
        <div className="flex items-center rounded-lg border border-border bg-surface">
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            aria-label="Previous week"
            className="p-2 text-ink/60 hover:bg-bg"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="border-x border-border px-3 py-1.5 text-sm font-medium tabular-nums text-ink">
            {formatWeekRange(weekStart)}
          </span>
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            aria-label="Next week"
            className="p-2 text-ink/60 hover:bg-bg"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading schedule…
        </div>
      ) : shifts.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface py-12 text-center">
          <Calendar className="mx-auto h-8 w-8 text-ink/40" aria-hidden="true" />
          <p className="mt-2 text-sm text-ink/60">No shifts scheduled this week.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {weekDays.map((day) => {
            const dayShifts = shiftsByDay.get(day.toDateString()) ?? [];
            if (dayShifts.length === 0) return null;
            return (
              <div key={day.toDateString()} className="rounded-2xl border border-border bg-surface p-4">
                <p className="text-sm font-semibold text-ink">{formatDay(dayShifts[0].start_time)}</p>
                <div className="mt-2 space-y-2">
                  {dayShifts.map((s) => (
                    <div key={s.id} className="flex items-center gap-3 rounded-lg bg-bg px-3 py-2">
                      <Clock className="h-4 w-4 shrink-0 text-ink/50" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{s.title ?? 'Shift'}</p>
                        <p className="truncate text-xs text-ink/60">{s.locations?.name ?? 'No location'}</p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-ink/80">
                        {formatClock(s.start_time)} – {formatClock(s.end_time)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Tab 3 — My Timesheets
// ===========================================================================

function MyTimesheetsTab({ profile }: { profile: Profile }): ReactNode {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [logs, setLogs] = useState<TimeLogWithShift[]>([]);
  const [loading, setLoading] = useState(true);
  const { graceMinutes } = useLateGrace();
  const { roles } = useRoles();
  const trackedRoleNames = useMemo(() => tracksOrdersRoleNames(roles), [roles]);
  const showOrdersColumns = orgTracksOrders(roles);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data } = await supabase
      .from('time_logs')
      .select(
        'id, clock_in, clock_out, notes, location_id, orders_count, role_at_clock_in, locations:location_id ( name ), shifts:shift_id ( start_time ), delivery_runs ( one_way_miles )'
      )
      .eq('user_id', user.id)
      .gte('clock_in', weekStart.toISOString())
      .lt('clock_in', addDays(weekStart, 7).toISOString())
      .order('clock_in', { ascending: false });

    setLogs((data ?? []) as unknown as TimeLogWithShift[]);
    setLoading(false);
  }, [weekStart]);

  useEffect(() => { void load(); }, [load]);

  const totalHours = useMemo(() => logs.reduce((sum, log) => sum + durationHours(log.clock_in, log.clock_out), 0), [logs]);
  const hasOpenLog = logs.some((log) => log.clock_out === null);

  const milesFor = (log: TimeLogWithShift): number =>
    (log.delivery_runs ?? []).reduce((sum, r) => sum + (r.one_way_miles ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg tracking-tight text-ink">My timesheets</h2>
        <div className="flex items-center rounded-lg border border-border bg-surface">
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            aria-label="Previous week"
            className="p-2 text-ink/60 hover:bg-bg"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="border-x border-border px-3 py-1.5 text-sm font-medium tabular-nums text-ink">
            {formatWeekRange(weekStart)}
          </span>
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            aria-label="Next week"
            className="p-2 text-ink/60 hover:bg-bg"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink/50">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Total hours
          </div>
          <p className="mt-1.5 text-xl font-semibold tabular-nums text-ink">{formatHours(totalHours)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink/50">
            <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
            Entries
          </div>
          <p className="mt-1.5 text-xl font-semibold tabular-nums text-ink">{logs.length}</p>
          {hasOpenLog && <p className="mt-0.5 text-xs text-success">On shift now</p>}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading timesheets…
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface py-12 text-center">
          <Clock className="mx-auto h-8 w-8 text-ink/40" aria-hidden="true" />
          <p className="mt-2 text-sm text-ink/60">No time logged this week.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface">
          {/* Below sm: stacked cards, no sideways scroll. sm and up: a real table. */}
          <ul className="divide-y divide-border sm:hidden">
            {logs.map((log) => {
              const shiftStart = log.shifts?.start_time ?? null;
              const late = isLate(log.clock_in, shiftStart, graceMinutes);
              const needsReport = logNeedsOrdersReport(log.role_at_clock_in, profile.role, trackedRoleNames);

              return (
                <li key={log.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{formatDay(log.clock_in)}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-ink/70">
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
                      <p className="mt-1 text-xs text-ink/60">
                        {log.orders_count == null ? ORDERS_NOT_YET_REPORTED : `${log.orders_count} orders`}
                        {milesFor(log) > 0 && ` · ${milesFor(log).toFixed(1)} mi`}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-ink">
                    {formatHours(durationHours(log.clock_in, log.clock_out))}
                  </span>
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
                {showOrdersColumns && <th scope="col">Miles</th>}
                <th scope="col">Hours</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => {
                const shiftStart = log.shifts?.start_time ?? null;
                const late = isLate(log.clock_in, shiftStart, graceMinutes);
                const needsReport = logNeedsOrdersReport(log.role_at_clock_in, profile.role, trackedRoleNames);
                const miles = milesFor(log);

                return (
                  <tr key={log.id}>
                    <td className="px-4 py-3 text-ink/80">{formatDay(log.clock_in)}</td>
                    <td className="px-2 py-3 tabular-nums text-ink">
                      {formatClock(log.clock_in)}
                      {late && shiftStart && (
                        <span className="ml-2 inline-flex items-center rounded-lg bg-danger-bg px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                          LATE · {minutesLate(log.clock_in, shiftStart)} min
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-3 tabular-nums text-ink">
                      {log.clock_out ? formatClock(log.clock_out) : <span className="text-success">open</span>}
                    </td>
                    <td className="px-2 py-3 text-ink/70">{log.locations?.name ?? '—'}</td>
                    {showOrdersColumns && (
                      <td className="px-2 py-3 tabular-nums text-ink">
                        {ordersCellText(needsReport, log.orders_count ?? null)}
                      </td>
                    )}
                    {showOrdersColumns && (
                      <td className="px-2 py-3 tabular-nums text-ink">{miles > 0 ? miles.toFixed(1) : '—'}</td>
                    )}
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">
                      {formatHours(durationHours(log.clock_in, log.clock_out))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Tab 4 — More (Profile settings + Change password)
// ===========================================================================

function EmployeeMoreTab({ profile }: { profile: Profile }): ReactNode {
  const sections: MoreTabSection[] = [
    { id: 'profile', title: 'Profile settings', icon: User, render: () => <ProfileSettingsCard profile={profile} /> },
    { id: 'overtime', title: 'Overtime', icon: Clock, render: () => <OvertimeClaim profileId={profile.id} /> },
    { id: 'unavailability', title: 'Unavailability', icon: CalendarX, render: () => <UnavailabilityCard profileId={profile.id} /> },
  ];

  return (
    <div>
      <h2 className="mb-4 font-display text-lg tracking-tight text-ink">More</h2>
      <MoreTabSections sections={sections} storageKey="shifttrack:employee-more" />
      <p className="mt-4 text-center text-xs text-ink/50">
        <a href="/privacy" className="underline hover:text-ink/70">
          Privacy policy
        </a>
      </p>
    </div>
  );
}

// ===========================================================================
// Unavailability requests
// ===========================================================================

interface UnavailabilityRow {
  id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
}

function UnavailabilityCard({ profileId }: { profileId: string }): ReactNode {
  const [requests, setRequests] = useState<UnavailabilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('unavailability_requests')
      .select('id, start_date, end_date, reason, status, created_at')
      .eq('user_id', profileId)
      .order('created_at', { ascending: false });
    if (error) {
      setFault('Could not load your requests.');
    } else {
      setRequests((data ?? []) as UnavailabilityRow[]);
    }
    setLoading(false);
  }, [profileId]);

  useEffect(() => { void load(); }, [load]);

  const toggleDate = (dateStr: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  };

  const toggleWeek = (weekStart: Date) => {
    const weekDates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      weekDates.push(localDateKey(d));
    }
    setSelectedDates((prev) => {
      const allSelected = weekDates.every((d) => prev.has(d));
      const next = new Set(prev);
      if (allSelected) {
        weekDates.forEach((d) => next.delete(d));
      } else {
        weekDates.forEach((d) => next.add(d));
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selectedDates.size === 0) {
      setFault('Select at least one date.');
      return;
    }
    setSubmitting(true);
    setFault(null);
    // Group consecutive days into blocks. Selecting Mon and Fri must
    // create two requests, not one spanning the whole week.
    const sorted = Array.from(selectedDates).sort();
    const blocks: Array<{ start: string; end: string }> = [];
    for (const day of sorted) {
      const last = blocks[blocks.length - 1];
      if (last) {
        const nextDay = new Date(`${last.end}T12:00:00`);
        nextDay.setDate(nextDay.getDate() + 1);
        if (localDateKey(nextDay) === day) {
          last.end = day;
          continue;
        }
      }
      blocks.push({ start: day, end: day });
    }
    const { error } = await supabase.from('unavailability_requests').insert(
      blocks.map((block) => ({
        user_id: profileId,
        start_date: block.start,
        end_date: block.end,
        reason: reason.trim() || null,
      }))
    );
    if (error) {
      setFault('Could not submit request. Try again.');
      setSubmitting(false);
      return;
    }
    setSelectedDates(new Set());
    setReason('');
    setSubmitting(false);
    await load();
  };

  const monthDays = useMemo(() => {
    const firstOfMonth = new Date(viewMonth);
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const gridStart = addDays(firstOfMonth, -startOffset);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [viewMonth]);

  const todayStr = localDateKey(new Date());

  const statusBadge = (status: string) => {
    if (status === 'approved') return 'bg-success-bg text-success';
    if (status === 'denied') return 'bg-danger-bg text-danger';
    return 'bg-warning-bg text-warning';
  };

  const formatDateRange = (start: string, end: string) => {
    if (start === end) return new Date(start + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${new Date(start + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(end + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <p className="text-sm text-ink/60">Request time off by selecting dates on the calendar.</p>

      {/* Calendar */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
            className="rounded-lg p-2 text-ink/60 hover:bg-bg min-h-[44px]"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="text-sm font-semibold text-ink">
            {viewMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })}
          </span>
          <button
            type="button"
            onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
            className="rounded-lg p-2 text-ink/60 hover:bg-bg min-h-[44px]"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-7 gap-1 text-center">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <span key={i} className="text-xs font-medium text-ink/50 py-1">{d}</span>
          ))}
          {monthDays.map((date) => {
            const dateStr = localDateKey(date);
            const inMonth = date.getMonth() === viewMonth.getMonth();
            const isPast = dateStr < todayStr;
            const isSelected = selectedDates.has(dateStr);
            return (
              <button
                key={dateStr}
                type="button"
                disabled={isPast}
                onClick={() => toggleDate(dateStr)}
                className={`rounded-lg py-2 text-sm transition min-h-[44px] ${
                  !inMonth ? 'text-ink/30' : isPast ? 'text-ink/30 cursor-not-allowed' : isSelected ? 'bg-primary text-white font-semibold' : 'text-ink hover:bg-bg'
                }`}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggleWeek(monthDays[0])}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink/80 hover:bg-bg min-h-[44px]"
          >
            Toggle visible week
          </button>
          {selectedDates.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedDates(new Set())}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink/80 hover:bg-bg min-h-[44px]"
            >
              Clear ({selectedDates.size})
            </button>
          )}
        </div>
      </div>

      {/* Reason */}
      <div className="mt-4">
        <label htmlFor="unavail-reason" className="block text-sm font-medium text-ink">Reason (optional)</label>
        <input
          id="unavail-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. doctor appointment"
          className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
      </div>

      {fault && (
        <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>
      )}

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={submitting || selectedDates.size === 0}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60 min-h-[44px]"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CalendarX className="h-4 w-4" aria-hidden="true" />}
        Submit request
      </button>

      {/* Existing requests */}
      <div className="mt-5 space-y-2">
        <p className="text-sm font-semibold text-ink">Your requests</p>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink/60">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : requests.length === 0 ? (
          <p className="text-sm text-ink/60">No requests submitted.</p>
        ) : (
          <ul className="space-y-2">
            {requests.map((req) => (
              <li key={req.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-ink">{formatDateRange(req.start_date, req.end_date)}</p>
                  {req.reason && <p className="text-xs text-ink/60">{req.reason}</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(req.status)}`}>
                  {req.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
