import { describe, it, beforeAll, inject } from 'vitest';
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
  // A1 only. profiles/overtime_claims are scoped by manages_person();
  // shifts/tasks are scoped by manages_location() — both resolve to false
  // here, but through different RLS mechanisms, which is worth covering
  // separately rather than assuming they behave identically.
  const cases: ScopedCase[] = [
    {
      table: 'profiles',
      id: fixtures.orgA.employee2.id,
      field: 'role',
      original: fixtures.orgA.roleNames.employee,
      attempted: fixtures.orgA.roleNames.manager,
    },
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
