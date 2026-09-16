import { describe, it, expect, beforeAll, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectNoRows, expectWriteBlocked } from '../setup/assert';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

interface ScopedCase {
  table: string;
  id: string;
  field: string;
  original: unknown;
  attempted: unknown;
}

describe('a location manager cannot read or update staff/shifts/time_logs/tasks/overtime outside their locations', () => {
  let manager: SupabaseClient;

  beforeAll(async () => {
    manager = await signInAs(fixtures.orgA.manager);
  });

  // employee2 is at Location A2; the manager's scope (profile_locations) is
  // A1 only. overtime_claims is scoped by manages_person(); shifts/tasks
  // are scoped by manages_location() — both resolve to false here, but
  // through different RLS mechanisms, which is worth covering separately
  // rather than assuming they behave identically. profiles is deliberately
  // NOT in this table — see the dedicated block below for why reading one
  // is not part of this boundary at all.
  const cases: ScopedCase[] = [
    {
      table: 'shifts',
      id: fixtures.orgA.shiftEmployee2Id,
      field: 'notes',
      original: null,
      attempted: 'out-of-scope edit attempt',
    },
    {
      table: 'time_logs',
      id: fixtures.orgA.timeLogEmployee2Id,
      field: 'notes',
      original: null,
      attempted: 'out-of-scope edit attempt',
    },
    {
      table: 'tasks',
      id: fixtures.orgA.taskEmployee2Id,
      field: 'title',
      original: 'RLS fixture task',
      attempted: 'out-of-scope edit attempt',
    },
    {
      table: 'overtime_claims',
      id: fixtures.orgA.overtimeClaimEmployee2Id,
      field: 'reason',
      original: 'RLS fixture claim',
      attempted: 'out-of-scope edit attempt',
    },
  ];

  for (const c of cases) {
    it(`cannot read ${c.table} outside their locations`, async () => {
      const result = await manager.from(c.table).select('id').eq('id', c.id);
      expectNoRows(result, `manager reading out-of-scope ${c.table}`);
    });

    it(`cannot update ${c.table} outside their locations`, async () => {
      await expectWriteBlocked(
        `manager updating out-of-scope ${c.table}.${c.field}`,
        () => manager.from(c.table).update({ [c.field]: c.attempted }).eq('id', c.id),
        async () => {
          const { data, error } = await adminClient.from(c.table).select(c.field).eq('id', c.id).single();
          if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
          const value = (data as unknown as Record<string, unknown>)[c.field];
          if (value !== c.original) {
            throw new Error(`${c.table}.${c.field} changed to ${JSON.stringify(value)}`);
          }
        }
      );
    });
  }

  // profiles_select_org deliberately reads org-wide, not location-scoped —
  // NOT a case of "outside their locations" excluding a row. It was
  // widened on purpose so a colleague's name renders everywhere it should
  // (e.g. a task comment's author), instead of showing "Unknown" for
  // anyone outside the viewer's own locations. Reading a name is not a
  // leak; acting on someone is. Do not narrow this back to manages_person()
  // — that regresses the task-comment-author bug this was fixed for. The
  // boundary that must hold is everything below: a manager can see that
  // employee2 exists and who they are, but can't change them, deactivate
  // them, or reach any of their protected records.
  describe('a manager can read an out-of-scope profile, but cannot act on it', () => {
    it('can read the profile', async () => {
      const { data, error } = await manager.from('profiles').select('id').eq('id', fixtures.orgA.employee2.id);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('cannot change their role', async () => {
      await expectWriteBlocked(
        "manager changing an out-of-scope employee's role",
        () =>
          manager
            .from('profiles')
            .update({ role: fixtures.orgA.roleNames.manager })
            .eq('id', fixtures.orgA.employee2.id),
        async () => {
          const { data, error } = await adminClient.from('profiles').select('role').eq('id', fixtures.orgA.employee2.id).single();
          if (error || !data) throw new Error(error?.message ?? 'profile missing on re-read');
          if (data.role !== fixtures.orgA.roleNames.employee) throw new Error(`role changed to ${data.role}`);
        }
      );
    });

    it('cannot deactivate them', async () => {
      await expectWriteBlocked(
        'manager deactivating an out-of-scope employee',
        () => manager.from('profiles').update({ is_active: false }).eq('id', fixtures.orgA.employee2.id),
        async () => {
          const { data, error } = await adminClient.from('profiles').select('is_active').eq('id', fixtures.orgA.employee2.id).single();
          if (error || !data) throw new Error(error?.message ?? 'profile missing on re-read');
          if (data.is_active !== true) throw new Error('the profile was deactivated anyway');
        }
      );
    });

    // Also exercised, in more depth, by the generic loop above (time_logs)
    // and by manager-admin-only.test.ts (staff_wage_rates, unconditionally
    // for every manager). Duplicated here too, briefly, so this reads as
    // one complete statement of the boundary rather than three scattered
    // fragments a reader has to go hunt down.
    it('cannot read their time_logs', async () => {
      const result = await manager.from('time_logs').select('id').eq('id', fixtures.orgA.timeLogEmployee2Id);
      expectNoRows(result, "manager reading an out-of-scope employee's time_logs");
    });

    it('cannot read employee_notes about them', async () => {
      const result = await manager.from('employee_notes').select('id').eq('id', fixtures.orgA.noteEmployee2Id);
      expectNoRows(result, "manager reading employee_notes about an out-of-scope employee");
    });

    it('cannot read their wage rate', async () => {
      const result = await manager.from('staff_wage_rates').select('id').eq('id', fixtures.orgA.wageRateEmployee2Id);
      expectNoRows(result, "manager reading an out-of-scope employee's wage rate");
    });
  });

  // employee_notes has no manager UPDATE policy at all (only an admin can
  // soft-delete one) — a manager's only real operations on it are SELECT
  // and INSERT, both scoped by manages_person(). So this is SELECT+INSERT,
  // not SELECT+UPDATE like the cases above.
  it('cannot read an employee_notes row about someone outside their locations', async () => {
    const result = await manager.from('employee_notes').select('id').eq('id', fixtures.orgA.noteEmployee2Id);
    expectNoRows(result, 'manager reading out-of-scope employee_notes');
  });

  it('cannot write an employee_notes row about someone outside their locations', async () => {
    await expectWriteBlocked(
      'manager inserting employee_notes about an out-of-scope employee',
      () =>
        manager.from('employee_notes').insert({
          org_id: fixtures.orgA.orgId,
          employee_id: fixtures.orgA.employee2.id,
          manager_id: fixtures.orgA.manager.id,
          note_text: 'should not be allowed',
        }),
      async () => {
        const { data, error } = await adminClient
          .from('employee_notes')
          .select('id')
          .eq('employee_id', fixtures.orgA.employee2.id)
          .eq('note_text', 'should not be allowed');
        if (error) throw new Error(error.message);
        if ((data ?? []).length > 0) throw new Error('the out-of-scope note was inserted anyway');
      }
    );
  });
});
