import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Download, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles } from '../hooks/useRoles';
import { useManagedLocations } from '../hooks/useManagedLocations';

interface TimeLogRow {
  id: string;
  clock_in: string;
  clock_out: string | null;
  location_id: string | null;
  profiles: { full_name: string | null; first_name: string | null; role: string | null } | null;
  locations: { name: string } | null;
}

interface ReportRow {
  location: string;
  role: string;
  name: string;
  hours: number;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Built from calendar fields, like every other date range in this app —
// never a raw ms offset, which would drift across a DST boundary.
function localDayStartIso(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function localDayEndExclusiveIso(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString();
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export default function PayrollReportModal({
  locations,
  onClose,
}: {
  locations: Array<{ id: string; name: string }>;
  onClose: () => void;
}): ReactNode {
  const { roles, loading: rolesLoading } = useRoles();
  const { locationIds: managedLocationIds } = useManagedLocations();
  const managedLocationSet = useMemo(() => new Set(managedLocationIds), [managedLocationIds]);
  // Never offer a location the database would reject the viewer for
  // choosing. An Administrator manages every org location, so this is a
  // no-op for them.
  const visibleLocations = useMemo(
    () => locations.filter((l) => managedLocationSet.has(l.id)),
    [locations, managedLocationSet]
  );

  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return localDateKey(d);
  });
  const [endDate, setEndDate] = useState(() => localDateKey(new Date()));
  const [selectedLocations, setSelectedLocations] = useState<Set<string>>(new Set());
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [excludedCount, setExcludedCount] = useState(0);

  // Both multi-selects default to everything, once their options load.
  useEffect(() => {
    setSelectedLocations(new Set(visibleLocations.map((l) => l.id)));
  }, [visibleLocations]);
  useEffect(() => {
    setSelectedRoles(new Set(roles.map((r) => r.name)));
  }, [roles]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleLocation = (id: string) => {
    setSelectedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRole = (name: string) => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const generate = async () => {
    if (!startDate || !endDate) {
      setFault('Choose a start and end date.');
      return;
    }
    if (endDate < startDate) {
      setFault('End date must be on or after the start date.');
      return;
    }

    setLoading(true);
    setFault(null);
    setRows(null);

    const { data, error } = await supabase
      .from('time_logs')
      .select(
        'id, clock_in, clock_out, location_id, profiles:user_id ( full_name, first_name, role ), locations:location_id ( name )'
      )
      .gte('clock_in', localDayStartIso(startDate))
      .lt('clock_in', localDayEndExclusiveIso(endDate))
      .order('clock_in')
      .returns<TimeLogRow[]>();

    setLoading(false);

    if (error) {
      setFault('Could not load timesheet data. Try again.');
      return;
    }

    const logs = data ?? [];

    // An open shift has no final duration and would understate or inflate
    // the total, so it's excluded — but silently dropping hours before
    // payroll is worse than the gap, hence the count surfaced below.
    const withClockOut = logs.filter((log) => log.clock_out !== null);
    setExcludedCount(logs.length - withClockOut.length);

    const scoped = withClockOut.filter((log) => {
      if (log.location_id && !selectedLocations.has(log.location_id)) return false;
      const role = log.profiles?.role;
      if (role && !selectedRoles.has(role)) return false;
      return true;
    });

    const grouped = new Map<string, ReportRow>();
    for (const log of scoped) {
      const location = log.locations?.name ?? 'No location';
      const role = log.profiles?.role ?? 'No role';
      const name = log.profiles?.full_name ?? log.profiles?.first_name ?? 'Unknown';
      const key = `${location}|${role}|${name}`;
      const hours = (new Date(log.clock_out as string).getTime() - new Date(log.clock_in).getTime()) / 3_600_000;

      const existing = grouped.get(key);
      if (existing) existing.hours += hours;
      else grouped.set(key, { location, role, name, hours });
    }

    setRows(
      Array.from(grouped.values()).sort(
        (a, b) =>
          a.location.localeCompare(b.location) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name)
      )
    );
  };

  const total = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.hours, 0), [rows]);

  const downloadCsv = () => {
    if (!rows) return;

    const lines: string[] = [
      `${startDate},${endDate}`,
      '',
      'Location,Role,Name,Hours',
      ...rows.map((row) =>
        [csvField(row.location), csvField(row.role), csvField(row.name), row.hours.toFixed(2)].join(',')
      ),
      ['Total', '', '', total.toFixed(2)].join(','),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `shifttrack-hours-${startDate}-to-${endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payroll-report-title"
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="payroll-report-title" className="text-base font-semibold text-ink">
            Payroll hours report
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="report-start" className="block text-sm font-medium text-ink">
                Start date
              </label>
              <input
                id="report-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
            <div>
              <label htmlFor="report-end" className="block text-sm font-medium text-ink">
                End date
              </label>
              <input
                id="report-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-ink">Locations</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {visibleLocations.map((loc) => {
                const on = selectedLocations.has(loc.id);
                return (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => toggleLocation(loc.id)}
                    aria-pressed={on}
                    className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      on ? 'border-primary bg-primary text-white' : 'border-border text-ink hover:border-primary/40'
                    }`}
                  >
                    {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                    {loc.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-ink">Roles</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {roles.map((r) => {
                const on = selectedRoles.has(r.name);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggleRole(r.name)}
                    aria-pressed={on}
                    className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      on ? 'border-primary bg-primary text-white' : 'border-border text-ink hover:border-primary/40'
                    }`}
                  >
                    {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="flex gap-2 rounded-lg bg-bg px-3 py-2 text-xs text-ink/60">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            The role shown for each person is their CURRENT role, not the role they held during this
            period — that matters if someone changed position mid-period.
          </p>

          {fault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

          <button
            type="button"
            onClick={() => void generate()}
            disabled={loading || rolesLoading}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            )}
            Generate
          </button>

          {rows && excludedCount > 0 && (
            <p className="flex gap-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {excludedCount} {excludedCount === 1 ? 'entry is' : 'entries are'} still clocked in and
              excluded from these totals. Check {excludedCount === 1 ? 'it' : 'them'} before running payroll.
            </p>
          )}

          {rows &&
            (rows.length === 0 ? (
              <p className="text-sm text-ink/60">No completed time logs in this range for the selected filters.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg text-left text-xs font-semibold text-ink/50">
                      <th className="px-3 py-2">Location</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2 text-right">Hours</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                      <tr key={`${row.location}-${row.role}-${row.name}`}>
                        <td className="px-3 py-2 text-ink/80">{row.location}</td>
                        <td className="px-3 py-2 text-ink/80">{row.role}</td>
                        <td className="px-3 py-2 text-ink">{row.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-ink">
                          {row.hours.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border font-semibold">
                      <td className="px-3 py-2 text-ink" colSpan={3}>
                        Total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink">{total.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))}
        </div>

        {rows && rows.length > 0 && (
          <div className="flex justify-end border-t border-border px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={downloadCsv}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download CSV
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
