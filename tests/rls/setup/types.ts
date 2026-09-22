// Shape of everything the fixture setup creates, passed from global-setup.ts
// to every test file via Vitest's provide()/inject(). Must stay
// JSON-serializable — no functions, no class instances, no Dates (use ISO
// strings if a timestamp is ever needed here).

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface OrgAFixture {
  orgId: string;
  orgSlug: string;
  locationA1Id: string;
  locationA2Id: string;
  roleNames: { administrator: string; manager: string; employee: string };

  admin: TestUser;
  deactivatedAdmin: TestUser;
  manager: TestUser;
  /** Location A1 — inside the manager's scope. */
  employee1: TestUser;
  /** Location A2 — outside the manager's scope. Target of every "outside their locations" case. */
  employee2: TestUser;
  /** Location A1, profiles.is_active = false. */
  deactivatedEmployee: TestUser;

  shiftEmployee1Id: string;
  shiftEmployee2Id: string;
  /** Unassigned, at A2, required_role = the Employee role — for shift_applications. */
  openShiftForApplicationId: string;

  /** Closed (clock_out set) time_logs, one per active user. */
  timeLogEmployee1Id: string;
  timeLogEmployee2Id: string;
  timeLogManagerId: string;
  timeLogAdminId: string;

  /** The list. Still holds title/location/assignment/start/due; status,
   *  completion and photos moved to task_items (0026). */
  taskEmployee1Id: string;
  taskEmployee2Id: string;
  /** The one item each fixture list is required to have. */
  taskItemEmployee1Id: string;
  taskItemEmployee2Id: string;
  taskCommentEmployee1Id: string;
  taskPhotoEmployee1Id: string;
  taskPhotoEmployee2Id: string;

  /** employee_notes rows — about employee1 and employee2 respectively. */
  noteEmployee1Id: string;
  noteEmployee2Id: string;

  wageRateEmployee1Id: string;
  wageRateEmployee2Id: string;

  notificationEmployee1Id: string;
  notificationEmployee2Id: string;

  /** requester = employee1, target = employee2. */
  shiftSwapId: string;
  /** employee2 applying to openShiftForApplicationId. */
  shiftApplicationId: string;
  /** Off timeLogEmployee2Id. */
  overtimeClaimEmployee2Id: string;
  unavailabilityRequestEmployee2Id: string;

  liveLocationEmployee1Id: string;
}

export interface OrgBFixture {
  orgId: string;
  orgSlug: string;
  locationId: string;

  admin: TestUser;
  employee: TestUser;

  shiftId: string;
  timeLogId: string;
  taskId: string;
  taskItemId: string;
  taskCommentId: string;
  taskPhotoId: string;
  noteId: string;
  wageRateId: string;
  notificationId: string;
  /** requester = employee, target = admin — Org B only has these two people. */
  shiftSwapId: string;
  openShiftForApplicationId: string;
  shiftApplicationId: string;
  overtimeClaimId: string;
  unavailabilityRequestId: string;
  liveLocationId: string;
}

export interface FixtureManifest {
  orgA: OrgAFixture;
  orgB: OrgBFixture;
}

declare module 'vitest' {
  export interface ProvidedContext {
    fixtures: FixtureManifest;
  }
}
