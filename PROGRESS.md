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
**Next up:** Phase 3 hardening

**Known broken / unverified:**
- Hardcoded Supabase credentials in `src/supabaseClient.js` — workaround
  for a Bolt bug, must move to environment variables
- SMTP not set up. Supabase's built-in mailer caps at a few emails per
  hour, nowhere near enough for 60 staff
- MapTiler key not domain-restricted
- Job roles are still hardcoded in the frontend (`ALL_ROLES` in
  `ManagerDashboard.tsx`) — need to become per-organisation

---

## Log

### 2026-09-02
- Phase 2 multi-tenancy: added `organisations` table, backfilled `org_id`
  across all tables
- Rewrote every RLS policy to scope by `my_org_id()`
- Updated triggers and RPCs for the new org scoping
- Verified isolation with a second test organisation
- Known gap: job roles are still hardcoded in the frontend, need to
  become per-organisation

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
