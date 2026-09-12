# PROGRESS.md

Running log of what has actually been done. Keep it in the repo root.

**How to use it:** at the end of each Claude Code session, tell it
"update PROGRESS.md with what we did". At the start of a chat session,
paste the last few entries. This file is the handover — nothing else
travels between the two.

Newest entries at the top.

---

## Current state

**Phase:** 2d complete — multi-tenancy schema and RLS (2a), capability-flag
permissions rebuild (2b), full schema baseline dumped to
`supabase/migrations/0001_baseline.sql` (2c), SMTP + Cloudflare hosting +
custom domain + pending-invite handling all live and verified (2d). The
repo is now the source of truth for schema, not Supabase — see CLAUDE.md.
**Next up:**
1. **Set `VITE_SENTRY_DSN` in Cloudflare Pages' build environment
   variables** — Sentry is wired up in the app (see log below) but the
   production build has no DSN until this is set there; until then it
   builds with error reporting silently disabled.
2. **Phase 3 hardening, remaining**: Supabase Pro for point-in-time
   backups, UptimeRobot, an index review. The security review found 18
   issues (3 CRITICAL, 2 HIGH, 8 MEDIUM, 5 LOW/hygiene). Fixed so far
   (migrations 0006–0008, see log below): both HIGH findings, one of the
   three CRITICALs (profile_locations location-scoping), and both LOW
   grant-hygiene findings. **Two CRITICALs are still open and unfixed**:
   task-photos storage has no org/task scoping (any authenticated user on
   the platform can read or overwrite another org's task photos), and
   notify_org_managers()/notify_location_managers() are still callable by
   anon with arbitrary org_id and attacker-controlled title/body — these
   are the next priority, ahead of the remaining MEDIUM/LOW items.
3. **Phase 4 testing**, starting with automated RLS tests.
4. Real-device check of the branding + visual redesign pass pushed
   2026-09-09 (see log below) — NOT YET REVIEWED on a real device, unlike
   everything else in this file so far.
5. Wire `organisations.primary_colour` into actual theming — it's
   fetched by `useOrganisation` but nothing consumes it yet; the app is
   still hardcoded to brand green (#14532D) everywhere.
6. The purged-photo fallback in Task History (a task older than the
   one-month photo-purge cron, where the signed URL request should fail
   gracefully) hasn't actually been exercised. Needs a task old enough
   for the purge to have already run against it.

Task module is complete and tested end to end on both sides (template
creation, instance generation, employee completion with and without a
required photo, manager review, rejection with a required comment, redo,
and approval all verified against real data). Manager task tooling has
since grown well past the original spec — see the log below.

**Known broken / unverified:**
- Branding (logo upload, org name, `useOrganisation`) and the visual
  redesign pass (design tokens, header bar, status colour, Archivo) are
  pushed but UNREVIEWED — no real device check yet. Also: the
  per-screen restraint pass (checking every screen actually follows the
  new design-system rules, not just the ones touched directly) was not
  exhaustive.
- `organisations.primary_colour` is fetched by `useOrganisation` but not
  wired into theming anywhere yet.
- The purged-photo fallback in Task History — see "Next up" above.
- Hardcoded Supabase credentials in `src/supabaseClient.js` — workaround
  for a Bolt bug, must move to environment variables
- A new sending domain (kitescheduling.com, via Resend) lands in spam
  until its reputation builds — tell staff to check junk during
  onboarding until that settles.
- MapTiler key not domain-restricted
- `LiveMap` `DEFAULT_CENTER` is hardcoded to Essex — should derive from
  the org's own locations
- Late clock-in detection is implemented but UNTESTED — needs a real
  clock-in against a scheduled shift to verify the LATE badge, since
  manual SQL `time_logs` inserts have no `shift_id`

---

## Log

### 2026-09-12
- **Sentry error monitoring added** (`@sentry/react`, initialised in
  `src/main.tsx` before the app renders). `environment` set from
  `import.meta.env.MODE`; tracing at a 10% sample rate; session replay
  deliberately never enabled — this app shows payroll data, employee
  locations and manager notes on screen, and replay records what a user
  does. `src/lib/sentryScrub.ts` strips emails, names, coordinates, and
  `employee_notes` content out of every event (`beforeSend` and
  `beforeSendTransaction`) before it leaves the browser, since Sentry is
  a third party. The whole app is wrapped in `Sentry.ErrorBoundary`
  (`src/components/ErrorFallback.tsx`) showing a plain "Something went
  wrong, please reload" instead of a blank screen on a crash. DSN reads
  from `VITE_SENTRY_DSN` (`.env`, gitignored; `.env.example` added to
  document it) — **still needs setting in Cloudflare Pages' build
  environment variables**, or the production build has no DSN and runs
  with error reporting silently disabled.
- **Phase 3 security review fixes** (migrations 0006–0008, run against
  the live database; not separately logged when they landed, so
  recorded here): the two HIGH findings (five pg_cron-only functions
  reachable by anon with no permission check, destructively in two
  cases; org-logos storage writes with no org scoping) and one of three
  CRITICALs (profile_locations writes with no manages_location() check
  at all, letting a location-scoped Manager reassign any staff member to
  any location) are fixed. A least-privilege grants pass
  (migration 0007) also revoked anon/PUBLIC execute from every internal
  helper function that had it, down to authenticated-only where the app
  or an RLS policy actually needs it, or no grant at all where neither
  does. Two CRITICALs remain open — see "Next up" above.

### 2026-09-11 (later)
Phase 2d complete — the infrastructure and pending-invite loose ends
from Phase 2 are closed out and verified, not just pushed.

- **SMTP confirmed live**: Resend, on the `kitescheduling.com` domain,
  sending from `hello@kitescheduling.com`. Invites deliver. A new
  sending domain lands in spam until its reputation builds — tell staff
  to check junk during onboarding (see "Known broken" above) until that
  settles.
- **Hosting moved Netlify → Cloudflare, confirmed end to end**: custom
  domain `app.kitescheduling.com` is live, and the Supabase Site URL and
  Redirect URLs are updated to match it. Added the `https://`-prefix
  trap to CLAUDE.md's Known traps — saved without it, Supabase treats
  the value as a relative path and every invite/magic-link email goes
  out with a broken redirect.
- **Migration 0004 run, and the pending-invite feature verified
  working**: `profiles.accepted_at` mirrors
  `auth.users.email_confirmed_at`; the Pending badge, Resend invite
  control, and exclusion from the scheduler/task/swap pickers all
  confirmed working (previously pushed 2026-09-11 but unverified — see
  the entry below this one).
- **`role_at_clock_in`** wired through clock-in, the offline queue, and
  the payroll report (previously logged in detail below — recapping here
  since it closes out under this same phase).
- **`0001_baseline.sql` frozen as of 2026-09-09** — every schema change
  since lives only in its own numbered migration (previously logged in
  detail below).

### 2026-09-11
- **SMTP live**: Resend, on the `kitescheduling.com` domain, sending from
  `hello@kitescheduling.com`. Invites now actually deliver — the
  long-standing blocker (Supabase's built-in mailer capped at a few
  emails an hour) is cleared. Known wrinkle: a brand-new sending domain
  lands in spam until its reputation builds, so early invites may need
  telling people to check there.
- **Hosting confirmed on Cloudflare.**
- **`profiles.accepted_at`** (`0004_pending_invites.sql`) run and
  verified: mirrors `auth.users.email_confirmed_at`, so the app can tell
  a genuinely-active account from one that has never accepted its
  invite.
- Pushed the app side of pending invites: a muted "Pending" badge and a
  Resend control in `StaffManager` (re-POSTs to the `invite-staff` Edge
  Function for that email), the section header now reading "N staff, M
  pending" instead of one lumped count, and exclusion of anyone with a
  null `accepted_at` from the scheduler's Add-shift staff picker, task
  assignment, and swap targets — nobody can work a shift they cannot
  sign in for. **Not yet visually verified** — see "Next up".
- **`0001_baseline.sql` is now frozen as of 2026-09-09.** It had drifted
  into being kept "current" across the role_at_clock_in, notify-capability,
  and pending-invites migrations; reverted that and marked it frozen in
  both the file header and CLAUDE.md — every change from here on lives
  only in its own later numbered migration.

### 2026-09-09 (even later)
- **`role_at_clock_in`**: the payroll report grouped hours by a person's
  *current* role, so a promotion silently rewrote which role earned past
  hours. `supabase/migrations/0002_role_at_clock_in.sql` (run and
  backfill confirmed) — the column already existed live but nothing set
  or read it. Now set on every clock-in insert in
  `EmployeeDashboard.handleClockIn`, from the profile's role at that
  moment; the same payload object is reused for the offline-queue
  `enqueue()` call, so a queued clock-in already carries the
  time-of-clock-in role before it ever reaches `offlineQueue.js` — that
  file needed no change. `PayrollReportModal` now reads
  `role_at_clock_in`, falling back to the profile's current role only
  when null, and the role filter/grouping both use it.
- **`invite-staff` Edge Function**: rejected Administrators outright —
  it checked `profile.role !== "Manager"`, a literal string stale since
  the role rename. Replaced with an `is_manager()` RPC call made as the
  caller (their own JWT, not the service-role key). Also added: location
  ids on an invite are validated against `my_managed_locations()` for
  that caller and rejected if any fall outside it (managers are
  location-scoped now); `org_id` is now taken from `my_org_id()` for the
  inviter rather than trusted from the request body. That last one
  incidentally fixed a real cross-tenant bug — nothing had ever set
  `org_id` anywhere in this function, so every invite was silently
  falling through `tg_handle_new_user`'s hardcoded fallback and landing
  in org `org-1` regardless of the inviter's actual org. Not deployed by
  this session (no linked Supabase CLI session here, and the MCP
  connection is read-only) — needs `supabase functions deploy
  invite-staff` run manually.
- **`notify_org_managers()` / `tg_task_comment_notify()`**: both also
  compared `profiles.role` to the literal `'Manager'`, so since the
  rename both matched nobody — manager notifications for shift swaps,
  overtime claims, unavailability requests, open-shift applications,
  submitted tasks, and non-manager task comments had been going out to
  no one. `supabase/migrations/0003_manager_notify_capability.sql` (run)
  fixes both to join `roles` and check `can_manage`, matching
  `notify_location_managers()`'s existing correct pattern (checked
  whether the two should call each other — no, `notify_location_managers`
  needs a location id and would silently drop location-scoped Managers
  if called with none). Audited every remaining function in the baseline
  for any other role-name comparison: everything else is either the
  correct capability-join pattern, or legitimate role-as-label matching
  (task `assigned_role` / shift `required_role` assignment, same-role
  swap eligibility) unrelated to permissions — left alone. One
  wording-only leftover, not fixed: `tg_protect_profile_role()`'s
  exception text still reads "Only a Manager may change role".
- Both migrations run against the live database and `0001_baseline.sql`
  updated to match (the two corrected function bodies, each flagged with
  a comment pointing at 0003; the `role_at_clock_in` column already
  existed there, just documented with a `COMMENT ON COLUMN`).
- **Hosting moved from Netlify to Cloudflare** — the long-pending item
  from the "Next up" list above, done this session (build-minute cap on
  Netlify's free tier had already blocked a deploy once, see the
  2026-09-07 entry below).

### 2026-09-09 (yet later)
Phase 2c: the entire database schema — every table, RLS policy,
function, trigger, storage bucket/policy and cron job — had been typed
into the Supabase SQL Editor by hand over the life of this project, with
none of it in the repo. That was the biggest unmanaged risk in the
project: no diff, no review, no way to reconstruct it.

- Dumped the full live schema via the read-only Supabase MCP connection
  (`pg_get_constraintdef`/`functiondef`/`triggerdef`, `pg_policy`,
  `pg_indexes`, `storage.buckets`, `cron.job`) into
  `supabase/migrations/0001_baseline.sql`: 17 tables with columns,
  defaults, constraints and the one generated column
  (`tasks.task_day`); 34 explicit indexes; 42 functions; 20 triggers (18
  on app tables, 2 on `auth.users`); RLS enabled/forced + all 59
  policies (54 table + 5 on `storage.objects`); 2 storage buckets and
  their policies; 5 `pg_cron` job schedules; the project's own
  `ensure_rls` event trigger. Ordered so the file actually runs
  top-to-bottom (tables → indexes → functions → a short pass attaching
  `org_id default my_org_id()` once that function exists → triggers →
  RLS → storage → cron), which is not the literal order it was
  requested in — RLS policies and several column defaults call
  functions that have to exist first.
- Marked explicitly as a point-in-time snapshot (2026-09-09), not a
  from-scratch build script, and not tested against an empty database.
- Two inline comments in the first draft turned out to be stale —
  re-querying the live functions caught both: `delete_staff_member`
  already calls `manages_person()` (the comment claiming it didn't was
  leftover from before that fix landed); the `locations` RLS policy's
  `WITH CHECK (is_admin())` is deliberate, not a bug — editing a
  geofence changes where staff can clock in, so that's
  administrators-only by design. Corrected both comments.
- Verified completeness by diffing every table, policy, function and
  trigger name in the file against a fresh MCP query of the live
  database — all four categories matched exactly, nothing live is
  missing from the dump.
- Updated CLAUDE.md: the repo is the source of truth for schema now,
  not Supabase. Every schema change is a new numbered migration file,
  committed, then run manually in the SQL Editor — never made directly
  against the live database with no migration to show for it.

### 2026-09-09 (later)
Permissions model rebuilt around capability flags, plus a security
pass fixing the gap that opened between what the UI offered a
location-scoped Manager and what the database would actually let them
do. Verified end to end with a location-scoped Manager account, not
just an Administrator.

- **Capability flags, not role names**: `roles.can_manage` and
  `roles.is_admin` now drive every permission decision, both in RLS
  policies and in the client (`usePermissions`, calling the
  `is_manager()`/`is_admin()` SECURITY DEFINER functions rather than
  matching `profiles.role` text against a hardcoded list). `Manager`
  was renamed to `Administrator`; a new location-scoped `Manager` role
  sits underneath it — an Administrator manages every org location, a
  Manager only the locations in their own `profile_locations` rows.
- **Scoping enforced in the database, not just the UI**:
  `manages_person()`/`manages_location()` (both wrapping
  `my_managed_locations()`) gate the RLS policies on `profiles`,
  `employee_notes`, `shifts`, and `locations` — a Manager cannot write
  a row for a person or location outside their scope no matter what
  the client sends. `employee_notes` also picked up a soft-delete path
  (`deleted_at`/`deleted_by`) for Administrators; it is no longer
  strictly append-only, but there is still no hard DELETE policy for
  anyone.
- **Fixed a session-restore race in all four module-scoped hooks**
  (`usePermissions`, `useRoles`, `useOrganisation`, `useLateGrace`):
  each fetched on first mount regardless of whether the Supabase
  session had finished restoring from storage, so the RPC/query could
  fire with no auth token, 401, and get cached as a permanent
  false/empty/zero — for `usePermissions` specifically, that could
  route a Manager to the wrong dashboard. Each hook now awaits
  `supabase.auth.getSession()` first, never marks a fetch as loaded on
  a missing session or an error, and clears its cache on
  `SIGNED_IN`/`SIGNED_OUT` so a second user signing in in the same tab
  (e.g. the deactivated-account sign-out path, which does not reload
  the page) cannot inherit the previous user's cached permissions.
- **New `src/hooks/useManagedLocations.ts`**, wrapping
  `my_managed_locations()` with the same session-gated,
  never-cache-a-failure pattern. Wired into every location picker in
  the app — `StaffManager`'s roster, `ManagerDashboard`'s
  Map/Timesheets filter, `ManagerScheduler`'s filter and Add-shift
  modal (which also gates who can be picked as staff, via
  `profile_locations` for the now-restricted location), `ManagerTasks`
  (template form, one-off form, history filter), `ManagerShiftRequests`'
  open-shift form, and `PayrollReportModal`'s location multi-select —
  so a Manager is never offered a person or location the database
  would reject, instead of reaching the control and hitting a raw RLS
  error.
- **New `src/lib/friendlyError.ts`**: maps Postgres/PostgREST error
  codes to plain language (42501/RLS → permission, 23505 → unique,
  23503 → foreign key, 23514 → check violation; anything else logs the
  raw error and shows a generic message). Applied everywhere a
  Supabase database error was being shown to a user via raw
  `error.message`; left untouched the handful of sites where the
  message comes from Supabase Auth, the geolocation API, or the
  invite-staff Edge Function's own JSON body, since none of those
  carry Postgres codes.
- **Locations are admin-only to edit**: the `locations` RLS policy's
  `WITH CHECK` requires `is_admin()` unconditionally (a Manager can
  view/select a location they manage but never save an edit to one),
  so the Locations card in `ManagerMoreTab` moved behind the `isAdmin`
  gate alongside Roles, Branding, and the grace period — a
  location-scoped Manager does not see that row at all, since editing
  a geofence changes where staff can clock in.
- **Supabase MCP connected, read-only.** Documented in CLAUDE.md: check
  the live schema through it before writing queries rather than
  assuming column names from this file or a grep of `src/`, since the
  migrations folder is known to be incomplete. Being read-only, it
  cannot apply schema changes — migrations still go to the user to run
  manually.

### 2026-09-09
Org branding + a full visual redesign pass. Pushed but **not yet
reviewed on a real device** — unlike the rest of this log, treat this
entry as unverified until that check happens.

- **Branding**: new `src/hooks/useOrganisation.ts` (module-scoped cache,
  same pattern as `useRoles.ts`) reading the org's `name`, `logo_url`,
  and `primary_colour` via `my_org_id()`. Branding card in
  `ManagerMoreTab` for logo upload (png/jpg/svg, 1MB cap, public
  `org-logos` bucket at `${orgId}/logo.<ext>`, cache-busted URL) and
  editable org name. Both dashboard headers now show the logo, falling
  back to the org name in text when `logo_url` is null. Removed every
  hardcoded "ShiftTrack" from the UI, including the sign-in screen.
  `organisations.primary_colour` is fetched by the hook but **not wired
  into theming anywhere yet** — the app is still hardcoded to brand
  green (#14532D).
- **Design system**, defined in `src/index.css` and then applied
  app-wide rather than screen-by-screen: Archivo self-hosted via
  `@fontsource/archivo` as `--font-sans`; custom type scale
  (`--text-xs`…`--text-3xl` with paired line-heights); border radius
  collapsed to exactly two tiers (`rounded-lg`, `rounded-2xl`) via a
  mechanical find/replace of every `rounded-xl`/`rounded-md`/bare
  `rounded` across `.tsx`/`.jsx`; new `active` (teal) status colour kept
  separate from `success` green and brand green.
- Known gap from this pass: the per-screen restraint pass (confirming
  every screen actually follows the new rules, not just the ones edited
  directly) was **not exhaustive** — expect stragglers.
- **Not yet done:** real-device check of any of the above.

### 2026-09-07 (later still)
Manager-side task tooling and navigation, largely driven by using the
task module against real data and finding it needed room to grow. All
verified on a real device except the purged-photo fallback in Task
History, noted above — that needs a task old enough for the monthly
photo-purge cron to have actually run against it.

- **Task notifications**: a database trigger now writes a `notifications`
  row on task events, and a daily cron flags overdue tasks. Added
  `'task'` to `NotificationBell`'s type→icon map (`CheckSquare`) so
  they render instead of falling back to the generic bell icon.
- **Manager More tab → drill-down navigation**: both More tabs
  (manager and employee) were one long stack of cards. New shared
  `MoreTabSections.tsx` turns each into a list of section rows with a
  chevron; tapping one replaces the list with that section's content
  and a back button, entirely within the tab. Rows for
  pending-item sections (unavailability requests, overtime claims,
  shift requests) carry a live count badge, computed from a
  lightweight query at the list level so it's visible before drilling
  in rather than only once the full section mounts. `CollapsibleSection`
  stays in use where a section still has more than one sub-topic
  worth independently collapsing (Task History's Review/Setup/History
  split).
- **FilterButton popover pattern**: a shared `FilterButton.tsx`
  (button + active-count badge + popover) replaced loose filter
  `<select>`s wherever they'd accumulated (ManagerDashboard header,
  ManagerScheduler). The popover portals to `document.body` rather
  than positioning relative to its trigger — the live map's wrapper
  has `isolation: isolate` to contain Leaflet's own z-index, which
  also traps any z-index value trying to escape it from a normal
  absolutely-positioned child, so no z-index number could ever have
  fixed that; a portal sidesteps the stacking context entirely. Later
  found the popover could still render past the bottom of a phone
  screen with no way to scroll to it — fixed by rendering it as a
  full-width bottom sheet below `sm` (own scroll, safe-area padding,
  tap-to-close backdrop) and, from `sm` up, clamping the popover to
  the viewport (flips above the trigger when there isn't room below,
  shifts horizontally to stay on screen, gets its own max-height and
  internal scroll).
- **ManagerScheduler role filter**: added alongside the existing
  location filter, both now in one FilterButton popover, filtering
  the week's shifts by the assigned person's role.
- **Payroll CSV report**: `PayrollReportModal.tsx`, opened via
  "Generate report" on the Timesheets tab. Date range + location/role
  multi-selects (default all), excludes still-open time logs from the
  totals with a called-out count so a manager can chase them before
  running payroll, groups by location → role → person, on-screen table
  (hours to 2 decimals, total row) before a CSV download in the same
  shape plus the date range on line 1.
- **Task History**: third section in ManagerTasks alongside Review and
  Task setup. Filters (date range defaulting to the last 7 days,
  location multi-select, role multi-select, status — All/Completed/Not
  completed — all defaulting to All) in a FilterButton popover. Every
  status shows, newest first; role filtering happens client-side per
  page since a person-targeted task has a null `assigned_role` and
  should never be excluded by a role filter. Photo thumbnails reuse a
  newly-extracted shared `PhotoLightbox` (Review now uses it too); a
  failed signed-URL fetch shows a muted "Photo no longer stored" note.
  Paginated at 50 with Load more. A "never completed" count (pending,
  due_time already past, same date/location/role filters) sits at the
  top, from a separate lightweight query rather than a head-count one,
  since the role filter can't be pushed server-side for the reason
  above and a count-only query couldn't apply it either.
- **Tasks promoted to a top-level manager tab** (`CheckSquare`, between
  Schedule and Timesheets — five tabs now) and removed from the More
  list. Compared against EmployeeDashboard's existing six-tab bottom
  bar as precedent that five shorter labels would read fine without
  needing to shorten any.
- **Invite staff button removed from ManagerDashboard's header** — it
  was the only non-navigation, non-filter control living there: still
  reachable from the More tab, untouched.
- **Badge counts corrected to match their panels**: the shift-requests
  badge counted every `shift_applications` row, while the panel only
  ever renders applicants against shifts that are still unassigned and
  in the future. Fixed the badge query to inner-join to `shifts` and
  apply the identical filter. Checked the other three badges
  (unavailability, overtime, tasks-review) against their panels — all
  three already matched exactly.
- **Expired open-shift cleanup**: an unfilled open shift that's already
  started used to just linger — the panel's `start_time >= now()`
  filter meant it fell out of view with no way to action it. Added an
  "Expired" group to `ManagerShiftRequests` (muted styling, applicant
  count, Delete only — no per-applicant action, since assigning someone
  to a shift that already happened isn't meaningful), excluded from the
  badge. Also added a daily cron, one day after a shift's start, for
  the automatic side of the same cleanup.
- **`safeUuid()` helper** (`src/lib/ids.ts`): `crypto.randomUUID()`
  needs a secure context (undefined on the plain-HTTP local dev server)
  and is missing on older iOS Safari. First fallback was a
  timestamp+random string, which broke `shifts.series_id` (a real
  `uuid` column) with "invalid input syntax for type uuid" — fixed to
  build a proper v4-shaped UUID from `crypto.getRandomValues` (or
  `Math.random` as a last resort), version/variant bits set per
  RFC 4122. Replaced both call sites (task photo paths, recurring-shift
  `series_id`).
- **`profiles.email`**: backfilled from `auth.users` and kept in sync by
  a `sync_profile_email` trigger. Added to the `Profile` interface and
  every place that builds one; `StaffManager` shows it (truncated in
  the collapsed row, in full expanded) and the search filter matches
  on it. Documented in CLAUDE.md: read it, never write it directly.

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
