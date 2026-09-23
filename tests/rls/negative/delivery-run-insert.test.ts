import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';

const fixtures = inject('fixtures');

/**
 * tg_protect_delivery_run_insert (0034) — security audit finding 3:
 * delivery_runs_insert_own's with_check restricted which time_log a run
 * could attach to, but not which columns the insert itself could set.
 * Confirmed live before the fix: a driver could INSERT a delivery_runs
 * row with one_way_miles/gps_one_way_miles/mileage_source: 'gps' fully
 * fabricated, straight past record_delivery_run's GPS filtering engine,
 * zero error.
 *
 * Each test opens its own throwaway time_log (delivery_runs_insert_own
 * requires clock_out is null) rather than touching the shared
 * timeLogEmployee1Id fixture, which is closed and shared by other tests.
 */
describe('delivery_runs — INSERT cannot set mileage directly', () => {
  async function openThrowawayTimeLog(): Promise<string> {
    const { data, error } = await adminClient
      .from('time_logs')
      .insert({ org_id: fixtures.orgA.orgId, user_id: fixtures.orgA.employee1.id, location_id: fixtures.orgA.locationA1Id, clock_out: null })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture time_log create failed: ${error?.message}`);
    return data.id;
  }

  it('a driver directly inserting a run cannot set mileage columns', async () => {
    const timeLogId = await openThrowawayTimeLog();
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const { error } = await employee1
        .from('delivery_runs')
        .insert({ time_log_id: timeLogId, one_way_miles: 500, gps_one_way_miles: 500, mileage_source: 'gps' });
      expect(error).toBeNull(); // the insert itself is not rejected — it just starts blank

      const { data, error: readError } = await adminClient
        .from('delivery_runs')
        .select('one_way_miles, gps_one_way_miles, mileage_source')
        .eq('time_log_id', timeLogId)
        .single();
      if (readError || !data) throw new Error(`readback failed: ${readError?.message}`);
      expect(data.one_way_miles).toBeNull();
      expect(data.gps_one_way_miles).toBeNull();
      expect(data.mileage_source).toBeNull();
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });

  it('record_delivery_run itself still writes real mileage (the GUC escape hatch works)', async () => {
    const timeLogId = await openThrowawayTimeLog();
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const now = new Date();
      const drops = [
        { sequence: 1, delivered_at: now.toISOString(), latitude: 51.5, longitude: -0.1, accuracy: 10, odometer_miles: 3.2 },
      ];
      const { data: runId, error } = await employee1.rpc('record_delivery_run', {
        p_time_log_id: timeLogId,
        p_started_at: now.toISOString(),
        p_ended_at: now.toISOString(),
        p_one_way_miles: 3.2,
        p_drops: drops,
      });
      if (error) throw new Error(`record_delivery_run failed: ${error.message}`);

      const { data, error: readError } = await adminClient
        .from('delivery_runs')
        .select('one_way_miles, gps_one_way_miles, mileage_source')
        .eq('id', runId as string)
        .single();
      if (readError || !data) throw new Error(`readback failed: ${readError?.message}`);
      expect(Number(data.one_way_miles)).toBe(3.2);
      expect(Number(data.gps_one_way_miles)).toBe(3.2);
      expect(data.mileage_source).toBe('gps');
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });
});
