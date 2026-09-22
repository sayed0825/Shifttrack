import { describe, it, expect, inject } from 'vitest';
import { anonClient } from '../setup/clients';
import { expectNoRows } from '../setup/assert';

const fixtures = inject('fixtures');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const ALL_TABLES = [
  'profiles',
  'locations',
  'shifts',
  'time_logs',
  'live_locations',
  'profile_locations',
  'unavailability_requests',
  'notifications',
  'shift_applications',
  'shift_swaps',
  'overtime_claims',
  'organisations',
  'roles',
  'employee_notes',
  'task_templates',
  'task_template_items',
  'tasks',
  'task_items',
  'task_comments',
  'task_photos',
  'staff_wage_rates',
];

// Every function the app actually calls via .rpc() (see supabase/migrations
// 0007's least-privilege pass) — all confirmed to have no anon EXECUTE
// grant, so every one of these is expected to error before the function
// body ever runs. Dummy args are plausible-shaped but arbitrary; none of
// these should get far enough to care what they contain.
const RPCS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'approve_shift_application', args: { p_application_id: NIL_UUID } },
  { name: 'approve_shift_swap', args: { p_swap_id: NIL_UUID } },
  { name: 'can_see_task', args: { p_task_id: NIL_UUID } },
  { name: 'can_see_task_item', args: { p_item_id: NIL_UUID } },
  { name: 'decide_overtime_claim', args: { p_claim_id: NIL_UUID, p_approve: true } },
  { name: 'delete_my_account', args: {} },
  { name: 'delete_staff_member', args: { p_user_id: NIL_UUID } },
  { name: 'is_active_user', args: {} },
  { name: 'is_admin', args: {} },
  { name: 'is_clocked_in', args: { p_user_id: NIL_UUID } },
  { name: 'is_manager', args: {} },
  { name: 'manages_location', args: { p_location_id: NIL_UUID } },
  { name: 'manages_person', args: { p_user_id: NIL_UUID } },
  { name: 'my_can_view_map', args: {} },
  { name: 'my_late_grace_minutes', args: {} },
  { name: 'my_managed_locations', args: {} },
  { name: 'my_order_rate', args: {} },
  { name: 'my_org_id', args: {} },
  { name: 'my_role', args: {} },
  { name: 'verify_geofenced_clock_in', args: { p_user_id: NIL_UUID, p_lat: 0, p_long: 0, p_location_id: NIL_UUID } },
  { name: 'wage_rate_at', args: { p_profile_id: NIL_UUID, p_on: '2020-01-01' } },
];

describe('anonymous access', () => {
  it.each(ALL_TABLES)('cannot read %s', async (table) => {
    const client = anonClient();
    const result = await client.from(table).select('id').limit(1);
    expectNoRows(result, `anon reading ${table}`);
  });

  it('cannot insert a time_log', async () => {
    const client = anonClient();
    const { error } = await client.from('time_logs').insert({
      org_id: fixtures.orgA.orgId,
      user_id: fixtures.orgA.employee1.id,
      location_id: fixtures.orgA.locationA1Id,
      clock_in: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it('cannot insert a shift', async () => {
    const client = anonClient();
    const { error } = await client.from('shifts').insert({
      org_id: fixtures.orgA.orgId,
      title: 'anon inserted shift',
      location_id: fixtures.orgA.locationA1Id,
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(error).not.toBeNull();
  });

  // No verifyUnchanged/DB-state check needed here, unlike the authenticated
  // RPC tests — none of these have any anon EXECUTE grant at all, so the
  // call is rejected before the function body (and any side effect) ever
  // runs. There's nothing for a side effect to have touched.
  it.each(RPCS)('cannot call $name', async ({ name, args }) => {
    const client = anonClient();
    const { error } = await client.rpc(name, args);
    expect(error, `anon calling ${name} should have been rejected`).not.toBeNull();
  });
});
