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

**Only two of the many tables/functions the app depends on have migrations checked in** (`supabase/migrations/`): `profile_locations`, `unavailability_requests`, `notifications`, plus a `profiles.role` rework. Tables like `profiles`, `locations`, `shifts`, `time_logs`, `shift_swaps`, `shift_applications`, `overtime_claims`, `live_locations`, and the RPC functions above exist in the live database but were created outside this migrations folder (e.g. directly via the Supabase dashboard/SQL editor). When changing schema-dependent code, don't assume `supabase/migrations/` is the full picture of the schema — check actual RPC/table usage across `src/` (`grep "\.from('" -r src` / `grep "\.rpc("`) as the source of truth for shape, and add new schema changes as new migration files here going forward.

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
- Roles: Manager, Employee, Driver, FOH, KA, Head Chef, Second Chef, Cook,
  Tandoori Chef, Kitchen Porter. Enforced by a CHECK on profiles.role.

### UI

- Tailwind theme tokens only: bg-bg, bg-surface, text-ink, border-border,
  bg-primary (royal green), bg-secondary (brownish orange), plus
  success/warning/danger for status. Text is black or white only.
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
