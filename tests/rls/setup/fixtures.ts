import { randomUUID } from 'node:crypto';
import { adminClient } from './env';
import { ORG_A_NAME, ORG_A_SLUG, ORG_B_NAME, ORG_B_SLUG, EMAIL_DOMAIN } from './constants';
import type { FixtureManifest, OrgAFixture, OrgBFixture, TestUser } from './types';

function mustSucceed<T>(result: { data: T | null; error: { message: string } | null }, label: string): T {
  if (result.error) {
    throw new Error(`Fixture setup failed — ${label}: ${result.error.message}`);
  }
  if (result.data == null) {
    throw new Error(`Fixture setup failed — ${label}: no data returned`);
  }
  return result.data;
}

function password(): string {
  return `Rls-Test-${randomUUID()}!`;
}

async function createOrg(name: string, slug: string): Promise<string> {
  const result = await adminClient.from('organisations').insert({ name, slug, is_active: true }).select('id').single();
  return mustSucceed(result, `create organisation "${name}"`).id;
}

interface RoleNames {
  administrator: string;
  manager: string;
  employee: string;
}

/** Role rows are per-org. is_manager()/is_admin() join profiles.role to
 *  roles.name within the same org, so these must exist before any user's
 *  `role` column is set to one of these names. */
async function createRoles(orgId: string, includeManager: boolean): Promise<RoleNames> {
  const rows = [
    { org_id: orgId, name: 'Administrator', sort_order: 1, is_admin: true, can_manage: true },
    ...(includeManager ? [{ org_id: orgId, name: 'Manager', sort_order: 2, is_admin: false, can_manage: true }] : []),
    { org_id: orgId, name: 'Employee', sort_order: 3, is_admin: false, can_manage: false },
  ];
  const result = await adminClient.from('roles').insert(rows).select('name');
  mustSucceed({ data: result.data ?? [], error: result.error }, `create roles for org ${orgId}`);
  return { administrator: 'Administrator', manager: 'Manager', employee: 'Employee' };
}

async function createLocation(orgId: string, name: string): Promise<string> {
  const result = await adminClient
    .from('locations')
    .insert({ org_id: orgId, name, latitude: 51.5, longitude: -0.1, radius_meters: 100, is_active: true })
    .select('id')
    .single();
  return mustSucceed(result, `create location "${name}"`).id;
}

interface CreateUserArgs {
  orgId: string;
  emailLocalPart: string;
  fullName: string;
  role: string;
  isActive?: boolean;
}

/**
 * Creates a confirmed auth user (so it can sign in immediately, no email
 * round-trip) and lets the `on_auth_user_created` trigger create the
 * matching `profiles` row — passing `org_id` in user_metadata so that row
 * lands in the right *test* org rather than the trigger's real-org
 * fallback (`slug = 'org-1'`). Then updates role/is_active, which the
 * trigger doesn't set.
 */
async function createUser({ orgId, emailLocalPart, fullName, role, isActive = true }: CreateUserArgs): Promise<TestUser> {
  const email = `${emailLocalPart}@${EMAIL_DOMAIN}`;
  const pass = password();

  const created = await adminClient.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
    user_metadata: { org_id: orgId, full_name: fullName, first_name: fullName.split(' ')[0] },
  });
  if (created.error || !created.data.user) {
    throw new Error(`Fixture setup failed — create auth user ${email}: ${created.error?.message ?? 'no user returned'}`);
  }
  const id = created.data.user.id;

  const updated = await adminClient.from('profiles').update({ role, is_active: isActive }).eq('id', id).select('id').single();
  mustSucceed(updated, `set role/is_active for ${email}`);

  return { id, email, password: pass };
}

async function assignLocation(profileId: string, locationId: string, orgId: string, isPrimary: boolean): Promise<void> {
  const { error } = await adminClient
    .from('profile_locations')
    .insert({ profile_id: profileId, location_id: locationId, org_id: orgId, is_primary: isPrimary });
  if (error) throw new Error(`Fixture setup failed — assign location: ${error.message}`);
}

interface ShiftArgs {
  orgId: string;
  locationId: string;
  assignedUserId?: string | null;
  requiredRole?: string | null;
  startsInHours: number;
  durationHours: number;
}

async function createShift({ orgId, locationId, assignedUserId = null, requiredRole = null, startsInHours, durationHours }: ShiftArgs): Promise<string> {
  const start = new Date(Date.now() + startsInHours * 3_600_000);
  const end = new Date(start.getTime() + durationHours * 3_600_000);
  const result = await adminClient
    .from('shifts')
    .insert({
      org_id: orgId,
      title: 'RLS fixture shift',
      location_id: locationId,
      assigned_user_id: assignedUserId,
      required_role: requiredRole,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    })
    .select('id')
    .single();
  return mustSucceed(result, 'create shift').id;
}

interface TimeLogArgs {
  orgId: string;
  userId: string;
  locationId: string;
  shiftId?: string | null;
  roleAtClockIn: string;
}

/** Always closed (clock_out set) — every fixture time_log needs a settled
 *  duration for cost/hours calculations elsewhere not to choke, and the
 *  "own closed log" positive case needs one that's actually closed. */
async function createClosedTimeLog({ orgId, userId, locationId, shiftId = null, roleAtClockIn }: TimeLogArgs): Promise<string> {
  const clockIn = new Date(Date.now() - 6 * 3_600_000);
  const clockOut = new Date(Date.now() - 2 * 3_600_000);
  const result = await adminClient
    .from('time_logs')
    .insert({
      org_id: orgId,
      user_id: userId,
      location_id: locationId,
      shift_id: shiftId,
      clock_in: clockIn.toISOString(),
      clock_out: clockOut.toISOString(),
      role_at_clock_in: roleAtClockIn,
    })
    .select('id')
    .single();
  return mustSucceed(result, 'create time log').id;
}

interface TaskArgs {
  orgId: string;
  locationId: string;
  assignedUserId: string;
}

async function createTask({ orgId, locationId, assignedUserId }: TaskArgs): Promise<string> {
  const start = new Date(Date.now() - 3_600_000);
  const due = new Date(Date.now() + 3_600_000);
  const result = await adminClient
    .from('tasks')
    .insert({
      org_id: orgId,
      location_id: locationId,
      title: 'RLS fixture task',
      assigned_user_id: assignedUserId,
      start_time: start.toISOString(),
      due_time: due.toISOString(),
      status: 'pending',
    })
    .select('id')
    .single();
  return mustSucceed(result, 'create task').id;
}

async function createTaskComment(orgId: string, taskId: string, senderId: string): Promise<string> {
  const result = await adminClient
    .from('task_comments')
    .insert({ org_id: orgId, task_id: taskId, sender_id: senderId, comment_text: 'RLS fixture comment' })
    .select('id')
    .single();
  return mustSucceed(result, 'create task comment').id;
}

async function createNote(orgId: string, employeeId: string, managerId: string): Promise<string> {
  const result = await adminClient
    .from('employee_notes')
    .insert({ org_id: orgId, employee_id: employeeId, manager_id: managerId, note_text: 'RLS fixture note' })
    .select('id')
    .single();
  return mustSucceed(result, 'create employee note').id;
}

async function createWageRate(orgId: string, profileId: string, createdBy: string): Promise<string> {
  const effectiveFrom = new Date().toISOString().slice(0, 10);
  const result = await adminClient
    .from('staff_wage_rates')
    .insert({ org_id: orgId, profile_id: profileId, hourly_rate: 15.5, effective_from: effectiveFrom, created_by: createdBy })
    .select('id')
    .single();
  return mustSucceed(result, 'create wage rate').id;
}

async function createNotification(orgId: string, userId: string): Promise<string> {
  const result = await adminClient
    .from('notifications')
    .insert({ org_id: orgId, user_id: userId, type: 'shift_changed', title: 'RLS fixture notification' })
    .select('id')
    .single();
  return mustSucceed(result, 'create notification').id;
}

async function createShiftSwap(orgId: string, requesterId: string, requesterShiftId: string, targetId: string, targetShiftId: string): Promise<string> {
  const result = await adminClient
    .from('shift_swaps')
    .insert({
      org_id: orgId,
      requester_id: requesterId,
      requester_shift_id: requesterShiftId,
      target_id: targetId,
      target_shift_id: targetShiftId,
      status: 'pending_manager',
    })
    .select('id')
    .single();
  return mustSucceed(result, 'create shift swap').id;
}

async function createShiftApplication(orgId: string, shiftId: string, userId: string): Promise<string> {
  const result = await adminClient
    .from('shift_applications')
    .insert({ org_id: orgId, shift_id: shiftId, user_id: userId })
    .select('id')
    .single();
  return mustSucceed(result, 'create shift application').id;
}

async function createOvertimeClaim(orgId: string, userId: string, timeLogId: string): Promise<string> {
  const result = await adminClient
    .from('overtime_claims')
    .insert({ org_id: orgId, user_id: userId, time_log_id: timeLogId, status: 'pending', reason: 'RLS fixture claim' })
    .select('id')
    .single();
  return mustSucceed(result, 'create overtime claim').id;
}

async function createUnavailability(orgId: string, userId: string): Promise<string> {
  const start = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
  const result = await adminClient
    .from('unavailability_requests')
    .insert({ org_id: orgId, user_id: userId, start_date: start, end_date: end, reason: 'RLS fixture', status: 'pending' })
    .select('id')
    .single();
  return mustSucceed(result, 'create unavailability request').id;
}

async function createLiveLocation(orgId: string, userId: string): Promise<string> {
  const result = await adminClient
    .from('live_locations')
    .insert({ org_id: orgId, user_id: userId, latitude: 51.5, longitude: -0.1 })
    .select('id')
    .single();
  return mustSucceed(result, 'create live location').id;
}

// ---------------------------------------------------------------------------

async function buildOrgA(): Promise<OrgAFixture> {
  const orgId = await createOrg(ORG_A_NAME, ORG_A_SLUG);
  const roleNames = await createRoles(orgId, true);
  const locationA1Id = await createLocation(orgId, 'RLS Test Location A1');
  const locationA2Id = await createLocation(orgId, 'RLS Test Location A2');

  const admin = await createUser({ orgId, emailLocalPart: 'org-a-admin', fullName: 'Org A Admin', role: roleNames.administrator });
  const deactivatedAdmin = await createUser({
    orgId,
    emailLocalPart: 'org-a-deactivated-admin',
    fullName: 'Org A Deactivated Admin',
    role: roleNames.administrator,
    isActive: false,
  });
  const manager = await createUser({ orgId, emailLocalPart: 'org-a-manager', fullName: 'Org A Manager', role: roleNames.manager });
  const employee1 = await createUser({ orgId, emailLocalPart: 'org-a-employee-1', fullName: 'Org A Employee One', role: roleNames.employee });
  const employee2 = await createUser({ orgId, emailLocalPart: 'org-a-employee-2', fullName: 'Org A Employee Two', role: roleNames.employee });
  const deactivatedEmployee = await createUser({
    orgId,
    emailLocalPart: 'org-a-deactivated-employee',
    fullName: 'Org A Deactivated Employee',
    role: roleNames.employee,
    isActive: false,
  });

  // The manager's scope is A1 only — employee2 (A2) is deliberately outside
  // it, and is the target of every "outside their locations" negative case.
  await assignLocation(manager.id, locationA1Id, orgId, true);
  await assignLocation(employee1.id, locationA1Id, orgId, true);
  await assignLocation(employee2.id, locationA2Id, orgId, true);
  await assignLocation(deactivatedEmployee.id, locationA1Id, orgId, true);

  const shiftEmployee1Id = await createShift({ orgId, locationId: locationA1Id, assignedUserId: employee1.id, startsInHours: -24, durationHours: 6 });
  const shiftEmployee2Id = await createShift({ orgId, locationId: locationA2Id, assignedUserId: employee2.id, startsInHours: -24, durationHours: 6 });
  const openShiftForApplicationId = await createShift({
    orgId,
    locationId: locationA2Id,
    requiredRole: roleNames.employee,
    startsInHours: 48,
    durationHours: 6,
  });

  const timeLogEmployee1Id = await createClosedTimeLog({ orgId, userId: employee1.id, locationId: locationA1Id, shiftId: shiftEmployee1Id, roleAtClockIn: roleNames.employee });
  const timeLogEmployee2Id = await createClosedTimeLog({ orgId, userId: employee2.id, locationId: locationA2Id, shiftId: shiftEmployee2Id, roleAtClockIn: roleNames.employee });
  const timeLogManagerId = await createClosedTimeLog({ orgId, userId: manager.id, locationId: locationA1Id, roleAtClockIn: roleNames.manager });
  const timeLogAdminId = await createClosedTimeLog({ orgId, userId: admin.id, locationId: locationA1Id, roleAtClockIn: roleNames.administrator });

  const taskEmployee1Id = await createTask({ orgId, locationId: locationA1Id, assignedUserId: employee1.id });
  const taskEmployee2Id = await createTask({ orgId, locationId: locationA2Id, assignedUserId: employee2.id });
  const taskCommentEmployee1Id = await createTaskComment(orgId, taskEmployee1Id, employee1.id);

  const noteEmployee1Id = await createNote(orgId, employee1.id, manager.id);
  const noteEmployee2Id = await createNote(orgId, employee2.id, admin.id);

  const wageRateEmployee1Id = await createWageRate(orgId, employee1.id, admin.id);
  const wageRateEmployee2Id = await createWageRate(orgId, employee2.id, admin.id);

  const notificationEmployee1Id = await createNotification(orgId, employee1.id);
  const notificationEmployee2Id = await createNotification(orgId, employee2.id);

  const shiftSwapId = await createShiftSwap(orgId, employee1.id, shiftEmployee1Id, employee2.id, shiftEmployee2Id);
  const shiftApplicationId = await createShiftApplication(orgId, openShiftForApplicationId, employee2.id);
  const overtimeClaimEmployee2Id = await createOvertimeClaim(orgId, employee2.id, timeLogEmployee2Id);
  const unavailabilityRequestEmployee2Id = await createUnavailability(orgId, employee2.id);
  const liveLocationEmployee1Id = await createLiveLocation(orgId, employee1.id);

  return {
    orgId,
    orgSlug: ORG_A_SLUG,
    locationA1Id,
    locationA2Id,
    roleNames,
    admin,
    deactivatedAdmin,
    manager,
    employee1,
    employee2,
    deactivatedEmployee,
    shiftEmployee1Id,
    shiftEmployee2Id,
    openShiftForApplicationId,
    timeLogEmployee1Id,
    timeLogEmployee2Id,
    timeLogManagerId,
    timeLogAdminId,
    taskEmployee1Id,
    taskEmployee2Id,
    taskCommentEmployee1Id,
    noteEmployee1Id,
    noteEmployee2Id,
    wageRateEmployee1Id,
    wageRateEmployee2Id,
    notificationEmployee1Id,
    notificationEmployee2Id,
    shiftSwapId,
    shiftApplicationId,
    overtimeClaimEmployee2Id,
    unavailabilityRequestEmployee2Id,
    liveLocationEmployee1Id,
  };
}

async function buildOrgB(): Promise<OrgBFixture> {
  const orgId = await createOrg(ORG_B_NAME, ORG_B_SLUG);
  const roleNames = await createRoles(orgId, false);
  const locationId = await createLocation(orgId, 'RLS Test Location B1');

  const admin = await createUser({ orgId, emailLocalPart: 'org-b-admin', fullName: 'Org B Admin', role: roleNames.administrator });
  const employee = await createUser({ orgId, emailLocalPart: 'org-b-employee', fullName: 'Org B Employee', role: roleNames.employee });

  await assignLocation(admin.id, locationId, orgId, true);
  await assignLocation(employee.id, locationId, orgId, true);

  const shiftId = await createShift({ orgId, locationId, assignedUserId: employee.id, startsInHours: -24, durationHours: 6 });
  const adminShiftId = await createShift({ orgId, locationId, assignedUserId: admin.id, startsInHours: -24, durationHours: 6 });
  const openShiftForApplicationId = await createShift({ orgId, locationId, requiredRole: roleNames.employee, startsInHours: 48, durationHours: 6 });

  const timeLogId = await createClosedTimeLog({ orgId, userId: employee.id, locationId, shiftId, roleAtClockIn: roleNames.employee });

  const taskId = await createTask({ orgId, locationId, assignedUserId: employee.id });
  const taskCommentId = await createTaskComment(orgId, taskId, employee.id);

  const noteId = await createNote(orgId, employee.id, admin.id);
  const wageRateId = await createWageRate(orgId, employee.id, admin.id);
  const notificationId = await createNotification(orgId, employee.id);

  // Cross-org isolation coverage only (see fixtures README note in
  // global-setup.ts) — Org B doesn't need a location-scoped manager, so
  // these rows exist purely so the "every table" sweep has something real
  // to confirm Org A can't see, not to exercise any RPC against them.
  const shiftSwapId = await createShiftSwap(orgId, employee.id, shiftId, admin.id, adminShiftId);
  const shiftApplicationId = await createShiftApplication(orgId, openShiftForApplicationId, employee.id);
  const overtimeClaimId = await createOvertimeClaim(orgId, employee.id, timeLogId);
  const unavailabilityRequestId = await createUnavailability(orgId, employee.id);
  const liveLocationId = await createLiveLocation(orgId, employee.id);

  return {
    orgId,
    orgSlug: ORG_B_SLUG,
    locationId,
    admin,
    employee,
    shiftId,
    timeLogId,
    taskId,
    taskCommentId,
    noteId,
    wageRateId,
    notificationId,
    shiftSwapId,
    openShiftForApplicationId,
    shiftApplicationId,
    overtimeClaimId,
    unavailabilityRequestId,
    liveLocationId,
  };
}

export async function createFixtures(): Promise<FixtureManifest> {
  const orgA = await buildOrgA();
  const orgB = await buildOrgB();
  return { orgA, orgB };
}
