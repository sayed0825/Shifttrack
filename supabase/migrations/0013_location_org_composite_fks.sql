-- ============================================================================
-- 0013_location_org_composite_fks.sql
--
-- Phase 3 security review, MEDIUM finding: nothing in the schema tied a
-- row's location_id to its own org_id. Every location_id foreign key just
-- required "some valid location," not one in the same organisation --
-- profile_locations, shifts, tasks and task_templates could all, in
-- principle, reference a location belonging to a different org. Nothing
-- in the app writes such a row today (verified: zero mismatched rows
-- across all four tables before writing this), but RLS is not what
-- should be preventing it -- manages_location()/manages_person() and
-- every policy built on them assume this consistency holds, and RLS can
-- be bypassed entirely by any SECURITY DEFINER function. This is a data
-- integrity constraint, not a permission check, so it belongs at the
-- schema level regardless of who or what is writing the row.
--
-- Composite foreign keys: (location_id, org_id) on each child table now
-- references (id, org_id) on locations, which requires a supporting
-- unique constraint there first (id alone is already unique via the
-- primary key; this is a second, wider unique constraint over the same
-- column plus org_id, which Postgres requires before it can be the
-- target of a composite FK).
--
-- ON DELETE behaviour is preserved exactly as it was on each single-
-- column FK it replaces, using PostgreSQL 15+'s column-scoped SET NULL
-- for shifts specifically: shifts.org_id is NOT NULL, so a plain
-- composite "ON DELETE SET NULL" (which would null every referencing
-- column) would itself violate that NOT NULL constraint the moment a
-- location with shifts was deleted. "ON DELETE SET NULL (location_id)"
-- nulls only location_id, leaving org_id untouched -- exactly what the
-- single-column FK it replaces already did. profile_locations and tasks
-- and task_templates all used CASCADE, which deletes the whole
-- referencing row regardless of column count, so no such scoping is
-- needed for them.
-- ============================================================================

alter table public.locations
  add constraint locations_id_org_id_key unique (id, org_id);

-- profile_locations
alter table public.profile_locations
  drop constraint profile_locations_location_id_fkey;
alter table public.profile_locations
  add constraint profile_locations_location_org_fkey
  foreign key (location_id, org_id) references public.locations (id, org_id)
  on delete cascade;

-- shifts (nullable location_id; only location_id is nulled on delete, org_id is not)
alter table public.shifts
  drop constraint shifts_location_id_fkey;
alter table public.shifts
  add constraint shifts_location_org_fkey
  foreign key (location_id, org_id) references public.locations (id, org_id)
  on delete set null (location_id);

-- tasks
alter table public.tasks
  drop constraint tasks_location_id_fkey;
alter table public.tasks
  add constraint tasks_location_org_fkey
  foreign key (location_id, org_id) references public.locations (id, org_id)
  on delete cascade;

-- task_templates
alter table public.task_templates
  drop constraint task_templates_location_id_fkey;
alter table public.task_templates
  add constraint task_templates_location_org_fkey
  foreign key (location_id, org_id) references public.locations (id, org_id)
  on delete cascade;
