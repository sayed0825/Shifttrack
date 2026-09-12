-- ============================================================================
-- 0011_swaps_manager_all_scope.sql
--
-- Phase 3 security review, MEDIUM finding: swaps_manager_all checked
-- manages_person(requester_id) only. A shift swap moves both people's
-- shifts, so approving or otherwise touching one requires managing both
-- sides -- approve_shift_swap() already enforces exactly that
-- ("if not (manages_person(v.requester_id) and manages_person(v.target_id))
-- then raise exception"). This RLS policy governs direct table access
-- (UPDATE/DELETE bypassing that RPC) and did not match: a manager who
-- manages the requester but not the target could directly edit or delete
-- a shift_swaps row involving someone outside their scope.
-- ============================================================================

drop policy if exists swaps_manager_all on public.shift_swaps;

create policy swaps_manager_all on public.shift_swaps for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(requester_id) and manages_person(target_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(requester_id) and manages_person(target_id));
