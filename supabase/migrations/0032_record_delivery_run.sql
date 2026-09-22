-- ============================================================================
-- 0032_record_delivery_run.sql
--
-- Step 4 of 4: the GPS engine writes a completed run in one call, not two
-- separate insert requests (run, then its drops). Two requests means a
-- connection drop between them can leave an orphaned run with no drops
-- (never discarded, since the client's own "0 drops -> discard" check
-- only runs client-side before the first request) or, on retry, a
-- duplicate run entirely. One function call is atomic by default in
-- Postgres -- either both inserts commit or neither does -- which is the
-- actual reason this exists, not performance.
--
-- security invoker, deliberately -- this runs under the CALLING driver's
-- own RLS, exactly as if they'd issued the two inserts themselves. No new
-- privilege exists here: delivery_runs_insert_own and
-- delivery_drops_insert_own (both 0028) still apply in full, including
-- their "shift still open" requirement. org_id is left to each table's
-- own default (public.my_org_id()), same as a direct insert would get.
-- ============================================================================

begin;

create function public.record_delivery_run(
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

-- Same grant hygiene as every RPC-exposed helper (0007's pass, and the
-- exact thing 0026 missed for can_see_task_item, fixed in 0027) --
-- Postgres grants EXECUTE to PUBLIC by default on function creation. The
-- security invoker gating means a caller who isn't the shift's owner (or
-- a manager with 0030's write policy) still can't make this do anything
-- their own RLS wouldn't already allow -- this is about not leaving a
-- callable-by-anyone surface lying around regardless.
revoke all on function public.record_delivery_run(uuid, timestamptz, timestamptz, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.record_delivery_run(uuid, timestamptz, timestamptz, numeric, jsonb) to authenticated;

commit;
