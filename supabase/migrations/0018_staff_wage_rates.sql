-- ============================================================================
-- 0018_staff_wage_rates.sql
--
-- Hourly wage rates -- the most sensitive data this app holds. Effective-
-- dated (profile_id, effective_from) rather than a single column on
-- profiles, so a pay rise never rewrites the cost of every past shift, and
-- a backdated rise still recalculates correctly from its own start date:
-- the rate that applies to a given shift is whichever row has the latest
-- effective_from on or before that shift's date.
--
-- Access is Administrator-only, full stop. A location Manager (can_manage
-- but not is_admin) gets no policy on this table at all -- not read-only,
-- nothing -- and staff must never be able to see their own rate through
-- the API. wage_rate_at() below is the one sanctioned way anything else in
-- the schema reads a rate, and it enforces the same is_admin() gate
-- internally rather than relying on the caller already having RLS access.
-- ============================================================================

create table public.staff_wage_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  profile_id uuid not null
    references public.profiles (id) on delete cascade,
  hourly_rate numeric(8, 2) not null check (hourly_rate >= 0),
  effective_from date not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  unique (profile_id, effective_from)
);

create index staff_wage_rates_profile_effective_idx
  on public.staff_wage_rates (profile_id, effective_from desc);

alter table public.staff_wage_rates enable row level security;
alter table public.staff_wage_rates force row level security;

-- One policy, every operation, is_admin() only. There is deliberately no
-- second policy for is_manager() or for the row's own profile_id -- a
-- location manager reads this table the same way an unauthenticated
-- request does: not at all.
create policy wage_rates_admin_all
  on public.staff_wage_rates
  for all
  to authenticated
  using (public.is_admin() and org_id = public.my_org_id())
  with check (public.is_admin() and org_id = public.my_org_id());

-- The rate in effect for a person on a given date: the row with the latest
-- effective_from on or before p_on, or null if none exists yet. SECURITY
-- DEFINER so it can be called by a non-admin caller (RLS would otherwise
-- return zero rows and the function would just look like "nobody has a
-- rate" instead of "you can't see this") -- but it checks is_admin()
-- itself before touching the table, so calling it as a Manager or a staff
-- member to probe someone's pay returns null, not their rate. org_id is
-- pinned to the caller's own org inside the query rather than trusted from
-- the argument, since SECURITY DEFINER bypasses staff_wage_rates' RLS
-- entirely.
create function public.wage_rate_at(p_profile_id uuid, p_on date)
returns numeric
language sql
stable
security definer
set search_path to ''
as $function$
  select case
    when public.is_admin() then (
      select r.hourly_rate
      from public.staff_wage_rates r
      where r.profile_id = p_profile_id
        and r.org_id = public.my_org_id()
        and r.effective_from <= p_on
      order by r.effective_from desc
      limit 1
    )
    else null
  end;
$function$;

revoke all on function public.wage_rate_at(uuid, date) from public, anon, authenticated;
grant execute on function public.wage_rate_at(uuid, date) to authenticated;
