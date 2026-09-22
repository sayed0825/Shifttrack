import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';

const fixtures = inject('fixtures');

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

/**
 * The exact worked example the driver pay engine's formula was checked
 * against before writing any SQL (migration 0028): 2 drops on one run,
 * one-way distance 6.5 miles, org defaults (free_miles_per_run 3.5,
 * excess_mile_rate 0.50, mileage_cap_per_run 2.00, order_rate 1.00).
 *   run_mileage = min(max(0, 6.5 - 3.5) x 0.50, 2.00) = 1.50
 *   orders_pay  = 2 x 1.00 = 2.00
 * fixtures.orgA.manager has no staff_wage_rates row, so hours_pay
 * resolves to 0 regardless of the shift's length — isolating the
 * assertion to exactly the two terms the worked example itself uses,
 * total_pay = 3.50.
 */
describe('shift_pay — worked example (2 drops, one run, 6.5mi one-way)', () => {
  it('totals £3.50', async () => {
    const orgId = fixtures.orgA.orgId;
    const driver = fixtures.orgA.manager;

    const clockIn = new Date(Date.now() - 3 * 3_600_000);
    const clockOut = new Date();

    const { data: log, error: logError } = await adminClient
      .from('time_logs')
      .insert({
        org_id: orgId,
        user_id: driver.id,
        location_id: fixtures.orgA.locationA1Id,
        clock_in: clockIn.toISOString(),
        clock_out: clockOut.toISOString(),
        role_at_clock_in: fixtures.orgA.roleNames.manager,
      })
      .select('id')
      .single();
    if (logError || !log) throw new Error(`fixture time_log insert failed: ${logError?.message}`);

    const { data: run, error: runError } = await adminClient
      .from('delivery_runs')
      .insert({ org_id: orgId, time_log_id: log.id, one_way_miles: 6.5 })
      .select('id')
      .single();
    if (runError || !run) throw new Error(`fixture delivery_run insert failed: ${runError?.message}`);

    const { error: dropsError } = await adminClient.from('delivery_drops').insert([
      { org_id: orgId, run_id: run.id, sequence: 1, latitude: 51.5, longitude: -0.1, odometer_miles: 4.5 },
      { org_id: orgId, run_id: run.id, sequence: 2, latitude: 51.51, longitude: -0.11, odometer_miles: 6.5 },
    ]);
    if (dropsError) throw new Error(`fixture delivery_drops insert failed: ${dropsError.message}`);

    const admin = await signInAs(fixtures.orgA.admin);
    const { data, error } = await admin.rpc('shift_pay', { p_time_log_id: log.id });
    const breakdown = data as ShiftPayBreakdown | null;

    expect(error).toBeNull();
    expect(breakdown?.orders_count).toBe(2);
    expect(breakdown?.orders_pay).toBe(2);
    expect(breakdown?.mileage_pay).toBe(1.5);
    expect(breakdown?.hours_pay).toBe(0);
    expect(breakdown?.total_pay).toBe(3.5);
  });

  it('a driver cannot read their own shift_pay', async () => {
    const employee = await signInAs(fixtures.orgA.employee1);
    const { data, error } = await employee.rpc('shift_pay', { p_time_log_id: fixtures.orgA.timeLogEmployee1Id });

    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});
