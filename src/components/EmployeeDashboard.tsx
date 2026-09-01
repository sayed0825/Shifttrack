import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  Calendar,
  CalendarDays,
  CalendarX,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  Loader2,
  LogIn,
  LogOut,
  MapPin,
  MoreHorizontal,
  Radio,
  RefreshCw,
  User,
  UserCog,
  X,
} from 'lucide-react';
import {
  enqueue,
  flushQueue,
  haversineMeters,
  onQueueChange,
  pendingCount,
} from '../lib/offlineQueue';
import { supabase, pushLiveLocation } from '../supabaseClient';
import LiveMap from './LiveMap';
import NotificationBell from './NotificationBell';
import EmployeeShiftActions from './EmployeeShiftActions';
import OvertimeClaim from './OvertimeClaim';
import type { Profile } from './ManagerDashboard';

type TabId = 'clock' | 'schedule' | 'shifts' | 'timesheets' | 'more';

const TABS: ReadonlyArray<{ id: TabId; label: string; Icon: typeof Clock }> = [
  { id: 'clock', label: 'Clock-In', Icon: LogIn },
  { id: 'schedule', label: 'My Schedule', Icon: CalendarDays },
  { id: 'shifts', label: 'Shifts', Icon: ArrowLeftRight },
  { id: 'timesheets', label: 'My Timesheets', Icon: Clock },
  { id: 'more', label: 'More', Icon: MoreHorizontal },
];

const MAP_VIEWER_ROLES = ['Manager', 'FOH', 'KA'];
const LATE_THRESHOLD_MS = 5 * 60 * 1000;

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
  const [tab, setTab] = useState<TabId>('clock');
  const canViewMap = MAP_VIEWER_ROLES.includes(profile.role);

  if (profile.is_active === false) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <div className="flex max-w-sm gap-3 rounded-xl border border-border bg-surface p-4">
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
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-md items-center justify-between px-3 py-2">
          <h1 className="text-sm font-bold text-primary">ShiftTrack</h1>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                window.location.reload();
              }}
              aria-label="Log out"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-border text-ink hover:bg-bg"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md px-4 py-4 pb-24">
          {tab === 'clock' && <ClockInTab profile={profile} canViewMap={canViewMap} />}
          {tab === 'schedule' && <MyScheduleTab />}
          {tab === 'shifts' && <EmployeeShiftActions profile={profile} />}
          {tab === 'timesheets' && <MyTimesheetsTab />}
          {tab === 'more' && <EmployeeMoreTab profile={profile} />}
        </div>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-border bg-surface md:hidden" aria-label="Dashboard sections">
        {TABS.map(({ id, label, Icon }) => (
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
// Tab 1 — Clock-In
// ===========================================================================

function ClockInTab({ profile, canViewMap }: { profile: Profile; canViewMap: boolean }): ReactNode {
  const [shift, setShift] = useState<ShiftRow | null>(null);
  const [openLog, setOpenLog] = useState<TimeLogRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fence, setFence] = useState<{ inRange: boolean; distance: number | null; radius: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<string | null>(null);
  const [pending, setPending] = useState(pendingCount());

  const tracking = Boolean(openLog);

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
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!openLog) { setElapsed(null); return; }
    setElapsed(formatElapsed(openLog.clock_in));
    const id = setInterval(() => setElapsed(formatElapsed(openLog.clock_in)), 30_000);
    return () => clearInterval(id);
  }, [openLog]);

  // Only drivers are tracked, and only while on shift. 90s is a
  // deliberate compromise: fresh enough for dispatch, light enough
  // not to drain a phone across a five-hour evening.
  useEffect(() => {
    if (!tracking || profile.role !== 'Driver') return undefined;
    let cancelled = false;
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
  }, [tracking, profile.id, profile.role]);

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
        setFault(err instanceof Error ? err.message : 'Could not verify your location.');
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
      setFault(err instanceof Error ? err.message : 'Clock in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleClockOut = async () => {
    if (!openLog) return;
    setBusy(true);
    setFault(null);
    const clockOut = new Date().toISOString();
    const isLocal = openLog.id.startsWith('local-');

    try {
      if (isLocal) throw new Error('queued');
      const { error } = await supabase
        .from('time_logs')
        .update({ clock_out: clockOut })
        .eq('id', openLog.id);
      if (error) throw error;
      setOpenLog(null);
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
  const railColor = tracking ? 'bg-secondary' : inRange ? 'bg-success' : 'bg-danger';

  return (
    <div className="space-y-4">
      {/* Date + shift summary */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-ink/50">{formatFullDate(now)}</p>

        {shift ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-ink">{shift.title ?? 'Shift'}</h2>
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
                <dt className="text-xs uppercase tracking-wide text-ink/50">Start</dt>
                <dd className="font-medium tabular-nums text-ink">{formatClock(shift.start_time)}</dd>
              </div>
              <div className="text-right">
                <dt className="text-xs uppercase tracking-wide text-ink/50">End</dt>
                <dd className="font-medium tabular-nums text-ink">{formatClock(shift.end_time)}</dd>
              </div>
            </dl>

            <div className="flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm">
              <User className="h-4 w-4 text-ink/50" aria-hidden="true" />
              <span className="text-ink/80">Your role:</span>
              <span className="font-medium text-ink">{profile.role}</span>
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
        <div className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className={`absolute inset-y-0 left-0 w-1.5 ${railColor}`} aria-hidden="true" />

          <div className="p-5 pl-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink/50">
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
                      ? 'bg-success-bg text-success'
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
              <div className="mt-4 rounded-xl bg-bg p-4">
                <div className="flex items-baseline justify-between">
                  <div>
                    <span className="font-mono text-2xl font-semibold tabular-nums text-ink">
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
                <div className="relative mt-3 h-2 rounded-full bg-slate-200">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${inRange ? 'bg-success' : 'bg-danger'}`}
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
              <div className="mt-4 flex items-center justify-between rounded-xl bg-secondary/10 px-4 py-3">
                <span className="text-sm text-secondary">On shift for</span>
                <span className="text-lg font-semibold tabular-nums text-secondary">{elapsed}</span>
              </div>
            )}

            {pending > 0 && (
              <div className="mt-4 flex gap-2 rounded-xl bg-secondary/10 p-3 text-sm">
                <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
                <p className="text-secondary">
                  {pending} entr{pending === 1 ? 'y' : 'ies'} saved on this device. They will
                  sync automatically when you are back online.
                </p>
              </div>
            )}

            {/* Fault */}
            {fault && (
              <div className="mt-4 flex gap-2 rounded-xl bg-warning-bg p-3 text-sm">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <p className="text-warning">{fault}</p>
              </div>
            )}

            {/* Action button */}
            {tracking ? (
              <button
                type="button"
                onClick={() => void handleClockOut()}
                disabled={busy}
                className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-60"
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
                  className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
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

      {/* Conditional LiveMap for FOH and KA */}
      {canViewMap && (
        <div className="rounded-2xl border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <MapPin className="h-4 w-4 text-ink/50" aria-hidden="true" />
              Live map
            </h3>
          </div>
          <div className="h-80">
            <LiveMap height="100%" />
          </div>
        </div>
      )}
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
        <h2 className="text-lg font-semibold text-ink">My schedule</h2>
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

function MyTimesheetsTab(): ReactNode {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [logs, setLogs] = useState<TimeLogRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data } = await supabase
      .from('time_logs')
      .select('id, clock_in, clock_out, notes, location_id')
      .eq('user_id', user.id)
      .gte('clock_in', weekStart.toISOString())
      .lt('clock_in', addDays(weekStart, 7).toISOString())
      .order('clock_in', { ascending: false });

    setLogs(data ?? []);
    setLoading(false);
  }, [weekStart]);

  useEffect(() => { void load(); }, [load]);

  const totalHours = useMemo(() => logs.reduce((sum, log) => sum + durationHours(log.clock_in, log.clock_out), 0), [logs]);
  const hasOpenLog = logs.some((log) => log.clock_out === null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">My timesheets</h2>
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
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink/50">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Total hours
          </div>
          <p className="mt-1.5 text-xl font-semibold tabular-nums text-ink">{formatHours(totalHours)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink/50">
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
          <table className="w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Clock in</th>
                <th scope="col">Clock out</th>
                <th scope="col">Hours</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-3 text-ink/80">{formatDay(log.clock_in)}</td>
                  <td className="px-2 py-3 tabular-nums text-ink">{formatClock(log.clock_in)}</td>
                  <td className="px-2 py-3 tabular-nums text-ink">
                    {log.clock_out ? formatClock(log.clock_out) : <span className="text-success">open</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">
                    {formatHours(durationHours(log.clock_in, log.clock_out))}
                  </td>
                </tr>
              ))}
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
  const [firstName, setFirstName] = useState(profile.first_name ?? '');
  const [fullName, setFullName] = useState(profile.full_name ?? '');
  const [email, setEmail] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileFault, setProfileFault] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordFault, setPasswordFault] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) setEmail(user.email);
    })();
  }, []);

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    setProfileSaved(false);
    setProfileFault(null);

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ first_name: firstName.trim() || null, full_name: fullName.trim() || null })
      .eq('id', profile.id);

    if (profileError) {
      setProfileFault('Could not save profile. Try again.');
      setSavingProfile(false);
      return;
    }

    if (email) {
      const { error: emailError } = await supabase.auth.updateUser({ email });
      if (emailError) {
        setProfileFault('Profile saved, but email could not be updated.');
        setSavingProfile(false);
        return;
      }
    }

    setProfileSaved(true);
    setSavingProfile(false);
  };

  const handleChangePassword = async () => {
    setPasswordFault(null);
    if (newPassword.length < 6) {
      setPasswordFault('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFault('Passwords do not match.');
      return;
    }

    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);

    if (error) {
      setPasswordFault(error.message);
    } else {
      setPasswordSaved(true);
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">More</h2>

      {/* Profile settings */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <User className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Profile settings</h3>
        </div>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="emp-first-name" className="block text-sm font-medium text-ink">
                First name
              </label>
              <input
                id="emp-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
            <div>
              <label htmlFor="emp-full-name" className="block text-sm font-medium text-ink">
                Full name
              </label>
              <input
                id="emp-full-name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
          </div>
          <div>
            <label htmlFor="emp-email" className="block text-sm font-medium text-ink">
              Email
            </label>
            <input
              id="emp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm">
            <span className="text-ink/60">Role:</span>
            <span className="font-medium text-ink">{profile.role}</span>
          </div>

          {profileFault && (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{profileFault}</p>
          )}
          {profileSaved && !profileFault && (
            <p className="text-sm text-success">Profile saved.</p>
          )}

          <button
            type="button"
            onClick={() => void handleSaveProfile()}
            disabled={savingProfile}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
          >
            {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Save profile
          </button>
        </div>
      </div>

      {/* Password */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <UserCog className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Change password</h3>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="emp-new-password" className="block text-sm font-medium text-ink">
              New password
            </label>
            <input
              id="emp-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div>
            <label htmlFor="emp-confirm-password" className="block text-sm font-medium text-ink">
              Confirm new password
            </label>
            <input
              id="emp-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          {passwordFault && (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{passwordFault}</p>
          )}
          {passwordSaved && (
            <p className="text-sm text-success">Password updated.</p>
          )}
          <button
            type="button"
            onClick={() => void handleChangePassword()}
            disabled={savingPassword || !newPassword}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
          >
            {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Update password
          </button>
        </div>
      </div>

      <OvertimeClaim profileId={profile.id} />
      <UnavailabilityCard profileId={profile.id} />
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
      <div className="flex items-center gap-2">
        <CalendarX className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Unavailability</h3>
      </div>
      <p className="mt-2 text-sm text-ink/60">Request time off by selecting dates on the calendar.</p>

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
          className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
