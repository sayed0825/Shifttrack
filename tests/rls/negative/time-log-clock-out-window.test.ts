import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';

const fixtures = inject('fixtures');

/**
 * tg_protect_own_time_log (0020) had a real bug, caught live rather than
 * here: its "everyone else" branch rejected ANY change to clock_out
 * unconditionally, meaning an ordinary employee (or a manager acting on
 * their own row) could never clock themselves out at all — confirmed by
 * impersonating a driver in SQL. Fixed live, recorded in migration 0031.
 * These are the tests that would have caught it before it shipped.
 */
describe('time_log clock-out — allowed once, open to closed, within the window', () => {
  async function createOpenLog(userId: string, clockInHoursAgo: number): Promise<string> {
    const { data, error } = await adminClient
      .from('time_logs')
      .insert({
        org_id: fixtures.orgA.orgId,
        user_id: userId,
        location_id: fixtures.orgA.locationA1Id,
        clock_in: new Date(Date.now() - clockInHoursAgo * 3_600_000).toISOString(),
        role_at_clock_in: fixtures.orgA.roleNames.employee,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture open time_log insert failed: ${error?.message}`);
    return data.id;
  }

  it('an employee CAN clock out their own open shift', async () => {
    const logId = await createOpenLog(fixtures.orgA.employee1.id, 2);
    const employee1 = await signInAs(fixtures.orgA.employee1);

    const { error } = await employee1
      .from('time_logs')
      .update({ clock_out: new Date().toISOString() })
      .eq('id', logId);
    expect(error).toBeNull();

    const { data, error: readError } = await adminClient.from('time_logs').select('clock_out').eq('id', logId).single();
    expect(readError).toBeNull();
    expect(data?.clock_out).not.toBeNull();
  });

  it('an employee cannot set clock_out outside the 5-minute window', async () => {
    const logId = await createOpenLog(fixtures.orgA.employee1.id, 2);
    const employee1 = await signInAs(fixtures.orgA.employee1);

    // 10 minutes in the past — well outside now()-5m..now()+1m.
    const tooOld = new Date(Date.now() - 10 * 60_000).toISOString();

    await expectWriteBlocked(
      'employee setting clock_out outside the window',
      () => employee1.from('time_logs').update({ clock_out: tooOld }).eq('id', logId),
      async () => {
        const { data, error } = await adminClient.from('time_logs').select('clock_out').eq('id', logId).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.clock_out !== null) throw new Error(`clock_out was set to ${data.clock_out}`);
      }
    );
  });

  it('an employee cannot change clock_out once it is set', async () => {
    // A closed log — old.clock_out is not null, so the window doesn't
    // even apply; this must be rejected regardless of what the new value is.
    const logId = fixtures.orgA.timeLogEmployee1Id;
    const { data: before, error: beforeError } = await adminClient
      .from('time_logs')
      .select('clock_out')
      .eq('id', logId)
      .single();
    if (beforeError || !before) throw new Error('could not read the fixture time_log before the attempt');

    const employee1 = await signInAs(fixtures.orgA.employee1);

    await expectWriteBlocked(
      'employee changing an already-set clock_out',
      () => employee1.from('time_logs').update({ clock_out: new Date().toISOString() }).eq('id', logId),
      async () => {
        const { data, error } = await adminClient.from('time_logs').select('clock_out').eq('id', logId).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.clock_out !== before.clock_out) throw new Error(`clock_out changed to ${data.clock_out}`);
      }
    );
  });

  // sweep_open_shifts() (pg_cron, every 15 minutes) can't be invoked
  // directly here — like every other cron-only function in this schema,
  // it's guarded by a session_user/rolsuper check that a service-role
  // client from PostgREST never satisfies (session_user is 'authenticator',
  // not 'postgres', regardless of which Postgres role the request runs
  // as). What this actually tests is the mechanism the sweep depends on:
  // a null-auth.uid() caller (the sweep's own execution context, and this
  // suite's service-role adminClient — its JWT carries no `sub` claim
  // either) may set clock_out on an open shift outside the 5-minute
  // window, exactly what closing a shift that ended hours ago requires.
  it('a null-auth.uid() caller (what the sweep runs as) CAN close an overdue shift', async () => {
    const logId = await createOpenLog(fixtures.orgA.employee2.id, 10);
    // Well outside the window an authenticated owner would be held to —
    // this is the whole point of the exemption.
    const shiftEndedHoursAgo = new Date(Date.now() - 4 * 3_600_000).toISOString();

    const { error } = await adminClient
      .from('time_logs')
      .update({ clock_out: shiftEndedHoursAgo, notes: 'Auto clocked-out at shift end' })
      .eq('id', logId);
    expect(error).toBeNull();

    const { data, error: readError } = await adminClient.from('time_logs').select('clock_out').eq('id', logId).single();
    expect(readError).toBeNull();
    expect(data?.clock_out).not.toBeNull();
  });
});
