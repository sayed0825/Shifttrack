import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';
import type { TestUser } from '../setup/types';

const fixtures = inject('fixtures');

interface Case {
  label: string;
  user: TestUser;
  timeLogId: string;
}

// tg_protect_own_time_log (migration 0017, tightened in 0020 after this
// suite caught the gap): an administrator may edit their own hours (and
// anyone else's, as before). A manager may still edit anyone ELSE's hours,
// but not their own. Everyone else — an employee on their own log — can
// only ever set orders_count, never clock_in/clock_out.
describe('time_log clock_in/clock_out edits are scoped by whose row it is and who is editing it', () => {
  describe('blocked: editing your own hours without being an administrator', () => {
    const cases: Case[] = [
      { label: 'employee', user: fixtures.orgA.employee1, timeLogId: fixtures.orgA.timeLogEmployee1Id },
      { label: 'manager', user: fixtures.orgA.manager, timeLogId: fixtures.orgA.timeLogManagerId },
    ];

    for (const c of cases) {
      it(`${c.label} cannot change clock_in/clock_out on their own closed log`, async () => {
        const client = await signInAs(c.user);

        const { data: before, error: beforeError } = await adminClient
          .from('time_logs')
          .select('clock_in, clock_out')
          .eq('id', c.timeLogId)
          .single();
        if (beforeError || !before) throw new Error('could not read the fixture time_log before the attempt');

        await expectWriteBlocked(
          `${c.label} rewriting clock_in/clock_out on their own log`,
          () =>
            client
              .from('time_logs')
              .update({
                clock_in: new Date(Date.now() - 100 * 3_600_000).toISOString(),
                clock_out: new Date().toISOString(),
              })
              .eq('id', c.timeLogId),
          async () => {
            const { data, error } = await adminClient.from('time_logs').select('clock_in, clock_out').eq('id', c.timeLogId).single();
            if (error || !data) throw new Error('could not re-read the time_log');
            if (data.clock_in !== before.clock_in || data.clock_out !== before.clock_out) {
              throw new Error('clock_in/clock_out changed');
            }
          }
        );
      });
    }
  });

  describe('allowed: editing hours you are entitled to change', () => {
    it('an administrator can change clock_in/clock_out on their own closed log', async () => {
      const client = await signInAs(fixtures.orgA.admin);
      const newClockIn = new Date(Date.now() - 100 * 3_600_000).toISOString();
      const newClockOut = new Date().toISOString();

      const { error: updateError } = await client
        .from('time_logs')
        .update({ clock_in: newClockIn, clock_out: newClockOut })
        .eq('id', fixtures.orgA.timeLogAdminId);
      expect(updateError).toBeNull();

      const { data, error } = await adminClient
        .from('time_logs')
        .select('clock_in, clock_out')
        .eq('id', fixtures.orgA.timeLogAdminId)
        .single();
      expect(error).toBeNull();
      expect(data?.clock_in).toBe(newClockIn);
      expect(data?.clock_out).toBe(newClockOut);
    });

    it("a manager can change clock_in/clock_out on a subordinate's closed log", async () => {
      const client = await signInAs(fixtures.orgA.manager);
      const newClockIn = new Date(Date.now() - 100 * 3_600_000).toISOString();
      const newClockOut = new Date().toISOString();

      // employee1 is at Location A1, inside the manager's scope (see
      // fixtures.ts). time_logs_manager_all (manages_person) is what admits
      // the row for update at all; the trigger then permits the actual
      // column change because the target isn't the caller themselves.
      const { error: updateError } = await client
        .from('time_logs')
        .update({ clock_in: newClockIn, clock_out: newClockOut })
        .eq('id', fixtures.orgA.timeLogEmployee1Id);
      expect(updateError).toBeNull();

      const { data, error } = await adminClient
        .from('time_logs')
        .select('clock_in, clock_out')
        .eq('id', fixtures.orgA.timeLogEmployee1Id)
        .single();
      expect(error).toBeNull();
      expect(data?.clock_in).toBe(newClockIn);
      expect(data?.clock_out).toBe(newClockOut);
    });
  });
});
