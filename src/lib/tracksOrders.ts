import type { Role } from '../hooks/useRoles';

/** Names of roles that require order reporting, for this org. */
export function tracksOrdersRoleNames(roles: Role[]): Set<string> {
  return new Set(roles.filter((r) => r.tracks_orders).map((r) => r.name));
}

/** Whether any role in the org tracks orders at all — gates showing Orders UI
 * so a business without drivers never sees an empty column. */
export function orgTracksOrders(roles: Role[]): boolean {
  return roles.some((r) => r.tracks_orders);
}

/**
 * Whether a specific time_log should be reporting orders. Uses the role held at
 * clock-in when recorded, falling back to the profile's current role only when
 * null — same convention as payroll's role grouping, so a promotion never
 * silently changes which past shifts required a report.
 */
export function logNeedsOrdersReport(
  roleAtClockIn: string | null | undefined,
  currentRole: string | null | undefined,
  trackedRoleNames: Set<string>
): boolean {
  const role = roleAtClockIn ?? currentRole;
  return role != null && trackedRoleNames.has(role);
}

export const ORDERS_NOT_YET_REPORTED = 'Orders not yet reported';

/**
 * Display text for a timesheet row's Orders cell. `orders_count` is only
 * ever null on a log that still owes a report — once OwedOrdersModal
 * submits one it's a required field — so null there, for a log whose role
 * tracks orders, means exactly that: still owed, not zero.
 */
export function ordersCellText(needsReport: boolean, ordersCount: number | null): string {
  if (!needsReport) return '—';
  if (ordersCount == null) return ORDERS_NOT_YET_REPORTED;
  return String(ordersCount);
}
