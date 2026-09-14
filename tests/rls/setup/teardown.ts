import { adminClient } from './env';
import type { FixtureManifest, TestUser } from './types';

interface Failure {
  step: string;
  message: string;
}

/**
 * Explicit, ordered deletes rather than relying on cascade behaviour —
 * some profile-owned rows cascade on profile delete (time_logs,
 * employee_notes, staff_wage_rates, ...), others use ON DELETE SET NULL
 * (shifts.assigned_user_id, tasks.assigned_user_id/completed_by/
 * reviewed_by/created_by), so deleting profiles first would silently
 * orphan shifts and tasks rather than remove them. Deleting every table
 * by org_id directly, children before parents, sidesteps needing to get
 * that distinction right table by table.
 *
 * Best-effort: every step runs even if an earlier one fails, and every
 * failure is collected rather than thrown immediately — a teardown that
 * aborts halfway leaves a bigger mess than one that finishes with a
 * reported gap. All failures are thrown together at the end so a broken
 * teardown is loud, not silent (see the collision guard, which exists
 * because of exactly this scenario).
 */
export async function teardownFixtures(fixtures: FixtureManifest): Promise<void> {
  const failures: Failure[] = [];

  const run = async (step: string, fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    try {
      const { error } = await fn();
      if (error) failures.push({ step, message: error.message });
    } catch (err) {
      failures.push({ step, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const deleteByOrg = (table: string, orgId: string) => run(`delete ${table} (org ${orgId})`, () => adminClient.from(table).delete().eq('org_id', orgId));

  const orgIds = [fixtures.orgA.orgId, fixtures.orgB.orgId];

  const tablesInDependencyOrder = [
    'task_comments',
    'tasks',
    'task_templates',
    'notifications',
    'shift_applications',
    'shift_swaps',
    'overtime_claims',
    'unavailability_requests',
    'live_locations',
    'time_logs',
    'staff_wage_rates',
    'employee_notes',
    'profile_locations',
    'shifts',
    'locations',
    'roles',
    'profiles',
  ];

  for (const table of tablesInDependencyOrder) {
    for (const orgId of orgIds) {
      await deleteByOrg(table, orgId);
    }
  }

  const users: TestUser[] = [
    fixtures.orgA.admin,
    fixtures.orgA.deactivatedAdmin,
    fixtures.orgA.manager,
    fixtures.orgA.employee1,
    fixtures.orgA.employee2,
    fixtures.orgA.deactivatedEmployee,
    fixtures.orgB.admin,
    fixtures.orgB.employee,
  ];

  for (const user of users) {
    await run(`delete auth user ${user.email}`, async () => {
      const { error } = await adminClient.auth.admin.deleteUser(user.id);
      return { error: error ? { message: error.message } : null };
    });
  }

  for (const orgId of orgIds) {
    await run(`delete organisation ${orgId}`, () => adminClient.from('organisations').delete().eq('id', orgId));
  }

  if (failures.length > 0) {
    const summary = failures.map((f) => `  - ${f.step}: ${f.message}`).join('\n');
    throw new Error(
      `Teardown finished with ${failures.length} failure(s) — some fixture data may remain in the ` +
        `live database and need manual cleanup:\n${summary}`
    );
  }
}
