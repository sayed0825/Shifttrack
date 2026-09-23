import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';

const fixtures = inject('fixtures');

/**
 * tg_protect_own_time_log (0035) — security audit finding 6: the existing
 * "who, where and when the shift started never change" freeze covered
 * user_id/location_id/is_geofenced_valid/clock_in, but not
 * role_at_clock_in, shift_id, or clock_in_latitude/_longitude/_distance_m.
 * Confirmed live: on their own still-open shift (the only window
 * time_logs_update_own_open leaves reachable at all), an employee could
 * rewrite any of these with zero error.
 *
 * Each test opens its own throwaway open time_log — the shared
 * timeLogEmployee1Id fixture is closed, so RLS alone (not this trigger)
 * would already block the owner from reaching it, which wouldn't
 * actually exercise the column freeze this migration adds. Uses
 * deactivatedEmployee, not employee1 — delivery-run-insert.test.ts and
 * time-log-clock-out-window.test.ts both also open throwaway time_logs
 * for employee1, and time_logs_one_open_per_user_idx allows only one
 * open log per user; Vitest runs test files in parallel, so sharing
 * employee1 across files collides on that index. deactivatedEmployee is
 * still at Location A1, inside the manager's scope, so the positive
 * control below still holds.
 */
describe('time_logs — clock-in fields are frozen against the owner, even while open', () => {
  async function openThrowawayTimeLog(): Promise<string> {
    const { data, error } = await adminClient
      .from('time_logs')
      .insert({
        org_id: fixtures.orgA.orgId,
        user_id: fixtures.orgA.deactivatedEmployee.id,
        location_id: fixtures.orgA.locationA1Id,
        shift_id: fixtures.orgA.shiftEmployee1Id,
        role_at_clock_in: fixtures.orgA.roleNames.employee,
        clock_in_latitude: 51.5,
        clock_in_longitude: -0.1,
        clock_in_distance_m: 5,
        clock_out: null,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture time_log create failed: ${error?.message}`);
    return data.id;
  }

  it('an employee cannot change role_at_clock_in/shift_id/clock_in location on their own open log', async () => {
    const timeLogId = await openThrowawayTimeLog();
    try {
      const deactivatedEmployee = await signInAs(fixtures.orgA.deactivatedEmployee);
      await expectWriteBlocked(
        'employee rewriting clock-in fields on their own open log',
        () =>
          deactivatedEmployee
            .from('time_logs')
            .update({
              role_at_clock_in: fixtures.orgA.roleNames.manager,
              shift_id: fixtures.orgA.shiftEmployee2Id,
              clock_in_latitude: 0,
              clock_in_longitude: 0,
              clock_in_distance_m: 999,
            })
            .eq('id', timeLogId),
        async () => {
          const { data, error } = await adminClient
            .from('time_logs')
            .select('role_at_clock_in, shift_id, clock_in_latitude, clock_in_longitude, clock_in_distance_m')
            .eq('id', timeLogId)
            .single();
          if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
          if (
            data.role_at_clock_in !== fixtures.orgA.roleNames.employee ||
            data.shift_id !== fixtures.orgA.shiftEmployee1Id ||
            data.clock_in_latitude !== 51.5 ||
            data.clock_in_longitude !== -0.1 ||
            data.clock_in_distance_m !== 5
          ) {
            throw new Error(`clock-in fields changed: ${JSON.stringify(data)}`);
          }
        }
      );
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });

  it("a manager CAN change shift_id/role_at_clock_in on a subordinate's open log", async () => {
    const timeLogId = await openThrowawayTimeLog();
    try {
      const manager = await signInAs(fixtures.orgA.manager);
      // deactivatedEmployee is at Location A1, inside the manager's scope (see fixtures.ts).
      const { error } = await manager
        .from('time_logs')
        .update({ shift_id: fixtures.orgA.shiftEmployee2Id, role_at_clock_in: fixtures.orgA.roleNames.manager })
        .eq('id', timeLogId);
      expect(error).toBeNull();

      const { data, error: readError } = await adminClient
        .from('time_logs')
        .select('shift_id, role_at_clock_in')
        .eq('id', timeLogId)
        .single();
      if (readError || !data) throw new Error(`readback failed: ${readError?.message}`);
      expect(data.shift_id).toBe(fixtures.orgA.shiftEmployee2Id);
      expect(data.role_at_clock_in).toBe(fixtures.orgA.roleNames.manager);
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });
});
