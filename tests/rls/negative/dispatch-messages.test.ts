import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectNoRows, expectWriteBlocked, expectRpcBlocked } from '../setup/assert';
import type { TestUser } from '../setup/types';

const fixtures = inject('fixtures');

/**
 * dispatch_messages (0040) — everything except `status` is force-derived
 * server-side by tg_dispatch_message_insert from the caller's own open
 * shift; there is no update policy for authenticated at all, only
 * mark_dispatch_message_arrived() and (separately) the ETA Edge Function's
 * service-role write can ever change a row after insert.
 *
 * A throwaway "Driver" role (tracks_orders = true) plus a throwaway driver
 * user and open time_log, not the shared fixtures — none of the existing
 * fixture users carry tracks_orders, and an open time_log is destructive
 * enough (one-open-shift-per-user) not to risk colliding with another
 * file's own throwaway shift.
 */
describe('dispatch_messages — force-derived columns, driver-only posting, location-scoped visibility', () => {
  async function openThrowawayDriver(): Promise<{ driver: TestUser; timeLogId: string; cleanup: () => Promise<void> }> {
    const roleName = `Driver-Audit-${Date.now()}`;
    const { error: roleError } = await adminClient
      .from('roles')
      .insert({ org_id: fixtures.orgA.orgId, name: roleName, sort_order: 999, tracks_orders: true });
    if (roleError) throw new Error(`fixture role create failed: ${roleError.message}`);

    const email = `audit-driver-${Date.now()}@example.com`;
    const password = `Test-${Date.now()}-Xx1!`;
    const { data: authUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { org_id: fixtures.orgA.orgId, full_name: 'Audit Driver' },
    });
    if (createError || !authUser.user) throw new Error(`fixture driver create failed: ${createError?.message}`);
    await adminClient.from('profiles').update({ role: roleName, is_active: true }).eq('id', authUser.user.id);

    const { data: timeLog, error: timeLogError } = await adminClient
      .from('time_logs')
      .insert({ org_id: fixtures.orgA.orgId, user_id: authUser.user.id, location_id: fixtures.orgA.locationA1Id, clock_out: null })
      .select('id')
      .single();
    if (timeLogError || !timeLog) throw new Error(`fixture time_log create failed: ${timeLogError?.message}`);

    return {
      driver: { id: authUser.user.id, email, password },
      timeLogId: timeLog.id,
      cleanup: async () => {
        await adminClient.from('time_logs').delete().eq('id', timeLog.id);
        await adminClient.auth.admin.deleteUser(authUser.user.id);
        await adminClient.from('roles').delete().eq('org_id', fixtures.orgA.orgId).eq('name', roleName);
      },
    };
  }

  it('a driver posting Delivered gets org_id/location_id/time_log_id/sender_id/drop_sequence force-derived, ignoring client-supplied values', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      const driverClient = await signInAs(driver);
      const { data, error } = await driverClient
        .from('dispatch_messages')
        .insert({
          status: 'delivered',
          org_id: fixtures.orgB.orgId, // fabricated — must be ignored
          location_id: fixtures.orgA.locationA2Id, // fabricated — must be ignored
          time_log_id: '00000000-0000-0000-0000-000000000000', // fabricated — must be ignored
          sender_id: fixtures.orgA.admin.id, // fabricated — must be ignored
          eta_minutes: 999, // fabricated — must be ignored
          drop_sequence: 999, // fabricated — must be ignored
        })
        .select('org_id, location_id, time_log_id, sender_id, eta_minutes, drop_sequence, status')
        .single();
      if (error || !data) throw new Error(`insert failed: ${error?.message}`);
      expect(data.org_id).toBe(fixtures.orgA.orgId);
      expect(data.location_id).toBe(fixtures.orgA.locationA1Id);
      expect(data.time_log_id).toBe(timeLogId);
      expect(data.sender_id).toBe(driver.id);
      expect(data.eta_minutes).toBeNull();
      expect(data.drop_sequence).toBe(1);
      expect(data.status).toBe('delivered');
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('drop_sequence counts up across successive Delivered posts on the same shift', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      const driverClient = await signInAs(driver);
      const { data: first } = await driverClient.from('dispatch_messages').insert({ status: 'delivered' }).select('drop_sequence').single();
      const { data: second } = await driverClient.from('dispatch_messages').insert({ status: 'delivered' }).select('drop_sequence').single();
      expect(first?.drop_sequence).toBe(1);
      expect(second?.drop_sequence).toBe(2);
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('a non-driver (no tracks_orders role) cannot post at all', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    const { error } = await employee1.from('dispatch_messages').insert({ status: 'delivered' });
    expect(error).not.toBeNull();
  });

  it('a driver with no open shift cannot post', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      await adminClient.from('time_logs').update({ clock_out: new Date().toISOString() }).eq('id', timeLogId);
      const driverClient = await signInAs(driver);
      const { error } = await driverClient.from('dispatch_messages').insert({ status: 'delivered' });
      expect(error).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('a driver cannot post status = arrived or stale directly', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      const driverClient = await signInAs(driver);
      const { error: arrivedError } = await driverClient.from('dispatch_messages').insert({ status: 'arrived' });
      expect(arrivedError).not.toBeNull();
      const { error: staleError } = await driverClient.from('dispatch_messages').insert({ status: 'stale' });
      expect(staleError).not.toBeNull();
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('FOH/a driver at the same location can see the message; someone at a different location cannot', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    let messageId = '';
    try {
      const driverClient = await signInAs(driver);
      const { data } = await driverClient.from('dispatch_messages').insert({ status: 'delivered' }).select('id').single();
      messageId = data!.id;

      // employee1 is at Location A1, same as the throwaway driver's shift.
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const { data: seen, error: seenError } = await employee1.from('dispatch_messages').select('id').eq('id', messageId);
      expect(seenError).toBeNull();
      expect(seen?.length).toBe(1);

      // employee2 is at Location A2.
      const employee2 = await signInAs(fixtures.orgA.employee2);
      const notSeen = await employee2.from('dispatch_messages').select('id').eq('id', messageId);
      expectNoRows(notSeen, "employee2 (Location A2) reading a Location A1 dispatch message");
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('a manager outside their scope cannot see the message; the manager who manages Location A1 can', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    let messageId = '';
    try {
      const driverClient = await signInAs(driver);
      const { data } = await driverClient.from('dispatch_messages').insert({ status: 'delivered' }).select('id').single();
      messageId = data!.id;

      // fixtures.orgA.manager manages Location A1 (see fixtures.ts).
      const manager = await signInAs(fixtures.orgA.manager);
      const { data: seen, error: seenError } = await manager.from('dispatch_messages').select('id').eq('id', messageId);
      expect(seenError).toBeNull();
      expect(seen?.length).toBe(1);

      // Cross-org: orgB's admin must never see an orgA message.
      const orgBAdmin = await signInAs(fixtures.orgB.admin);
      const notSeen = await orgBAdmin.from('dispatch_messages').select('id').eq('id', messageId);
      expectNoRows(notSeen, "orgB admin reading an orgA dispatch message");
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('a driver cannot directly UPDATE their own message — no update policy exists', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      const driverClient = await signInAs(driver);
      const { data } = await driverClient.from('dispatch_messages').insert({ status: 'returning' }).select('id').single();
      const messageId = data!.id;

      await expectWriteBlocked(
        'driver directly updating eta_minutes on their own message',
        () => driverClient.from('dispatch_messages').update({ eta_minutes: 5 }).eq('id', messageId),
        async () => {
          const { data: row, error } = await adminClient.from('dispatch_messages').select('eta_minutes').eq('id', messageId).single();
          if (error || !row) throw new Error(error?.message ?? 'row missing on re-read');
          if (row.eta_minutes !== null) throw new Error(`eta_minutes changed to ${row.eta_minutes}`);
        }
      );
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('mark_dispatch_message_arrived resolves the caller\'s own returning message', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      const driverClient = await signInAs(driver);
      const { data } = await driverClient.from('dispatch_messages').insert({ status: 'returning' }).select('id').single();
      const messageId = data!.id;

      const { error } = await driverClient.rpc('mark_dispatch_message_arrived', { p_message_id: messageId });
      expect(error).toBeNull();

      const { data: row, error: readError } = await adminClient.from('dispatch_messages').select('status, eta_minutes').eq('id', messageId).single();
      expect(readError).toBeNull();
      expect(row?.status).toBe('arrived');
      expect(row?.eta_minutes).toBeNull();
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });

  it('mark_dispatch_message_arrived refuses to resolve someone else\'s message', async () => {
    const { driver, timeLogId, cleanup } = await openThrowawayDriver();
    try {
      const driverClient = await signInAs(driver);
      const { data } = await driverClient.from('dispatch_messages').insert({ status: 'returning' }).select('id').single();
      const messageId = data!.id;

      const employee1 = await signInAs(fixtures.orgA.employee1);
      await expectRpcBlocked(
        "employee1 resolving another driver's dispatch message",
        () => employee1.rpc('mark_dispatch_message_arrived', { p_message_id: messageId }),
        async () => {
          const { data: row, error } = await adminClient.from('dispatch_messages').select('status').eq('id', messageId).single();
          if (error || !row) throw new Error(error?.message ?? 'row missing on re-read');
          if (row.status !== 'returning') throw new Error(`status changed to ${row.status}`);
        }
      );
    } finally {
      await adminClient.from('dispatch_messages').delete().eq('time_log_id', timeLogId);
      await cleanup();
    }
  });
});
