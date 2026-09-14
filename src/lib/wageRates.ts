// Shared helpers for hourly wage rates — effective-dated per staff member
// (staff_wage_rates: profile_id, hourly_rate, effective_from), mirroring
// the wage_rate_at() Postgres function so the client and the database agree
// on which rate applies to a given date. See supabase/migrations/0018.

export interface WageRateRow {
  id: string;
  profile_id: string;
  hourly_rate: number;
  effective_from: string; // YYYY-MM-DD
  created_at: string;
  created_by: string | null;
}

export const WAGE_RATE_FIELDS = 'id, profile_id, hourly_rate, effective_from, created_at, created_by';

/** Groups rate rows by profile_id, each list sorted most-recent-first. */
export function groupWageRatesByProfile(rows: WageRateRow[]): Map<string, WageRateRow[]> {
  const map = new Map<string, WageRateRow[]>();
  for (const row of rows) {
    const list = map.get(row.profile_id);
    if (list) list.push(row);
    else map.set(row.profile_id, [row]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  }
  return map;
}

/**
 * The rate with the latest effective_from on or before `dateKey`, or null
 * if none applies yet. Mirrors wage_rate_at() in Postgres — `ratesDesc`
 * must already be sorted most-recent-first (see groupWageRatesByProfile).
 */
export function rateOnDate(ratesDesc: WageRateRow[] | undefined, dateKey: string): number | null {
  if (!ratesDesc) return null;
  const match = ratesDesc.find((rate) => rate.effective_from <= dateKey);
  return match ? match.hourly_rate : null;
}

export function localDateKeyFromIso(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatHourlyRate(rate: number): string {
  return `£${rate.toFixed(2)}/hr`;
}

export function formatCurrencyAmount(value: number): string {
  return `£${value.toFixed(2)}`;
}
