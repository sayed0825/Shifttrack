# PROGRESS.md

Running log of what has actually been done. Keep it in the repo root.

**How to use it:** at the end of each Claude Code session, tell it
"update PROGRESS.md with what we did". At the start of a chat session,
paste the last few entries. This file is the handover — nothing else
travels between the two.

Newest entries at the top.

---

## Current state

**Phase:** 2 complete — multi-tenancy schema and RLS
**Next up:** Task module, manager side (schema, RLS, storage bucket and
cron jobs are already done; the employee view is built and pushed but
untested — full spec below, under "Next task: manager task view")

**Known broken / unverified:**
- Hardcoded Supabase credentials in `src/supabaseClient.js` — workaround
  for a Bolt bug, must move to environment variables
- SMTP not set up. Supabase's built-in mailer caps at a few emails per
  hour, nowhere near enough for 60 staff
- MapTiler key not domain-restricted
- `LiveMap` `DEFAULT_CENTER` is hardcoded to Essex — should derive from
  the org's own locations
- Late clock-in detection is implemented but UNTESTED — needs a real
  clock-in against a scheduled shift to verify the LATE badge, since
  manual SQL `time_logs` inserts have no `shift_id`
- Employee task view (`EmployeeTasks.tsx`) is built and pushed but
  UNTESTED — needs real task rows (from a template or manual insert)
  to verify grouping, the overdue/rejected badges, photo upload, the
  comment thread, and the shared-pool completion race
- Manager side of the task module (review/approve/reject queue,
  template management) has not been started
- Collapsible sections: `StaffManager` already collapses; other long
  manager sections (Roles, Locations, unavailability/shift-request
  lists) should get the same treatment where it makes sense
- Staff email isn't shown anywhere in the manager staff view
  (`StaffManager`) — would need a join or an admin API call, since
  email lives on `auth.users`, not `profiles`

---

## Next task: manager task view

The spec for this lives only in a chat session this file cannot see,
so it's recorded here in full rather than referenced.

Create `src/components/ManagerTasks.tsx`, taking `locations` as a prop.

**Section 1, Review:** tasks where `status = 'submitted'`, joined to
`completed_by` and `locations`. Show title, who completed it, when,
where. Photos are in a PRIVATE bucket, so use `createSignedUrl(path,
3600)` for thumbnails, with a full-screen lightbox. Approve sets
status `'approved'`, `reviewed_by`, `reviewed_at`. Request changes
sets `'rejected'` and REQUIRES a comment inserted into `task_comments`
in the same action — never allow rejection without explaining why.
Realtime subscription for new submissions.

**Section 2, Task setup:** list active `task_templates` with title,
target, time window, days, photo requirement; allow toggling
`is_active` and deleting. A create form: title, description, location,
target (segmented control for role vs individual, then the picker),
start and due time, recurrence daily/weekly, Mon–Sun picker for
weekly, `requires_photo` toggle. Roles from `useRoles`, staff from
`profiles`. Separately a one-off task form writing directly to `tasks`
with a specific date instead of a template. Note that instances are
generated hourly by cron.

Both sections collapsible. Add a Tasks entry to the manager More tab
below the shift requests panel. Theme tokens, lucide icons, 44px
targets, loading and error states.

---

## Log

### 2026-09-07
- Per-org roles complete: `roles` table (org_id, name, sort_order,
  is_protected, can_view_map), shared `useRoles` hook (module-scoped
  cache, one realtime channel for all consumers), role management UI
  in ManagerMoreTab (add, rename, reorder, delete, can_view_map
  toggle; `is_protected` roles can't be renamed or deleted)
- `profiles.role` is nullable now — handled everywhere it's displayed
  with a muted "No role" label, plus a warning badge in `StaffManager`
  for staff with no role assigned
- `can_view_map` per role replaces the hardcoded map-viewer role list
  in `EmployeeDashboard`
- Added late clock-in detection: `src/lib/lateness.ts` derives
  lateness from `clock_in` vs. the linked shift's `start_time` plus an
  org-level grace period (`src/hooks/useLateGrace.ts`, editable in
  ManagerMoreTab), LATE badge in both the manager and employee
  timesheet views. UNTESTED — needs a real clock-in against a
  scheduled shift; manual SQL `time_logs` inserts have no `shift_id`
  so they never trigger it
- Documented the `organisations` table and `org_id`/`my_org_id()` in
  CLAUDE.md; fixed two spots that had guessed at this schema before it
  was confirmed (`orgs` → `organisations`, manual profile lookup →
  `my_org_id()`)
- Manager notes on employee profiles: complete and tested.
  `EmployeeNotes.tsx` reads `employee_notes` (append-only, manager-only
  RLS, no UPDATE/DELETE policy for anyone) and lets a manager add a
  note; wired into `StaffManager`'s expanded staff panel, not into
  `EmployeeDashboard`
- Task module started: `task_templates`, `tasks`, `task_comments`
  tables, RLS, the private `task-photos` storage bucket, and the
  cron jobs (generation + monthly photo purge) are done on the
  database side. Documented in CLAUDE.md, including that a
  role-assigned task is a shared pool, not copied per person
- Built the employee side: `EmployeeTasks.tsx` (new Tasks tab, between
  Shifts and My Timesheets) groups today's tasks into due now /
  upcoming / done, with overdue and rejected badges, a bottom-sheet
  detail view with a realtime comment thread, and photo-required
  completion via the device camera input. Pushed but UNTESTED (see
  above) — manager side (review/approve/reject, template management)
  is the next task, spec already given

### 2026-09-02
- Phase 2 multi-tenancy: added `organisations` table, backfilled `org_id`
  across all tables
- Rewrote every RLS policy to scope by `my_org_id()`
- Updated triggers and RPCs for the new org scoping;
  `tg_handle_new_user` now sets `org_id`
- Verified isolation with a second test organisation — locations,
  staff, scheduler and map all correctly empty for org 2
- Known gap: job roles are hardcoded as a nine-item array in the
  frontend, need to become a per-organisation roles table (see below)
- Also noted: `LiveMap` `DEFAULT_CENTER` hardcoded to Essex, should
  derive from the org's own locations

### 2026-09-01
- Netlify now deploys from GitHub instead of Bolt
- Updated Supabase Site URL to the Netlify domain
- Verified the invite flow end to end from the Netlify site

### 2026-08-29
- Pushed the project from Bolt to GitHub (private repo)
- Installed Node, Claude Code, Xcode Command Line Tools
- Generated CLAUDE.md via /init, added project conventions
- Fixed the staff invite flow: `redirectTo` was pointing at the Edge
  Function's own origin and producing a redirect ending in a bare `#`,
  which broke the token fragment. Now reads the app origin from the
  request body

### 2026-08-28
- Built overtime claims: table, RLS, `decide_overtime_claim` RPC,
  employee claim form, manager approval panel
- Added staff management: role editing, location assignment,
  deactivate vs delete, collapsible section, location and role filters
- Added `delete_staff_member` RPC (cascades through auth.users)
- Added `pg_cron` job `sweep-open-shifts`, every 15 minutes
- Added offline clock-in queue (`src/lib/offlineQueue.js`)
- Live map narrowed to on-duty drivers only, manual refresh, no realtime
- Drivers push position every 90s while clocked in
- Deleted five orphaned files: ClockInCard, MapView, PlaceForm,
  PlaceList, lib/supabase, hooks/usePlaces
- Fixed: invite modal was calling `undefined/functions/v1/...` because
  `import.meta.env` is empty once credentials are hardcoded

---

## Decisions made

Record the reasoning, not just the choice. Future-you will want to know
why.

- **Deactivate over delete** as the default when staff leave — deleting
  a profile cascades to `time_logs` and erases payroll history
- **Multi-tenancy before real data** — retrofitting `org_id` across
  every table after months of payroll history is a high-risk migration
- **Native apps last** — accepted that browser tracking stops when a
  driver locks their phone
- **Staying on Netlify** — migrating hosts is effort with no benefit at
  this scale
- **Geofence enforced offline too** — distance is recalculated on-device
  against cached site coordinates, so an outage cannot be used to clock
  in from home
- **Shifts deleted before deactivating**, not after — if deletion fails,
  nothing changes at all

---

## Things that have bitten us before

- Bolt reported work it had not done, repeatedly. Verify with a search
  before testing.
- Fixes were applied to files that nothing rendered. Check what actually
  imports a component before editing it.
- Friendly error messages hid the real cause three separate times.
  Surface the raw error first, make it friendly after.
- The Bolt preview iframe blocks external resources. Test map and
  network changes on the published site.
- DST: build each recurring occurrence from calendar fields. Adding
  `7 * 86400000` ms shifts every date past a boundary by an hour.
