import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Plus,
  Repeat,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';

const PRESET_TIMES = [
  { start: '17:00', end: '22:00' },
  { start: '17:00', end: '21:00' },
  { start: '17:30', end: '21:30' },
  { start: '18:00', end: '22:00' },
];

const WEEKDAYS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
];

// A year of daily shifts is already far beyond any sane rota. The cap exists so
// a mis-set end date cannot insert thousands of rows in one click.
const MAX_OCCURRENCES = 366;

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function startOfWeek(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Builds a UTC instant from a local calendar date plus a local wall-clock time.
 * dayOffset shifts the calendar date, which is how an overnight end time lands
 * on the following day. Each occurrence is constructed from calendar fields, so
 * a 17:00 shift stays 17:00 across a daylight-saving boundary.
 */
function toUtcIso(key, hhmm, dayOffset = 0) {
  const [year, month, day] = key.split('-').map(Number);
  const [hours, minutes] = hhmm.split(':').map(Number);
  return new Date(year, month - 1, day + dayOffset, hours, minutes, 0, 0).toISOString();
}

function localHhmm(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatRange(from, to) {
  const options = { month: 'short', day: 'numeric' };
  return `${from.toLocaleDateString([], options)} – ${to.toLocaleDateString([], options)}`;
}

function formatLongDate(key) {
  return new Date(`${key}T12:00:00`).toLocaleDateString([], {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function roleDotClass(role) {
  return role === 'Driver' ? 'bg-secondary' : 'bg-primary';
}

/** True when the end time is at or before the start, meaning it runs past midnight. */
function isOvernight(start, end) {
  return end <= start;
}

// --- occurrence generation (DST-safe) ---------------------------------------

function buildOccurrences({ anchorKey, weekdays, recurring, repeatUntil }) {
  if (!recurring) return [anchorKey];

  // Without an end date there is no stopping condition. Returning nothing keeps
  // the save button disabled until the manager picks one.
  if (!repeatUntil || weekdays.length === 0) return [];

  const [year, month, day] = anchorKey.split('-').map(Number);
  const anchor = new Date(year, month - 1, day);
  const until = new Date(`${repeatUntil}T23:59:59`);
  if (until < anchor) return [];

  const firstWeek = startOfWeek(anchor);
  const keys = [];

  for (let week = 0; ; week += 1) {
    const weekStart = addDays(firstWeek, week * 7);
    if (weekStart > until) break;

    for (const weekday of weekdays) {
      const offset = (weekday + 6) % 7;
      const occurrence = addDays(weekStart, offset);
      if (occurrence < anchor) continue;
      if (occurrence > until) continue;
      keys.push(dateKey(occurrence));
    }

    if (keys.length > MAX_OCCURRENCES) break;
  }

  return keys.sort();
}

// ============================================================================

export default function ManagerScheduler() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [locations, setLocations] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [locationFilter, setLocationFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSeed, setModalSeed] = useState(null);
  const [notice, setNotice] = useState(null);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart]
  );

  const loadShifts = useCallback(async () => {
    const rangeStart = new Date(weekStart);
    const rangeEnd = addDays(weekStart, 7);

    let query = supabase
      .from('shifts')
      .select(
        'id, title, start_time, end_time, location_id, assigned_user_id, is_recurring, series_id, profiles:assigned_user_id ( id, first_name, full_name, role )'
      )
      .gte('start_time', rangeStart.toISOString())
      .lt('start_time', rangeEnd.toISOString())
      .order('start_time');

    if (locationFilter !== 'all') query = query.eq('location_id', locationFilter);

    const { data } = await query;
    setShifts(data ?? []);
  }, [weekStart, locationFilter]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      const locationResult = await supabase
        .from('locations')
        .select('id, name')
        .eq('is_active', true)
        .order('name');

      if (cancelled) return;
      setLocations(locationResult.data ?? []);
      await loadShifts();
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadShifts]);

  const shiftsByDay = useMemo(() => {
    const map = {};
    for (const shift of shifts) {
      const key = dateKey(new Date(shift.start_time));
      (map[key] ??= []).push(shift);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    }
    return map;
  }, [shifts]);

  const handleDelete = useCallback(
    async (shift) => {
      const scope =
        shift.series_id &&
        window.confirm('Delete every future shift in this series? Cancel deletes just this one.')
          ? 'series'
          : 'one';

      if (scope === 'series') {
        await supabase
          .from('shifts')
          .delete()
          .eq('series_id', shift.series_id)
          .gte('start_time', new Date().toISOString());
      } else {
        await supabase.from('shifts').delete().eq('id', shift.id);
      }
      await loadShifts();
    },
    [loadShifts]
  );

  const openModal = (seed) => {
    setModalSeed(seed);
    setModalOpen(true);
  };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-surface">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center rounded-lg border border-border bg-surface">
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            aria-label="Previous week"
            className="min-h-[44px] p-2 text-ink/60 hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="border-x border-border px-3 py-1.5 text-sm font-medium tabular-nums text-ink">
            {formatRange(weekStart, addDays(weekStart, 6))}
          </span>
          <button
            type="button"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            aria-label="Next week"
            className="min-h-[44px] p-2 text-ink/60 hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setWeekStart(startOfWeek(new Date()))}
          className="min-h-[44px] rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink/80 hover:bg-bg"
        >
          This week
        </button>

        <div className="relative">
          <select
            value={locationFilter}
            onChange={(event) => setLocationFilter(event.target.value)}
            aria-label="Filter schedule by location"
            className="min-h-[44px] appearance-none rounded-lg border border-border bg-surface py-2 pl-9 pr-9 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <option value="all">All locations</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          <MapPin
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
            aria-hidden="true"
          />
        </div>

        <button
          type="button"
          onClick={() => openModal(null)}
          className="ml-auto inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add shift
        </button>
      </div>

      {notice && (
        <div className="flex items-center gap-2 border-b border-border bg-bg px-4 py-2 text-xs text-ink">
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="rounded p-1 hover:bg-surface"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Day-by-day schedule */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink/60">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading schedule…
          </div>
        ) : (
          <div className="space-y-3">
            {weekDays.map((day) => {
              const key = dateKey(day);
              const dayShifts = shiftsByDay[key] ?? [];
              const isToday = key === dateKey(new Date());

              return (
                <div
                  key={key}
                  className={`rounded-xl border ${
                    isToday ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface'
                  }`}
                >
                  <div
                    className={`flex items-center justify-between border-b px-4 py-2.5 ${
                      isToday ? 'border-primary/20' : 'border-border'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${isToday ? 'text-primary' : 'text-ink'}`}>
                        {day.toLocaleDateString([], { weekday: 'long' })}
                      </span>
                      <span className="text-xs tabular-nums text-ink/60">
                        {day.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openModal({ dateKey: key })}
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
                      aria-label={`Add shift on ${day.toLocaleDateString()}`}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>

                  {dayShifts.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-ink/50">No shifts scheduled.</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {dayShifts.map((shift) => (
                        <li key={shift.id} className="flex items-center gap-3 px-4 py-2.5">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${roleDotClass(shift.profiles?.role)}`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink">
                              {shift.profiles?.full_name ?? shift.profiles?.first_name ?? 'Unassigned'}
                            </p>
                            <p className="text-xs text-ink/60">{shift.profiles?.role ?? '—'}</p>
                          </div>
                          <span className="shrink-0 text-xs tabular-nums text-ink/80">
                            {localHhmm(shift.start_time)} – {localHhmm(shift.end_time)}
                          </span>
                          {shift.is_recurring && (
                            <Repeat className="h-3.5 w-3.5 shrink-0 text-ink/40" aria-label="Recurring" />
                          )}
                          <button
                            type="button"
                            onClick={() => handleDelete(shift)}
                            aria-label={`Delete ${shift.profiles?.first_name ?? 'shift'}`}
                            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded p-1.5 text-ink/40 hover:bg-danger-bg hover:text-danger"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modalOpen && (
        <ShiftModal
          seed={modalSeed}
          locations={locations}
          onClose={() => setModalOpen(false)}
          onSaved={async ({ inserted, skipped }) => {
            setModalOpen(false);
            setNotice(
              skipped > 0
                ? `${inserted} shift${inserted === 1 ? '' : 's'} created. ${skipped} skipped — already booked at an overlapping time.`
                : `${inserted} shift${inserted === 1 ? '' : 's'} created.`
            );
            await loadShifts();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================

function ShiftModal({ seed, locations, onClose, onSaved }) {
  const [staffId, setStaffId] = useState('');
  const [staffQuery, setStaffQuery] = useState('');
  const [staff, setStaff] = useState([]);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [startTime, setStartTime] = useState('17:00');
  const [endTime, setEndTime] = useState('22:00');
  const [useCustomTime, setUseCustomTime] = useState(false);
  const [startDate, setStartDate] = useState(seed?.dateKey ?? dateKey(new Date()));
  const [recurring, setRecurring] = useState(false);
  const [weekdays, setWeekdays] = useState([]);
  const [repeatUntil, setRepeatUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState(null);
  const [unavailWarn, setUnavailWarn] = useState(null);

  const dialogRef = useRef(null);
  const weekdaysSeeded = useRef(false);

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    dialogRef.current?.querySelector('input')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Seed the repeat days from the start date once. Guarding on weekdays.length
  // instead would re-add the day every time the manager clears the last one.
  useEffect(() => {
    if (!recurring || weekdaysSeeded.current) return;
    weekdaysSeeded.current = true;
    const [year, month, day] = startDate.split('-').map(Number);
    setWeekdays([new Date(year, month - 1, day).getDay()]);
  }, [recurring, startDate]);

  // Staff for the selected location, via the profile_locations join.
  useEffect(() => {
    if (!locationId) {
      setStaff([]);
      return undefined;
    }
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from('profile_locations')
        .select('profile_id, profiles ( id, first_name, full_name, role, is_active )')
        .eq('location_id', locationId);

      if (cancelled) return;
      setStaff(
        (data ?? [])
          .map((row) => row.profiles)
          .filter((p) => p && p.is_active !== false)
          .sort((a, b) =>
            (a.full_name ?? a.first_name ?? '').localeCompare(b.full_name ?? b.first_name ?? '')
          )
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const filteredStaff = useMemo(() => {
    const needle = staffQuery.trim().toLowerCase();
    if (!needle) return staff;
    return staff.filter((person) =>
      `${person.full_name ?? ''} ${person.first_name ?? ''}`.toLowerCase().includes(needle)
    );
  }, [staff, staffQuery]);

  const occurrences = useMemo(
    () => buildOccurrences({ anchorKey: startDate, weekdays, recurring, repeatUntil }),
    [startDate, weekdays, recurring, repeatUntil]
  );

  const overnight = isOvernight(startTime, endTime);
  const overCap = occurrences.length > MAX_OCCURRENCES;
  const canSave =
    Boolean(staffId) && Boolean(locationId) && occurrences.length > 0 && !overCap && !saving;

  const toggleWeekday = (value) =>
    setWeekdays((prev) =>
      prev.includes(value) ? prev.filter((day) => day !== value) : [...prev, value]
    );

  // Warn — never block — when shifts land on approved unavailability.
  useEffect(() => {
    if (!staffId || occurrences.length === 0) {
      setUnavailWarn(null);
      return undefined;
    }
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from('unavailability_requests')
        .select('start_date, end_date')
        .eq('user_id', staffId)
        .eq('status', 'approved')
        .gte('end_date', occurrences[0])
        .lte('start_date', occurrences[occurrences.length - 1]);

      if (cancelled) return;

      const clashes = occurrences.filter((key) =>
        (data ?? []).some((request) => key >= request.start_date && key <= request.end_date)
      );

      setUnavailWarn(
        clashes.length > 0
          ? `${clashes.length} shift${clashes.length === 1 ? '' : 's'} fall on dates with an approved unavailability request.`
          : null
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [staffId, occurrences]);

  const handleSave = async () => {
    if (!staffId || !locationId || occurrences.length === 0) {
      setFault('Pick a location, a staff member, and at least one date.');
      return;
    }
    if (overCap) {
      setFault(`That would create ${occurrences.length} shifts. Bring the end date closer.`);
      return;
    }
    if (startTime === endTime) {
      setFault('Start and end times cannot be the same.');
      return;
    }

    setSaving(true);
    setFault(null);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // is_recurring and series_id must be set together — the
      // shifts_series_consistency CHECK rejects a row with one but not the other.
      const seriesId = recurring ? crypto.randomUUID() : null;
      const location = locations.find((entry) => entry.id === locationId);
      const endDayOffset = overnight ? 1 : 0;

      const rows = occurrences.map((key) => ({
        title: `${startTime}–${endTime} · ${location?.name ?? 'Site'}`,
        start_time: toUtcIso(key, startTime),
        end_time: toUtcIso(key, endTime, endDayOffset),
        location_id: locationId,
        assigned_user_id: staffId,
        is_recurring: recurring,
        series_id: seriesId,
        created_by: user?.id ?? null,
      }));

      // Skip anything that overlaps an existing booking, not just an exact
      // start-time match — 17:00-22:00 and 17:30-21:30 are both double bookings.
      const rangeStart = rows[0].start_time;
      const rangeEnd = rows[rows.length - 1].end_time;

      const { data: existing } = await supabase
        .from('shifts')
        .select('start_time, end_time')
        .eq('assigned_user_id', staffId)
        .lt('start_time', rangeEnd)
        .gt('end_time', rangeStart);

      const booked = (existing ?? []).map((row) => [
        new Date(row.start_time).getTime(),
        new Date(row.end_time).getTime(),
      ]);

      const fresh = rows.filter((row) => {
        const from = new Date(row.start_time).getTime();
        const to = new Date(row.end_time).getTime();
        return !booked.some(([bookedFrom, bookedTo]) => from < bookedTo && to > bookedFrom);
      });

      if (fresh.length === 0) {
        setFault('This person is already booked for every one of those times.');
        return;
      }

      const { error } = await supabase.from('shifts').insert(fresh);
      if (error) throw error;

      await onSaved({ inserted: fresh.length, skipped: rows.length - fresh.length });
    } catch (error) {
      setFault(error?.message ?? 'The shifts could not be saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const lastOccurrence = occurrences.at(-1);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shift-modal-title"
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="shift-modal-title" className="text-base font-semibold text-ink">
            Add shift
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {/* Location — chosen first, because it determines who can be scheduled */}
          <div>
            <label htmlFor="shift-location" className="block text-sm font-medium text-ink">
              Location
            </label>
            <select
              id="shift-location"
              value={locationId}
              onChange={(event) => {
                setLocationId(event.target.value);
                setStaffId('');
              }}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>

          {/* Staff picker */}
          <div>
            <label htmlFor="staff-search" className="block text-sm font-medium text-ink">
              Staff member
            </label>
            <div className="relative mt-1.5">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
                aria-hidden="true"
              />
              <input
                id="staff-search"
                type="text"
                value={staffQuery}
                onChange={(event) => setStaffQuery(event.target.value)}
                placeholder="Search by name"
                className="min-h-[44px] w-full rounded-lg border border-border py-2 pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
            <div
              role="listbox"
              aria-label="Staff members"
              className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-border"
            >
              {filteredStaff.length === 0 && (
                <p className="px-3 py-4 text-center text-sm text-ink/60">
                  {locationId
                    ? 'Nobody at this location matches that name.'
                    : 'Select a location first.'}
                </p>
              )}
              {filteredStaff.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  role="option"
                  aria-selected={staffId === person.id}
                  onClick={() => setStaffId(person.id)}
                  className={`flex min-h-[44px] w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm ${
                    staffId === person.id ? 'bg-primary text-white' : 'text-ink hover:bg-bg'
                  }`}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${roleDotClass(person.role)}`}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate">{person.full_name ?? person.first_name}</span>
                  <span className={`text-xs ${staffId === person.id ? 'text-white/70' : 'text-ink/50'}`}>
                    {person.role}
                  </span>
                  {staffId === person.id && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>

          {/* Times */}
          <fieldset>
            <legend className="text-sm font-medium text-ink">Times</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PRESET_TIMES.map((preset) => {
                const selected =
                  !useCustomTime && startTime === preset.start && endTime === preset.end;
                return (
                  <button
                    key={`${preset.start}-${preset.end}`}
                    type="button"
                    onClick={() => {
                      setUseCustomTime(false);
                      setStartTime(preset.start);
                      setEndTime(preset.end);
                    }}
                    aria-pressed={selected}
                    className={`min-h-[44px] rounded-lg border px-2 py-2.5 text-center text-xs font-semibold tabular-nums transition ${
                      selected
                        ? 'border-primary bg-primary text-white'
                        : 'border-border text-ink hover:border-primary/40'
                    }`}
                  >
                    {preset.start}–{preset.end}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setUseCustomTime(true)}
                aria-pressed={useCustomTime}
                className={`min-h-[44px] rounded-lg border px-2 py-2.5 text-center text-xs font-semibold transition ${
                  useCustomTime
                    ? 'border-primary bg-primary text-white'
                    : 'border-border text-ink hover:border-primary/40'
                }`}
              >
                Custom
              </button>
            </div>

            {useCustomTime && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="custom-start" className="block text-xs font-medium text-ink/60">
                    Start
                  </label>
                  <input
                    id="custom-start"
                    type="time"
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
                <div>
                  <label htmlFor="custom-end" className="block text-xs font-medium text-ink/60">
                    End
                  </label>
                  <input
                    id="custom-end"
                    type="time"
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
              </div>
            )}

            {overnight && startTime !== endTime && (
              <p className="mt-2 text-xs text-ink/60">Ends at {endTime} the following morning.</p>
            )}
          </fieldset>

          {/* Start date */}
          <div>
            <label htmlFor="shift-date" className="block text-sm font-medium text-ink">
              {recurring ? 'First shift' : 'Date'}
            </label>
            <input
              id="shift-date"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          {/* Single vs recurring */}
          <div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
              {[
                { value: false, label: 'Single shift', Icon: CalendarDays },
                { value: true, label: 'Repeats weekly', Icon: Repeat },
              ].map(({ value, label, Icon }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setRecurring(value)}
                  aria-pressed={recurring === value}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-md py-2 text-sm font-medium transition ${
                    recurring === value ? 'bg-surface text-ink shadow-sm' : 'text-ink/60'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>

            {recurring && (
              <div className="mt-3 rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-ink">Repeat on</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleWeekday(day.value)}
                      aria-pressed={weekdays.includes(day.value)}
                      className={`h-11 w-12 rounded-lg border text-xs font-semibold transition ${
                        weekdays.includes(day.value)
                          ? 'border-primary bg-primary text-white'
                          : 'border-border text-ink/70 hover:border-primary/40'
                      }`}
                    >
                      {day.short}
                    </button>
                  ))}
                </div>

                <div className="mt-3">
                  <label htmlFor="repeat-until" className="block text-xs font-medium text-ink/60">
                    Repeat until
                  </label>
                  <input
                    id="repeat-until"
                    type="date"
                    value={repeatUntil}
                    min={startDate}
                    onChange={(event) => setRepeatUntil(event.target.value)}
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>

                <p className="mt-2 text-xs text-ink/60">
                  {!repeatUntil
                    ? 'Pick an end date to see how many shifts this creates.'
                    : weekdays.length === 0
                      ? 'Select at least one day of the week.'
                      : occurrences.length === 0
                        ? 'That end date is before the first shift.'
                        : `${occurrences.length} shifts, through ${formatLongDate(lastOccurrence)}.`}
                </p>
              </div>
            )}
          </div>

          {overCap && (
            <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <p className="text-danger">
                That would create {occurrences.length} shifts, over the {MAX_OCCURRENCES} limit. Bring
                the end date closer.
              </p>
            </div>
          )}

          {unavailWarn && (
            <div className="flex gap-2 rounded-lg bg-warning-bg p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <p className="text-warning">{unavailWarn}</p>
            </div>
          )}

          {fault && (
            <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <p className="text-danger">{fault}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-5 py-4">
          <p className="flex-1 text-sm text-ink/60">
            <span className="font-semibold tabular-nums text-ink">{occurrences.length}</span> shift
            {occurrences.length === 1 ? '' : 's'}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Save shifts
          </button>
        </div>
      </div>
    </div>
  );
}
