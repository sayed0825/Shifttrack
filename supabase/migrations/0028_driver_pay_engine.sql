-- ============================================================================
-- 0028_driver_pay_engine.sql
--
-- Step 1 of 4: schema only. No app code reads any of this yet.
--
-- Replaces an earlier version of this same migration number, deleted
-- before it was ever run -- that version modeled mileage per ORDER
-- (excess over orders_count x an allowance, halved). Wrong. The correct
-- model, confirmed against a worked example, is per DELIVERY RUN: the
-- one-way distance from the store to the run's last drop, minus a flat
-- free-miles allowance, capped per run, summed across the shift's runs.
-- The return trip is excluded by construction -- one_way_miles is the
-- odometer reading at the LAST drop, recorded by the app (later step),
-- not something this schema computes.
--
-- Worked example this migration's test asserts exactly:
--   2 drops, one run, one-way 6.5mi, defaults (free 3.5, rate 0.50,
--   cap 2.00): run_mileage = min(max(0, 6.5-3.5) x 0.50, 2.00) = 1.50.
--   orders_pay = 2 x £1.00 = 2.00. With no wage rate on the test driver
--   (hours_pay = 0), total_pay = 3.50.
--
-- Fixes the same pre-existing bug as before in passing: organisations.
-- order_rate is not effective-dated, so changing it today silently
-- rewrites every past shift's order pay (PayrollReportModal applies
-- today's rate flat, regardless of the shift's own date). org_pay_settings
-- replaces it going forward, same effective-dated pattern as
-- staff_wage_rates/wage_rate_at (0018). organisations.order_rate is NOT
-- dropped here -- kept until the three places that read/write it
-- (my_order_rate(), useOrderRate.ts, PayrollReportModal.tsx,
-- ManagerMoreTab's OrderRateCard) move over, in a later step.
--
-- Backfill: one org_pay_settings row per org, effective_from a fixed
-- sentinel (2000-01-01, before all live data -- earliest time_log is
-- 2026-08-27), carrying today's order_rate. With only one row per org,
-- the new effective-dated lookup and the old flat one resolve
-- identically for every existing shift -- see the reconciliation query
-- at the bottom of this file (not part of the transaction, run by hand
-- after). A new AFTER INSERT trigger on organisations seeds every future
-- org the same way, same sentinel (not current_date), so a shift can
-- never predate its own org's settings on either path.
--
-- Orders: drops are the source of truth once a shift has any
-- (time_logs.orders_count non-null alongside them is then a driver
-- override of the tap-derived figure -- both stay independently
-- visible, since delivery_drops is never edited, so the raw drop count
-- is always recoverable by counting it, regardless of what orders_count
-- says). A shift with zero delivery_runs falls back to orders_count
-- exactly as before this migration -- nothing about that path changes.
--
-- shift_pay(p_time_log_id) returns jsonb, not a composite type -- the
-- mileage cap applies per run, so "the full breakdown" may need a
-- per-run array later (two 5-mile runs are not one 10-mile run); jsonb
-- lets that be added as an additive key without breaking the existing
-- shape. Every money value (hours_pay, orders_pay, mileage_pay,
-- total_pay) is rounded to 2dp in Postgres before jsonb_build_object --
-- the client never does money arithmetic in JS floats. Every other
-- field (hours, orders_count, total_miles) is not money and stays
-- unrounded. Admin-only via the same is_admin()-else-null gating as
-- wage_rate_at; raises (rather than computing with nulls) for a
-- nonexistent time_log, a still-open shift, or no pay settings in force
-- for the shift's date, naming the org. A missing wage rate is NOT one
-- of these -- contributes 0 to hours_pay, same as PayrollReportModal's
-- existing established convention.
--
-- delivery_drops is append-only -- no update/delete policy for anyone,
-- same as task_comments/task_photos. Only delivery_runs.one_way_miles
-- gets edit/audit machinery (tg_protect_delivery_run, mirroring the
-- extended tg_protect_own_time_log): gps_one_way_miles immutable once
-- set, unconditionally, even for an admin; a manager editing someone
-- else's run stamps mileage_source='manager' + who/when; the owner's
-- own edit force-derives mileage_source='driver' from whether
-- one_way_miles actually changed in the statement, pinning
-- mileage_edited_by/_at to their old values regardless -- closing the
-- same client-spoof path 0028's time_logs version closed, just
-- retargeted at delivery_runs.
--
-- Wrapped in one transaction, matching 0026/0027 -- nothing here is
-- destructive (additive tables/columns, a function replace, a new
-- function), no in-transaction abort-on-mismatch check needed.
-- ============================================================================

begin;

-- ============================================================================
-- 1. org_pay_settings
-- ============================================================================

create table public.org_pay_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id) on delete cascade,
  effective_from date not null,
  order_rate numeric(6,2) not null,
  free_miles_per_run numeric(6,2) not null default 3.5,
  excess_mile_rate numeric(6,2) not null default 0.50,
  mileage_cap_per_run numeric(6,2) not null default 2.00,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, effective_from)
);

alter table public.org_pay_settings enable row level security;
alter table public.org_pay_settings force row level security;

-- Same gating as staff_wage_rates -- admin-only, every operation, no
-- manager or self policy.
create policy pay_settings_admin_all
  on public.org_pay_settings
  for all
  to authenticated
  using (public.is_admin() and org_id = public.my_org_id())
  with check (public.is_admin() and org_id = public.my_org_id());

insert into public.org_pay_settings (org_id, effective_from, order_rate)
select id, date '2000-01-01', coalesce(order_rate, 1.00)
from public.organisations;

-- ============================================================================
-- 2. Seed a default row for every future organisation, same sentinel date
-- as the backfill above.
-- ============================================================================

create function public.tg_seed_org_pay_settings()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.org_pay_settings (org_id, effective_from, order_rate)
  values (new.id, date '2000-01-01', coalesce(new.order_rate, 1.00));
  return new;
end; $function$;

create trigger seed_org_pay_settings
  after insert on public.organisations
  for each row execute function public.tg_seed_org_pay_settings();

-- ============================================================================
-- 3. delivery_runs -- one row per store-to-drops-to-store trip.
-- one_way_miles/gps_one_way_miles are nullable: the app fills them in
-- once the run has at least one drop (the last drop's odometer reading),
-- not at insert time.
-- ============================================================================

create table public.delivery_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  time_log_id uuid not null references public.time_logs (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  one_way_miles numeric(7,2),
  gps_one_way_miles numeric(7,2),
  mileage_source text check (mileage_source in ('gps', 'driver', 'manager')),
  mileage_edited_by uuid references public.profiles (id) on delete set null,
  mileage_edited_at timestamptz,
  created_at timestamptz not null default now()
);

create index delivery_runs_time_log_idx on public.delivery_runs (time_log_id);

alter table public.delivery_runs enable row level security;
alter table public.delivery_runs force row level security;

-- Same split as time_logs itself: insert/update-while-open for the
-- owner, full access for a manager/admin who manages that person,
-- plus a plain select covering the owner viewing their own row (the
-- manager-all policy only covers someone else's).
create policy delivery_runs_insert_own
  on public.delivery_runs
  for insert
  to authenticated
  with check (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.time_logs tl
      where tl.id = time_log_id and tl.user_id = (select auth.uid()) and tl.clock_out is null
    )
  );

create policy delivery_runs_update_own_open
  on public.delivery_runs
  for update
  to authenticated
  using (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.time_logs tl
      where tl.id = time_log_id and tl.user_id = (select auth.uid()) and tl.clock_out is null
    )
  )
  with check (org_id = public.my_org_id());

create policy delivery_runs_select
  on public.delivery_runs
  for select
  to authenticated
  using (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.time_logs tl
      where tl.id = time_log_id
        and (tl.user_id = (select auth.uid()) or public.manages_person(tl.user_id))
    )
  );

create policy delivery_runs_manager_all
  on public.delivery_runs
  for all
  to authenticated
  using (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (select 1 from public.time_logs tl where tl.id = time_log_id and public.manages_person(tl.user_id))
  )
  with check (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (select 1 from public.time_logs tl where tl.id = time_log_id and public.manages_person(tl.user_id))
  );

-- ============================================================================
-- 4. delivery_drops -- append-only. sequence + delivered_at + a GPS fix
-- per Delivered tap; odometer_miles is the per-run running total at that
-- tap, which one_way_miles is later derived from (last drop's reading).
-- ============================================================================

create table public.delivery_drops (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  run_id uuid not null references public.delivery_runs (id) on delete cascade,
  sequence integer not null,
  delivered_at timestamptz not null default now(),
  latitude double precision not null,
  longitude double precision not null,
  accuracy double precision,
  odometer_miles numeric(7,2) not null,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

alter table public.delivery_drops enable row level security;
alter table public.delivery_drops force row level security;

create policy delivery_drops_insert_own
  on public.delivery_drops
  for insert
  to authenticated
  with check (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.delivery_runs dr
      join public.time_logs tl on tl.id = dr.time_log_id
      where dr.id = run_id and tl.user_id = (select auth.uid()) and tl.clock_out is null
    )
  );

create policy delivery_drops_select
  on public.delivery_drops
  for select
  to authenticated
  using (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.delivery_runs dr
      join public.time_logs tl on tl.id = dr.time_log_id
      where dr.id = run_id
        and (tl.user_id = (select auth.uid()) or public.manages_person(tl.user_id))
    )
  );

-- ============================================================================
-- 5. tg_protect_delivery_run -- mirrors the extended tg_protect_own_time_log
-- exactly, retargeted at delivery_runs.one_way_miles instead of
-- time_logs.total_miles (which does not exist -- this migration
-- supersedes the deleted version's time_logs mileage columns entirely).
-- ============================================================================

create function public.tg_protect_delivery_run()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.gps_one_way_miles is not null and new.gps_one_way_miles is distinct from old.gps_one_way_miles then
    raise exception 'gps_one_way_miles cannot be changed once set' using errcode = '42501';
  end if;

  if public.is_admin() then
    return new;
  end if;

  -- A manager editing someone else's run.
  if public.is_manager() and not exists (
    select 1 from public.time_logs tl where tl.id = new.time_log_id and tl.user_id = (select auth.uid())
  ) then
    if new.one_way_miles is distinct from old.one_way_miles then
      new.mileage_source := 'manager';
      new.mileage_edited_by := (select auth.uid());
      new.mileage_edited_at := now();
    else
      new.mileage_source := old.mileage_source;
      new.mileage_edited_by := old.mileage_edited_by;
      new.mileage_edited_at := old.mileage_edited_at;
    end if;
    return new;
  end if;

  -- The owner's own run (driver, or a manager editing their own --
  -- role-agnostic, same precedent as tg_protect_own_time_log).
  -- mileage_source is force-derived from whether one_way_miles actually
  -- changed, never trusted from the client; mileage_edited_by/_at are
  -- pinned to their old values unconditionally, closing the path where
  -- an owner spoofs them via an unrelated field change.
  if new.one_way_miles is distinct from old.one_way_miles then
    new.mileage_source := 'driver';
  else
    new.mileage_source := old.mileage_source;
  end if;
  new.mileage_edited_by := old.mileage_edited_by;
  new.mileage_edited_at := old.mileage_edited_at;

  return new;
end; $function$;

create trigger protect_delivery_run
  before update on public.delivery_runs
  for each row execute function public.tg_protect_delivery_run();

-- ============================================================================
-- 6. shift_pay -- the full breakdown, computed on demand, never stored.
-- ============================================================================

create function public.shift_pay(p_time_log_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_log public.time_logs%rowtype;
  v_org public.organisations%rowtype;
  v_settings public.org_pay_settings%rowtype;
  v_shift_date date;
  v_hours numeric;
  v_hourly_rate numeric;
  v_hours_pay numeric;
  v_drops_count integer;
  v_orders_count integer;
  v_orders_pay numeric;
  v_total_miles numeric;
  v_raw_mileage_pay numeric;
  v_mileage_pay numeric;
  v_total_pay numeric;
begin
  if not public.is_admin() then
    return null;
  end if;

  select * into v_log from public.time_logs where id = p_time_log_id;
  if not found then
    raise exception 'shift_pay: no time_log %', p_time_log_id;
  end if;

  if v_log.clock_out is null then
    raise exception 'shift_pay: time_log % is still open, no clock_out yet', p_time_log_id;
  end if;

  select * into v_org from public.organisations where id = v_log.org_id;

  -- Same hardcoded Europe/London convention as tasks.task_day/
  -- reminders.reminder_day -- deliberately not the viewing admin's own
  -- browser timezone (see wageRates.ts's rateOnDate, a pre-existing,
  -- separate inconsistency this doesn't attempt to fix).
  v_shift_date := (v_log.clock_in at time zone 'Europe/London')::date;

  select * into v_settings
  from public.org_pay_settings
  where org_id = v_log.org_id and effective_from <= v_shift_date
  order by effective_from desc
  limit 1;

  if not found then
    raise exception 'shift_pay: no pay settings in force for % on %', v_org.name, v_shift_date;
  end if;

  v_hours := extract(epoch from (v_log.clock_out - v_log.clock_in)) / 3600.0;
  v_hourly_rate := public.wage_rate_at(v_log.user_id, v_shift_date);
  -- Missing wage rate contributes 0, same as PayrollReportModal's
  -- existing client-side convention -- not a case this raises for.
  v_hours_pay := round(v_hours * coalesce(v_hourly_rate, 0), 2);

  select count(*) into v_drops_count
  from public.delivery_drops dd
  join public.delivery_runs dr on dr.id = dd.run_id
  where dr.time_log_id = p_time_log_id;

  -- Drops are the source of truth once any exist for this shift. A
  -- non-null orders_count alongside them is a driver-recorded override
  -- (the confirm-and-adjust path) -- the raw drop count stays
  -- independently recoverable via delivery_drops itself, which is never
  -- edited, so the override changes what gets paid without erasing the
  -- audit trail. Zero runs -> orders_count is the plain manual entry,
  -- exactly as before this migration.
  v_orders_count := case
    when v_drops_count > 0 and v_log.orders_count is not null then v_log.orders_count
    when v_drops_count > 0 then v_drops_count
    else coalesce(v_log.orders_count, 0)
  end;

  v_orders_pay := round(v_orders_count * v_settings.order_rate, 2);

  -- Per run: min(max(0, one_way - free) x rate, cap), summed across
  -- every run this shift completed (one_way_miles is null until a run
  -- has its last drop, so an abandoned/in-progress run contributes
  -- nothing). Zero runs -> both aggregates are 0 -- "zero drops means
  -- zero mileage pay" falls out on its own, no special case needed.
  select
    coalesce(sum(one_way_miles), 0),
    coalesce(sum(
      least(
        greatest(0, one_way_miles - v_settings.free_miles_per_run) * v_settings.excess_mile_rate,
        v_settings.mileage_cap_per_run
      )
    ), 0)
  into v_total_miles, v_raw_mileage_pay
  from public.delivery_runs
  where time_log_id = p_time_log_id and one_way_miles is not null;

  v_mileage_pay := round(v_raw_mileage_pay, 2);
  v_total_pay := round(v_hours_pay + v_orders_pay + v_mileage_pay, 2);

  return jsonb_build_object(
    'hours', v_hours,
    'hourly_rate', v_hourly_rate,
    'hours_pay', v_hours_pay,
    'orders_count', v_orders_count,
    'order_rate', v_settings.order_rate,
    'orders_pay', v_orders_pay,
    'total_miles', v_total_miles,
    'mileage_pay', v_mileage_pay,
    'total_pay', v_total_pay
  );
end; $function$;

-- Same grant hygiene 0007 established for every RPC-exposed helper (and
-- the exact thing 0026 missed for can_see_task_item, fixed in 0027) --
-- Postgres grants EXECUTE to PUBLIC by default on function creation, so
-- this must be revoked explicitly rather than left to the default.
revoke all on function public.shift_pay(uuid) from public, anon, authenticated;
grant execute on function public.shift_pay(uuid) to authenticated;

commit;

-- ============================================================================
-- Reconciliation -- run by hand after this migration. Not part of the
-- transaction above. (Nothing here can run "before": org_pay_settings
-- doesn't exist yet. Not needed either -- organisations.order_rate is
-- untouched by this migration, so old_total_order_pay below, computed
-- from it after the fact, is exactly what it would have been before.
-- delivery_runs/delivery_drops start empty, so every existing shift
-- still resolves its order pay through orders_count exactly as today.)
--
-- Expect, per org: settings_row_count = 1, backfilled_rate = flat_rate,
-- and old_total_order_pay = new_total_order_pay exactly.
-- ============================================================================

select
  o.id as org_id,
  o.name as org_name,
  o.order_rate as flat_rate,
  (
    select s.order_rate from public.org_pay_settings s
    where s.org_id = o.id and s.effective_from <= date '2000-01-01'
    order by s.effective_from desc
    limit 1
  ) as backfilled_rate,
  (select count(*) from public.org_pay_settings s where s.org_id = o.id) as settings_row_count
from public.organisations o
order by o.name;

select
  o.id as org_id,
  o.name as org_name,
  sum(coalesce(tl.orders_count, 0) * o.order_rate) as old_total_order_pay,
  sum(
    coalesce(tl.orders_count, 0) *
    (
      select s.order_rate from public.org_pay_settings s
      where s.org_id = o.id
        and s.effective_from <= (tl.clock_in at time zone 'Europe/London')::date
      order by s.effective_from desc
      limit 1
    )
  ) as new_total_order_pay
from public.organisations o
join public.time_logs tl on tl.org_id = o.id
where tl.clock_out is not null
group by o.id, o.name
order by o.name;
