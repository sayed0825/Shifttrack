import { describe, it, beforeAll, inject } from 'vitest';
import { signInAs } from '../setup/clients';
import { expectNoRows } from '../setup/assert';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

describe('an employee cannot read what is not theirs', () => {
  let employee1: SupabaseClient;

  beforeAll(async () => {
    employee1 = await signInAs(fixtures.orgA.employee1);
  });

  it("cannot read another employee's time_logs", async () => {
    const result = await employee1.from('time_logs').select('id').eq('id', fixtures.orgA.timeLogEmployee2Id);
    expectNoRows(result, "employee1 reading employee2's time_log");
  });

  it('cannot read employee_notes at all — including a note about themselves', async () => {
    const own = await employee1.from('employee_notes').select('id').eq('id', fixtures.orgA.noteEmployee1Id);
    expectNoRows(own, 'employee1 reading their own employee_notes row');

    const other = await employee1.from('employee_notes').select('id').eq('id', fixtures.orgA.noteEmployee2Id);
    expectNoRows(other, "employee1 reading employee2's employee_notes row");
  });

  it('cannot read staff_wage_rates at all — including their own', async () => {
    const own = await employee1.from('staff_wage_rates').select('id').eq('id', fixtures.orgA.wageRateEmployee1Id);
    expectNoRows(own, 'employee1 reading their own wage rate');

    const other = await employee1.from('staff_wage_rates').select('id').eq('id', fixtures.orgA.wageRateEmployee2Id);
    expectNoRows(other, "employee1 reading employee2's wage rate");
  });
});
