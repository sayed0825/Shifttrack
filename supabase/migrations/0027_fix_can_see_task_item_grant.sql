-- ============================================================================
-- 0027_fix_can_see_task_item_grant.sql
--
-- can_see_task_item() (0026) was created without the revoke/grant pair
-- every other RPC-exposed helper got in 0007's least-privilege pass --
-- caught by the RLS suite's pre-push run: anon could call it directly
-- (Postgres grants EXECUTE to PUBLIC by default on function creation,
-- and 0026 never revoked it). Not a data leak on its own -- auth.uid()
-- is null for anon, so it always resolves to false -- but it should
-- never have been callable without a session, same reasoning as every
-- function 0007 already locked down. Same fix, same pattern.
-- ============================================================================

revoke all on function public.can_see_task_item(uuid) from public, anon, authenticated;
grant execute on function public.can_see_task_item(uuid) to authenticated;
