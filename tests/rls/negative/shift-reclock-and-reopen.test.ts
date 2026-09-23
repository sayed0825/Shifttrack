import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';
import type { TestUser } from '../setup/types';

const fixtures = inject('fixtures');

/**
 * 0043 — two independent changes.
 *
 * shift_already_completed_by_caller()/time_logs_insert_own: once a
 * shift_id has a completed (clock_out set) time_logs row for a given
 * employee, that employee cannot insert another row against the same
 * shift_id. Scoped to (user_id, shift_id), not the day — a different
 * shift_id (a split shift) is completely unaffected, and an ad-hoc
 * clock-in (shift_id null) is never restricted by this at all, since
 * there's no shift to have "completed".
 *
 * reopened_by/reopened_at: force-derived by tg_protect_own_time_log
 * whenever an admin/manager clears clock_out on someone else's row —
 * never client-supplied, and also protected against an employee setting
 * fake values on their own still-open row without ever touching
 * clock_out.
 *
 * Tests that need a genuinely OPEN row use a throwaway employee, not any
 * of the shared fixture users — time_logs_one_open_per_user_idx (one
 * open shift per user) means an open row for employee1/employee2/
 * deactivatedEmployee here could collide with another file's own
 * throwaway open time_log for the same user, run in parallel (see the
 * comments in delivery-run-insert.test.ts and
 * time-log-clock-in-fields.test.ts, which hit exactly this).
 */
describe('time_logs — no re-clock-in against a completed shift, reopen is audited', () => {
  async function throwawayEmployee(): Promise<{ user: TestUser; cleanup: () => Promise<void> }> {
    const email = `audit-reclock-${Date.now()}@example.com`;
    const password = `Test-${Date.now()}-Xx1!`;
    const { data: authUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { org_id: fixtures.orgA.orgId, full_name: 'Audit Reclock' },
    });
    if (createError || !authUser.user) throw new Error(`fixture user create failed: ${createError?.message}`);
    await adminClient.from('profiles').update({ role: fixtures.orgA.roleNames.employee, is_active: true }).eq('id', authUser.user.id);
    return {
      user: { id: authUser.user.id, email, password },
      cleanup: async () => {
        await adminClient.from('time_logs').delete().eq('user_id', authUser.user.id);
        await adminClient.auth.admin.deleteUser(authUser.user.id);
      },
    };
  }

  it('an employee cannot insert a second time_log against a shift that already has a completed one', async () => {
    // fixtures.orgA.timeLogEmployee1Id is closed and tied to
    // shiftEmployee1Id (see fixtures.ts) — read-only use, no mutation, so
    // no risk of colliding with anything else using employee1.
    const employee1 = await signInAs(fixtures.orgA.employee1);
    await expectWriteBlocked(
      'employee re-inserting a time_log for an already-completed shift',
      () =>
        employee1.from('time_logs').insert({
          user_id: fixtures.orgA.employee1.id,
          location_id: fixtures.orgA.locationA1Id,
          shift_id: fixtures.orgA.shiftEmployee1Id,
          role_at_clock_in: fixtures.orgA.roleNames.employee,
        }),
      async () => {
        const { data, error } = await adminClient
          .from('time_logs')
          .select('id')
          .eq('shift_id', fixtures.orgA.shiftEmployee1Id)
          .eq('user_id', fixtures.orgA.employee1.id);
        if (error) throw new Error(error.message);
        if ((data?.length ?? 0) !== 1) throw new Error(`expected exactly the original fixture row, found ${data?.length}`);
      }
    );
  });

  it('an employee CAN clock into a different (split) shift on the same day', async () => {
    const { user, cleanup } = await throwawayEmployee();
    const { data: shift, error: shiftError } = await adminClient
      .from('shifts')
      .insert({
        org_id: fixtures.orgA.orgId,
        title: 'RLS fixture split shift',
        location_id: fixtures.orgA.locationA1Id,
        assigned_user_id: user.id,
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
        end_time: new Date(Date.now() + 7_200_000).toISOString(),
      })
      .select('id')
      .single();
    if (shiftError || !shift) throw new Error(`fixture shift create failed: ${shiftError?.message}`);

    try {
      // A completed FIRST shift for this same employee, on a different
      // shift_id — proves the block above is scoped per shift_id, not
      // "this employee has completed a shift today".
      const { error: firstShiftError } = await adminClient.from('time_logs').insert({
        org_id: fixtures.orgA.orgId,
        user_id: user.id,
        location_id: fixtures.orgA.locationA1Id,
        clock_in: new Date(Date.now() - 4 * 3_600_000).toISOString(),
        clock_out: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      });
      if (firstShiftError) throw new Error(`fixture first shift's time_log create failed: ${firstShiftError.message}`);

      const employeeClient = await signInAs(user);
      const { error } = await employeeClient.from('time_logs').insert({
        user_id: user.id,
        location_id: fixtures.orgA.locationA1Id,
        shift_id: shift.id,
        role_at_clock_in: fixtures.orgA.roleNames.employee,
        // Closed immediately at insert — this test only needs to prove
        // the insert itself is allowed, not exercise open-shift state.
        clock_out: new Date(Date.now() - 3_600_000).toISOString(),
        clock_in: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      });
      expect(error).toBeNull();
    } finally {
      await cleanup();
      await adminClient.from('shifts').delete().eq('id', shift.id);
    }
  });

  it('an employee CAN clock in ad-hoc (no shift_id) repeatedly, unrestricted by this rule', async () => {
    const { user, cleanup } = await throwawayEmployee();
    try {
      const employeeClient = await signInAs(user);
      // clock_in/clock_out both explicit and well in the past, not the
      // column's own now() default — this session found real clock skew
      // between this machine and the Supabase server earlier, and
      // time_logs_time_order requires clock_out > clock_in.
      const { error: firstError } = await employeeClient.from('time_logs').insert({
        user_id: user.id,
        location_id: fixtures.orgA.locationA1Id,
        role_at_clock_in: fixtures.orgA.roleNames.employee,
        clock_in: new Date(Date.now() - 4 * 3_600_000).toISOString(),
        clock_out: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      });
      expect(firstError).toBeNull();

      const { error: secondError } = await employeeClient.from('time_logs').insert({
        user_id: user.id,
        location_id: fixtures.orgA.locationA1Id,
        role_at_clock_in: fixtures.orgA.roleNames.employee,
        clock_in: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        clock_out: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(secondError).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("a manager reopening a subordinate's shift gets reopened_by/reopened_at force-derived", async () => {
    const { user, cleanup } = await throwawayEmployee();
    await adminClient.from('profile_locations').insert({ profile_id: user.id, location_id: fixtures.orgA.locationA1Id, org_id: fixtures.orgA.orgId, is_primary: true });
    const { data: log, error: logError } = await adminClient
      .from('time_logs')
      .insert({
        org_id: fixtures.orgA.orgId,
        user_id: user.id,
        location_id: fixtures.orgA.locationA1Id,
        clock_in: new Date(Date.now() - 4 * 3_600_000).toISOString(),
        clock_out: new Date(Date.now() - 3_600_000).toISOString(),
      })
      .select('id')
      .single();
    if (logError || !log) throw new Error(`fixture time_log create failed: ${logError?.message}`);

    try {
      // fixtures.orgA.manager manages Location A1 (see fixtures.ts).
      const manager = await signInAs(fixtures.orgA.manager);
      const before = Date.now();
      const { error } = await manager
        .from('time_logs')
        .update({
          clock_out: null,
          // fabricated — must be ignored
          reopened_by: fixtures.orgA.employee2.id,
          reopened_at: '2020-01-01T00:00:00Z',
        })
        .eq('id', log.id);
      const after = Date.now();
      expect(error).toBeNull();

      const { data, error: readError } = await adminClient
        .from('time_logs')
        .select('reopened_by, reopened_at')
        .eq('id', log.id)
        .single();
      if (readError || !data) throw new Error(readError?.message ?? 'row missing on re-read');
      expect(data.reopened_by).toBe(fixtures.orgA.manager.id);
      const reopenedAtMs = new Date(data.reopened_at!).getTime();
      expect(reopenedAtMs).toBeGreaterThanOrEqual(before - 1000);
      expect(reopenedAtMs).toBeLessThanOrEqual(after + 1000);
    } finally {
      await cleanup();
    }
  });

  it('an employee cannot set reopened_by/reopened_at on their own open row directly', async () => {
    const { user, cleanup } = await throwawayEmployee();
    const { data: log, error: logError } = await adminClient
      .from('time_logs')
      .insert({
        org_id: fixtures.orgA.orgId,
        user_id: user.id,
        location_id: fixtures.orgA.locationA1Id,
        clock_out: null,
      })
      .select('id')
      .single();
    if (logError || !log) throw new Error(`fixture time_log create failed: ${logError?.message}`);

    try {
      const employeeClient = await signInAs(user);
      await expectWriteBlocked(
        'employee setting reopened_by/reopened_at on their own open row',
        () =>
          employeeClient
            .from('time_logs')
            .update({ reopened_by: user.id, reopened_at: new Date().toISOString() })
            .eq('id', log.id),
        async () => {
          const { data, error } = await adminClient.from('time_logs').select('reopened_by, reopened_at').eq('id', log.id).single();
          if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
          if (data.reopened_by !== null || data.reopened_at !== null) throw new Error(`reopened fields changed: ${JSON.stringify(data)}`);
        }
      );
    } finally {
      await cleanup();
    }
  });
});
