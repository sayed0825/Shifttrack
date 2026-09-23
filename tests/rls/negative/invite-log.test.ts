import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectNoRows } from '../setup/assert';

const fixtures = inject('fixtures');

/**
 * invite_log (0039) — invite-staff now sends a real email on every call
 * with no cap, so it needed a rate limit and something to check it
 * against. RLS: an admin may read their own org's rows (an audit
 * trail); nobody writes through the API at all — no insert/update/delete
 * policy exists for authenticated or anon, only service_role (BYPASSRLS)
 * can write, which is how the Edge Function itself writes.
 */
describe('invite_log — admin-readable within org, write-only via service role', () => {
  async function seedRow(orgId: string, senderId: string): Promise<string> {
    const { data, error } = await adminClient
      .from('invite_log')
      .insert({ org_id: orgId, sender_id: senderId, email_sent_to: `audit-invite-${Date.now()}@example.com` })
      .select('id')
      .single();
    if (error || !data) throw new Error(`fixture invite_log insert failed: ${error?.message}`);
    return data.id;
  }

  it('an admin can read their own org\'s invite_log rows', async () => {
    const rowId = await seedRow(fixtures.orgA.orgId, fixtures.orgA.manager.id);
    try {
      const admin = await signInAs(fixtures.orgA.admin);
      const { data, error } = await admin.from('invite_log').select('id').eq('id', rowId);
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    } finally {
      await adminClient.from('invite_log').delete().eq('id', rowId);
    }
  });

  it('an admin cannot read another org\'s invite_log rows', async () => {
    const rowId = await seedRow(fixtures.orgB.orgId, fixtures.orgB.admin.id);
    try {
      const admin = await signInAs(fixtures.orgA.admin);
      const result = await admin.from('invite_log').select('id').eq('id', rowId);
      expectNoRows(result, "orgA admin reading orgB's invite_log row");
    } finally {
      await adminClient.from('invite_log').delete().eq('id', rowId);
    }
  });

  it('a manager (not admin) cannot read invite_log at all', async () => {
    const rowId = await seedRow(fixtures.orgA.orgId, fixtures.orgA.manager.id);
    try {
      const manager = await signInAs(fixtures.orgA.manager);
      const result = await manager.from('invite_log').select('id').eq('id', rowId);
      expectNoRows(result, "manager reading invite_log");
    } finally {
      await adminClient.from('invite_log').delete().eq('id', rowId);
    }
  });

  it('an employee cannot read invite_log at all', async () => {
    const rowId = await seedRow(fixtures.orgA.orgId, fixtures.orgA.manager.id);
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const result = await employee1.from('invite_log').select('id').eq('id', rowId);
      expectNoRows(result, "employee reading invite_log");
    } finally {
      await adminClient.from('invite_log').delete().eq('id', rowId);
    }
  });

  it('an admin cannot insert into invite_log directly — only service_role writes', async () => {
    const admin = await signInAs(fixtures.orgA.admin);
    const { error } = await admin
      .from('invite_log')
      .insert({ org_id: fixtures.orgA.orgId, sender_id: fixtures.orgA.admin.id, email_sent_to: 'audit-direct-insert@example.com' });
    expect(error).not.toBeNull();

    const { data, error: readError } = await adminClient
      .from('invite_log')
      .select('id')
      .eq('email_sent_to', 'audit-direct-insert@example.com');
    expect(readError).toBeNull();
    expect(data?.length ?? 0).toBe(0);
  });
});
