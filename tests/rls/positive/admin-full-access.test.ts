import { describe, it, expect, beforeAll, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

describe('an administrator reaches everything in their own org', () => {
  let admin: SupabaseClient;

  beforeAll(async () => {
    admin = await signInAs(fixtures.orgA.admin);
  });

  // employee2 (Location A2) is nobody's fixture "own" data from the
  // admin's point of view — the manager can't see any of this (see
  // negative/manager-scope.test.ts). is_admin() bypasses manages_location()/
  // manages_person() entirely, so the admin should reach it regardless of
  // profile_locations.
  const rows: Array<[string, string]> = [
    ['profiles', fixtures.orgA.employee2.id],
    ['shifts', fixtures.orgA.shiftEmployee2Id],
    ['time_logs', fixtures.orgA.timeLogEmployee2Id],
    ['tasks', fixtures.orgA.taskEmployee2Id],
    ['employee_notes', fixtures.orgA.noteEmployee2Id],
    ['overtime_claims', fixtures.orgA.overtimeClaimEmployee2Id],
    ['staff_wage_rates', fixtures.orgA.wageRateEmployee2Id],
    ['locations', fixtures.orgA.locationA2Id],
  ];

  it.each(rows)('reads %s outside any location profile_locations gives the admin directly', async (table, id) => {
    const { data, error } = await admin.from(table).select('id').eq('id', id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('can change the order rate', async () => {
    const { error: updateError } = await admin.from('organisations').update({ order_rate: 2.5 }).eq('id', fixtures.orgA.orgId);
    expect(updateError).toBeNull();

    const { data, error } = await adminClient.from('organisations').select('order_rate').eq('id', fixtures.orgA.orgId).single();
    expect(error).toBeNull();
    expect(Number(data?.order_rate)).toBe(2.5);
  });

  it('can update a location', async () => {
    const { error: updateError } = await admin.from('locations').update({ radius_meters: 150 }).eq('id', fixtures.orgA.locationA1Id);
    expect(updateError).toBeNull();

    const { data, error } = await adminClient.from('locations').select('radius_meters').eq('id', fixtures.orgA.locationA1Id).single();
    expect(error).toBeNull();
    expect(Number(data?.radius_meters)).toBe(150);
  });
});
