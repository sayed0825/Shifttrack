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
**Next up:**
1. Migrate hosting from Netlify to Cloudflare Pages (unlimited builds —
   Netlify's free tier build-minute cap has already blocked deploys once,
   see below).
2. Once deploys are flowing again, verify the responsive/iOS-safe-area
   pass and the map/bottom-nav z-index fix on a real iPhone — see "Known
   broken / unverified" below, neither has actually been confirmed yet.

Task module is complete and tested end to end on both sides (template
creation, instance generation, employee completion with and without a
required photo, manager review, rejection with a required comment, redo,
and approval all verified against real data). See the log below for what
that testing turned up and fixed.

**Known broken / unverified:**
- The responsive/iOS-safe-area pass (commit `e6c192f`) and the follow-up
  map z-index fix (commit `f79c2a9`) are committed and pushed but
  UNVERIFIED on a real device. Netlify had hit its free build-minute
  limit, so neither commit was ever actually deployed — the iPhone
  testing done against the live site was against a stale build that
  predates both fixes. Re-verify once hosting is migrated (see "Next up")
  — specifically the clock-tab map overlapping the bottom nav on iOS
  Safari, which is what these two commits were meant to fix
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
- Collapsible sections: `StaffManager` already collapses; other long
  manager sections (Roles, Locations, unavailability/shift-request
  lists) should get the same treatment where it makes sense
- Staff email isn't shown anywhere in the manager staff view
  (`StaffManager`) — would need a join or an admin API call, since
  email lives on `auth.users`, not `profiles`

---

## Log

### 2026-09-07 (yet later)
- Full responsive pass (iOS safe areas, `dvh` instead of `vh`, timesheet
  tables → stacked cards below `sm`, modal sheets capped at `90dvh` with
  safe-area padding on their action bars, tablet-width fixes). Specific
  target bug: the live map on `EmployeeDashboard`'s clock tab overlapping
  the bottom nav on iPhone Safari
- First pass fixed the spacing (nav padding, main's bottom padding) but
  the map was still painting over the nav — turned out to be z-index, not
  spacing: Leaflet's own panes/controls use z-index up to 1000, and
  `.leaflet-container` doesn't establish its own stacking context, so
  those values competed directly with page chrome. Fixed by wrapping both
  `LiveMap` usages in `relative z-0 isolate` to contain Leaflet's stacking,
  raising the fixed bottom nav to `z-[1100]`, and raising every modal
  (there are nine) plus the notification dropdown to `z-[1200]` so they
  still sit above both the nav and the map
- Both fixes pushed (`e6c192f`, `f79c2a9`) but turned out to be
  UNVERIFIED — see "Known broken / unverified" above. Netlify's free
  build-minute limit had been hit, so the site being tested on a phone
  was a stale build from before either commit
- Lesson: don't rely on a redeploy per iteration to test on a phone. Run
  `npm run dev -- --host` and open the printed Network URL on the phone
  (same Wi-Fi) instead — it reflects the working tree immediately, no
  build/deploy round-trip and no build-minute cost

### 2026-09-07 (even later)
- Task module tested end to end against real data: template creation,
  instance generation, employee completion (with and without a
  required photo), manager review, rejection with a required comment,
  redo, and approval all verified. Task module is now considered
  complete, not just code-complete
- Testing surfaced and fixed three bugs:
  - `task_templates.weekdays` is `NOT NULL` with a default of all
    seven days; the daily branch of the template-create form was
    sending `null` explicitly, which overrides the column default
    instead of falling back to it, and violates the constraint. Now
    sends `[0..6]` for daily; weekly still sends the selected days
  - Completing a rejected/pending task could report a false "someone
    else already completed this" on retry: the first tap's update
    succeeded but the card wasn't updated from the result, so a second
    tap found `status = 'submitted'` and read it as a shared-pool
    loss. `EmployeeTasks.tsx` now applies the row returned by the
    update directly to local state and refetches immediately; a
    zero-row update result is only reported as a real conflict after
    confirming the task wasn't already completed by this same user
  - Comment authors were resolving as "someone"/"Unknown" for a
    manager commenting on an employee's task, because the
    `profiles_select_same_role` RLS policy blocked reading a
    commenter's profile across roles. Replaced with
    `profiles_select_same_org` so any authenticated user can read
    every profile in their organisation; comment authors now resolve
    correctly. Checking `EmployeeShiftActions.tsx` for the same
    same-role assumption found the shift-swap peer list still relies
    on `shifts_select_same_role` RLS (unaffected, still same-role), so
    nothing there was exposed by the profiles change — added an
    explicit client-side role filter on the peer list anyway, RLS
    remains the real enforcement

### 2026-09-07 (later)
- Built the manager side of the task module: `ManagerTasks.tsx`, added
  to the manager More tab below the shift requests panel
- Review section: `status = 'submitted'` tasks joined to `completed_by`
  and `locations`; signed-url thumbnails (`createSignedUrl`, 1hr) from
  the private `task-photos` bucket with a full-screen lightbox;
  realtime subscription so new submissions show up live. Approve sets
  `approved` + `reviewed_by`/`reviewed_at`. Rejecting requires a
  comment — the comment is inserted into `task_comments` before the
  status update, specifically so a failed status update can never
  leave a task silently rejected with no explanation on record
- Task setup section: template list (title, role/individual target,
  time window, days, photo requirement) with an active/paused toggle
  and delete; a create-template modal (location, role-vs-individual
  segmented target picker, start/due time, daily/weekly recurrence
  with a Mon–Sun picker reusing the same weekday convention as
  `ManagerScheduler`, photo toggle); a separate one-off task modal that
  writes straight to `tasks` with a specific date instead of a
  template
- Both sections collapsible, same pattern as `StaffManager`. Not
  tested against real data yet (see "Known broken / unverified")

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
