-- ============================================================================
-- 0029_shift_pay_range.sql
--
-- Step 2 of 4. The admin timesheet's Cost/Total columns and the payroll
-- report currently compute pay client-side (hours x wage, plus orders x
-- order_rate) -- a second implementation of the same formula shift_pay()
-- already owns, which can only ever drift from it. That client-side
-- calculation is being removed in this step's app-code changes (not this
-- migration); shift_pay_range() is what the payroll report calls instead.
--
-- Guaranteeing shift_pay_range() can never disagree with shift_pay(): it
-- does not reimplement the formula at all -- it loops over the matching
-- time_logs and calls shift_pay() for each one, exactly as if the client
-- had called it per row. This is not the performance win (a thousand
-- in-process function calls inside one transaction is still a thousand
-- calls), it's the correctness guarantee -- the performance win is
-- collapsing what would be a thousand separate HTTP/RLS/auth round-trips
-- from the client into one. Tested directly (see the RLS suite addition
-- alongside this migration): shift_pay() and shift_pay_range() must
-- return byte-identical figures for the same shift, which is
-- automatically true by construction rather than something that could
-- silently stop being true after an edit to one function but not the
-- other.
--
-- Same admin-only gating as shift_pay() (returns no rows for a
-- non-admin, rather than null -- there's no single value to be null,
-- this is a set). Same date convention: filters by
-- (clock_in at time zone 'Europe/London')::date, matching what
-- shift_pay() itself uses internally for the wage-rate/settings lookup,
-- so "shifts in this range" and "the date each shift's own figures were
-- computed against" always agree.
--
-- location_ids/roles mirror PayrollReportModal's existing client-side
-- filter semantics exactly, not a new interpretation: a null location_id
-- shift is never excluded by a location filter (PayrollReportModal:
-- "if (log.location_id && !selectedLocations.has(...))" -- a falsy
-- location_id short-circuits before the check), and role matching falls
-- back to the profile's current role when role_at_clock_in is null
-- (CLAUDE.md: "falling back to the profile's current role only when it
-- is null, so a promotion never silently rewrites which role earned past
-- hours"). Both params default null, meaning no filter on that
-- dimension.
--
-- A missing org_pay_settings row (shift_pay()'s loudest failure mode)
-- propagates and aborts the whole range call rather than being caught
-- and skipped -- a payroll report silently missing one row's pay is
-- worse than the report failing to load at all, same "loud failure over
-- silent wrong number" reasoning as shift_pay() itself. In practice this
-- can't happen for any real org: the backfill/seed trigger from 0028
-- guarantee a settings row effective before any shift ever recorded.
-- ============================================================================

begin;

create function public.shift_pay_range(
  p_from date,
  p_to date,
  p_location_ids uuid[] default null,
  p_roles text[] default null
)
returns table (time_log_id uuid, breakdown jsonb)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    return;
  end if;

  for v_id in
    select tl.id
    from public.time_logs tl
    left join public.profiles p on p.id = tl.user_id
    where tl.org_id = public.my_org_id()
      and tl.clock_out is not null
      and (tl.clock_in at time zone 'Europe/London')::date between p_from and p_to
      and (p_location_ids is null or tl.location_id is null or tl.location_id = any (p_location_ids))
      and (p_roles is null or coalesce(tl.role_at_clock_in, p.role) = any (p_roles))
    order by tl.clock_in
  loop
    time_log_id := v_id;
    breakdown := public.shift_pay(v_id);
    return next;
  end loop;

  return;
end; $function$;

-- Same grant hygiene as shift_pay() -- Postgres grants EXECUTE to PUBLIC
-- by default on function creation.
revoke all on function public.shift_pay_range(date, date, uuid[], text[]) from public, anon, authenticated;
grant execute on function public.shift_pay_range(date, date, uuid[], text[]) to authenticated;

commit;
