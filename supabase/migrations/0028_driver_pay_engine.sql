-- ============================================================================
-- 0028_driver_pay_engine.sql
--
-- Step 1 of 4: schema only. No app code reads any of this yet.
--
-- Fixes an existing bug in passing: organisations.order_rate is not
-- effective-dated, so changing it today silently rewrites every past
-- shift's order pay in the payroll report (PayrollReportModal applies
-- today's rate flat, regardless of the shift's own date). org_pay_settings
-- replaces it going forward with an effective-dated table, same pattern
-- as staff_wage_rates/wage_rate_at (0018). organisations.order_rate is
-- NOT dropped here -- kept until the app code (PayrollReportModal,
-- useOrderRate, ManagerMoreTab's OrderRateCard -- the only three places
-- that read or write it, confirmed by grep) is moved over, in a later step.
--
-- Backfill is exact-by-construction, not just close: every org gets
-- exactly one org_pay_settings row, effective_from a fixed sentinel date
-- (2000-01-01, before any live data -- earliest time_log is 2026-08-27)
-- carrying today's organisations.order_rate. With only one row per org,
-- every existing shift resolves to that same single rate under the new
-- effective-dated lookup as it did under the old flat one -- the fix only
-- changes behaviour once a second settings row is added later, for a
-- future rate change. See the reconciliation queries at the bottom of
-- this file (not part of the transaction -- run by hand before and after).
--
-- New organisations get a default row too, seeded by a trigger using the
-- same 2000-01-01 sentinel as the backfill (not current_date) -- so a
-- shift can never predate its own org's pay settings, on either path.
--
-- shift_pay() raises rather than silently computing with nulls when:
--   - the time_log doesn't exist
--   - it's still open (no clock_out) -- an in-progress shift's pay isn't
--     a stable number, and "still clocked in" deserves a loud answer, not
--     a moving one
--   - no org_pay_settings row is in force for the shift's date
-- A missing wage rate is NOT one of these -- wage_rate_at() returning
-- null and contributing 0 to hours_pay is existing, established behaviour
-- (see PayrollReportModal: "missing rate contributes 0, same as an unset
-- order count"), unchanged here.
--
-- Rounding: only hours_pay, orders_pay, mileage_pay and total_pay are
-- round(x, 2). Every other field in the breakdown is full-precision --
-- it's the audit trail showing how those four were reached, not itself
-- money. total_pay sums the three already-rounded figures (exact at 2dp
-- by construction); rounding it again is a defensive no-op.
--
-- Wrapped in one transaction for atomicity, matching 0026/0027 -- nothing
-- here is destructive (additive table/columns, a function replace, a new
-- type/function), so there's no in-transaction abort-on-mismatch check
-- like 0026's step 14; the backfill's correctness is structural, not
-- something that needs verifying against a live count.
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
  miles_allowance_per_order numeric(6,2) not null default 7,
  excess_mile_rate numeric(6,2) not null default 0.50,
  mileage_cap_per_order numeric(6,2) not null default 2.00,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, effective_from)
);

alter table public.org_pay_settings enable row level security;
alter table public.org_pay_settings force row level security;

-- Same gating as staff_wage_rates -- admin-only, every operation, no
-- manager or self policy (confirmed live: wage_rates_admin_all is
-- exactly this shape).
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
-- as the backfill above -- so a shift can never predate its own org's
-- settings on either path.
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
-- 3. time_logs mileage columns. extra_miles is untouched -- unused, wrong
-- name for this model, left alone rather than repurposed.
-- ============================================================================

alter table public.time_logs
  add column total_miles numeric(7,2),
  add column mileage_source text check (mileage_source in ('gps', 'driver', 'manager')),
  add column gps_miles numeric(7,2),
  add column mileage_edited_by uuid references public.profiles (id) on delete set null,
  add column mileage_edited_at timestamptz;

-- ============================================================================
-- 4. tg_protect_own_time_log -- extended, not replaced in shape.
--
-- time_logs_update_own_orders' RLS with_check already permits the owner
-- to change any column on their own row (confirmed live: no column list
-- in its WITH CHECK) -- this trigger is the actual gate, so this step is
-- a function-body change only, no policy SQL.
--
-- New first check: gps_miles is immutable once set, unconditionally --
-- even for an admin. Every other branch below is unchanged in shape from
-- the existing function, just extended.
-- ============================================================================

create or replace function public.tg_protect_own_time_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.gps_miles is not null and new.gps_miles is distinct from old.gps_miles then
    raise exception 'gps_miles cannot be changed once set' using errcode = '42501';
  end if;

  if public.is_admin() then
    return new;
  end if;

  -- A manager editing someone else's log. total_miles changing here is a
  -- manager entering/correcting mileage on a driver's behalf -- stamped
  -- accordingly. Anything else about the row is left as-is, same as
  -- before this migration (full bypass beyond this new stamping).
  if public.is_manager() and new.user_id <> (select auth.uid()) then
    if new.total_miles is distinct from old.total_miles then
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

  -- The owner's own row (driver, or a manager editing their own log --
  -- role-agnostic, same as the existing orders_count precedent this
  -- extends).
  if new.clock_in is distinct from old.clock_in
     or new.clock_out is distinct from old.clock_out
     or new.user_id is distinct from old.user_id
     or new.location_id is distinct from old.location_id
     or new.is_geofenced_valid is distinct from old.is_geofenced_valid then
    raise exception 'You cannot change the hours on your own shift'
      using errcode = '42501';
  end if;

  -- mileage_source is force-derived from whether total_miles actually
  -- changed in this statement, never trusted from the client -- the only
  -- way this branch can ever produce 'driver' is by genuinely changing
  -- total_miles, and mileage_edited_by/_at are pinned to their old values
  -- unconditionally, closing the spoof path where an owner sends those
  -- two fields directly (e.g. alongside an unrelated orders_count edit)
  -- without touching total_miles at all.
  if new.total_miles is distinct from old.total_miles then
    new.mileage_source := 'driver';
  else
    new.mileage_source := old.mileage_source;
  end if;
  new.mileage_edited_by := old.mileage_edited_by;
  new.mileage_edited_at := old.mileage_edited_at;

  return new;
end; $function$;

-- ============================================================================
-- 5. shift_pay -- the full breakdown, computed on demand, never stored.
-- Same gating style as wage_rate_at (admin-only, else null) but plpgsql
-- rather than sql: this needs to branch and raise, which a single-select
-- sql-language function can't do.
-- ============================================================================

create type public.shift_pay_breakdown as (
  hours numeric,
  hourly_rate numeric,
  hours_pay numeric,
  orders_count integer,
  order_rate numeric,
  orders_pay numeric,
  total_miles numeric,
  miles_allowance_per_order numeric,
  included_miles numeric,
  excess_miles numeric,
  chargeable_miles numeric,
  excess_mile_rate numeric,
  mileage_cap numeric,
  mileage_pay numeric,
  total_pay numeric
);

create function public.shift_pay(p_time_log_id uuid)
returns public.shift_pay_breakdown
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
  v_included_miles numeric;
  v_excess_miles numeric;
  v_chargeable_miles numeric;
  v_mileage_cap numeric;
  v_raw_mileage_pay numeric;
  v_result public.shift_pay_breakdown;
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

  v_included_miles := coalesce(v_log.orders_count, 0) * v_settings.miles_allowance_per_order;
  v_excess_miles := greatest(0, coalesce(v_log.total_miles, 0) - v_included_miles);
  v_chargeable_miles := v_excess_miles / 2;
  v_mileage_cap := coalesce(v_log.orders_count, 0) * v_settings.mileage_cap_per_order;
  v_raw_mileage_pay := v_chargeable_miles * v_settings.excess_mile_rate;

  v_result.hours := v_hours;
  v_result.hourly_rate := v_hourly_rate;
  -- Missing wage rate contributes 0, same as PayrollReportModal's
  -- existing client-side convention -- not a case this raises for.
  v_result.hours_pay := round(v_hours * coalesce(v_hourly_rate, 0), 2);
  v_result.orders_count := coalesce(v_log.orders_count, 0);
  v_result.order_rate := v_settings.order_rate;
  v_result.orders_pay := round(coalesce(v_log.orders_count, 0) * v_settings.order_rate, 2);
  v_result.total_miles := coalesce(v_log.total_miles, 0);
  v_result.miles_allowance_per_order := v_settings.miles_allowance_per_order;
  v_result.included_miles := v_included_miles;
  v_result.excess_miles := v_excess_miles;
  v_result.chargeable_miles := v_chargeable_miles;
  v_result.excess_mile_rate := v_settings.excess_mile_rate;
  v_result.mileage_cap := v_mileage_cap;
  -- Zero orders => mileage_cap = 0 => mileage_pay = least(anything, 0) =
  -- 0, regardless of total_miles. Falls out of the formula on its own,
  -- no special case needed -- this is the "zero orders means zero
  -- mileage pay" requirement.
  v_result.mileage_pay := round(least(v_raw_mileage_pay, v_mileage_cap), 2);
  v_result.total_pay := round(v_result.hours_pay + v_result.orders_pay + v_result.mileage_pay, 2);

  return v_result;
end; $function$;

-- Same grant hygiene 0007 established for every other RPC-exposed helper
-- (and the exact thing 0026 missed for can_see_task_item, fixed in 0027)
-- -- Postgres grants EXECUTE to PUBLIC by default on function creation,
-- so this must be revoked explicitly rather than left to the default.
revoke all on function public.shift_pay(uuid) from public, anon, authenticated;
grant execute on function public.shift_pay(uuid) to authenticated;

commit;

-- ============================================================================
-- Reconciliation -- run by hand after this migration. Not part of the
-- transaction above. (Nothing here can run "before": org_pay_settings
-- doesn't exist yet. Not needed either -- organisations.order_rate is
-- untouched by this migration, so old_total_order_pay below, computed
-- from it after the fact, is exactly what it would have been before.)
--
-- Expect, per org: settings_row_count = 1, backfilled_rate = flat_rate,
-- and old_total_order_pay = new_total_order_pay exactly. All three
-- confirm the same thing three ways: with a single settings row
-- effective before every existing shift, the new effective-dated lookup
-- and the old flat rate resolve identically for every existing row --
-- nothing about past payroll changes today, only future rate changes now
-- behave correctly.
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
