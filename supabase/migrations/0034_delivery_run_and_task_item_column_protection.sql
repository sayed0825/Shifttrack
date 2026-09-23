-- ============================================================================
-- 0034_delivery_run_and_task_item_column_protection.sql
--
-- Security audit findings 3, 5 (2026-09-23) -- both confirmed live against
-- a throwaway org + real session before writing this.
--
-- Finding 3: delivery_runs_insert_own's with_check never restricted which
-- columns a direct INSERT could set -- a driver could POST a fully-formed
-- run (one_way_miles, gps_one_way_miles, mileage_source: 'gps') straight
-- past record_delivery_run and its whole filtering engine. Confirmed:
-- inserted 500 fabricated miles, zero error.
--
-- Fixing this needs to tell apart two things that look identical to a
-- trigger -- record_delivery_run's OWN insert (which legitimately DOES
-- need to set these, that is its entire job) and a raw client insert
-- (which must not) -- both run as the same auth.uid(), same role. Solved
-- with a transaction-local GUC: record_delivery_run sets
-- kite.internal_delivery_run_insert before its own insert: the new
-- BEFORE INSERT trigger checks for it and only nulls out the three
-- mileage columns when it's absent. is_local (the third set_config
-- argument), so it can never leak past the transaction that set it.
--
-- Deliberately universal, not driver-only: no current insert path (the
-- driver's finalizeRun, or a manager's "Add run" in EditLogModal) ever
-- legitimately sets mileage at INSERT time anyway -- EditLogModal's own
-- "Add run" already inserts blank and sets one_way_miles via a later
-- UPDATE, which tg_protect_delivery_run (0028) already gates correctly.
-- Silently nulls rather than rejecting the insert outright -- "a directly
-- inserted run starts with no mileage," not "a directly inserted run is
-- refused."
--
-- Finding 5: task_items_submit's with_check only ever constrained
-- `status`. In the same UPDATE call meant to submit your own work, an
-- assignee could also set completed_by to a DIFFERENT real profile
-- (confirmed live -- no error), plus rewrite the item's own definition
-- (is_required: false, max_photos: 9, also confirmed live, no error).
-- New BEFORE UPDATE trigger: for anyone who isn't a manager/admin (who
-- already go through task_items_manager_all, a full ALL policy, not this
-- path), the task's definition columns are frozen and completed_by is
-- force-derived from auth.uid(), never trusted from the client -- same
-- "force-derive, don't just validate" pattern mileage_source already
-- uses. requires_photo/task_id/template_item_id/reviewed_by/reviewed_at
-- added to the frozen set alongside the explicitly named
-- is_required/max_photos/title/sort_order -- same "task definition, not
-- user input" reasoning extended to the columns adjacent to the ones
-- named outright.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- delivery_runs: INSERT-time mileage columns
-- ----------------------------------------------------------------------------

create function public.tg_protect_delivery_run_insert()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(current_setting('kite.internal_delivery_run_insert', true), 'false') = 'true' then
    return new;
  end if;

  new.one_way_miles := null;
  new.gps_one_way_miles := null;
  new.mileage_source := null;

  return new;
end; $function$;

create trigger protect_delivery_run_insert
  before insert on public.delivery_runs
  for each row execute function public.tg_protect_delivery_run_insert();

create or replace function public.record_delivery_run(
  p_time_log_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_one_way_miles numeric,
  p_drops jsonb
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run_id uuid;
begin
  -- Local to this transaction only -- tg_protect_delivery_run_insert
  -- checks for it on the very next statement and never sees it again
  -- once this function's (implicit, single-statement-per-call) transaction
  -- ends.
  perform set_config('kite.internal_delivery_run_insert', 'true', true);

  insert into public.delivery_runs (time_log_id, started_at, ended_at, one_way_miles, gps_one_way_miles, mileage_source)
  values (p_time_log_id, p_started_at, p_ended_at, p_one_way_miles, p_one_way_miles, 'gps')
  returning id into v_run_id;

  insert into public.delivery_drops (run_id, sequence, delivered_at, latitude, longitude, accuracy, odometer_miles)
  select
    v_run_id,
    (d->>'sequence')::integer,
    (d->>'delivered_at')::timestamptz,
    (d->>'latitude')::double precision,
    (d->>'longitude')::double precision,
    nullif(d->>'accuracy', 'null')::double precision,
    (d->>'odometer_miles')::numeric
  from jsonb_array_elements(p_drops) as d;

  return v_run_id;
end; $function$;

-- ----------------------------------------------------------------------------
-- task_items: the employee submit path
-- ----------------------------------------------------------------------------

create function public.tg_protect_task_item_submit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Managers/admins reach task_items through task_items_manager_all (a
  -- full ALL policy), not the assignee's own submit path -- this trigger
  -- still fires for their edits too, so let them through untouched.
  if public.is_manager() then
    return new;
  end if;

  -- No session (service role / cron) -- trusted server context.
  if (select auth.uid()) is null then
    return new;
  end if;

  -- The item's own definition belongs to whoever set up the task, not
  -- whoever is submitting it.
  if new.is_required is distinct from old.is_required
     or new.requires_photo is distinct from old.requires_photo
     or new.max_photos is distinct from old.max_photos
     or new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.sort_order is distinct from old.sort_order
     or new.template_item_id is distinct from old.template_item_id
     or new.task_id is distinct from old.task_id
     or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at then
    raise exception 'You can only submit your own work, not change the task itself' using errcode = '42501';
  end if;

  -- Force-derived, never trusted from the client -- same reasoning as
  -- mileage_source elsewhere in this schema.
  new.completed_by := (select auth.uid());

  return new;
end; $function$;

create trigger protect_task_item_submit
  before update on public.task_items
  for each row execute function public.tg_protect_task_item_submit();

commit;
