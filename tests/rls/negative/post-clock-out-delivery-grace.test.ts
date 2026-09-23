import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';

const fixtures = inject('fixtures');

/**
 * time_log_accepts_drops() (0042) — mid-delivery auto clock-out.
 * delivery_runs_insert_own/delivery_drops_insert_own both required
 * tl.clock_out IS NULL, so a shift closing (sweep_open_shifts) while a
 * driver was still out on a run meant record_delivery_run's insert was
 * rejected outright the moment the shift closed — the final drop, that
 * leg's mileage and its order pay had nowhere to go. Now allowed for up
 * to 2 hours 15 minutes past clock_out (2 hours + slack for request
 * latency/a stationary driver generating no new GPS fix) — the actual
 * server-side hard cap, independent of whatever the client's own timing
 * does.
 *
 * Uses employee2, not employee1 — delivery-run-insert.test.ts already
 * claims employee2 for its own throwaway open-time_log probes in this
 * suite; reusing a DIFFERENT user here (deactivatedEmployee, at Location
 * A1) avoids the same cross-file time_logs_one_open_per_user_idx
 * collision documented in that file.
 */
describe('delivery_runs/delivery_drops — attach to a shift that closed underneath the driver, within the grace window', () => {
  async function closedTimeLog(hoursAgoClosedAt: number): Promise<string> {
    const { data, error } = await adminClient
      .from('time_logs')
      .insert({
        org_id: fixtures.orgA.orgId,
        user_id: fixtures.orgA.deactivatedEmployee.id,
        location_id: fixtures.orgA.locationA1Id,
        clock_in: new Date(Date.now() - (hoursAgoClosedAt + 3) * 3_600_000).toISOString(),
        clock_out: new Date(Date.now() - hoursAgoClosedAt * 3_600_000).toISOString(),
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture closed time_log create failed: ${error?.message}`);
    return data.id;
  }

  it('a run can still attach 1 hour after clock_out (within the grace window)', async () => {
    const timeLogId = await closedTimeLog(1);
    try {
      const driver = await signInAs(fixtures.orgA.deactivatedEmployee);
      const { data, error } = await driver
        .from('delivery_runs')
        .insert({ time_log_id: timeLogId })
        .select('id')
        .single();
      expect(error).toBeNull();

      const { error: dropError } = await driver
        .from('delivery_drops')
        .insert({ run_id: data!.id, sequence: 1, latitude: 51.5, longitude: -0.1, odometer_miles: 2.1 });
      expect(dropError).toBeNull();
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });

  it('a run cannot attach 3 hours after clock_out (past the grace window)', async () => {
    const timeLogId = await closedTimeLog(3);
    try {
      const driver = await signInAs(fixtures.orgA.deactivatedEmployee);
      const { error } = await driver.from('delivery_runs').insert({ time_log_id: timeLogId });
      expect(error).not.toBeNull();
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });

  it('a drop cannot attach to a run whose shift closed 3 hours ago, even if the run row itself exists', async () => {
    const timeLogId = await closedTimeLog(3);
    try {
      // adminClient bypasses RLS to create the run directly, isolating
      // this test to the drops policy specifically.
      const { data: run, error: runError } = await adminClient
        .from('delivery_runs')
        .insert({ org_id: fixtures.orgA.orgId, time_log_id: timeLogId })
        .select('id')
        .single();
      if (runError || !run) throw new Error(`fixture run create failed: ${runError?.message}`);

      const driver = await signInAs(fixtures.orgA.deactivatedEmployee);
      const { error } = await driver
        .from('delivery_drops')
        .insert({ run_id: run.id, sequence: 1, latitude: 51.5, longitude: -0.1, odometer_miles: 2.1 });
      expect(error).not.toBeNull();
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });
});
