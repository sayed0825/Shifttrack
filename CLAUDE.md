# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

ShiftTrack is a staff scheduling / time-clock app for a restaurant-type business, built with React 19 + TypeScript + Vite, Tailwind CSS v4, and Supabase (Postgres + Auth + Realtime + Edge Functions) as the backend. It ships as a web app and is wrapped with Capacitor for iOS/Android (`android/`, `ios/` are Capacitor-generated native shells — barely customized beyond `Info.plist` / `AndroidManifest.xml`).

This started from the Bolt.new `bolt-vite-react-ts` template (see `.bolt/`). The `.bolt/prompt` conventions still apply: use the `@/` path alias for imports (maps to `src/`), use `lucide-react` for icons, and don't introduce new UI/icon libraries without good reason.

## Commands

```bash
npm run dev        # start Vite dev server
npm run build       # production build (tsc project refs are NOT run separately — Vite/esbuild does the TS transpile; there is no standalone `tsc --noEmit` script)
npm run preview     # preview a production build
npm run sync         # build + `cap sync` (copies web build into native projects)
npm run ios          # sync + open the Xcode project
npm run android      # sync + open the Android Studio project
npm run doctor       # `cap doctor` — sanity-check the Capacitor setup
```

There is no test suite and no `lint` script in `package.json`. `eslint.config.js` exists (flat config, typescript-eslint + react-hooks + react-refresh) but ESLint is not currently a declared dependency — running it requires installing the eslint packages it references first.

## Architecture

### Two dashboards, one entry point

`src/App.tsx` owns all authentication (Supabase email/password + invite-link password-set flow) and, once a session resolves, branches on the signed-in user's `profiles.role`:
- `role === 'Manager'` → `ManagerDashboard`
- everything else → `EmployeeDashboard`

There is no router (`react-router-dom` is a dependency but unused) — navigation within each dashboard is local tab state, not URL-based.

Roles are an open text set, not just Manager/Employee: `ALL_ROLES` in `ManagerDashboard.tsx` is `Manager, Employee, Driver, FOH, KA, Head Chef, Second Chef, Cook, Tandoori Chef, Kitchen Porter`. Only `Manager` vs. non-Manager currently changes app behavior; the rest are labels used for scheduling/filtering.

### Supabase is the backend; business logic lives in Postgres

There is no application server. Components call the Supabase JS client (`src/supabaseClient.js`) directly for CRUD, and call Postgres functions via `.rpc(...)` for anything that needs to be trusted/atomic:
- `verify_geofenced_clock_in` — server-side distance check against a location's geofence, called before every clock-in/clock-out.
- `approve_shift_swap`, `approve_shift_application` — manager actions on `shift_swaps` / `shift_applications`.
- `decide_overtime_claim` — approve/deny an `overtime_claims` row.
- `delete_staff_member` — cascading staff removal.
- `is_manager()` — used inside RLS policies (see migrations) to gate manager-only rows.

`supabase/migrations/0001_baseline.sql` is a **baseline snapshot** of the live database (tables, RLS, functions, triggers, storage buckets/policies, cron jobs), dumped via the read-only Supabase MCP connection — not a from-scratch build script, and not tested against an empty database. Every migration after it is incremental on top of that snapshot. Before it existed, only two tables/functions the app depends on had migrations checked in at all (`profile_locations`, `unavailability_requests`, `notifications`, plus a `profiles.role` rework); everything else had been created directly via the Supabase dashboard/SQL editor with no record in this repo. The live schema can still have drifted since the baseline was captured (2026-09-09) — don't assume it's exactly current.

**The repo is the source of truth for schema, not the database. Never make a schema change that exists only in Supabase.** Every schema change — a new table, column, RLS policy, function, trigger, storage bucket/policy, or cron job — is written as a new numbered migration file in `supabase/migrations/` (e.g. `0002_<description>.sql`), committed, and only then run manually in the SQL Editor (this MCP connection is read-only and cannot apply it for you). Never edit the Supabase-managed schema directly and skip writing the migration; a future session (or `mcp__supabase__list_migrations`) has no other way to know what changed.

A Supabase MCP server is connected, **read-only**. Use it to check the actual live schema (tables, columns, RLS policies) before writing queries, instead of assuming column names from this file, the migrations folder, or a grep of `src/` — the live schema can have drifted since the baseline was captured. Because the connection is read-only, it cannot apply schema changes: migrations still go to the user to run manually.

`src/supabaseClient.js` hardcodes the project URL and anon key rather than reading `import.meta.env` (a `.env` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` exists but isn't consumed). The anon key is safe to expose by design; RLS policies (see migrations) are what actually restrict access.

`supabase/functions/invite-staff` is the one Edge Function: it verifies the caller is a Manager, uses the service-role key to invite a user by email (`auth.admin.inviteUserByEmail`), upserts their `profiles` row and `profile_locations`. This is the only place a service-role key is used — everything else goes through the anon key + RLS.

### Employee-side flow (`EmployeeDashboard.tsx` + helpers)

- Tabs: Clock-In, My Schedule, Shifts (swap/apply, in `EmployeeShiftActions.tsx`), My Timesheets, More.
- Clock-in requires geolocation (`navigator.geolocation`, not a Capacitor plugin) and a server-side geofence check (`verify_geofenced_clock_in`) against the shift's assigned `locations` row.
- **Offline clock-in queue** (`src/lib/offlineQueue.js`): clocking in/out is the one action that must never silently fail. If the RPC/insert fails (offline, server error), the action is queued in `localStorage` with a client-computed haversine distance check (mirrors the server's geofence math) and replayed in order on reconnect via `flushQueue`. Clock-outs queued before their matching clock-in has synced are held back until the real row id is known. Preserve this "never drop a queued clock event" invariant when touching this file.
- Managers, FOH, and KA roles (`MAP_VIEWER_ROLES`) additionally see a live staff map (`LiveMap.jsx`) built on `react-leaflet`, backed by realtime updates on the `live_locations` table (`pushLiveLocation` / `subscribeToLiveLocations` in `supabaseClient.js`).

### Manager-side flow (`ManagerDashboard.tsx` + sub-components)

- `ManagerScheduler.jsx` — rota builder: single/recurring shift creation (weekday presets, capped at 366 occurrences per action), assignment to staff and locations.
- `StaffManager.tsx` — roster CRUD: role changes, primary/secondary location assignment, deactivate/reactivate, and hard delete via the `delete_staff_member` RPC.
- `ManagerShiftRequests.tsx` — approve/deny employee shift swaps and open-shift applications.
- `OvertimeApprovals.tsx` / `OvertimeClaim.tsx` — employee-submitted overtime claims and manager decisions.
- `InviteStaffModal.tsx` — calls the `invite-staff` Edge Function.
- `ManagerMoreTab.tsx` — locations management and unavailability-request review; also the place that writes to `notifications`.
- `NotificationBell.tsx` — realtime `notifications` subscription (per-user, via `is_read`/RLS-scoped rows).

### Known dead code

`src/lib/categories.ts` and `src/lib/markerIcon.ts` (place/category icon helpers with Food/Nature/Culture/etc. categories) are leftovers from a different, unrelated Bolt template and are not wired into any current component — `LiveMap.jsx` has its own marker/icon logic. Don't assume they're load-bearing; either ignore them or remove them if you're cleaning up, but don't build new features on top of them without checking they're actually reachable.

### Styling

Tailwind v4 with a custom theme defined via `@theme` in `src/index.css` (no `tailwind.config.js` — v4 uses CSS-based theming). Use the existing semantic color tokens (`bg`, `surface`, `primary`, `primary-dark`, `secondary`, `ink`, `paper`, `border`, `success`/`warning`/`danger` + their `-bg` variants) instead of raw Tailwind palette colors, to stay consistent with the rest of the app.

### Mixed JS/TS

Some components are `.jsx`/`.js` (`ManagerScheduler.jsx`, `LiveMap.jsx`, `offlineQueue.js`, `supabaseClient.js`) rather than `.tsx`/`.ts`. `src/components/legacy.d.ts` hand-declares module types for the `.jsx` files so TS-strict consumers (`ManagerDashboard.tsx`, `EmployeeDashboard.tsx`) can import them with types. If you convert one of these files to TypeScript, remove its corresponding declaration from `legacy.d.ts`.

## Project conventions

### Non-negotiables

- Timesheet data is payroll data. Never delete or overwrite a time_log
  without an explicit instruction. Deactivate staff rather than delete —
  deleting a profile cascades to time_logs and erases payroll history.
- Every recurring shift occurrence must be built from calendar fields and
  converted per-occurrence. Never generate one Date and add 7 * 86400000 ms
  per week — that shifts every date past a DST boundary by an hour.
- is_recurring and series_id must always be set together. The
  shifts_series_consistency CHECK rejects a row with one but not the other.
- Any recurring generation needs a hard cap and a required end date.
  An unbounded loop here can insert thousands of rows in one click.
- The geofence must be enforced offline too, recalculated on-device against
  cached site coordinates, so an outage cannot be used to clock in from home.

### Database

- Supabase Postgres with RLS enabled and forced on every table.
- is_manager() and my_role() are SECURITY DEFINER helpers used inside
  policies to avoid RLS recursion on profiles.
- Approvals that change two rows (shift swaps) go through SECURITY DEFINER
  RPCs so both rows move together or neither does.
- The protect_profile_role trigger blocks role changes when auth.uid() is
  not a Manager. It allows null auth.uid() so the invite Edge Function
  (service_role) can set a role.
- Roles are per-organisation rows in a `roles` table (org_id, name,
  sort_order, is_protected, can_view_map) rather than a fixed CHECK-enforced
  set. profiles.role is nullable text, not an FK — see src/hooks/useRoles.ts.
- profiles.email mirrors auth.users.email via the sync_profile_email
  trigger. Read it, never write it directly.
- Multi-tenancy: an `organisations` table (id, name, slug, logo_url,
  primary_colour, is_active, late_grace_minutes) is the tenant root. Every
  domain table carries org_id referencing it, including profiles.org_id.
  my_org_id() is a SECURITY DEFINER helper that reads profiles.org_id for
  the current user, the same pattern as is_manager()/my_role().
- White-labelled: `organisations.name` and `logo_url` are the only branding
  shown anywhere — the product name is never hardcoded in the UI. Logos
  live in the public `org-logos` storage bucket at
  `${orgId}/logo.<ext>` (png/jpg/svg, 1MB cap, enforced client-side in
  ManagerMoreTab's Branding card). See src/hooks/useOrganisation.ts.
- `employee_notes` (id, org_id, employee_id, manager_id, note_text,
  created_at, deleted_at, deleted_by) — manager notes on an employee's
  profile. Manager-only RLS. Notes cannot be edited, and there is still no
  hard DELETE policy for anyone. It is no longer strictly append-only,
  though: an Administrator can soft-delete a note, setting deleted_at and
  deleted_by. The row stays — the UI renders it as a tombstone rather than
  removing it. See src/components/EmployeeNotes.tsx.
- Task module:
  - `task_templates` (id, org_id, location_id, title, description,
    assigned_role, assigned_user_id, requires_photo, recurrence,
    weekdays smallint[], start_at time, due_at time, is_active,
    created_by, created_at) — the recurring definition a day's tasks are
    generated from.
  - `tasks` (id, org_id, template_id, location_id, title, description,
    assigned_role, assigned_user_id, start_time, due_time,
    requires_photo, photo_path, status, completed_by, completed_at,
    reviewed_by, reviewed_at, created_by, created_at, task_day) — one
    day's generated instance. status is 'pending' | 'submitted' |
    'approved' | 'rejected'.
  - `task_comments` (id, org_id, task_id, sender_id, comment_text,
    created_at) — a thread on one task, visible to the assignee(s) and
    managers.
  - Photos live in the private `task-photos` storage bucket and are
    purged after one month by a cron job.
  - A task assigned to `assigned_role` is a SHARED POOL, not copied per
    person — whoever completes it first completes it for everyone else
    with that role. See src/components/EmployeeTasks.tsx.
  - `tasks.task_day` is `GENERATED ALWAYS AS ((start_time at time zone
    'Europe/London')::date) STORED` — select it, never write it. Any
    insert/update payload that includes the column, even as null, fails
    with "cannot insert a non-DEFAULT value into column".

### UI — design system

Defined in `src/index.css` under `@theme`. Change the look there, not with
one-off values on a screen.

- Two-family pairing, both self-hosted in index.css — never a CDN, never
  a bare system-font fallback:
  - **Interface** — Instrument Sans, via `@fontsource/instrument-sans`
    (400/500/600/700), set as `--font-sans` so it's the default
    everywhere. Use it for body copy, labels, buttons, form fields, and
    every number: times, durations, hours, dates, counts. Every one of
    those gets `tabular-nums` — this app is half numbers and they need
    to align in columns.
  - **Display** — Instrument Serif, via `@fontsource/instrument-serif`
    (400 only — it has no bold, so never pair it with `font-semibold`/
    `font-bold`), set as `--font-display` (`font-display` utility).
    Use it only for section headings, the organisation name in the
    header, and large standalone numbers where it reads well — paired
    with `tracking-tight`. Never below `text-lg`: its high stroke
    contrast falls apart under 16px, and this app gets read on phones
    mid-service.
- Type scale is custom and deliberately short — five sizes (`--text-xs`
  … `--text-xl` + paired `--line-height`s in `@theme`), not Tailwind's
  stock sizes and not more tiers than that. Small jumps low in the scale,
  opening into large jumps at the top, so a heading actually reads as a
  heading instead of sitting one notch above body text. `--text-lg` and
  `--text-xl` are where display-font headings live, but the tiers
  themselves aren't display-only — large numbers use them too, in the
  interface font.
- Exactly two border radii: `rounded-lg` (small — controls: buttons,
  inputs, chips, nested rows) and `rounded-2xl` (large — sheets, modals,
  cards that genuinely group content). Both are redefined in `@theme`
  (`--radius-lg`, `--radius-2xl`); don't reach for `rounded-xl`,
  `rounded-md`, or a bare `rounded` — there's nowhere in the scale for
  them to mean anything, and they'll get merged away again.
  `rounded-full` stays default, for pills/dots only.
- Colour: `bg-primary` (#0B3B1F, deep green) is brand only — the header
  bar, primary buttons. Status has its own set, deliberately not brand
  green or secondary orange: `success`/`warning`/`danger` for
  approved/attention/rejected outcomes, and `active` (teal) specifically
  for something ongoing right now — on shift, in range, on duty — which
  is a different thing from "approved" and must never fall back to brand
  or success green just because both happen to be green.
- No entrance animations, no hover transitions on static cards (only on
  genuinely interactive controls), no all-caps labels, no eyebrow labels
  above a heading, no gradients, no shadow on static content — shadow
  only on things that actually float (a popover, a modal, an active tab
  pill). Text is black or white only.
- The header bar (`bg-primary`) is structural on both dashboards — it
  carries the org logo (falling back to the org name in text when
  `logo_url` is null, via `useOrganisation`), the tab nav, and header
  controls (filters, notifications, log out) in a white/translucent
  treatment (`FilterButton`'s `variant="inverted"` is the pattern for a
  header-bar control; the bottom mobile nav and screen content stay on
  the neutral bg/surface palette — green is chrome, not a wash over
  everything).
- Minimum 44px touch targets. Mobile is the primary case.
- Leaflet DivIcon markup is built outside React, so every Tailwind class in
  it must be a complete literal string. Never assemble class names
  dynamically — the scanner cannot see them and they compile away.

### Known traps

- Surface the raw error before making it friendly. Three separate bugs were
  misdiagnosed because a generic message hid the real cause.
- Verify a component is actually imported and rendered before editing it.
  Five orphaned files were found in this project, and fixes were applied to
  components that never rendered.
- Supabase credentials are currently hardcoded in src/supabaseClient.js as a
  workaround for a Bolt bug. This must move back to environment variables.
