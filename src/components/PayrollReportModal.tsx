import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Download, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles } from '../hooks/useRoles';
import { useManagedLocations } from '../hooks/useManagedLocations';
import { usePermissions } from '../hooks/usePermissions';
import { useOrderRate } from '../hooks/useOrderRate';
import { orgTracksOrders, tracksOrdersRoleNames } from '../lib/tracksOrders';
import {
  WAGE_RATE_FIELDS,
  formatCurrencyAmount,
  groupWageRatesByProfile,
  localDateKeyFromIso,
  rateOnDate,
  type WageRateRow,
} from '../lib/wageRates';

interface TimeLogRow {
  id: string;
  user_id: string;
  clock_in: string;
  clock_out: string | null;
  location_id: string | null;
  role_at_clock_in: string | null;
  orders_count: number | null;
  profiles: { full_name: string | null; first_name: string | null; role: string | null } | null;
  locations: { name: string } | null;
}

interface ReportRow {
  location: string;
  role: string;
  name: string;
  userId: string;
  hours: number;
  orders: number;
  // Sum of hours × the rate effective on each log's date. Stays 0 when the
  // viewer isn't an Administrator, or no rate is on file for a date — see
  // the same "missing rate contributes 0" choice in ManagerDashboard's
  // TimesheetsPanel.
  cost: number;
  // cost + (orders × the org's order rate, captured at generation time —
  // see reportOrderRate). Stays 0 for anyone but an Administrator.
  total: number;
}

// A person's totals across every row for the whole selected period — not
// just one location/role combination. Keyed by profile id (userId), not
// display name, since two people can share a name.
interface PersonTotal {
  userId: string;
  name: string;
  hours: number;
  orders: number;
  cost: number;
  total: number;
}

type ColumnKey = 'location' | 'role' | 'name' | 'hours' | 'orders' | 'cost' | 'total';

const COLUMN_LABELS: Record<ColumnKey, string> = {
  location: 'Location',
  role: 'Role',
  name: 'Name',
  hours: 'Hours',
  orders: 'Orders',
  cost: 'Cost',
  total: 'Total',
};

// Columns that make sense on a per-person summary — Location and Role don't,
// since one person's total spans every location/role they worked in the
// period.
const PERSON_COLUMNS: ColumnKey[] = ['name', 'hours', 'orders', 'cost', 'total'];

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
  const trackedRoleNames = useMemo(() => tracksOrdersRoleNames(roles), [roles]);
  const showOrdersColumns = orgTracksOrders(roles);
  const { isAdmin } = usePermissions();
  const { orderRate } = useOrderRate();
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
  const [personTotals, setPersonTotals] = useState<PersonTotal[] | null>(null);
  // The order rate as it stood when this report was generated, so the
  // figures stay correct even if the setting changes later — and so it can
  // be printed into the report header/CSV, months later, self-explanatory.
  const [reportOrderRate, setReportOrderRate] = useState<number | null>(null);
  const [excludedCount, setExcludedCount] = useState(0);

  // Which columns are available at all depends on the org (orders) and the
  // viewer (cost/total, Administrator only) — neither is ever even offered
  // as an option to anyone else.
  const availableColumns = useMemo<ColumnKey[]>(() => {
    const cols: ColumnKey[] = ['location', 'role', 'name', 'hours'];
    if (showOrdersColumns) cols.push('orders');
    if (isAdmin) cols.push('cost', 'total');
    return cols;
  }, [showOrdersColumns, isAdmin]);
  const [selectedColumns, setSelectedColumns] = useState<Set<ColumnKey>>(new Set());

  // Every multi-select defaults to everything available, once its options load.
  useEffect(() => {
    setSelectedLocations(new Set(visibleLocations.map((l) => l.id)));
  }, [visibleLocations]);
  useEffect(() => {
    setSelectedRoles(new Set(roles.map((r) => r.name)));
  }, [roles]);
  useEffect(() => {
    setSelectedColumns(new Set(availableColumns));
  }, [availableColumns]);

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

  const toggleColumn = (col: ColumnKey) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
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
    setPersonTotals(null);
    setReportOrderRate(null);

    // Rates are only ever fetched for an Administrator — staff_wage_rates
    // RLS would return nothing to anyone else, but this skips the request
    // entirely rather than firing it and discarding an empty result.
    const [{ data, error }, ratesResult] = await Promise.all([
      supabase
        .from('time_logs')
        .select(
          'id, user_id, clock_in, clock_out, location_id, role_at_clock_in, orders_count, profiles:user_id ( full_name, first_name, role ), locations:location_id ( name )'
        )
        .gte('clock_in', localDayStartIso(startDate))
        .lt('clock_in', localDayEndExclusiveIso(endDate))
        .order('clock_in')
        .returns<TimeLogRow[]>(),
      isAdmin
        ? supabase.from('staff_wage_rates').select(WAGE_RATE_FIELDS).returns<WageRateRow[]>()
        : Promise.resolve({ data: [] as WageRateRow[], error: null }),
    ]);

    setLoading(false);

    if (error) {
      setFault('Could not load timesheet data. Try again.');
      return;
    }

    const logs = data ?? [];
    const ratesByProfile = groupWageRatesByProfile(ratesResult.data ?? []);
    // Snapshot the org's order rate at generation time — a later change to
    // the setting must not silently rewrite an already-generated report.
    const currentOrderRate = isAdmin ? orderRate : 0;

    // An open shift has no final duration and would understate or inflate
    // the total, so it's excluded — but silently dropping hours before
    // payroll is worse than the gap, hence the count surfaced below.
    const withClockOut = logs.filter((log) => log.clock_out !== null);
    setExcludedCount(logs.length - withClockOut.length);

    // The role a person held at clock-in, not their current one — a
    // promotion since must not rewrite which role earned these hours.
    // Only falls back to the current role for a log that predates this
    // column ever being set.
    const roleFor = (log: TimeLogRow) => log.role_at_clock_in ?? log.profiles?.role ?? null;

    const scoped = withClockOut.filter((log) => {
      if (log.location_id && !selectedLocations.has(log.location_id)) return false;
      const role = roleFor(log);
      if (role && !selectedRoles.has(role)) return false;
      return true;
    });

    const grouped = new Map<string, ReportRow>();
    const personTotalsMap = new Map<string, PersonTotal>();

    for (const log of scoped) {
      const location = log.locations?.name ?? 'No location';
      const role = roleFor(log) ?? 'No role';
      const name = log.profiles?.full_name ?? log.profiles?.first_name ?? 'Unknown';
      const key = `${location}|${role}|${name}`;
      const hours = (new Date(log.clock_out as string).getTime() - new Date(log.clock_in).getTime()) / 3_600_000;
      // Null (still owed, or a role that never tracked orders) contributes
      // nothing to the total rather than being treated as a hard zero.
      const orders = log.orders_count ?? 0;
      // The rate effective on the shift's own date, not today's — a rate
      // change must never rewrite the cost of a shift that already
      // happened. Missing rate contributes 0, same as an unset order count.
      const rate = isAdmin ? rateOnDate(ratesByProfile.get(log.user_id), localDateKeyFromIso(log.clock_in)) : null;
      const cost = rate === null ? 0 : rate * hours;
      const orderPay = orders * currentOrderRate;
      const rowTotal = cost + orderPay;

      const existing = grouped.get(key);
      if (existing) {
        existing.hours += hours;
        existing.orders += orders;
        existing.cost += cost;
        existing.total += rowTotal;
      } else {
        grouped.set(key, { location, role, name, userId: log.user_id, hours, orders, cost, total: rowTotal });
      }

      // Across every row for this person in the period — not just this one
      // location/role combination. Keyed by user_id, not name, since two
      // people can share a display name.
      if (isAdmin) {
        const personExisting = personTotalsMap.get(log.user_id);
        const personEntry: PersonTotal = personExisting ?? {
          userId: log.user_id,
          name,
          hours: 0,
          orders: 0,
          cost: 0,
          total: 0,
        };
        personEntry.hours += hours;
        personEntry.orders += orders;
        personEntry.cost += cost;
        personEntry.total += rowTotal;
        personTotalsMap.set(log.user_id, personEntry);
      }
    }

    setRows(
      Array.from(grouped.values()).sort(
        (a, b) =>
          a.location.localeCompare(b.location) || a.role.localeCompare(b.role) || a.name.localeCompare(b.name)
      )
    );
    setPersonTotals(
      isAdmin
        ? Array.from(personTotalsMap.values()).sort((a, b) => a.name.localeCompare(b.name))
        : null
    );
    setReportOrderRate(isAdmin ? currentOrderRate : null);
  };

  const total = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.hours, 0), [rows]);
  const totalOrders = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.orders, 0), [rows]);
  const totalCost = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.cost, 0), [rows]);
  const grandTotal = useMemo(() => (rows ?? []).reduce((sum, r) => sum + r.total, 0), [rows]);

  const downloadCsv = () => {
    if (!rows) return;

    const columns = availableColumns.filter((col) => selectedColumns.has(col));
    if (columns.length === 0) return;

    const cellFor = (row: ReportRow, col: ColumnKey): string => {
      switch (col) {
        case 'location':
          return csvField(row.location);
        case 'role':
          return csvField(row.role);
        case 'name':
          return csvField(row.name);
        case 'hours':
          return row.hours.toFixed(2);
        case 'orders':
          return trackedRoleNames.has(row.role) ? String(row.orders) : '';
        case 'cost':
          return row.cost.toFixed(2);
        case 'total':
          return row.total.toFixed(2);
      }
    };
    const totalFor = (col: ColumnKey): string => {
      switch (col) {
        case 'location':
          return 'Total';
        case 'hours':
          return total.toFixed(2);
        case 'orders':
          return String(totalOrders);
        case 'cost':
          return totalCost.toFixed(2);
        case 'total':
          return grandTotal.toFixed(2);
        default:
          return '';
      }
    };

    const header = columns.map((col) => COLUMN_LABELS[col]).join(',');
    const rowLine = (row: ReportRow) => columns.map((col) => cellFor(row, col)).join(',');
    const totalLine = columns.map(totalFor).join(',');

    const metaLines = [`${startDate},${endDate}`];
    if (isAdmin && reportOrderRate !== null) {
      metaLines.push(`Order rate per completed order,${reportOrderRate.toFixed(2)}`);
    }

    const lines: string[] = [...metaLines, '', header, ...rows.map(rowLine), totalLine];

    // Per-person totals across the whole period, not just one row — a
    // second table in the same file, using whichever of the same columns
    // (minus Location/Role, which don't apply to a person spanning several)
    // are selected.
    if (isAdmin && personTotals && personTotals.length > 0) {
      const personColumns = columns.filter((col): col is ColumnKey => PERSON_COLUMNS.includes(col));
      if (personColumns.length > 0) {
        const personCellFor = (person: PersonTotal, col: ColumnKey): string => {
          switch (col) {
            case 'name':
              return csvField(person.name);
            case 'hours':
              return person.hours.toFixed(2);
            case 'orders':
              return String(person.orders);
            case 'cost':
              return person.cost.toFixed(2);
            case 'total':
              return person.total.toFixed(2);
            default:
              return '';
          }
        };
        lines.push(
          '',
          'Per-person totals for this period',
          personColumns.map((col) => COLUMN_LABELS[col]).join(','),
          ...personTotals.map((person) => personColumns.map((col) => personCellFor(person, col)).join(','))
        );
      }
    }

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
            The role shown for each entry is the role they held at clock-in, so a later promotion
            does not change which role earned past hours.
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

          {/* Printed into the CSV too, so an exported file stays
              self-explanatory months after the setting may have changed. */}
          {rows && isAdmin && reportOrderRate !== null && (
            <p className="rounded-lg bg-bg px-3 py-2 text-xs text-ink/60">
              Cost and Total include order pay at {formatCurrencyAmount(reportOrderRate)} per completed
              order — the rate in effect when this report was generated.
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
                      {showOrdersColumns && <th className="px-3 py-2 text-right">Orders</th>}
                      {isAdmin && <th className="px-3 py-2 text-right">Cost</th>}
                      {isAdmin && <th className="px-3 py-2 text-right">Total</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => {
                      const rowTracksOrders = trackedRoleNames.has(row.role);
                      return (
                      <tr key={`${row.location}-${row.role}-${row.name}`}>
                        <td className="px-3 py-2 text-ink/80">{row.location}</td>
                        <td className="px-3 py-2 text-ink/80">{row.role}</td>
                        <td className="px-3 py-2 text-ink">{row.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-ink">
                          {row.hours.toFixed(2)}
                        </td>
                        {showOrdersColumns && (
                          <td className="px-3 py-2 text-right tabular-nums text-ink">
                            {rowTracksOrders ? row.orders : '—'}
                          </td>
                        )}
                        {isAdmin && (
                          <td className="px-3 py-2 text-right tabular-nums text-ink">
                            {formatCurrencyAmount(row.cost)}
                          </td>
                        )}
                        {isAdmin && (
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-ink">
                            {formatCurrencyAmount(row.total)}
                          </td>
                        )}
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border font-semibold">
                      <td className="px-3 py-2 text-ink" colSpan={3}>
                        Total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink">{total.toFixed(2)}</td>
                      {showOrdersColumns && (
                        <td className="px-3 py-2 text-right tabular-nums text-ink">{totalOrders}</td>
                      )}
                      {isAdmin && (
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {formatCurrencyAmount(totalCost)}
                        </td>
                      )}
                      {isAdmin && (
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {formatCurrencyAmount(grandTotal)}
                        </td>
                      )}
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))}

          {isAdmin && personTotals && personTotals.length > 0 && (
            <div>
              <p className="text-sm font-medium text-ink">
                Per-person totals for this period
              </p>
              <div className="mt-1.5 overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg text-left text-xs font-semibold text-ink/50">
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2 text-right">Hours</th>
                      {showOrdersColumns && <th className="px-3 py-2 text-right">Orders</th>}
                      <th className="px-3 py-2 text-right">Cost</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {personTotals.map((person) => (
                      <tr key={person.userId}>
                        <td className="px-3 py-2 text-ink">{person.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-ink">
                          {person.hours.toFixed(2)}
                        </td>
                        {showOrdersColumns && (
                          <td className="px-3 py-2 text-right tabular-nums text-ink">{person.orders}</td>
                        )}
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {formatCurrencyAmount(person.cost)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-ink">
                          {formatCurrencyAmount(person.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {rows && rows.length > 0 && (
          <div className="space-y-3 border-t border-border px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div>
              <p className="text-xs font-medium text-ink/60">Columns to include in the CSV</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {availableColumns.map((col) => {
                  const on = selectedColumns.has(col);
                  return (
                    <button
                      key={col}
                      type="button"
                      onClick={() => toggleColumn(col)}
                      aria-pressed={on}
                      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                        on ? 'border-primary bg-primary text-white' : 'border-border text-ink hover:border-primary/40'
                      }`}
                    >
                      {on && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                      {COLUMN_LABELS[col]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={downloadCsv}
                disabled={selectedColumns.size === 0}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Download CSV
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
