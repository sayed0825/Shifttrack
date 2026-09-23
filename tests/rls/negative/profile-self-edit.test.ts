import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';

const fixtures = inject('fixtures');

/**
 * tg_protect_profile_role (0033) — security audit findings 1, 4, 10:
 * profiles_update_own's with_check is just id = auth.uid(), no column
 * restriction, and the trigger only ever checked `role`. Confirmed live
 * before the fix: an ordinary employee could set org_id (full cross-org
 * move), is_active (self-reactivate after deactivation), and accepted_at,
 * all with zero error. email added to the same fix (one-way mirror of
 * auth.users.email, never independently writable) and role tightened to
 * close a related escalation: any manager could previously grant
 * themselves or anyone an Administrator role by direct table update, the
 * same class of bug fixed in invite-staff.
 */
describe('profiles — self-edit is column-restricted, not just row-restricted', () => {
  it('an employee cannot set their own org_id', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    await expectWriteBlocked(
      'employee setting their own org_id',
      () => employee1.from('profiles').update({ org_id: fixtures.orgB.orgId }).eq('id', fixtures.orgA.employee1.id),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('org_id').eq('id', fixtures.orgA.employee1.id).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.org_id !== fixtures.orgA.orgId) throw new Error(`org_id changed to ${data.org_id}`);
      }
    );
  });

  it('an employee cannot reactivate themselves after being deactivated', async () => {
    const deactivated = await signInAs(fixtures.orgA.deactivatedEmployee);
    await expectWriteBlocked(
      'a deactivated employee reactivating themselves',
      () => deactivated.from('profiles').update({ is_active: true }).eq('id', fixtures.orgA.deactivatedEmployee.id),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('is_active').eq('id', fixtures.orgA.deactivatedEmployee.id).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.is_active !== false) throw new Error('the profile was reactivated anyway');
      }
    );
  });

  it('an employee cannot set their own accepted_at', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    const { data: before } = await adminClient.from('profiles').select('accepted_at').eq('id', fixtures.orgA.employee1.id).single();
    await expectWriteBlocked(
      'employee setting their own accepted_at',
      () => employee1.from('profiles').update({ accepted_at: '2020-01-01T00:00:00Z' }).eq('id', fixtures.orgA.employee1.id),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('accepted_at').eq('id', fixtures.orgA.employee1.id).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.accepted_at !== before?.accepted_at) throw new Error(`accepted_at changed to ${data.accepted_at}`);
      }
    );
  });

  it('an employee cannot set their own email', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    await expectWriteBlocked(
      'employee setting their own email',
      () => employee1.from('profiles').update({ email: 'spoofed@example.com' }).eq('id', fixtures.orgA.employee1.id),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('email').eq('id', fixtures.orgA.employee1.id).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.email === 'spoofed@example.com') throw new Error('email was overwritten');
      }
    );
  });

  it('a manager cannot set their own org_id, even though they can manage others', async () => {
    const manager = await signInAs(fixtures.orgA.manager);
    await expectWriteBlocked(
      "manager setting their own org_id",
      () => manager.from('profiles').update({ org_id: fixtures.orgB.orgId }).eq('id', fixtures.orgA.manager.id),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('org_id').eq('id', fixtures.orgA.manager.id).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.org_id !== fixtures.orgA.orgId) throw new Error(`org_id changed to ${data.org_id}`);
      }
    );
  });

  it('a manager cannot grant an Administrator role to someone they manage', async () => {
    const manager = await signInAs(fixtures.orgA.manager);
    await expectWriteBlocked(
      'manager granting an Administrator role',
      () => manager.from('profiles').update({ role: fixtures.orgA.roleNames.administrator }).eq('id', fixtures.orgA.employee1.id),
      async () => {
        const { data, error } = await adminClient.from('profiles').select('role').eq('id', fixtures.orgA.employee1.id).single();
        if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
        if (data.role !== fixtures.orgA.roleNames.employee) throw new Error(`role changed to ${data.role}`);
      }
    );
  });

  it('a manager CAN reactivate someone they manage', async () => {
    const manager = await signInAs(fixtures.orgA.manager);
    // employee1 is at Location A1, inside the manager's scope (see fixtures.ts).
    const { error } = await manager.from('profiles').update({ is_active: false }).eq('id', fixtures.orgA.employee1.id);
    expect(error).toBeNull();
    const { error: reactivateError } = await manager.from('profiles').update({ is_active: true }).eq('id', fixtures.orgA.employee1.id);
    expect(reactivateError).toBeNull();
    const { data, error: readError } = await adminClient.from('profiles').select('is_active').eq('id', fixtures.orgA.employee1.id).single();
    expect(readError).toBeNull();
    expect(data?.is_active).toBe(true);
  });

  it('an admin CAN change their own org_id', async () => {
    // A throwaway admin profile, not the shared fixtures.orgA.admin — org_id
    // is destructive enough that it shouldn't touch a row other tests
    // depend on. Changes their OWN row, not someone else's:
    // profiles_manager_all's with_check pins org_id = my_org_id() for ANY
    // manager/admin acting on another profile, so a cross-org move of a
    // different row is blocked at the RLS-policy layer regardless of this
    // trigger — a separate, pre-existing gap between 0033's own docstring
    // and what's actually reachable, outside this migration's scope, flagged
    // back to the user rather than silently patched here. Self org_id
    // change is what profiles_update_own (id = auth.uid(), no org_id
    // constraint in the policy itself) actually leaves reachable, and it's
    // exactly what this trigger's is_admin() passthrough gates.
    const email = `audit-org-move-${Date.now()}@example.com`;
    const password = `Test-${Date.now()}-Xx1!`;
    const { data: authUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { org_id: fixtures.orgA.orgId, full_name: 'Org Move Test' },
    });
    if (createError || !authUser.user) throw new Error(`fixture user create failed: ${createError?.message}`);
    await adminClient.from('profiles').update({ role: fixtures.orgA.roleNames.administrator, is_active: true }).eq('id', authUser.user.id);

    try {
      const throwawayAdmin = await signInAs({ id: authUser.user.id, email, password });
      const { error } = await throwawayAdmin.from('profiles').update({ org_id: fixtures.orgB.orgId }).eq('id', authUser.user.id);
      expect(error).toBeNull();
      const { data, error: readError } = await adminClient.from('profiles').select('org_id').eq('id', authUser.user.id).single();
      expect(readError).toBeNull();
      expect(data?.org_id).toBe(fixtures.orgB.orgId);
    } finally {
      await adminClient.auth.admin.deleteUser(authUser.user.id);
    }
  });
});
