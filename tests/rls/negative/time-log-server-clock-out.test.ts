import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';

const fixtures = inject('fixtures');

/**
 * tg_protect_own_time_log (0041) — clock_out is now force-derived to the
 * server's own now() for the owner's own clock-out, never trusted from
 * the client. Confirmed live before the fix: this exact window (clock_out
 * within -5min/+1min of the server's now()) rejected one of this
 * session's own RLS tests over real clock skew between this machine and
 * the Supabase server — the same class of rejection a driver with a
 * skewed device clock, a slow request, or a delayed offline-queue replay
 * would hit.
 *
 * Each test opens its own throwaway open time_log — the shared
 * timeLogEmployee1Id fixture is closed, so RLS alone would already block
 * reaching it, which wouldn't exercise this trigger branch at all.
 */
describe('time_logs — clock_out is server time, not client time', () => {
  async function openThrowawayTimeLog(): Promise<string> {
    const { data, error } = await adminClient
      .from('time_logs')
      .insert({
        org_id: fixtures.orgA.orgId,
        user_id: fixtures.orgA.employee1.id,
        location_id: fixtures.orgA.locationA1Id,
        clock_in: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        clock_out: null,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture time_log create failed: ${error?.message}`);
    return data.id;
  }

  it("an employee's clock_out is set to the server's now(), ignoring a wildly skewed client value", async () => {
    const timeLogId = await openThrowawayTimeLog();
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const fabricated = new Date(Date.now() - 3 * 3_600_000).toISOString(); // "3 hours ago" — well outside the old window either direction
      const before = Date.now();
      const { error } = await employee1.from('time_logs').update({ clock_out: fabricated }).eq('id', timeLogId);
      const after = Date.now();
      expect(error).toBeNull();

      const { data, error: readError } = await adminClient.from('time_logs').select('clock_out').eq('id', timeLogId).single();
      if (readError || !data?.clock_out) throw new Error(readError?.message ?? 'row missing on re-read');
      const recordedMs = new Date(data.clock_out).getTime();
      expect(recordedMs).toBeGreaterThanOrEqual(before - 1000);
      expect(recordedMs).toBeLessThanOrEqual(after + 1000);
      expect(recordedMs).not.toBe(new Date(fabricated).getTime());
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });

  it('an employee cannot re-edit clock_out on an already-closed shift', async () => {
    const timeLogId = await openThrowawayTimeLog();
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const { error: firstCloseError } = await employee1.from('time_logs').update({ clock_out: new Date().toISOString() }).eq('id', timeLogId);
      expect(firstCloseError).toBeNull();

      const { data: afterFirst } = await adminClient.from('time_logs').select('clock_out').eq('id', timeLogId).single();
      const recordedClockOut = afterFirst?.clock_out;

      const { error: secondAttemptError } = await employee1
        .from('time_logs')
        .update({ clock_out: new Date(Date.now() + 3_600_000).toISOString() })
        .eq('id', timeLogId);
      expect(secondAttemptError).not.toBeNull();
      expect(secondAttemptError?.message ?? '').toContain('already been clocked out');

      const { data: afterSecond, error: readError } = await adminClient.from('time_logs').select('clock_out').eq('id', timeLogId).single();
      if (readError || !afterSecond) throw new Error(readError?.message ?? 'row missing on re-read');
      expect(afterSecond.clock_out).toBe(recordedClockOut);
    } finally {
      await adminClient.from('time_logs').delete().eq('id', timeLogId);
    }
  });
});
