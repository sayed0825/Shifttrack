-- ============================================================================
-- 0037_delivery_run_insert_service_role_passthrough.sql
--
-- Regression in 0034: tg_protect_delivery_run_insert nulled
-- one_way_miles/gps_one_way_miles/mileage_source unless
-- kite.internal_delivery_run_insert was set, which only covers
-- record_delivery_run's own insert. A service-role insert with no
-- session at all -- the same "trusted server context" every other
-- protective trigger in this schema (tg_protect_own_time_log,
-- tg_protect_profile_role, tg_protect_task_item_submit) already carves
-- out via `(select auth.uid()) is null` -- got nulled too. Caught by
-- tests/rls/positive/shift-pay-worked-example.test.ts, whose fixture
-- builds a delivery_runs row with a direct adminClient insert.
--
-- Adds the same null-auth.uid() passthrough 0034 should have had from
-- the start, ahead of the GUC check.
-- ============================================================================

begin;

create or replace function public.tg_protect_delivery_run_insert()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if coalesce(current_setting('kite.internal_delivery_run_insert', true), 'false') = 'true' then
    return new;
  end if;

  new.one_way_miles := null;
  new.gps_one_way_miles := null;
  new.mileage_source := null;

  return new;
end; $function$;

commit;
