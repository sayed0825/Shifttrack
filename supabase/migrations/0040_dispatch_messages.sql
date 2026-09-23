-- ============================================================================
-- 0040_dispatch_messages.sql
--
-- Dispatch chat: a per-location, real-time driver-status feed. FOH and
-- managers watch it; only a tracks_orders driver posts, and only via
-- buttons -- there is deliberately no body/free-text column anywhere in
-- this schema for anyone to put arbitrary text into. Design discussed
-- and approved with the user before this was written; see PROGRESS.md.
--
-- Every identity/scoping column (org_id, location_id, time_log_id,
-- sender_id) and eta_minutes/drop_sequence are force-derived server-side
-- by tg_dispatch_message_insert -- a client's own insert can only ever
-- vary `status`, and even that is constrained to the two client-
-- initiated values ('delivered', 'returning') by the RLS with_check.
-- 'arrived'/'stale' are only ever reachable via mark_dispatch_message_
-- arrived() or the (separately built) ETA Edge Function's own update --
-- there is no UPDATE policy for authenticated at all, same shape as
-- invite_log (0039): nobody writes through the API except the trusted
-- path.
--
-- Also fixes a real pre-existing bug this design's realtime check
-- surfaced: pg_publication_tables showed only live_locations and
-- notifications were ever added to the supabase_realtime publication.
-- Every OTHER .channel()/postgres_changes subscription in the app
-- (roles, time_logs, tasks, task_items, task_comments) has been
-- listening for events that could never arrive -- confirmed via
-- `select * from pg_publication_tables where pubname = 'supabase_realtime'`
-- before writing this. Most consequential: EmployeeDashboard's own
-- `clock-in-tab-${profile.id}` channel on time_logs is what's supposed
-- to detect a REMOTE clock-out (the manager sweep closing a forgotten
-- shift from a different device) so an in-progress delivery run gets
-- finalized -- that mechanism has never actually fired from a real
-- postgres_changes event since it was built.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------

create table public.dispatch_messages (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations (id) on delete cascade,
  location_id   uuid not null references public.locations (id) on delete cascade,
  time_log_id   uuid not null references public.time_logs (id) on delete cascade,
  sender_id     uuid not null references public.profiles (id) on delete set null,
  status        text not null check (status in ('delivered', 'returning', 'arrived', 'stale')),
  -- Only meaningful while status is 'returning' or 'stale' (the last
  -- known figure is kept on staling, not wiped -- "last seen at 12
  -- mins" is more useful than nothing). Always null otherwise.
  eta_minutes   integer,
  -- Only meaningful for status = 'delivered'. Server-derived count of
  -- this driver's delivered posts so far THIS SHIFT (not reset per
  -- outing) -- "Delivered * drop 2" reads as a running tally FOH can
  -- follow across the whole shift, not a per-trip count that resets
  -- confusingly mid-feed.
  drop_sequence integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index dispatch_messages_location_idx on public.dispatch_messages (location_id, created_at desc);
create index dispatch_messages_time_log_idx on public.dispatch_messages (time_log_id);

-- ----------------------------------------------------------------------------
-- 2. INSERT-time derivation -- see header. A client's insert can only
-- ever vary `status`; everything else comes from their own open shift,
-- never trusted from the request body.
-- ----------------------------------------------------------------------------

create function public.tg_dispatch_message_insert()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_shift record;
begin
  select id, org_id, location_id
    into strict v_shift
    from public.time_logs
    where user_id = (select auth.uid()) and clock_out is null;

  new.time_log_id := v_shift.id;
  new.org_id := v_shift.org_id;
  new.location_id := v_shift.location_id;
  new.sender_id := (select auth.uid());
  new.eta_minutes := null;

  if new.status = 'delivered' then
    select count(*) + 1 into new.drop_sequence
      from public.dispatch_messages
      where time_log_id = v_shift.id and status = 'delivered';
  else
    new.drop_sequence := null;
  end if;

  return new;
exception
  when no_data_found then
    raise exception 'You must be clocked in to post to dispatch chat' using errcode = '42501';
  when too_many_rows then
    raise exception 'Could not determine your current shift' using errcode = '42501';
end; $function$;

create trigger dispatch_message_insert
  before insert on public.dispatch_messages
  for each row execute function public.tg_dispatch_message_insert();

-- ----------------------------------------------------------------------------
-- 3. UPDATE-time state machine -- defense in depth. Only
-- mark_dispatch_message_arrived() and the (separately built) ETA Edge
-- Function's service-role update ever reach this at all, since there is
-- no UPDATE policy for authenticated -- but this still holds even if
-- one of those is ever called out of order, or a future change adds
-- more callers.
-- ----------------------------------------------------------------------------

create function public.tg_protect_dispatch_message()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.status in ('delivered', 'arrived') then
    raise exception 'This dispatch message can no longer be changed' using errcode = '42501';
  end if;

  -- old.status is 'returning' or 'stale' here. Only a same-family
  -- refresh (returning/stale -> returning/stale, eta_minutes/status
  -- changing) or a resolution to 'arrived' (eta_minutes forced null) is
  -- allowed -- everything else about the row is frozen.
  if new.org_id is distinct from old.org_id
     or new.location_id is distinct from old.location_id
     or new.time_log_id is distinct from old.time_log_id
     or new.sender_id is distinct from old.sender_id
     or new.drop_sequence is distinct from old.drop_sequence
     or new.created_at is distinct from old.created_at then
    raise exception 'This dispatch message can no longer be changed' using errcode = '42501';
  end if;

  if new.status = 'arrived' then
    new.eta_minutes := null;
  elsif new.status not in ('returning', 'stale') then
    raise exception 'Not a valid dispatch message transition' using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end; $function$;

create trigger protect_dispatch_message
  before update on public.dispatch_messages
  for each row execute function public.tg_protect_dispatch_message();

-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------

alter table public.dispatch_messages enable row level security;
alter table public.dispatch_messages force row level security;

create policy dispatch_messages_insert_own
  on public.dispatch_messages
  for insert
  to authenticated
  with check (
    status in ('delivered', 'returning')
    and exists (
      select 1 from public.profiles p
      join public.roles r on r.org_id = p.org_id and r.name = p.role
      where p.id = (select auth.uid()) and r.tracks_orders
    )
  );

create policy dispatch_messages_select
  on public.dispatch_messages
  for select
  to authenticated
  using (
    org_id = public.my_org_id()
    and (
      public.manages_location(location_id)
      or exists (
        select 1 from public.time_logs tl
        where tl.user_id = (select auth.uid()) and tl.clock_out is null and tl.location_id = dispatch_messages.location_id
      )
    )
  );

-- No update/delete policy for authenticated -- see header.

-- ----------------------------------------------------------------------------
-- 5. mark_dispatch_message_arrived -- the geofence-re-entry transition.
-- No external call needed (no Mapbox involved), so this is a plain
-- SECURITY DEFINER RPC rather than routed through the ETA Edge
-- Function, which exists only for the one thing that genuinely needs
-- its secret.
-- ----------------------------------------------------------------------------

create function public.mark_dispatch_message_arrived(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update public.dispatch_messages
    set status = 'arrived'
    where id = p_message_id
      and sender_id = (select auth.uid())
      and status in ('returning', 'stale');

  if not found then
    raise exception 'Dispatch message not found, not yours, or already resolved' using errcode = '42501';
  end if;
end; $function$;

grant execute on function public.mark_dispatch_message_arrived(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Staleness sweep -- same shape as sweep_open_shifts(): a 'returning'
-- message untouched for 15 minutes is marked 'stale' rather than left
-- to show an increasingly wrong ETA forever. Still resolvable to
-- 'arrived' afterwards (see mark_dispatch_message_arrived's own
-- status in ('returning','stale') check) -- a staled trip can still
-- end in a real arrival once signal recovers.
-- ----------------------------------------------------------------------------

create function public.sweep_stale_dispatch_messages()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  swept integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'sweep_stale_dispatch_messages() may only be run by pg_cron' using errcode = '42501';
  end if;

  update public.dispatch_messages
    set status = 'stale'
    where status = 'returning' and updated_at < now() - interval '15 minutes';
  get diagnostics swept = row_count;

  return swept;
end; $function$;

-- ----------------------------------------------------------------------------
-- 7. Retention -- 14 days, same pattern as purge_old_task_photos().
-- ----------------------------------------------------------------------------

create function public.purge_old_dispatch_messages()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  purged integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'purge_old_dispatch_messages() may only be run by pg_cron' using errcode = '42501';
  end if;

  delete from public.dispatch_messages where created_at < now() - interval '14 days';
  get diagnostics purged = row_count;

  return purged;
end; $function$;

select cron.schedule('sweep-stale-dispatch-messages', '*/5 * * * *', $$select public.sweep_stale_dispatch_messages();$$);
select cron.schedule('purge-dispatch-messages',       '45 3 * * *',  $$select public.purge_old_dispatch_messages();$$);

-- ----------------------------------------------------------------------------
-- 8. Realtime publication. dispatch_messages needs this to deliver any
-- postgres_changes event at all -- and per the header, five EXISTING
-- tables the app already subscribes to were missing from the
-- publication too, silently. Adding all of them here.
-- ----------------------------------------------------------------------------

alter publication supabase_realtime add table public.dispatch_messages;
alter publication supabase_realtime add table public.time_logs;
alter publication supabase_realtime add table public.roles;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.task_items;
alter publication supabase_realtime add table public.task_comments;

commit;
