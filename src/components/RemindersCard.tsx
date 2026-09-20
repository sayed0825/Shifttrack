import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Loader2,
  Megaphone,
  Plus,
  Repeat,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles, type Role } from '../hooks/useRoles';
import { friendlyError } from '../lib/friendlyError';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';
import FilterButton from './FilterButton';

type Target = 'role' | 'individual';
type Recurrence = 'daily' | 'weekly';
type AckFilter = 'all' | 'complete' | 'outstanding';

interface LocationLite {
  id: string;
  name: string;
}

interface StaffLite {
  id: string;
  first_name: string | null;
  full_name: string | null;
  role: string | null;
}

interface ReminderRow {
  id: string;
  title: string;
  body: string | null;
  target_role: string | null;
  target_user_id: string | null;
  target_location_id: string | null;
  send_at: string;
  template_id: string | null;
  target_profile: { first_name: string | null; full_name: string | null } | null;
  target_location: { name: string } | null;
}

const REMINDER_FIELDS =
  'id, title, body, target_role, target_user_id, target_location_id, send_at, template_id, ' +
  'target_profile:target_user_id ( first_name, full_name ), target_location:target_location_id ( name )';

const WEEKDAYS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
];

function nameOf(p: { first_name: string | null; full_name: string | null } | null): string {
  return p?.full_name ?? p?.first_name ?? 'Unknown';
}

function formatSendAt(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Combines a `yyyy-mm-dd` date and `HH:mm` time as local calendar fields,
 *  not string concatenation — see CLAUDE.md on building occurrences from
 *  calendar fields rather than adding milliseconds. */
function toLocalIso(dateKey: string, hhmm: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

// ===========================================================================
// Root
// ===========================================================================

export default function RemindersCard({ locations }: { locations: LocationLite[] }): ReactNode {
  const { roles } = useRoles();
  const [userId, setUserId] = useState<string | null>(null);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [staffLocations, setStaffLocations] = useState<Map<string, Set<string>>>(new Map());
  const [acks, setAcks] = useState<Map<string, Set<string>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFault, setActionFault] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [filterLocation, setFilterLocation] = useState('all');
  const [filterAck, setFilterAck] = useState<AckFilter>('all');

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUserId(user?.id ?? null);
    })();
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const [remindersRes, staffRes, staffLocRes] = await Promise.all([
      supabase
        .from('reminders')
        .select(REMINDER_FIELDS)
        .order('send_at', { ascending: false })
        .limit(200)
        .returns<ReminderRow[]>(),
      // Org-wide, not location-scoped — this sizes a role-targeted
      // reminder's audience regardless of any location narrowing on it.
      supabase
        .from('profiles')
        .select('id, first_name, full_name, role')
        .eq('is_active', true)
        .not('accepted_at', 'is', null)
        .order('full_name')
        .returns<StaffLite[]>(),
      // Which locations each person is assigned to — needed to narrow a
      // role's audience down to one location when a reminder sets it.
      supabase.from('profile_locations').select('profile_id, location_id'),
    ]);

    if (remindersRes.error || staffRes.error) {
      setError('Reminders could not be loaded.');
      setLoading(false);
      return;
    }

    const rows = remindersRes.data ?? [];
    setReminders(rows);
    setStaff(staffRes.data ?? []);

    const locMap = new Map<string, Set<string>>();
    for (const row of staffLocRes.data ?? []) {
      (locMap.get(row.profile_id) ?? locMap.set(row.profile_id, new Set()).get(row.profile_id)!).add(row.location_id);
    }
    setStaffLocations(locMap);

    if (rows.length > 0) {
      const { data: ackRows } = await supabase
        .from('reminder_acknowledgements')
        .select('reminder_id, profile_id')
        .in('reminder_id', rows.map((r) => r.id));
      const map = new Map<string, Set<string>>();
      for (const row of ackRows ?? []) {
        (map.get(row.reminder_id) ?? map.set(row.reminder_id, new Set()).get(row.reminder_id)!).add(row.profile_id);
      }
      setAcks(map);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const audienceFor = useCallback(
    (reminder: ReminderRow): StaffLite[] => {
      if (reminder.target_user_id) {
        const person = staff.find((s) => s.id === reminder.target_user_id);
        return person
          ? [person]
          : [{ id: reminder.target_user_id, first_name: null, full_name: nameOf(reminder.target_profile), role: null }];
      }
      return staff.filter((s) => {
        if (s.role !== reminder.target_role) return false;
        if (!reminder.target_location_id) return true;
        return (staffLocations.get(s.id) ?? new Set()).has(reminder.target_location_id);
      });
    },
    [staff, staffLocations]
  );

  const activeFilterCount =
    (filterFrom ? 1 : 0) + (filterTo ? 1 : 0) + (filterRole !== 'all' ? 1 : 0) +
    (filterLocation !== 'all' ? 1 : 0) + (filterAck !== 'all' ? 1 : 0);

  const filteredReminders = useMemo(() => {
    return reminders.filter((reminder) => {
      const sendDate = reminder.send_at.slice(0, 10);
      if (filterFrom && sendDate < filterFrom) return false;
      if (filterTo && sendDate > filterTo) return false;
      if (filterRole !== 'all' && reminder.target_role !== filterRole) return false;
      if (filterLocation !== 'all' && reminder.target_location_id !== filterLocation) return false;
      if (filterAck !== 'all') {
        const audience = audienceFor(reminder);
        const acked = acks.get(reminder.id) ?? new Set<string>();
        const complete = audience.length > 0 && acked.size >= audience.length;
        if (filterAck === 'complete' && !complete) return false;
        if (filterAck === 'outstanding' && complete) return false;
      }
      return true;
    });
  }, [reminders, filterFrom, filterTo, filterRole, filterLocation, filterAck, audienceFor, acks]);

  // Deleting a reminder always deletes just that row (its acknowledgements
  // cascade). For a recurring instance, that alone does not stop the
  // series — deleting the template does, same relationship as a shift's
  // series_id: deleting one occurrence never touches the others. One
  // confirm resolves the scope, same shape as ManagerScheduler's shift
  // delete (OK = the wider scope, Cancel = just this one) — a non-
  // recurring reminder has no scope to choose, so it deletes immediately,
  // same as a non-recurring shift.
  const handleDelete = async (reminder: ReminderRow) => {
    setActionFault(null);
    const audience = audienceFor(reminder);
    const acked = acks.get(reminder.id) ?? new Set<string>();
    const outstanding = acked.size < audience.length;

    let stopSeries = false;
    if (reminder.template_id) {
      stopSeries = window.confirm(
        outstanding
          ? 'Stop the whole recurring series and delete this reminder? Cancel deletes just this occurrence — the series keeps going.'
          : 'Stop the whole recurring series? Cancel just clears this old occurrence from history — the series keeps going.'
      );
      if (stopSeries) {
        const { error: templateError } = await supabase
          .from('reminder_templates')
          .delete()
          .eq('id', reminder.template_id);
        if (templateError) {
          setActionFault(friendlyError(templateError, 'Could not stop the series.'));
          return;
        }
      }
    }

    const { error: deleteError } = await supabase.from('reminders').delete().eq('id', reminder.id);
    if (deleteError) {
      setActionFault(friendlyError(deleteError, 'Could not delete the reminder.'));
      return;
    }

    setNotice(
      reminder.template_id
        ? stopSeries
          ? 'Series stopped — this reminder deleted.'
          : 'This occurrence retracted — the series continues.'
        : outstanding
          ? 'Reminder retracted.'
          : 'Reminder removed from history.'
    );
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink/60">
          Send a titled message to a role or a person. Staff must acknowledge it before it clears.
        </p>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New reminder
        </button>
      </div>

      {notice && <p className="rounded-lg bg-success-bg px-3 py-2 text-sm text-success">{notice}</p>}
      {actionFault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{actionFault}</p>}

      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 shrink-0 text-ink/50" aria-hidden="true" />
          <h3 className="flex-1 text-sm font-semibold text-ink">Sent reminders</h3>
          <FilterButton activeCount={activeFilterCount}>
            <div>
              <label htmlFor="reminder-filter-from" className="block text-xs font-medium text-ink/60">From</label>
              <input
                id="reminder-filter-from"
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="reminder-filter-to" className="block text-xs font-medium text-ink/60">To</label>
              <input
                id="reminder-filter-to"
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="reminder-filter-role" className="block text-xs font-medium text-ink/60">Target role</label>
              <select
                id="reminder-filter-role"
                value={filterRole}
                onChange={(e) => setFilterRole(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
              >
                <option value="all">All roles</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.name}>{r.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reminder-filter-location" className="block text-xs font-medium text-ink/60">Location</label>
              <select
                id="reminder-filter-location"
                value={filterLocation}
                onChange={(e) => setFilterLocation(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
              >
                <option value="all">All locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reminder-filter-ack" className="block text-xs font-medium text-ink/60">Acknowledgement</label>
              <select
                id="reminder-filter-ack"
                value={filterAck}
                onChange={(e) => setFilterAck(e.target.value as AckFilter)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
              >
                <option value="all">All</option>
                <option value="complete">Fully acknowledged</option>
                <option value="outstanding">Outstanding</option>
              </select>
            </div>
          </FilterButton>
        </div>

        {loading ? (
          <div className="mt-4 flex items-center justify-center gap-2 py-6 text-sm text-ink/60">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : error ? (
          <p className="mt-4 text-sm text-danger">{error}</p>
        ) : filteredReminders.length === 0 ? (
          <p className="mt-4 text-sm text-ink/60">
            {reminders.length === 0 ? 'No reminders sent yet.' : 'Nothing matches these filters.'}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {filteredReminders.map((reminder) => {
              const audience = audienceFor(reminder);
              const acked = acks.get(reminder.id) ?? new Set<string>();
              const expanded = expandedId === reminder.id;

              return (
                <li key={reminder.id} className="py-3">
                  <div className="flex w-full items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : reminder.id)}
                      aria-expanded={expanded}
                      className="flex min-h-[44px] flex-1 items-start justify-between gap-3 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{reminder.title}</p>
                        <p className="mt-0.5 text-xs text-ink/60">
                          {reminder.target_user_id
                            ? nameOf(reminder.target_profile)
                            : `Role: ${reminder.target_role}${reminder.target_location ? ` (${reminder.target_location.name})` : ''}`}
                          {' · '}
                          {formatSendAt(reminder.send_at)}
                          {reminder.template_id && ' · recurring'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs font-medium tabular-nums text-ink/70">
                          {acked.size} of {audience.length} acknowledged
                        </span>
                        <ChevronDown
                          className={`h-4 w-4 text-ink/50 transition-transform ${expanded ? 'rotate-180' : ''}`}
                          aria-hidden="true"
                        />
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(reminder)}
                      aria-label={`Delete ${reminder.title}`}
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-ink/40 hover:bg-danger-bg hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>

                  {expanded && (
                    <ul className="mt-2 space-y-1 rounded-lg bg-bg p-2">
                      {audience.length === 0 && (
                        <li className="px-2 py-1 text-xs text-ink/50">Nobody currently matches this target.</li>
                      )}
                      {audience.map((person) => (
                        <li key={person.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                          {acked.has(person.id) ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                          ) : (
                            <Circle className="h-3.5 w-3.5 shrink-0 text-ink/30" aria-hidden="true" />
                          )}
                          <span className={acked.has(person.id) ? 'text-ink/70' : 'font-medium text-ink'}>
                            {nameOf(person)}
                          </span>
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

      {showForm && (
        <ReminderFormModal
          userId={userId}
          staff={staff}
          locations={locations}
          onClose={() => setShowForm(false)}
          onSaved={async (message) => {
            setShowForm(false);
            setNotice(message);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Shared target picker (role vs individual) — same shape as ManagerTasks'
// TargetPicker, kept local rather than imported since that one isn't
// exported and the two forms' surrounding state differs.
// ===========================================================================

function TargetPicker({
  target,
  onTargetChange,
  role,
  onRoleChange,
  roles,
  rolesLoading,
  staffId,
  onStaffChange,
  staff,
  locationId,
  onLocationChange,
  locations,
}: {
  target: Target;
  onTargetChange: (t: Target) => void;
  role: string;
  onRoleChange: (r: string) => void;
  roles: Role[];
  rolesLoading: boolean;
  staffId: string;
  onStaffChange: (id: string) => void;
  staff: StaffLite[];
  locationId: string;
  onLocationChange: (id: string) => void;
  locations: LocationLite[];
}): ReactNode {
  return (
    <div>
      <p className="block text-sm font-medium text-ink">Send to</p>
      <div className="mt-1.5 inline-flex rounded-lg border border-border p-0.5">
        <button
          type="button"
          onClick={() => onTargetChange('role')}
          aria-pressed={target === 'role'}
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            target === 'role' ? 'bg-primary text-white' : 'text-ink/70 hover:bg-bg'
          }`}
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Role
        </button>
        <button
          type="button"
          onClick={() => onTargetChange('individual')}
          aria-pressed={target === 'individual'}
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            target === 'individual' ? 'bg-primary text-white' : 'text-ink/70 hover:bg-bg'
          }`}
        >
          <User className="h-3.5 w-3.5" aria-hidden="true" />
          Individual
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {target === 'role' ? (
          <>
            <select
              aria-label="Role"
              value={role}
              onChange={(e) => onRoleChange(e.target.value)}
              disabled={rolesLoading || roles.length === 0}
              className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.name}>{r.name}</option>
              ))}
            </select>
            <select
              aria-label="Location (optional narrowing)"
              value={locationId}
              onChange={(e) => onLocationChange(e.target.value)}
              className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
            >
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name} only</option>
              ))}
            </select>
          </>
        ) : (
          <select
            aria-label="Staff member"
            value={staffId}
            onChange={(e) => onStaffChange(e.target.value)}
            disabled={staff.length === 0}
            className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name ?? s.first_name ?? 'Unnamed'}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function WeekdayPicker({ selected, onToggle }: { selected: number[]; onToggle: (value: number) => void }): ReactNode {
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((day) => (
        <button
          key={day.value}
          type="button"
          onClick={() => onToggle(day.value)}
          aria-pressed={selected.includes(day.value)}
          className={`inline-flex min-h-[38px] min-w-[44px] items-center justify-center rounded-lg border px-2 text-xs font-semibold transition ${
            selected.includes(day.value)
              ? 'border-primary bg-primary text-white'
              : 'border-border text-ink/70 hover:border-primary/40'
          }`}
        >
          {day.short}
        </button>
      ))}
    </div>
  );
}

// ===========================================================================
// Create reminder modal
// ===========================================================================

function ReminderFormModal({
  userId,
  staff,
  locations,
  onClose,
  onSaved,
}: {
  userId: string | null;
  staff: StaffLite[];
  locations: LocationLite[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}): ReactNode {
  const { roles, loading: rolesLoading } = useRoles();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [target, setTarget] = useState<Target>('role');
  const [role, setRole] = useState('');
  const [staffId, setStaffId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('09:00');
  const [recurrence, setRecurrence] = useState<Recurrence>('daily');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  useEffect(() => {
    if (roles.length > 0 && !role) setRole(roles[0].name);
  }, [roles, role]);

  useEffect(() => {
    if (staff.length > 0 && !staffId) setStaffId(staff[0].id);
  }, [staff, staffId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => resetDocumentScroll, []);

  const toggleWeekday = (value: number) =>
    setWeekdays((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));

  const handleSave = async () => {
    setFault(null);

    if (!title.trim()) return setFault('Enter a title.');
    if (target === 'role' && !role) return setFault('Choose a role.');
    if (target === 'individual' && !staffId) return setFault('Choose a staff member.');
    if (!recurring && !date) return setFault('Pick a date.');
    if (recurring && recurrence === 'weekly' && weekdays.length === 0) return setFault('Pick at least one day.');
    if (!userId) return setFault('Your session has expired. Sign in again.');

    // Location narrowing only applies to a role target — an individual is
    // already one specific person, so it's silently ignored rather than
    // stored, regardless of whatever the picker last showed.
    const resolvedLocationId = target === 'role' && locationId ? locationId : null;

    setSaving(true);

    if (recurring) {
      const { error } = await supabase.from('reminder_templates').insert({
        title: title.trim(),
        body: body.trim() || null,
        target_role: target === 'role' ? role : null,
        target_user_id: target === 'individual' ? staffId : null,
        target_location_id: resolvedLocationId,
        recurrence,
        weekdays: recurrence === 'weekly' ? [...weekdays].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
        send_at: time,
        is_active: true,
        created_by: userId,
      });
      setSaving(false);
      if (error) return setFault(friendlyError(error, 'Could not save the reminder.'));
      await onSaved('Recurring reminder created — it will go out on its next scheduled day.');
      return;
    }

    const { error } = await supabase.from('reminders').insert({
      title: title.trim(),
      body: body.trim() || null,
      target_role: target === 'role' ? role : null,
      target_user_id: target === 'individual' ? staffId : null,
      target_location_id: resolvedLocationId,
      send_at: toLocalIso(date, time),
      template_id: null,
      created_by: userId,
    });
    setSaving(false);
    if (error) return setFault(friendlyError(error, 'Could not save the reminder.'));
    await onSaved('Reminder sent.');
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-modal-title"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="reminder-modal-title" className="text-base font-semibold text-ink">New reminder</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div>
            <label htmlFor="reminder-title" className="block text-sm font-medium text-ink">Title</label>
            <input
              id="reminder-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div>
            <label htmlFor="reminder-body" className="block text-sm font-medium text-ink">
              Description <span className="font-normal text-ink/50">(optional)</span>
            </label>
            <textarea
              id="reminder-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
              {[
                { value: false, label: 'One-off', Icon: Calendar },
                { value: true, label: 'Recurring', Icon: Repeat },
              ].map(({ value, label, Icon }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setRecurring(value)}
                  aria-pressed={recurring === value}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition ${
                    recurring === value ? 'bg-surface text-ink shadow-sm' : 'text-ink/60'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <TargetPicker
            target={target}
            onTargetChange={setTarget}
            role={role}
            onRoleChange={setRole}
            roles={roles}
            rolesLoading={rolesLoading}
            staffId={staffId}
            onStaffChange={setStaffId}
            staff={staff}
            locationId={locationId}
            onLocationChange={setLocationId}
            locations={locations}
          />

          {!recurring && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="reminder-date" className="block text-sm font-medium text-ink">Date</label>
                <input
                  id="reminder-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
              </div>
              <div>
                <label htmlFor="reminder-time" className="block text-sm font-medium text-ink">Time</label>
                <input
                  id="reminder-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
              </div>
            </div>
          )}

          {recurring && (
            <>
              <div>
                <label htmlFor="reminder-recurrence" className="block text-sm font-medium text-ink">Repeats</label>
                <select
                  id="reminder-recurrence"
                  value={recurrence}
                  onChange={(e) => setRecurrence(e.target.value as Recurrence)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>

              {recurrence === 'weekly' && (
                <div>
                  <p className="block text-sm font-medium text-ink">On these days</p>
                  <div className="mt-1.5">
                    <WeekdayPicker selected={weekdays} onToggle={toggleWeekday} />
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="reminder-time-recurring" className="block text-sm font-medium text-ink">Time</label>
                <input
                  id="reminder-time-recurring"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
              </div>
            </>
          )}

          {fault && (
            <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <p className="text-danger">{fault}</p>
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
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            {recurring ? 'Save recurring reminder' : 'Send reminder'}
          </button>
        </div>
      </div>
    </div>
  );
}
