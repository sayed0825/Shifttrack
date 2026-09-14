import { describe, it, beforeAll, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectRpcBlocked } from '../setup/assert';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

// Called directly via .rpc(), not through any UI path — the point is to
// exercise each function's own internal manages_person()/manages_location()
// check (see migration 0007's notes on these four), not whatever a screen
// happens to expose.
describe('a location manager cannot call staff/shift/overtime RPCs for someone outside their locations', () => {
  let manager: SupabaseClient;

  beforeAll(async () => {
    manager = await signInAs(fixtures.orgA.manager);
  });

  it('delete_staff_member rejects an out-of-scope target', async () => {
    await expectRpcBlocked(
      'delete_staff_member(employee2)',
      () => manager.rpc('delete_staff_member', { p_user_id: fixtures.orgA.employee2.id }),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('id').eq('id', fixtures.orgA.employee2.id).single();
        if (error || !data) throw new Error('employee2 no longer exists');
      }
    );
  });

  it('approve_shift_swap rejects a swap involving an out-of-scope target', async () => {
    await expectRpcBlocked(
      'approve_shift_swap',
      () => manager.rpc('approve_shift_swap', { p_swap_id: fixtures.orgA.shiftSwapId }),
      async () => {
        const { data, error } = await adminClient.from('shift_swaps').select('status').eq('id', fixtures.orgA.shiftSwapId).single();
        if (error || !data) throw new Error('the swap row no longer exists');
        if (data.status !== 'pending_manager') throw new Error(`swap status changed to ${data.status}`);
      }
    );
  });

  it('approve_shift_application rejects an application for a shift outside their locations', async () => {
    await expectRpcBlocked(
      'approve_shift_application',
      () => manager.rpc('approve_shift_application', { p_application_id: fixtures.orgA.shiftApplicationId }),
      async () => {
        const { data, error } = await adminClient
          .from('shifts')
          .select('assigned_user_id')
          .eq('id', fixtures.orgA.openShiftForApplicationId)
          .single();
        if (error || !data) throw new Error('the open shift no longer exists');
        if (data.assigned_user_id !== null) throw new Error('the shift was filled anyway');
      }
    );
  });

  it('decide_overtime_claim rejects a claim from an out-of-scope employee', async () => {
    await expectRpcBlocked(
      'decide_overtime_claim',
      () => manager.rpc('decide_overtime_claim', { p_claim_id: fixtures.orgA.overtimeClaimEmployee2Id, p_approve: true }),
      async () => {
        const { data, error } = await adminClient
          .from('overtime_claims')
          .select('status')
          .eq('id', fixtures.orgA.overtimeClaimEmployee2Id)
          .single();
        if (error || !data) throw new Error('the claim no longer exists');
        if (data.status !== 'pending') throw new Error(`claim status changed to ${data.status}`);
      }
    );
  });
});
