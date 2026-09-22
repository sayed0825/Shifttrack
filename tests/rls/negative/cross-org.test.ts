import { describe, it, beforeAll, inject } from 'vitest';
import { signInAs } from '../setup/clients';
import { expectNoRows } from '../setup/assert';
import type { SupabaseClient } from '@supabase/supabase-js';

const fixtures = inject('fixtures');

// Every org-scoped table, checked in both directions. Administrator is the
// prober on both sides deliberately: is_admin() only ever grants *more*
// access *within* an admin's own org (bypassing manages_location()-style
// checks) — it never touches the org_id boundary itself, which every
// single policy in the schema ANDs in regardless of role. If the
// highest-privileged role in an org can't see across the boundary, nothing
// in that org can.
const ORG_SCOPED_TABLES = [
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
  'roles',
  'employee_notes',
  'task_templates',
  'task_template_items',
  'tasks',
  'task_items',
  'task_comments',
  'task_photos',
  'staff_wage_rates',
  'org_pay_settings',
  'delivery_runs',
  'delivery_drops',
];

describe('cross-org isolation', () => {
  let adminA: SupabaseClient;
  let adminB: SupabaseClient;

  beforeAll(async () => {
    adminA = await signInAs(fixtures.orgA.admin);
    adminB = await signInAs(fixtures.orgB.admin);
  });

  it.each(ORG_SCOPED_TABLES)("Org A's admin cannot read Org B's %s", async (table) => {
    const result = await adminA.from(table).select('id').eq('org_id', fixtures.orgB.orgId);
    expectNoRows(result, `Org A admin reading ${table} filtered to Org B's org_id`);
  });

  it.each(ORG_SCOPED_TABLES)("Org B's admin cannot read Org A's %s", async (table) => {
    const result = await adminB.from(table).select('id').eq('org_id', fixtures.orgA.orgId);
    expectNoRows(result, `Org B admin reading ${table} filtered to Org A's org_id`);
  });

  it("Org A's admin cannot read Org B's organisations row", async () => {
    const result = await adminA.from('organisations').select('id').eq('id', fixtures.orgB.orgId);
    expectNoRows(result, "Org A admin reading Org B's organisations row");
  });

  it("Org B's admin cannot read Org A's organisations row", async () => {
    const result = await adminB.from('organisations').select('id').eq('id', fixtures.orgA.orgId);
    expectNoRows(result, "Org B admin reading Org A's organisations row");
  });
});
