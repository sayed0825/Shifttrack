import { describe, it, expect, beforeAll, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

// Positive cases exist so this suite catches over-tightening too, not just
// leaks — a policy accidentally locked down to nothing is just as wrong as
// one left wide open.
describe('an employee can reach their own data', () => {
  let employee1: SupabaseClient;

  beforeAll(async () => {
    employee1 = await signInAs(fixtures.orgA.employee1);
  });

  it('reads their own shift', async () => {
    const { data, error } = await employee1.from('shifts').select('id').eq('id', fixtures.orgA.shiftEmployee1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('reads their own time_log', async () => {
    const { data, error } = await employee1.from('time_logs').select('id').eq('id', fixtures.orgA.timeLogEmployee1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('reads their own task', async () => {
    const { data, error } = await employee1.from('tasks').select('id').eq('id', fixtures.orgA.taskEmployee1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // The item is the unit of work now (0026) — completion, review and
  // photos all live here, not on the list.
  it('reads their own task item', async () => {
    const { data, error } = await employee1.from('task_items').select('id').eq('id', fixtures.orgA.taskItemEmployee1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('can submit their own task item', async () => {
    const { error: updateError } = await employee1
      .from('task_items')
      .update({ status: 'submitted', completed_by: fixtures.orgA.employee1.id, completed_at: new Date().toISOString() })
      .eq('id', fixtures.orgA.taskItemEmployee1Id)
      .in('status', ['pending', 'rejected']);
    expect(updateError).toBeNull();

    const { data, error } = await adminClient.from('task_items').select('status').eq('id', fixtures.orgA.taskItemEmployee1Id).single();
    expect(error).toBeNull();
    expect(data?.status).toBe('submitted');
  });

  it('can set orders_count on their own closed log', async () => {
    const { error: updateError } = await employee1.from('time_logs').update({ orders_count: 7 }).eq('id', fixtures.orgA.timeLogEmployee1Id);
    expect(updateError).toBeNull();

    const { data, error } = await adminClient.from('time_logs').select('orders_count').eq('id', fixtures.orgA.timeLogEmployee1Id).single();
    expect(error).toBeNull();
    expect(data?.orders_count).toBe(7);
  });
});
