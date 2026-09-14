-- ============================================================================
-- 0019_order_rate.sql
--
-- Pay per completed order, per organisation -- another business pays a
-- different rate per drop, so this is never hardcoded.
--
-- Same access model as the existing late_grace_minutes column on this same
-- table: any org member can read it (orgs_select_own already covers every
-- column of their own org's row), only an Administrator can change it
-- (orgs_manager_update, likewise already covers every column -- no new RLS
-- policy needed). my_order_rate() mirrors my_late_grace_minutes(): a
-- SECURITY DEFINER convenience read so client code doesn't need to know the
-- organisations row shape to get one setting.
-- ============================================================================

alter table public.organisations
  add column order_rate numeric(6, 2) not null default 1.00;

create function public.my_order_rate()
returns numeric
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(o.order_rate, 1.00)
  from public.organisations o
  where o.id = public.my_org_id();
$function$;

revoke all on function public.my_order_rate() from public, anon, authenticated;
grant execute on function public.my_order_rate() to authenticated;
