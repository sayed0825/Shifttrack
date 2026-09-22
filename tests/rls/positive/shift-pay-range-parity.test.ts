import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';

const fixtures = inject('fixtures');

/**
 * shift_pay_range() must never disagree with shift_pay() -- it's built
 * to call shift_pay() internally per row rather than reimplement the
 * formula (see migration 0029), so this is a regression guard against
 * that guarantee silently breaking later, not a test of the formula
 * itself (already covered by shift-pay-worked-example.test.ts).
 */
describe('shift_pay_range — must agree with shift_pay for the same shift', () => {
  it('returns byte-identical figures', async () => {
    const orgId = fixtures.orgA.orgId;
    const driver = fixtures.orgA.manager;

    const clockIn = new Date(Date.now() - 4 * 3_600_000);
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
        orders_count: 3,
      })
      .select('id')
      .single();
    if (logError || !log) throw new Error(`fixture time_log insert failed: ${logError?.message}`);

    const admin = await signInAs(fixtures.orgA.admin);

    const { data: single, error: singleError } = await admin.rpc('shift_pay', { p_time_log_id: log.id });
    expect(singleError).toBeNull();

    const fromDate = clockIn.toISOString().slice(0, 10);
    const toDate = new Date(clockIn.getTime() + 24 * 3_600_000).toISOString().slice(0, 10);

    const { data: ranged, error: rangedError } = await admin.rpc('shift_pay_range', {
      p_from: fromDate,
      p_to: toDate,
      p_location_ids: null,
      p_roles: null,
    });
    expect(rangedError).toBeNull();

    const rows = (ranged ?? []) as Array<{ time_log_id: string; breakdown: unknown }>;
    const match = rows.find((r) => r.time_log_id === log.id);
    expect(match).toBeDefined();
    expect(match?.breakdown).toEqual(single);
  });
});
