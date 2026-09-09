-- ============================================================================
-- 0002_role_at_clock_in.sql
--
-- The payroll report (PayrollReportModal) grouped hours by a person's
-- current role, so a promotion or role change silently rewrote every past
-- hour they had ever worked under it. This records the role at the moment
-- of clock-in instead, so historical payroll data stays accurate after a
-- role change.
--
-- role_at_clock_in already exists on time_logs in the live database (see
-- 0001_baseline.sql), but nothing in the app has ever set or read it —
-- this migration is what actually starts using it. `add column if not
-- exists` keeps this migration safe to run regardless.
-- ============================================================================

alter table public.time_logs
  add column if not exists role_at_clock_in text;

comment on column public.time_logs.role_at_clock_in is 'The role held at clock-in, set on insert. Payroll reporting groups by this rather than a profile''s current role, so a promotion does not rewrite which role earned past hours.';

-- Backfill existing rows with the person's current role. Not strictly
-- accurate for anyone who has changed role, but better than null and it
-- is the only information available.
update public.time_logs t
set role_at_clock_in = p.role
from public.profiles p
where p.id = t.user_id and t.role_at_clock_in is null;
