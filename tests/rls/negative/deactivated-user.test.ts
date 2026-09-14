import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';

const fixtures = inject('fixtures');

// Supabase Auth has no notion of profiles.is_active — it's an app-level
// column. A deactivated user's password sign-in succeeds and returns a
// valid session; the app's own client code notices is_active === false
// afterward and signs itself out. What actually stops a deactivated user
// is RLS (is_active_user() in WITH CHECK clauses) and is_manager()/
// is_admin() both requiring is_active internally. So: sign-in succeeding
// here is correct, not a bug — the RLS-gated operations after it are what
// must fail.
describe('a deactivated user', () => {
  it('can still sign in — Supabase Auth has no view of profiles.is_active', async () => {
    const client = await signInAs(fixtures.orgA.deactivatedEmployee);
    const { data } = await client.auth.getSession();
    expect(data.session).not.toBeNull();
  });

  it('cannot insert a time_log — is_active_user() blocks it', async () => {
    const client = await signInAs(fixtures.orgA.deactivatedEmployee);
    const clockIn = new Date().toISOString();

    await expectWriteBlocked(
      'deactivated employee inserting a time_log',
      () =>
        client.from('time_logs').insert({
          org_id: fixtures.orgA.orgId,
          user_id: fixtures.orgA.deactivatedEmployee.id,
          location_id: fixtures.orgA.locationA1Id,
          clock_in: clockIn,
        }),
      async () => {
        const { data, error } = await adminClient
          .from('time_logs')
          .select('id')
          .eq('user_id', fixtures.orgA.deactivatedEmployee.id)
          .eq('clock_in', clockIn);
        if (error) throw new Error(error.message);
        if ((data ?? []).length > 0) throw new Error('the time_log was inserted anyway');
      }
    );
  });

  it('is_active_user() reports false for a deactivated employee', async () => {
    const client = await signInAs(fixtures.orgA.deactivatedEmployee);
    const { data, error } = await client.rpc('is_active_user');
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it('a deactivated administrator loses admin privileges — is_admin() checks is_active', async () => {
    const client = await signInAs(fixtures.orgA.deactivatedAdmin);
    const { data, error } = await client.rpc('is_admin');
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it('a deactivated administrator cannot reach an admin-only table', async () => {
    const client = await signInAs(fixtures.orgA.deactivatedAdmin);
    const { data, error } = await client.from('staff_wage_rates').select('id').eq('org_id', fixtures.orgA.orgId);
    if (error) return; // blocked with an explicit error is also fine
    expect(data ?? [], 'a deactivated admin should not see any wage rates').toHaveLength(0);
  });
});
