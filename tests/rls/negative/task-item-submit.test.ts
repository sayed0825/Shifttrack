import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';
import { expectWriteBlocked } from '../setup/assert';

const fixtures = inject('fixtures');

/**
 * tg_protect_task_item_submit (0034) — security audit finding 5:
 * task_items_submit's with_check only ever constrained `status`.
 * Confirmed live before the fix: in the same UPDATE meant to submit their
 * own work, an assignee could also set completed_by to a DIFFERENT real
 * profile, and rewrite the item's own definition (is_required: false,
 * max_photos: 9) — both with zero error.
 *
 * Each test opens its own throwaway task/item rather than touching the
 * shared taskItemEmployee1Id fixture, which other tests depend on
 * staying 'pending'.
 */
describe('task_items — the submit path cannot touch the item definition or spoof completed_by', () => {
  async function openThrowawayItem(): Promise<{ taskId: string; itemId: string }> {
    const { data: task, error: taskError } = await adminClient
      .from('tasks')
      .insert({
        org_id: fixtures.orgA.orgId,
        location_id: fixtures.orgA.locationA1Id,
        title: 'RLS throwaway task',
        assigned_user_id: fixtures.orgA.employee1.id,
        start_time: new Date(Date.now() - 3_600_000).toISOString(),
        due_time: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .select('id')
      .single();
    if (taskError || !task) throw new Error(`fixture task create failed: ${taskError?.message}`);

    const { data: item, error: itemError } = await adminClient
      .from('task_items')
      .insert({ org_id: fixtures.orgA.orgId, task_id: task.id, title: 'RLS throwaway item', is_required: true, requires_photo: false, max_photos: 1 })
      .select('id')
      .single();
    if (itemError || !item) throw new Error(`fixture task item create failed: ${itemError?.message}`);

    return { taskId: task.id, itemId: item.id };
  }

  it('an assignee submitting cannot also rewrite the item definition', async () => {
    const { taskId, itemId } = await openThrowawayItem();
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      await expectWriteBlocked(
        'employee submitting while also editing is_required/max_photos',
        () => employee1.from('task_items').update({ status: 'submitted', is_required: false, max_photos: 9 }).eq('id', itemId),
        async () => {
          const { data, error } = await adminClient.from('task_items').select('status, is_required, max_photos').eq('id', itemId).single();
          if (error || !data) throw new Error(error?.message ?? 'row missing on re-read');
          if (data.status !== 'pending' || data.is_required !== true || data.max_photos !== 1) {
            throw new Error(`item changed: ${JSON.stringify(data)}`);
          }
        }
      );
    } finally {
      await adminClient.from('tasks').delete().eq('id', taskId);
    }
  });

  it('an assignee submitting cannot spoof completed_by to another user', async () => {
    const { taskId, itemId } = await openThrowawayItem();
    try {
      const employee1 = await signInAs(fixtures.orgA.employee1);
      const { error } = await employee1
        .from('task_items')
        .update({ status: 'submitted', completed_by: fixtures.orgA.employee2.id })
        .eq('id', itemId);
      expect(error).toBeNull(); // the submit itself succeeds — completed_by is just force-derived, not rejected

      const { data, error: readError } = await adminClient.from('task_items').select('status, completed_by').eq('id', itemId).single();
      if (readError || !data) throw new Error(`readback failed: ${readError?.message}`);
      expect(data.status).toBe('submitted');
      expect(data.completed_by).toBe(fixtures.orgA.employee1.id);
    } finally {
      await adminClient.from('tasks').delete().eq('id', taskId);
    }
  });

  it('a manager CAN edit the item definition', async () => {
    const { taskId, itemId } = await openThrowawayItem();
    try {
      const manager = await signInAs(fixtures.orgA.manager);
      const { error } = await manager.from('task_items').update({ is_required: false, max_photos: 5 }).eq('id', itemId);
      expect(error).toBeNull();
      const { data, error: readError } = await adminClient.from('task_items').select('is_required, max_photos').eq('id', itemId).single();
      if (readError || !data) throw new Error(`readback failed: ${readError?.message}`);
      expect(data.is_required).toBe(false);
      expect(data.max_photos).toBe(5);
    } finally {
      await adminClient.from('tasks').delete().eq('id', taskId);
    }
  });
});
