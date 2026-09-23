-- ============================================================================
-- 0039_invite_log.sql
--
-- 2026-09-23: invite-staff sends a real email through Resend on every
-- call, with no per-caller cap. Any authenticated manager/admin session
-- could call it in a loop and use the project as a mass-mail relay.
--
-- invite_log is the record the Edge Function checks against and writes
-- to. RLS: an admin may SELECT their own org's rows (an audit trail of
-- who invited whom, when). Nobody writes through the API at all — no
-- insert/update/delete policy exists for authenticated or anon, so
-- that's a default deny; only service_role (which the Edge Function
-- uses, and which carries BYPASSRLS on this project, confirmed via
-- pg_roles) can write.
-- ============================================================================

begin;

create table public.invite_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  email_sent_to text not null,
  created_at timestamptz not null default now()
);

create index invite_log_sender_created_idx on public.invite_log (sender_id, created_at desc);

alter table public.invite_log enable row level security;
alter table public.invite_log force row level security;

create policy invite_log_admin_select
  on public.invite_log
  for select
  to authenticated
  using (org_id = public.my_org_id() and public.is_admin());

commit;
