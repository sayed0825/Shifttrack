import { describe, it, beforeAll, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { ORG_A_NAME } from '../setup/constants';
import { expectNoRows, expectWriteBlocked } from '../setup/assert';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

describe('a location manager cannot reach admin-only settings', () => {
  let manager: SupabaseClient;

  beforeAll(async () => {
    manager = await signInAs(fixtures.orgA.manager);
  });

  it('cannot read staff_wage_rates at all', async () => {
    const result = await manager.from('staff_wage_rates').select('id').eq('org_id', fixtures.orgA.orgId);
    expectNoRows(result, 'manager reading staff_wage_rates');
  });

  it('cannot rename a role', async () => {
    await expectWriteBlocked(
      'manager renaming the Employee role',
      () =>
        manager
          .from('roles')
          .update({ name: 'Renamed By Manager' })
          .eq('org_id', fixtures.orgA.orgId)
          .eq('name', fixtures.orgA.roleNames.employee),
      async () => {
        const { data, error } = await adminClient
          .from('roles')
          .select('name')
          .eq('org_id', fixtures.orgA.orgId)
          .eq('name', fixtures.orgA.roleNames.employee)
          .single();
        if (error || !data) throw new Error('the Employee role no longer exists under its original name');
      }
    );
  });

  it('cannot change branding (organisation name)', async () => {
    await expectWriteBlocked(
      'manager renaming the organisation',
      () => manager.from('organisations').update({ name: 'Renamed By Manager' }).eq('id', fixtures.orgA.orgId),
      async () => {
        const { data, error } = await adminClient.from('organisations').select('name').eq('id', fixtures.orgA.orgId).single();
        if (error) throw new Error(error.message);
        if (data?.name !== ORG_A_NAME) throw new Error(`organisation name changed to "${data?.name}"`);
      }
    );
  });

  it('cannot change the order rate', async () => {
    await expectWriteBlocked(
      'manager changing organisations.order_rate',
      () => manager.from('organisations').update({ order_rate: 99.99 }).eq('id', fixtures.orgA.orgId),
      async () => {
        const { data, error } = await adminClient.from('organisations').select('order_rate').eq('id', fixtures.orgA.orgId).single();
        if (error) throw new Error(error.message);
        if (Number(data?.order_rate) === 99.99) throw new Error('order_rate was changed');
      }
    );
  });

  it('cannot update a location, even one they manage', async () => {
    // locations_manager_all's WITH CHECK requires is_admin() unconditionally
    // (see the migration) — a manager cannot update ANY location, in scope
    // or not. Deliberately testing against A1, which the manager DOES
    // manage, to isolate this from the separate out-of-scope-location
    // cases in manager-scope.test.ts.
    await expectWriteBlocked(
      'manager updating their own managed location',
      () => manager.from('locations').update({ radius_meters: 999 }).eq('id', fixtures.orgA.locationA1Id),
      async () => {
        const { data, error } = await adminClient.from('locations').select('radius_meters').eq('id', fixtures.orgA.locationA1Id).single();
        if (error) throw new Error(error.message);
        if (Number(data?.radius_meters) === 999) throw new Error('radius_meters was changed');
      }
    );
  });
});
