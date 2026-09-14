import { describe, it, expect, beforeAll, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

describe('a manager can manage their own location', () => {
  let manager: SupabaseClient;

  beforeAll(async () => {
    manager = await signInAs(fixtures.orgA.manager);
  });

  it("reads employee1's profile (same location, A1)", async () => {
    const { data, error } = await manager.from('profiles').select('id').eq('id', fixtures.orgA.employee1.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("updates employee1's shift (their own location)", async () => {
    const { error: updateError } = await manager
      .from('shifts')
      .update({ notes: 'confirmed by manager' })
      .eq('id', fixtures.orgA.shiftEmployee1Id);
    expect(updateError).toBeNull();

    const { data, error } = await adminClient.from('shifts').select('notes').eq('id', fixtures.orgA.shiftEmployee1Id).single();
    expect(error).toBeNull();
    expect(data?.notes).toBe('confirmed by manager');
  });

  it("reads employee1's time_log (managed location)", async () => {
    const { data, error } = await manager.from('time_logs').select('id').eq('id', fixtures.orgA.timeLogEmployee1Id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
