# PROGRESS.md

Running log of what has actually been done. Keep it in the repo root.

**How to use it:** at the end of each Claude Code session, tell it
"update PROGRESS.md with what we did". At the start of a chat session,
paste the last few entries. This file is the handover — nothing else
travels between the two.

Newest entries at the top.

---

## Current state

**This session, in order:** task lists shipped — the item is now the
unit of work, submitted and reviewed individually (migration 0026,
which needed three rolled-back attempts before it ran clean,
reconciled against manual backups each time; 0027 followed immediately
to revoke an anon EXECUTE grant on `can_see_task_item()` the pre-push
suite caught). Then the driver pay engine, steps 1-4: effective-dated
`org_pay_settings` (also fixing a real pre-existing bug where changing
`organisations.order_rate` silently rewrote every past shift's pay);
`delivery_runs`/`delivery_drops`; `shift_pay()`/`shift_pay_range()`
computed on demand, never stored, admin-only, verified against the
user's own worked example (2 drops, one 6.5mi run, defaults → £3.50
exactly); manager editing of runs with a full audit trail; native
compliance for background location, tracked for `tracks_orders`
drivers only, gated on the role FLAG not a role name; and finally the
real GPS engine and the Delivered button. **Also, mid-session: a
serious pre-existing bug, unrelated to any of the above, found and
fixed** — `tg_protect_own_time_log` (since migration 0020) rejected
ANY change to `clock_out` in its non-admin/non-manager-of-someone-else
branch, meaning an ordinary employee could never clock themselves out
at all. Confirmed live by impersonating a driver in SQL, fixed live,
recorded as `0031_time_log_clock_out_window.sql`, **pushed**
(`ccd033ea00be3282b1b4f477b36b0fe11335ea18`), with RLS tests covering
an ordinary employee clocking out their own shift, the 5-minute
window's edges, and the sweep's exemption from it — see the log below
for the full audit (a client-side auto clock-out fallback was removed
entirely, and two more findings were reported rather than silently
fixed: the app sends its own device timestamp for clock_out, and a
clock-out queued offline replays with its original, now possibly
stale, timestamp).

**Since then:** `0032_record_delivery_run.sql` ran, step 4 pushed
(`b9a5dc3a48b49af411c7537e1a56685878c04bd9`), RLS suite confirmed green
at 164/164 against the live database after each push.

A public privacy policy went live at `kitescheduling.com/privacy` —
static HTML (`public/privacy.html`), no JS, no session, no Supabase
call, required for both app stores before submission. Custom domain
`kitescheduling.com` added on the Cloudflare Pages production
deployment. While checking that domain: confirmed there is **no
subdomain tenancy** — the app never reads the hostname, organisation
is resolved from `profiles.org_id` after sign-in (`useOrganisation.ts`
→ `my_org_id()`), and the sign-in screen itself is unbranded on every
domain, `App.tsx`'s `session === null` branch has no org lookup at
all. Also fixed while in there: `index.html`'s title and favicon were
still the original Bolt template's ("Placemarks", `/vite.svg` — which
didn't even exist in `public/`, so the icon link was 404ing) on every
domain, not just the custom one.

**Not yet tested: the GPS engine (step 4)** — a real device test is
now set up and ready (TEST STORE + TEST SHIFT rows in the live
database, a 75m geofence at the tester's home, cleanup SQL already in
hand) but the actual drive hasn't happened yet. See "Known broken"
below for the exact testing note (1.5 m/s floor filters walking pace —
test in a car, not on foot).

**Next up, before anything else:**
1. The actual device test drive for the GPS engine.
2. ICO registration — a self-assessment says the fee applies; the user
   has deferred it. The registration number line has been removed
   from the privacy policy entirely (not left as a placeholder) until
   it's done.
3. Store assets not started at all: screenshots, a background-location
   demo video (required alongside the ICO/DPIA paperwork for both
   stores' background-location review), and the privacy labels
   (App Store's Privacy Nutrition Label / Play's Data Safety form) —
   PROGRESS.md's own "Privacy policy notes" section above is the
   source for what those should say.

**Older, still open, unrelated to this session:**
- Migration 0021 (guards the two shift-notify triggers against an
  already-deleted profile) — still not confirmed run against the live
  database; see "Known broken" below, unchanged since it was first
  logged.
- Real-device check of the branding + visual redesign pass pushed
  2026-09-09 — still not reviewed on a real device.
- Wire `organisations.primary_colour` into actual theming — still
  fetched by `useOrganisation` but nothing consumes it; the app is
  still hardcoded to brand green everywhere.
- The purged-photo fallback in Task History still hasn't been
  exercised — needs a task old enough for the one-month purge cron to
  have already run against it.

The automated RLS test suite (`tests/rls/`) is at 164 tests across 14
files as of the clock-out fix, run against the live database with
teardown confirmed clean. Re-run it after any RLS policy or trigger
change — it exists specifically because that class of bug (0017's
recursion, 0020's self-edit gap, 0021's notify-trigger FK violation,
and now the clock-out window) keeps getting found by accident, and it
only protects against the next one if it's actually run each time.
Supabase Pro (point-in-time backups) is deliberately deferred until
ready to pay — see "Known broken" below. The repo is the source of
truth for schema, not Supabase — see CLAUDE.md.

**Outside engineering, gates the launch date:** Apple Developer and
Google Play accounts — not yet started. Pure calendar time (Apple
approval especially can take days), doesn't block any of the
engineering work above running in parallel.

Task module is complete and tested end to end on both sides (template
creation, instance generation, employee completion with and without a
required photo, manager review, rejection with a required comment, redo,
and approval all verified against real data). Manager task tooling has
since grown well past the original spec — see the log below.

**Known broken / unverified:**
- **The GPS mileage engine (driver pay engine step 4) is UNTESTED on a
  real device** — Android can't be device-tested yet, iOS is pending
  TestFlight. **Test it in a car, not on foot**: the 1.5 m/s
  moving-speed floor (`MIN_MOVING_SPEED_MPS`, `src/lib/gpsFilter.ts`)
  filters out walking pace, so a test done on foot will record almost
  nothing and look broken when the filtering is actually working as
  designed. Also unverified: whether a realtime `postgres_changes`
  subscription survives deep OS backgrounding long enough to catch a
  remote clock-out (the manager sweep) mid-run — if the WebSocket has
  disconnected by the time the sweep fires, the app won't learn its
  shift closed until next relaunch, and any run in progress at that
  point is lost (see the log entry below for the full reasoning).
- Migration 0021 (guards the two shift-notify triggers against an
  already-deleted profile) is written and pushed but NOT CONFIRMED RUN
  against the live database. Notably, the RLS suite passing green does
  NOT verify this one either way: teardown's explicit per-table delete
  order (shifts before profiles) sidesteps the org-cascade path that
  originally surfaced `tg_shift_delete_notify`'s bug, and the suite's
  only `delete_staff_member` call is a negative case (an out-of-scope
  manager, rejected before any delete happens) — so `tg_shift_update_notify`'s
  SET-NULL path has never actually been exercised by anything, manual
  or automated. Until this is confirmed run, deleting a staff member
  with existing shifts via "Delete permanently" in StaffManager can
  still fail with a `notifications_user_id_fkey` violation.
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
- No point-in-time backups — Supabase Pro deferred until ready to pay.
- Phase 3 security review: 7 of 18 findings still open, none urgent
  (all CRITICAL/HIGH, and 4 of 8 MEDIUM, are fixed — see log below).
  MEDIUM: `is_clocked_in(p_user_id)` has no org scoping on the argument
  (an authenticated user in any org can learn whether an arbitrary user
  id elsewhere on the platform is clocked in); `proflocs_select_org`
  lets every org member read the full org-wide staff↔location map, not
  just their own; `time_logs` and `tasks` are each missing an index for
  a real query pattern (org-wide date-range reporting; the
  `notify_overdue_tasks()` cron scan) and will increasingly sequential-
  scan as they grow. LOW/hygiene: `profiles_select_own` is dead policy
  (fully subsumed by `profiles_select_org`); a duplicate index on
  `notifications` (`idx_notifications_user_created` and
  `notifications_user_created_idx`); 11 of 17 tables have RLS enabled
  but not forced.
- MapTiler key not domain-restricted
- `LiveMap` `DEFAULT_CENTER` is hardcoded to Essex — should derive from
  the org's own locations
- Late clock-in detection is implemented but UNTESTED — needs a real
  clock-in against a scheduled shift to verify the LATE badge, since
  manual SQL `time_logs` inserts have no `shift_id`

---

## Log

### 2026-09-23 (privacy policy live, domain cleanup, GPS test rig)
Migrations 0032 confirmed run, driver pay engine step 4 pushed
(`b9a5dc3a48b49af411c7537e1a56685878c04bd9`), 164/164 RLS tests green.

Privacy policy (`public/privacy.html`) drafted by the user, built as a
static page (no router in this app — `react-router-dom` is an unused
dependency — and a static file served cold with no JS/session is more
reliable for App Store/Play reviewers than depending on Cloudflare's
SPA-fallback config anyway), linked from the sign-in screen and both
More tabs. Content iterated: the "Before publishing" internal note
removed (it was a note to the user, not policy text), all bracketed
placeholders filled in except ICO registration number — that one
removed entirely, not left as a placeholder, since it's genuinely
pending (see below). Now live at `kitescheduling.com/privacy` — the
custom domain was added on Cloudflare Pages' production deployment as
part of this.

While the custom domain was in front of us: the user asked whether it
actually reads the subdomain to pick an organisation (it looked, from
`kaanikaana.kitescheduling.com`, like it might be doing per-tenant
routing). Traced it end to end — it doesn't. `App.tsx` never reads
`window.location.hostname` anywhere; organisation is resolved purely
from the signed-in user's `profiles.org_id` (`useOrganisation.ts` →
`my_org_id()`), and that hook only ever mounts after `App.tsx` already
has a session, so the sign-in screen itself has no org lookup at all
and is identical on every domain. The apparent "branded sign-in page"
on `kitescheduling.com` is almost certainly a persisted Supabase
session in that specific browser resuming straight to the dashboard,
not a routing bug — confirmed in code, not by testing the actual
browser in question, so flagged as the likely explanation rather than
a settled one.

Found while checking `index.html` for the same reason: title was still
the original Bolt template's "Placemarks — Your map of favorite
places", and the favicon pointed at `/vite.svg`, which was never
actually in `public/` — that icon link had been 404ing this whole
time, on every domain. Fixed: real title, a description meta tag,
`og:title`/`og:description`, and a plain placeholder favicon
(`public/favicon.svg`, brand-green rounded square with a white "K",
explicitly flagged in a code comment as a placeholder, not a designed
mark). Also dropped `og:image`/`twitter:image`, which pointed at
`https://bolt.new/static/og_default.png` — a third-party Bolt asset,
served on every link preview of the app. Swept the rest of the repo
for the same residue: `ios/App/App/public/index.html` has the same
stale content but is an untracked `cap sync` build artifact, not
hand-edited, picked up automatically by the next `npm run sync`;
`README.md`'s "Open in Bolt" badge removed; `.bolt/config.json` left
alone — internal scaffold marker, never shown in the browser or app,
already documented as intentional in CLAUDE.md.

GPS engine (step 4) device test rig is set up and confirmed live: a
`TEST STORE` location (75m geofence, the tester's home) and a
`TEST SHIFT` open until 36 hours from creation, both org- and
profile-scoped correctly, `profile_locations` linked. Cleanup SQL
already in the user's hands. The actual drive test hasn't happened
yet — nothing about the GPS engine has been verified on a real device.

Outstanding, reported rather than silently deferred: ICO registration
— a self-assessment says the data protection fee applies, user has
deferred paying/registering it, so the privacy policy's registration
number line was removed entirely rather than left half-true. Store
assets (screenshots, a background-location demo video, the two
stores' privacy label/data-safety forms) haven't been started at all.

### 2026-09-22 (driver pay engine, step 4)
**The GPS engine and the Delivered button — native only.** Web drivers
keep entering mileage manually (OwedOrdersModal, step 2) since mobile
Safari suspends location the moment the screen locks. **NOT
DEVICE-TESTED** — see "Known broken" above for the testing note
(1.5 m/s floor filters walking pace; test in a car).

- **One watcher**: the existing background-geolocation watcher
  (step 3, already pushing live location) now also drives the mileage
  engine — not a second, competing watcher. Its callback pushes live
  location exactly as before, then (native only) feeds the same fix
  through geofence-transition detection and, while a run is active,
  through `src/lib/gpsFilter.ts`'s `applyFix`.
- **Filtering** (`gpsFilter.ts`, every threshold a named constant in
  one place): reject accuracy worse than `MIN_FIX_ACCURACY_M` (20m);
  reject speed below `MIN_MOVING_SPEED_MPS` (1.5 m/s) when the device
  reports one, rely on displacement alone when it doesn't; reject if
  implied speed from the last ACCEPTED point exceeds
  `MAX_IMPLIED_SPEED_MPS` (40 m/s) — a GPS jump; only accumulate once
  displacement from the last accepted point reaches
  `MIN_ACCUMULATE_DISPLACEMENT_M` (15m) — a fix that doesn't cross
  that is neither accumulated nor promoted to the new reference point,
  so small back-and-forth jitter around one spot can never compound
  into distance. Pure functions, no Capacitor/Supabase imports, so
  they're at least reasoned-about independent of a device even though
  this repo has no unit-test runner beyond the live-DB RLS suite to
  actually exercise them automatically.
- **Runs**: start on geofence exit, end on geofence re-entry (or
  clock-out without returning — handleClockOut finalizes any active
  run first, same as a remote clock-out via the realtime listener
  does). A run's whole lifecycle — drops, odometer — lives in
  `ClockInTab`'s own component state until it ends; nothing is written
  to `delivery_runs`/`delivery_drops` mid-run. That's also what makes
  "record drops... locally" while offline need no special-casing at
  the per-tap level: there's no network call at tap time to fail in
  the first place.
- **One-way distance**: a run's `one_way_miles` is the last drop's
  odometer reading — the return leg is excluded automatically, since
  nothing recorded after that last tap ever counts. Zero drops pays
  nothing and the run is discarded outright (never written at all).
  Written to `one_way_miles` and `gps_one_way_miles` together, source
  `'gps'`, via one new RPC (`record_delivery_run`, migration 0032)
  that inserts the run and all its drops in a single call — not two
  separate requests, so a connection drop between them can never leave
  an orphaned run with no drops or, on retry, a duplicate. `security
  invoker`, not `definer` — runs under the calling driver's own RLS,
  no new privilege over what 0028's `delivery_runs_insert_own`/
  `delivery_drops_insert_own` already allowed directly.
- **Offline**: reuses `offlineQueue.js`'s exact pattern (new
  `delivery_run_complete` entry type, same local-id correlation
  `clock_out` already uses for a shift that hasn't synced yet). A
  queued drop keeps its original timestamp and odometer reading
  because it was never anything else — it's been sitting in the
  in-memory drops array since the tap, untouched. `handleClockOut`
  awaits any pending run-finalize BEFORE its own clock-out
  request/enqueue, specifically so that if both end up queued offline,
  they queue in that order — `flushQueue` replays in order, so the run
  reaches the server while the shift is still open (required by its
  own RLS) before the clock-out entry right behind it closes it. This
  ordering is an implicit invariant (queue order = dependency order),
  not something the database enforces on its own.
- **Confirmed against step 2's orders confirmation**: no code change
  needed — OwedOrdersModal already reads `delivery_runs`/
  `delivery_drops` however they got there, manager-entered (step 2) or
  GPS-entered (this step); "N orders across M runs — correct?" fires
  the same way either way.
- **A real pre-existing gap this step exposed, fixed**: `ClockInTab`
  was conditionally rendered per active tab (`{tab === 'clock' &&
  <ClockInTab/>}`), unmounting — and tearing down the watcher — on
  every tab switch. Harmless before (a live-location ping just resumes
  a bit later), not harmless now: a driver checking Tasks or
  Timesheets mid-run would have silently lost every drop recorded
  since the last sync. Now always mounted, hidden via CSS
  (`display:none`) when another tab is active, so its state and
  effects survive a tab switch. Incidental fix: this also means
  tracking now starts on dashboard load regardless of which tab was
  last persisted, rather than only once the driver happens to visit
  Clock — previously, a driver whose persisted tab was e.g. Timesheets
  wouldn't be tracked at all until they manually switched tabs.
- **Disclosed, not fixed** (see "Known broken" above): a realtime
  listener catches a remote clock-out (the manager sweep) mid-run and
  finalizes the run — but only if the WebSocket subscription is still
  connected when the sweep fires. Deep OS backgrounding could have
  disconnected it; Postgres realtime doesn't backfill missed events on
  reconnect. True app/process death mid-run also loses that run's
  in-memory drops — no crash-recovery layer was built for this
  (deliberately out of scope: point 6 asked for network-loss
  resilience, a distinct concern from process-death resilience).

Build and a scoped `tsc --noEmit` are clean. No RLS suite changes this
step (no new RLS boundary, just wiring an existing schema up to a real
GPS source instead of a manager typing numbers in) — confirm it still
passes regardless before pushing, since 0032 is a new migration.

### 2026-09-22 (clock-out window hotfix)
**tg_protect_own_time_log blocked every non-manager clock-out.**
0020's trigger rejected ANY change to clock_out unconditionally in its
"everyone else" branch — an ordinary employee (or a manager acting on
their own row) could never clock themselves out at all. Found and
fixed live by the user (confirmed by impersonating a driver in SQL),
pulled back out via the MCP and recorded as
`0031_time_log_clock_out_window.sql` — already live, this migration
file is the record, not the change. New rule: an owner may set
clock_out exactly once, open to closed, within 5 minutes before now
through 1 minute after; a null-auth.uid() caller (pg_cron's
`sweep_open_shifts()`, an existing job — every 15 minutes — with no
migration file of its own, a pre-existing gap noted but not closed
here since it wasn't asked for) is exempt entirely.

Audited every clock-out path against the new window:
- **ManagerDashboard's client-side `runAutoClockOut` was broken by
  this fix** — it wrote a shift's own (already past) end_time as
  clock_out, running AS the viewer, for their own open shifts (and, if
  they can manage, everyone else's too). For the viewer's own row (or
  a manager's own), that's now always outside the window and always
  rejected. Removed outright rather than restricted to "managers
  closing someone else's shift" — that would still leave a manager's
  own forgotten shift stuck, and the pg_cron sweep already runs
  independent of whether any dashboard is ever opened, which was the
  original reason a client-side fallback existed at all.
- **The app sends its own timestamp for clock_out**
  (`new Date().toISOString()`, both the direct path and the offline
  queue), not a server-generated one. A device clock more than ~5
  minutes off system time would have its own clock-out rejected.
  Flagging, not fixing — not asked for, and the right fix (switch to a
  server-side timestamp vs. widen the window vs. leave it) is a real
  design choice.
- **A clock-out IS queued offline**
  (`src/lib/offlineQueue.js`'s `flushQueue`, `type: 'clock_out'`) and
  replayed with its ORIGINAL timestamp whenever connectivity returns —
  which can be well past 5 minutes later. That replay would now be
  rejected by the window, and since the entry is re-queued on failure
  with the same stale timestamp, it would fail identically forever
  rather than eventually succeeding. **Confirmed real, not fixed** —
  told rather than widening the window, per instruction. Needs a
  decision: exempt offline-synced clock-outs somehow, or timestamp them
  differently, or accept the manual-fix-required edge case.

Tests added (`tests/rls/negative/time-log-clock-out-window.test.ts`):
employee can clock out their own open shift; cannot set clock_out
outside the window; cannot change clock_out once set; a null-auth.uid()
caller (what the sweep runs as — the actual cron function can't be
invoked directly here, same as every other cron-only function in this
suite, guarded by a session_user/rolsuper check no service-role client
satisfies) can close an overdue shift outside the window.

### 2026-09-22 (driver pay engine, step 3)
**Native compliance for background location — gated on the role flag,
disclosed before the prompt, hard-stopped on clock-out.** No migration
this step (schema/app pay work was steps 1-2, already live — see the
step-1/step-2 entries below).

- **Role gate fixed**: the background-tracking effect in
  `EmployeeDashboard.tsx`'s `ClockInTab` checked `profile.role !==
  'Driver'` — a literal role NAME, wrong once roles are per-org
  configurable text. Now gated on `roles.tracks_orders` (mirrors
  `canViewMap`'s existing pattern exactly). This was the change that
  mattered most, for the DPIA as much as store review — a
  front-of-house employee must never be tracked in the background,
  and a name check doesn't guarantee that for an org that renames or
  adds delivery-style roles.
- **Prominent disclosure**: new `LocationConsentModal.tsx`, shown once
  per driver (persisted client-side) before the watcher starts —
  `addBackgroundLocationWatcher`'s `requestPermissions: true` (the
  actual system prompt) only fires after "Agree and continue".
  Required by Google Play ahead of a background-location request;
  shown on iOS too since it reads well to Apple's reviewers, not just
  where it's mandatory.
- **iOS**: `Info.plist`'s `NSLocationWhenInUseUsageDescription`/
  `NSLocationAlwaysAndWhenInUseUsageDescription` rewritten to the
  exact stated reasons (clock-in verification; mileage for pay +
  dispatch visibility, only while clocked in on a delivery shift).
  `showsBackgroundLocationIndicator` (the blue status-bar pill
  reviewers look for) turned out to already be automatic — it's a
  CLLocationManager property the plugin's own Swift side sets
  whenever a `backgroundMessage` is present, not an Info.plist key;
  documented in place rather than adding a redundant/wrong key.
- **Android**: manifest already had all four permissions
  (`ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`) from earlier
  work — confirmed, not re-added. The foreground notification text
  ("Shift active" / "Measuring delivery mileage") comes from JS
  (`backgroundTitle`/`backgroundMessage` in
  `src/lib/backgroundGeolocation.ts`); it's non-dismissible
  automatically too (`setOngoing(true)` in the plugin's own Java, a
  foreground-service property, not a manifest setting).
- **Hard stop, two gaps closed**: (1) the manager-side auto clock-out
  sweep (`ManagerDashboard.tsx`'s `checkAndCloseEndedShifts`) closes a
  shift from a *different* browser/device — the driver's own app
  previously had no way to learn its shift had ended, so tracking
  could keep running in the background indefinitely. Fixed with a
  realtime listener on the driver's own `time_logs` row in
  `ClockInTab`. (2) a watcher started before a crash or force-quit has
  no live JS context left to clean it up, and the plugin exposes no
  "stop everything" API, only `removeWatcher(id)`. Fixed by persisting
  the watcher id (`backgroundGeolocation.ts`) and checking for a stale
  one with no matching open shift on every app launch.
- Privacy policy notes section added near the end of this file, for
  whoever writes the actual policy.
- **Android cannot be device-tested yet; iOS will be tested via
  TestFlight** — neither has been verified on a real device this
  session, per the user.

### 2026-09-22 (later)
**Task lists/items redesign — the item becomes the unit of work.**
Migration `0026_task_lists_and_items.sql` is written, self-reviewed, and
committed, but **NOT YET RUN against the live database** — the user is
running it manually together with the app deploy, back to back at a
quiet time, to keep the broken window short. Do not assume it's live
without checking `mcp__supabase__list_migrations` first.

- `tasks`/`task_templates` become pure list containers (title,
  description, location, assignment, shared start/due time,
  recurrence). Everything that used to carry per-completion state —
  `status`, `completed_by/at`, `reviewed_by/at`, `requires_photo`,
  `is_required`, `max_photos` — moves down to new `task_items`/
  `task_template_items` tables, one row per unit of work. An item is
  submitted, reviewed, approved or rejected individually; a list with
  zero items can't be created (the create forms enforce at least one)
  and a template with zero items generates nothing.
- Data safety: existing data migrates losslessly — every existing task
  becomes a list with exactly one item carrying its old state. An
  in-transaction reconciliation check (`RAISE EXCEPTION` on mismatch)
  aborts the whole migration if any count doesn't add up, rather than
  leaving a half-migrated table. `tasks.photo_path` is deliberately
  NOT dropped yet, per instruction — its data was already copied to
  `task_photos` by 0025, reconciled again here, and the column itself
  waits for a later migration once nothing reads it.
- Everything the design review flagged got updated to match:
  `generate_task_instances()`, `notify_overdue_tasks()` (now one
  notification per LIST naming how many required items remain, not one
  per item — avoids burying a manager under a dozen at once),
  `tg_task_notify`/new `tg_task_item_notify`, `tg_task_comment_notify`,
  `purge_old_task_photos()`, new `can_see_task_item()`, the
  `task-photos` storage policy (now checks the new item-scoped
  function OR the old task-scoped one, permanently, since photos
  uploaded before this migration are still keyed by the old task id in
  the object store and can't be renamed via SQL), and every affected
  RLS policy.
- Two real bugs caught in self-review before this ever reached the
  user, both Postgres-semantics issues rather than typos: (1) explicit
  `DROP INDEX` statements after a `DROP COLUMN` that had already
  auto-dropped the same index (no `CASCADE` needed for a plain index —
  the redundant drops would have errored "does not exist"); (2)
  `tg_task_notify`'s rewritten body lost its `TG_OP = 'INSERT'` guard
  while the trigger itself was still `AFTER INSERT OR UPDATE`, which
  would have spuriously re-fired "New task" notifications on any edit
  to a one-off task's assignee — fixed by re-scoping the trigger
  definition itself to `AFTER INSERT` only.
- App code rewritten to match, committed in the same batch but **not
  pushed** (pushing triggers this project's Cloudflare Pages
  auto-deploy — deploying now, against the pre-migration schema, would
  break the live app immediately, the opposite of the "short broken
  window" goal):
  - `EmployeeTasks.tsx` — items are ticked off and submitted one at a
    time (`ItemCard`, self-contained per-item photo/comment state);
    list grouping (due now / upcoming / done) is derived from aggregate
    item state; realtime now watches both `tasks` and `task_items`.
  - `ManagerTasks.tsx` — `ReviewSection` reviews/approves/rejects
    individual items, not lists; `TemplateFormModal`/`OneOffFormModal`
    gained an `ItemsEditor` to draft one-or-more items per list
    (enforces at least one, can't remove the last); `HistorySection`
    fetches lists with items embedded (a proven query shape) and
    flattens to one row per item client-side, same place the existing
    role filter already ran client-side, to sidestep uncertainty about
    whether PostgREST supports ordering by an embedded resource's
    column. Editing an existing template's item set after creation is
    deliberately NOT implemented this pass — out of scope for what was
    asked, worth a follow-up.
- RLS test suite (`tests/rls/`) rewritten to match: `task_items` and
  `task_photos` added to fixtures (every fixture task now also creates
  exactly one item and one photo, so cross-org/anon sweeps aren't
  vacuous), `createTaskComment` takes a `task_item_id` now, teardown's
  delete order gained `task_photos`/`task_items`/`task_template_items`.
  New coverage: an employee can read and submit their own item; a
  manager is blocked from reading/updating an out-of-scope item or
  reading an out-of-scope photo, same boundary as before just moved
  down a table. **Could not run this against the live database this
  session** — no `.env.test` configured in this environment, and even
  with one, the new tests target tables/columns that don't exist until
  0026 actually runs. Run `npm run test:rls` manually right after the
  migration, before or instead of relying on the pre-push hook, since
  this is exactly the kind of change the hook exists to catch and it's
  never been exercised against the real schema yet.
- Both `npm run build` and a scoped `tsc --noEmit` (app + tests) are
  clean. No UI testing was possible this session (no device/browser
  access) — build and typecheck only.

### 2026-09-22
**Multi-photo task submission failing on iPhone (PGRST116), Mac Safari
fine, same account.** Investigated via code + live bucket config
(read-only MCP), no device access this session to reproduce directly —
report what was actually confirmed, not assumed:

- Uploads are correctly awaited (`Promise.all`, all resolve or the
  first rejection throws) before the `tasks` update ever runs — not a
  race between upload and update.
- A failed upload is not swallowed — `if (uploadError) throw
  uploadError` inside the map propagates through `Promise.all` to the
  outer `try/catch` and surfaces via `completeFault`, same as before.
- `task-photos` bucket has no `file_size_limit` and no
  `allowed_mime_types` restriction (both null, checked live) — HEIC
  isn't blocked at the storage layer, and neither is file size short of
  the project-wide default.
- Could not confirm a literal PGRST116 origin in this code path — every
  query here already uses `.maybeSingle()`, not `.single()`; grepped
  the whole app for `.single()` and none of the three remaining call
  sites (ManagerMoreTab, EmployeeDashboard, offlineQueue.js) are in
  this flow. Left as an open question rather than a confirmed
  diagnosis — possible it's a stale build on the test device, or a
  device-specific retry/double-tap path not fully traced here.

**Fixed regardless, since it's correct either way**: every task photo
now goes through `src/lib/compressImage.ts` before upload — resized to
1600px on the long edge, re-encoded as JPEG via
`createImageBitmap`/canvas, falling back to the original file untouched
if this browser can't decode it. Closes a real gap independent of the
PGRST116 report: WebKit's canvas typically can't decode HEIC in a web
content process even where Safari itself can display one directly, so
a HEIC photo was being stored exactly as captured but wasn't
guaranteed renderable as an `<img>` in the manager's own review/history
screens. Also directly helps the 1GB free-tier constraint multiple
photos per task already made more pressing (see the 2026-09-20 (later)
entry below).

**Next up if the failure recurs after this ships**: get the actual
device console output (Safari Web Inspector against the TestFlight
build, same as the nav-drift/zoom sessions) rather than continuing to
guess from code alone — this class of bug has repeatedly turned out to
be a WKWebView-specific behavior invisible to static review.

### 2026-09-20 (later)
**Task module: optional tasks and multi-photo, migration 0025 pending
(not yet run — read-only MCP, run manually).**

- **`is_required`** (default true, on `tasks`/`task_templates`, with a
  Required/Optional toggle in both create forms): an optional task
  that's never completed is now excluded from both
  `notify_overdue_tasks()` and HistorySection's "never completed" count
  — nobody should be chased for skipping something they were never
  required to do. Shown as an "Optional" badge on the employee side so
  someone busy knows what they can skip, and in the manager's template
  list and history rows.
- **`max_photos`** (default 1, capped 1-10, number input in the create
  forms shown only when photo is required) plus a new `task_photos`
  child table (id, org_id, task_id, storage_path, uploaded_by,
  created_at) replacing the single `tasks.photo_path` going forward —
  same RLS shape as `task_comments` (`can_see_task()` gates read and
  insert). Existing `photo_path` values were copied into `task_photos`
  by the migration; the column itself is deliberately NOT dropped yet
  (grepped the app afterward — nothing reads it anymore, but it stays
  until a later migration makes that permanent). The employee
  completion control now accepts up to `max_photos` files, uploading
  each before confirming the submission itself succeeded (so a lost
  shared-pool race never leaves a `task_photos` row misattributed to
  the loser — the uploaded storage objects just sit as harmless orphans
  in that case, same trade-off the old single-photo flow already
  accepted). Manager review and history both show a thumbnail stack
  with a count badge and a paginated lightbox (arrow keys work too)
  instead of one photo each.
- **Flag for later: storage.** Five photos per task across three sites
  fills the 1GB Supabase free tier considerably faster than the one
  photo per task this was sized against originally. Worth watching
  usage after this ships, and worth reconsidering `max_photos` defaults
  per template if it climbs faster than expected — no cap enforcement
  beyond the 1-10 per-task check constraint exists today.
- The monthly purge cron (`purge_old_task_photos`) now clears every
  `task_photos` row and its storage object for a task, not just one,
  plus nulls any leftover legacy `photo_path`.

### 2026-09-20
**Reminders module shipped and verified on device.** Admin/manager sends
a titled message with a description, one-off or recurring, to a role or
an individual, with an optional location narrowing a role target down
to one site. Staff must acknowledge it — a blocking modal on app open
and on tapping the notification, one at a time, oldest first, no
dismiss but Acknowledge — and the sender sees who has and hasn't, with
history filters (date range, target role, location, acknowledgement
state). Deleting distinguishes a recurring instance from its series
(deleting the instance never stops the series; deleting the template
does, same relationship as a shift's `series_id`) and distinguishes
retracting an outstanding reminder from clearing an already-acknowledged
one out of history in the UI copy, though the delete itself is the same
action either way.

Migrations 0022 (`reminder_templates`/`reminders`/
`reminder_acknowledgements`, the generation and notification crons,
admin-only RLS), 0023 (`target_location_id` on both tables, location
narrowing wired into the crons and RLS), and 0024 (managers can create
reminders too — scoped to a role at a location they manage or an
individual they manage via `manages_location()`/`manages_person()`,
same shape as `tmpl_manager_all`/`tasks_manager_all`; a manager sending
org-wide, i.e. a null `target_location_id`, is rejected; Administrators
keep full scope through the same mechanism) are all run and confirmed
working live. Two real bugs found and fixed along the way, both from
testing on the actual device rather than assuming the migration was
enough: a PostgREST embed named the FK column instead of the table
(`target_location_id` vs `locations!reminders_location_org_fkey`) —
composite FKs don't get PostgREST's column-name shorthand the way a
plain single-column FK does; and a 401 on `profiles` from the same
session-restore race already fixed in the module-scoped hooks
(`usePermissions`/`useRoles`/`useOrganisation`/`useLateGrace`/
`useManagedLocations`), reached this time through a new component that
fired its own unguarded query in a separate effect from the one
confirming the session.

Also fixed this session, unrelated to reminders:
- **More tab drill-down position now persists across a backgrounded
  reload** — the active top-level tab already survived it
  (sessionStorage), but leaving and returning from inside a More
  subsection (or the two-level Staff submenu) landed back on the top of
  the list. `MoreTabSections` now persists both levels the same way.
- **Timesheet Location column restored** — added in `beb52ca`, lost
  when that commit was fully reverted (`6a40915`) along with its
  unrelated nav-drift and live-map fixes. The nav drift was later
  re-fixed properly (`09bc803`), but the timesheet column never came
  back until this session.

### 2026-09-19
Two native-only WKWebView bugs, both confirmed fixed on a real device
this session, plus one process failure that cost most of the session
before either fix actually reached the device.

- **Nav drift (status bar pushing content/the bottom nav down by 42px)**
  — root cause and fix landed in commit `09bc803` the previous session,
  but "not yet confirmed on a device build" at the time it was written.
  **Confirmed this session.** Root cause: `viewport-fit=cover` makes
  `100dvh` resolve to the WebView's whole frame, safe areas included;
  with `ios.contentInset` at anything but `"never"` (it was
  `"scrollableAxes"`), iOS *also* pushes content down by the safe-area
  amount at the native `UIScrollView` layer, on top of a document
  already sized to the full frame — nowhere for that push to go, so the
  WebView's resting scroll position became 42 instead of 0, dragging
  the fixed bottom nav with it. Fixed by `ios.contentInset: "never"`
  plus `pt-[env(safe-area-inset-top)]` on both dashboards' `<header>`,
  so the inset is consumed as CSS padding inside the correctly-sized
  root instead of added on top of it natively.
- **Horizontal scroll drift on the Schedule tab (and, once found,
  everywhere else)** — reported as `scrollX: 50` with `docW: 402/402`
  and no element measuring wider than the viewport. Went through two
  wrong theories before the real one: first, that something was
  transiently wider than the viewport during a modal/popover
  transition (led to `resetDocumentScroll`, the `useAnchoredPopoverPosition`
  `useLayoutEffect` fix, and root `overflow-x` hardening — all kept,
  none of them wrong to have, but none of them were the cause).
  **Actual root cause, measured on-device**: `visualViewport.scale` was
  `1.6` — the page was zoomed, not overflowing, which is exactly why
  nothing ever measured as too wide. iOS Safari/WKWebView auto-zooms on
  focusing any input/select/textarea with a computed font-size under
  16px; this app's form fields were `text-sm`/`text-xs` (14px/12px)
  almost everywhere, so nearly every field in the app was a trigger,
  and the zoom doesn't reliably clear itself on blur or modal close.
  Fixed at the source: every form field across the app (75 fields, 16
  files — add shift, edit time log, invite staff, task templates/
  one-off tasks, orders modal, profile settings, wage rates, payroll
  report, overtime claim, shift swap/apply, unavailability) is now
  `text-base sm:text-sm` (or `sm:text-xs`) — 16px below `sm`, the
  smaller size only from `sm` up where iOS doesn't auto-zoom. A first
  attempt at a global override rule failed on-device even with
  `!important`, because it was unlayered against Tailwind v4's
  `@layer utilities` — moved into `@layer utilities` explicitly and
  re-verified against the compiled CSS output (not assumed) once
  correctly scoped. Kept as a `@layer utilities` safety net for
  anything future code adds as bare `text-sm`; the per-field fix is
  the real one, living entirely in Tailwind's own cascade. Also added
  `resetViewportZoom()` (briefly adds `maximum-scale=1` to the
  viewport meta, then removes it — snaps zoom back to 1 without
  disabling pinch-zoom) folded into `resetDocumentScroll()`, called on
  every tab change, every modal/popover close, and app load, as a
  safety net for whatever still slips through. Deliberately did NOT
  use `maximum-scale=1`/`user-scalable=no` in the viewport meta
  permanently — that disables pinch-zoom outright, an accessibility
  failure.
- **Process failure: most of this session was lost to fixes never
  reaching the device.** Every fix above was correct in the working
  tree well before it was confirmed — but was only committed to local
  `main`, never pushed, across several rounds of "still broken on
  device" reports. Every device build being tested was building
  `origin/main` at `09bc803`, unchanged. The font-size fix in
  particular was independently re-diagnosed, re-verified against
  compiled CSS, and re-confirmed correct in the working tree — genuinely
  fixed the whole time — before the actual gap (nothing had been pushed)
  was found. **Lesson: after any fix meant to be tested on a device
  build, confirm it's actually on `origin/main` (`git log
  origin/main..HEAD`), not just committed locally, before waiting on a
  device result.**
- **Cleanup**: `DebugOverlay.tsx` (a throwaway diagnostic, originally
  added for the nav-drift bug and extended for the scrollX drift,
  always-rendering with no trigger) removed entirely, along with its
  two render sites in `App.tsx`. `ios.webContentsDebuggingEnabled` set
  back to `false` in `capacitor.config.json` — was `true` for on-device
  Safari Web Inspector debugging during this session; an inspectable
  WebView in a shipped build is a real weakness.

### 2026-09-16
**The automated RLS test suite runs green: 128 tests across 11 files,
run for real against the live database, teardown confirmed clean
afterward via the MCP (zero rows at either reserved test org slug).**
First actual execution since it was built 2026-09-14 — everything
about it before today had only been verified by reading.

Building and running it, across this and the previous session, found
three real bugs:

- **Managers could edit their own clock in/out times.** Traced
  `tg_protect_own_time_log` (0017): it let any manager or admin
  through unconditionally, with no check on whose row was being
  edited. Fixed live (migration 0020): an administrator may edit their
  own hours and anyone else's; a manager may edit anyone else's hours
  but not their own; everyone else can only set `orders_count` on
  their own log.
- **`tg_shift_delete_notify` failed with `notifications_user_id_fkey`**
  when a shift was deleted as part of a cascade that had already
  removed the profile it pointed at — an `organisations` delete
  cascades to both `profiles` and `shifts` (both `org_id` CASCADE),
  and Postgres doesn't guarantee which sibling cascade runs first.
- **`tg_shift_update_notify` had the same bug via a different path** —
  `shifts.assigned_user_id` is `ON DELETE SET NULL`, so deleting a
  profile directly fires this trigger as an UPDATE while
  `old.assigned_user_id` is the profile just deleted in the same
  statement. **Reachable today via the "Delete permanently" button in
  StaffManager** — the more realistic of the two paths, since it's
  already-exercised production behaviour, not a hypothetical bulk-org
  delete. Both guarded in migration 0021 (skip the insert, rather than
  error, if the target profile no longer exists) — written and pushed,
  **not yet confirmed run**; see "Known broken."

The suite itself also had two bugs, found on this first real run:
timestamp assertions compared a JS `.toISOString()` string (ends in
`Z`) against Postgres's returned notation (`+00:00`) — same instant,
different string, fixed with a `sameInstant()` helper that parses both
sides before comparing; and `manager-scope.test.ts` asserted a manager
can't read an out-of-scope colleague's profile, which stopped being
true when `profiles_select_org` was deliberately widened to org-wide
(so a colleague's name renders instead of "Unknown" as a task
comment's author) — replaced with a dedicated block asserting what
actually holds: read succeeds, but role changes, deactivation, and
reading their time_logs/employee_notes/wage_rate all still fail.

**Re-run the suite after any RLS policy or trigger change** — that is
its entire purpose, and a green result only means anything for the
policy shape it was actually run against.

### 2026-09-14 (yet later)
**Automated RLS test suite built and pushed — NOT YET RUN.** Needs
`SUPABASE_SERVICE_ROLE_KEY` in a local `.env.test` to execute (see
README.md, "Automated RLS tests"); the read-only MCP connection used
for everything else in this file has no service-role access either, so
this had to be built and verified by reading, not by running.

- 8 negative test files (cross-org isolation across every table, an
  employee reading another employee's time_logs or reading
  `employee_notes`/`staff_wage_rates` at all, a location manager
  reaching anything outside their locations both by table and by
  calling `delete_staff_member`/`approve_shift_swap`/
  `approve_shift_application`/`decide_overtime_claim` directly, a
  manager reaching admin-only settings, a deactivated user,
  `clock_in`/`clock_out` immutability, anonymous access to every table
  and RPC) and 3 positive files (an employee's own data, a manager's
  own location, an administrator's whole org) in `tests/rls/`. Real
  test users signed in with `@supabase/supabase-js` against two
  dedicated test organisations, not a mock of the policies.
- A collision guard refuses to run if either reserved test org already
  exists, rather than risk seeding into or tearing down real data —
  this suite runs against **production** until a staging project
  exists.
- Writing it surfaced a real bug before it was even run: tracing
  `tg_protect_own_time_log` (0017) showed it let any manager or
  administrator through unconditionally, with no check on whose row
  was being edited — a manager could rewrite their own
  `clock_in`/`clock_out`, not just a subordinate's. **Fixed and run
  live, recorded as migration 0020 (pulled from the database via the
  MCP to match):** an administrator may edit their own hours (and
  anyone else's, as before); a manager may still edit anyone else's
  hours, but not their own; everyone else can only set `orders_count`
  on their own log, unchanged. `time-log-immutable.test.ts` updated to
  match: manager and employee self-edits still fail, administrator
  self-edit and a manager editing a subordinate's log now succeed.

**Next session: get the service role key, run `npm run test:rls`, and
fix whatever it finds** — see "Next up" above. Nothing in this suite
has ever actually executed against the live database.

### 2026-09-14 (later)
This session, on top of the Week 1 UI batch below:

- **Fixed infinite recursion (42P17) in the time_logs update policy**
  (migration 0017 — run live via direct SQL before the migration file
  was written to match, so already confirmed applied).
  `time_logs_update_own_orders`'s `WITH CHECK` compared `to_jsonb()` of
  the stored row against the new one — selecting from `time_logs`
  inside a `time_logs` policy. Replaced with a plain org+user check in
  USING/WITH CHECK, plus a new `tg_protect_own_time_log` BEFORE UPDATE
  trigger (a policy can't see the previous row; a trigger can) that
  lets a manager through and otherwise rejects any change to
  `clock_in`/`clock_out`/`user_id`/`location_id`/`is_geofenced_valid` —
  so a driver can still only set their own `orders_count`, never
  rewrite their hours.
- **Add-shift availability warnings** (`ManagerScheduler.jsx`) — a role
  filter above the staff picker; the list splits into Available/
  Unavailable sections with the reason shown inline ("Approved time
  off, 14–16 Sep" / "Already scheduled 17:00–22:00 at Chelmsford").
  Unavailable people stay selectable — it's a warning, not a block. A
  recurring series is checked across every occurrence in one query
  (not per-date), and the save confirmation names the specific
  reason/date, or for multiple clashes, the count and a capped date
  list.
- **Driver order capture** — a blocking modal on any outstanding
  completed shift for a role with `tracks_orders`, an Orders column in
  both Timesheets and the payroll CSV, editable by a manager. **Mileage
  was removed at the user's request** — `time_logs.extra_miles` stays
  in the schema, unused, rather than being migrated out.
- **Wage rates** (migration 0018, `staff_wage_rates` — run and
  verified: the Pay section 404'd until this was applied, then wage
  history loaded correctly) — effective-dated per `(profile_id,
  effective_from)` rather than a column on `profiles`, so a pay rise
  doesn't rewrite the cost of a past shift and a backdated rise still
  recalculates correctly from its own start date. RLS is
  `is_admin()`-only for every operation, no policy at all for anyone
  else; `wage_rate_at()` is the one sanctioned read path elsewhere in
  the schema — SECURITY DEFINER, but returns null unless the caller is
  an admin, so it can't be used to probe pay. `hourly_rate` and
  `effective_from` added to `sentryScrub.ts`'s redaction list. A Pay
  section on StaffManager's expanded staff row (admin only); a Cost
  column in Timesheets and the payroll report (hours × the rate
  effective on that shift's date, admin only).
- **Per-order pay** (migration 0019, `organisations.order_rate` — run
  and verified: the order-rate setting appeared in the admin More tab
  after this was applied, and the Total column calculates correctly in
  both the on-screen report and the CSV) — per-org, not hardcoded, same
  access model as the existing `late_grace_minutes` column (any org
  member reads, only an admin writes). A setting for it sits next to
  the grace period in the admin More tab. The payroll report gets a
  Total column per row (hours × wage rate + orders × order rate) and a
  per-person total for the whole selected period, keyed by profile id
  rather than display name. The order rate used is snapshotted at
  generation time and printed into both the on-screen header and the
  CSV, so an exported file stays correct and self-explanatory even
  after the setting later changes. Cost and Total are both individually
  selectable in the CSV column picker.
- **Responsiveness pass** across everything built since the last one
  (the two-level More submenu, task history, the payroll report and
  its column picker, the pay section, the orders modal, add-shift
  availability) — audited every screen at 375/768/1280px plus tablet
  and landscape. Four real findings, all fixed: PayrollReportModal's
  results table (now up to 7 columns) had no small-screen fallback —
  now stacks into cards below `sm`, a real table `sm:` and up, matching
  the pattern already established in `TimesheetsPanel`; RolesCard's
  reorder buttons were 22×22px, under the 44px minimum; the Live
  Map/Roster grid skipped straight from one column to `lg`, wasting
  tablet width; the org-name `truncate` span's wrapper had a
  contradictory `shrink-0` next to `min-w-0` that silenced it entirely.
  Everything else checked (all 12 modals' safe-area padding, the
  driver-facing screens specifically, long-content wrapping elsewhere)
  came back clean — in particular, the orders modal (flagged as
  blocking, since if its button were unreachable a driver couldn't use
  the app at all) was confirmed safe at both 375×667 and 375×812.

### 2026-09-14
**Week 1 UI batch (10 items) complete and verified on the live site**:

- **Delete Account** (App Store blocker) — Profile settings section in
  both dashboards calling `delete_my_account()` (migration 0016),
  stating plainly that login/personal details are erased while worked
  hours are retained for payroll/legal reasons, gated behind typing
  `DELETE`. Verified it correctly refuses when the caller is the only
  administrator in their org.
- Map role filter removed (location filter kept) — the live map only
  ever shows drivers, so the role filter had nothing to do there.
- Weekly hours removed from the staff list.
- Staff submenu with two-level navigation (`MoreTabSections` now
  supports a second nav level: Staff opens staff list / roles / invite
  staff / grace period, Back returns one level at a time).
- Change password folded into Profile settings instead of its own row.
- Admin More list reordered: profile settings, staff, unavailability
  requests, overtime claims, shift requests, locations, branding.
- Administrator roles excluded from the open-shift required-role
  picker — you cannot post an open shift for an administrator.
- Active tab persisted to `sessionStorage` in both dashboards — fixes
  iOS Safari resetting to the first tab when the backgrounded page's JS
  context gets dropped and reloaded.
- Location name shown on each shift in the manager schedule view
  (previously staff name and role only).

Still outstanding from the original list, not part of this batch:
add-shift availability warnings and driver order/mileage capture on
clock-out — see "Next up" above.

### 2026-09-12 (still later)
Migrations 0015 and 0016 run and verified.

- **0015 — orders and cleanup**: `roles.tracks_orders` (capability flag,
  set true for each org's Driver role, so a renamed role keeps the
  behaviour); `time_logs.orders_count`/`extra_miles`, nullable, driving a
  "still owes an entry" prompt for anyone whose role tracks orders; a new
  `time_logs_update_own_orders` RLS policy letting a driver set only
  those two columns on their own already-closed log — a `to_jsonb()` row
  diff in `WITH CHECK` locks every other column, including `clock_in`/
  `clock_out` themselves, so this can't be used to edit anything else.
  Every location's `radius_meters` set to 75m. The unused `Employee` role
  deleted — confirmed zero profiles held it, in any org, before including
  the delete.
- **0016 — delete_my_account() for App Store compliance**: Apple requires
  in-app account deletion, not just deactivation. Anonymises the caller's
  profile (name/email cleared, `is_active` false) rather than deleting
  it, deletes their own `live_locations`/`profile_locations`/
  `notifications` rows and any still-pending requests, then deletes
  `auth.users` — leaving `time_logs`, `shifts`, and `employee_notes`
  intact under payroll/legal retention. Refuses if the caller is their
  org's only administrator, so the org can't be orphaned.
  - Found while writing it: `profiles.id` had `references auth.users(id)
    on delete cascade` — deleting `auth.users` would have immediately
    cascade-deleted the just-anonymised profile row too, and everything
    under it. Dropped that FK entirely; `profiles.id` no longer requires
    a live `auth.users` row. `delete_staff_member()` relied on exactly
    that cascade to wipe a profile, so it now explicitly deletes
    `public.profiles` itself first — same end result, no longer
    dependent on the FK just removed.
  - Also found, fixed in the same migration: `overtime_claims.decided_by`
    and `unavailability_requests.decided_by` referenced `profiles(id)`
    with no `ON DELETE` action at all, which would have blocked deleting
    any profile that had ever approved/denied one of those, independent
    of the account-deletion work above. Both changed to `ON DELETE SET
    NULL` — the decision stands as a historical record once the manager
    who made it is gone. Audited all 24 FKs referencing `profiles(id)`
    for the same gap: these two were the only ones; everything else
    already correctly used `SET NULL` (every `created_by`/
    `assigned_user_id`/`reviewed_by`/`completed_by`-shaped column, plus
    `employee_notes.manager_id`/`deleted_by`) or `CASCADE` (only where
    the row is meaningless without the person it belongs to).

### 2026-09-12 (yet later)
**Phase 3 security review complete.** 18 findings total; 11 fixed
(all 3 CRITICAL, both HIGH, 4 of 8 MEDIUM) across migrations 0006–0014,
run and verified via the MCP at each step:

- Anon-callable destructive `pg_cron`-only functions
  (`purge_expired_open_shifts`, `purge_old_task_photos`, plus
  `generate_task_instances`/`sweep_open_shifts`/`notify_overdue_tasks`,
  same class) — revoked from anon/authenticated/PUBLIC entirely, guarded
  against ever being callable outside `pg_cron` (0006, guard corrected in
  0010 after discovering `current_user` doesn't work inside a
  `SECURITY DEFINER` function — `session_user` does).
- `task-photos` storage had no org/task scoping at all — any
  authenticated user on the platform could read or overwrite another
  org's task-completion photos (0009).
- `profile_locations` writes had no `manages_location()` check — a
  privilege-escalation path, since a location-scoped Manager could
  reassign an out-of-scope employee onto a location they do manage and
  thereby gain `manages_person()` over them (0008).
- `notify_org_managers()`/`notify_location_managers()` — anon-callable
  with an arbitrary org_id and attacker-controlled title/body, no check
  at all (0010).
- `swaps_manager_all` now requires managing both sides of a swap, not
  just the requester (0011); `notif_manager_insert` now requires
  managing the notification's recipient (0012); `can_see_task()`'s
  manager branch now requires `manages_location()`, not bare
  `is_manager()` — this also fixes `task_comments`, which had the same
  gap all along (0014).
- **Composite foreign keys** now tie `location_id` to its own `org_id`
  on `profile_locations`, `shifts`, `tasks` and `task_templates` (0013)
  — cross-tenant separation no longer rests on RLS alone, which can be
  bypassed by any `SECURITY DEFINER` function. Confirmed zero existing
  rows violated this before the migration ran.

Sentry and UptimeRobot are live. Supabase Pro (point-in-time backups)
deliberately deferred until ready to pay. 7 findings remain open, none
urgent — see "Known broken" above.

### 2026-09-12 (later)
- Migrations 0008 and 0009 run and verified via the MCP.
  `proflocs_manager_all` now carries `manages_location(location_id)` in
  both USING and CHECK (finding 3, CRITICAL — fixed). `task_photos_read`/
  `task_photos_write` now resolve the object path back to a task and
  gate on `can_see_task()`, regex-guarded before the uuid cast (finding
  1, CRITICAL — fixed). Confirmed `authenticated` still has EXECUTE on
  both `can_see_task` and `manages_location` post-migration, so neither
  policy fails closed. One CRITICAL remains open — see "Next up" above.

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

## Privacy policy notes

For whoever writes the actual privacy policy — what the app does, not
polished copy.

- **Background location is collected for one purpose only**: measuring
  delivery mileage that a driver's pay is based on, and showing
  managers where drivers are for dispatch. Not analytics, not
  advertising, not location history beyond what's needed for those two
  things.
- **Only staff whose role has `tracks_orders` set are ever tracked in
  the background.** Gated on that flag, never a role name — an org can
  call its delivery role anything. A front-of-house employee, or any
  other non-tracking role, is never tracked in the background, full
  stop, regardless of whether they're clocked in. See
  `EmployeeDashboard.tsx`'s `tracksLocation` (mirrors `canViewMap`'s
  existing pattern) and migration 0028's `roles.tracks_orders`.
- **Only while clocked in on a shift**, never outside one. Tracking
  starts when a tracked-role driver clocks in and stops the moment
  they clock out — including a clock-out triggered remotely by a
  manager's auto clock-out sweep, not just the driver's own button
  (see the realtime listener in `ClockInTab`, added specifically
  because the sweep runs from a different browser/device with no other
  way to reach the driver's own app).
- **In-app disclosure before the system permission prompt** —
  `LocationConsentModal`, shown once per driver (persisted client-side)
  before `addBackgroundLocationWatcher`'s `requestPermissions: true`
  ever fires. States what's tracked, when, and why, in plain language,
  before iOS/Android's own prompt appears.
- **Stored data**: raw coordinates go to `live_locations` (current
  position only, for the dispatch map) and `delivery_runs`/
  `delivery_drops` (mileage/pay audit trail — see migration 0028).
  Neither is a general-purpose location history; both are scoped to
  what a driver's own shift needs.
- **A leftover watcher from a crash or force-quit** is checked for on
  every app launch and stopped if the shift it was tracking for has
  since closed — see the persisted watcher id in
  `backgroundGeolocation.ts` and the launch-time check in `ClockInTab`.

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
