import { describe, it, inject } from 'vitest';
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

// KNOWN GAP, found while writing this test — flagged in the session report,
// not silently worked around: tg_protect_own_time_log (migration 0017)
// lets a caller through unconditionally when is_manager() is true, with no
// check on whose row is being edited. That's correct for a manager
// correcting a *subordinate's* timesheet (EditLogModal), but the trigger
// has no way to distinguish that from a manager or administrator editing
// their OWN closed log — so today, the manager and administrator cases
// below are expected to FAIL this assertion (the write goes through)
// against the spec "any user updating clock_in/clock_out on their own
// time_log" must be rejected. Only the plain-employee case is currently
// enforced. Left in as written, against the full spec, so a fix to the
// trigger (e.g. requiring user_id <> auth.uid() alongside is_manager())
// turns this green rather than the suite quietly never having checked it.
describe('nobody can rewrite clock_in/clock_out on their own time_log via the client', () => {
  const cases: Case[] = [
    { label: 'employee', user: fixtures.orgA.employee1, timeLogId: fixtures.orgA.timeLogEmployee1Id },
    { label: 'manager', user: fixtures.orgA.manager, timeLogId: fixtures.orgA.timeLogManagerId },
    { label: 'administrator', user: fixtures.orgA.admin, timeLogId: fixtures.orgA.timeLogAdminId },
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
