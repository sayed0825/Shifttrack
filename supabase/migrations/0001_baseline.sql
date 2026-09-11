-- ============================================================================
-- 0001_baseline.sql
--
-- BASELINE SNAPSHOT of the live Supabase database, dumped via the read-only
-- Supabase MCP connection on 2026-09-09. This is NOT a from-scratch build
-- script and it has NOT been tested against an empty database.
--
-- Context: every table, RLS policy, function, trigger, storage bucket and
-- cron job in this project was created by hand in the Supabase SQL Editor.
-- None of it lived in this repo before this file. This is a point-in-time
-- capture of that state, reconstructed from pg_catalog/information_schema
-- introspection (pg_get_constraintdef, pg_get_functiondef,
-- pg_get_triggerdef, pg_policy), not copied from any prior migration.
--
-- Ordering note: the sections below run Tables, Indexes, Functions,
-- Triggers, then RLS (enable/force + policies), Storage, then Cron. That is
-- NOT the order these were requested in — RLS policies and several
-- `org_id` column defaults call functions like my_org_id()/is_admin(), so
-- those functions must exist before the policies (and before the org_id
-- defaults are attached) or this file cannot execute top-to-bottom. Tables
-- are therefore created first with their `org_id` column present but
-- without its default; the default is attached in a short ALTER TABLE pass
-- right after the functions section, once my_org_id() exists.
--
-- Assumptions this file makes and does not verify:
--   - It runs inside a Supabase project, so `auth.users`, `auth.uid()`,
--     the `storage.buckets`/`storage.objects` tables, and the `pg_cron`
--     job-scheduling infrastructure already exist and are managed by the
--     platform, not created here.
--   - The `pgcrypto` and `pg_cron` extensions are enabled (Supabase enables
--     both by default; the CREATE EXTENSION statements below are
--     IF NOT EXISTS no-ops in that case).
--   - At least one row exists in `organisations` with slug = 'org-1' —
--     `tg_handle_new_user()` falls back to it for a brand new auth user
--     with no invite metadata. That fallback (and the org-per-org
--     provisioning it implies) is not something this file sets up.
--
-- Going forward: schema changes are written as new numbered migration
-- files in supabase/migrations, committed to the repo, and then run
-- manually in the SQL Editor. See CLAUDE.md. Never make a schema change
-- that exists only in Supabase again.
--
-- This file is FROZEN as of 2026-09-09 and must not be edited again. A
-- snapshot that is kept perpetually current is a snapshot of nothing, and
-- running this file followed by 0002 onward against an empty database
-- would double-apply anything folded back in here. Every schema change
-- since 2026-09-09 — including ones that touch a table, function, or
-- trigger defined below — lives only in its own later numbered migration
-- (0002, 0003, ...), layered on top of this file, never edited into it.
-- ============================================================================


-- ============================================================================
-- Extensions
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;


-- ============================================================================
-- Tables (dependency order)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- organisations — the tenant root. Every domain table below carries org_id.
-- ---------------------------------------------------------------------------
create table public.organisations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text unique,
  logo_url            text,
  primary_colour      text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  late_grace_minutes  integer not null default 0
);

-- ---------------------------------------------------------------------------
-- roles — per-organisation role rows. can_manage/is_admin/can_view_map are
-- the capability flags every permission decision in the app is driven by.
-- ---------------------------------------------------------------------------
create table public.roles (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  name          text not null,
  sort_order    integer not null default 100,
  is_protected  boolean not null default false,
  created_at    timestamptz not null default now(),
  can_view_map  boolean not null default false,
  can_manage    boolean not null default false,
  is_admin      boolean not null default false,
  constraint roles_org_id_name_key unique (org_id, name)
);

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user. role is free text (not an FK into
-- roles), matched against roles.name at read time by is_admin()/is_manager().
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  first_name  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  role        text default 'Employee'::text,
  is_active   boolean not null default true,
  org_id      uuid not null references public.organisations(id) on delete cascade,
  email       text
);
comment on table public.profiles is 'Application profile for each auth user. role drives all RLS decisions.';

-- ---------------------------------------------------------------------------
-- locations — geofenced sites. org_id default attached later (needs
-- my_org_id()).
-- ---------------------------------------------------------------------------
create table public.locations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  address        text,
  latitude       double precision not null,
  longitude      double precision not null,
  radius_meters  double precision not null default 100,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  constraint locations_latitude_range check (latitude >= (-90)::double precision and latitude <= 90::double precision),
  constraint locations_longitude_range check (longitude >= (-180)::double precision and longitude <= 180::double precision),
  constraint locations_radius_positive check (radius_meters > 0::double precision)
);
comment on column public.locations.radius_meters is 'Geofence tolerance in metres. Clock-in is permitted at or inside this radius.';

-- ---------------------------------------------------------------------------
-- profile_locations — which staff belong to which location(s); a manager's
-- own rows here are what my_managed_locations() reads for a scoped Manager.
-- ---------------------------------------------------------------------------
create table public.profile_locations (
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  location_id  uuid not null references public.locations(id) on delete cascade,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  primary key (profile_id, location_id)
);

-- ---------------------------------------------------------------------------
-- shifts
-- ---------------------------------------------------------------------------
create table public.shifts (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  start_time         timestamptz not null,
  end_time           timestamptz not null,
  location_id        uuid references public.locations(id) on delete set null,
  assigned_user_id   uuid references public.profiles(id) on delete set null,
  is_recurring       boolean not null default false,
  series_id          uuid,
  notes              text,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  required_role      text,
  org_id             uuid not null references public.organisations(id) on delete cascade,
  constraint shifts_series_consistency check (is_recurring = (series_id is not null)),
  constraint shifts_time_order check (end_time > start_time)
);

-- ---------------------------------------------------------------------------
-- time_logs — payroll data. Never delete or overwrite without an explicit
-- instruction; deactivate staff rather than delete a profile.
-- ---------------------------------------------------------------------------
create table public.time_logs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  location_id           uuid references public.locations(id) on delete set null,
  shift_id              uuid references public.shifts(id) on delete set null,
  clock_in              timestamptz not null default now(),
  clock_out             timestamptz,
  is_geofenced_valid    boolean not null default false,
  clock_in_latitude     double precision,
  clock_in_longitude    double precision,
  clock_in_distance_m   double precision,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  notes                 text,
  org_id                uuid not null references public.organisations(id) on delete cascade,
  role_at_clock_in      text,
  constraint time_logs_time_order check (clock_out is null or clock_out > clock_in)
);
comment on column public.time_logs.is_geofenced_valid is 'True when the clock-in coordinates fell within the location geofence.';

-- ---------------------------------------------------------------------------
-- live_locations — single latest ping per user; clients UPSERT on user_id
-- rather than inserting history.
-- ---------------------------------------------------------------------------
create table public.live_locations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references public.profiles(id) on delete cascade,
  latitude    double precision not null,
  longitude   double precision not null,
  heading     double precision,
  speed       double precision,
  accuracy    double precision,
  updated_at  timestamptz not null default now(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  constraint live_locations_latitude_range check (latitude >= (-90)::double precision and latitude <= 90::double precision),
  constraint live_locations_longitude_range check (longitude >= (-180)::double precision and longitude <= 180::double precision),
  constraint live_locations_heading_range check (heading is null or (heading >= 0::double precision and heading < 360::double precision))
);
comment on table public.live_locations is 'Single latest ping per user. Clients UPSERT on user_id rather than inserting history.';

-- ---------------------------------------------------------------------------
-- unavailability_requests
-- ---------------------------------------------------------------------------
create table public.unavailability_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  start_date   date not null,
  end_date     date not null,
  reason       text,
  status       text not null default 'pending'::text,
  decided_by   uuid references public.profiles(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  constraint unavail_date_order check (end_date >= start_date),
  constraint unavail_status check (status = any (array['pending'::text, 'approved'::text, 'denied'::text]))
);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null default 'shift_changed'::text,
  title       text not null,
  body        text,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now(),
  org_id      uuid not null references public.organisations(id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- shift_applications — a staff member applying for an open shift.
-- ---------------------------------------------------------------------------
create table public.shift_applications (
  id          uuid primary key default gen_random_uuid(),
  shift_id    uuid not null references public.shifts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  constraint shift_applications_shift_id_user_id_key unique (shift_id, user_id)
);

-- ---------------------------------------------------------------------------
-- shift_swaps
-- ---------------------------------------------------------------------------
create table public.shift_swaps (
  id                   uuid primary key default gen_random_uuid(),
  requester_id         uuid not null references public.profiles(id) on delete cascade,
  requester_shift_id   uuid not null references public.shifts(id) on delete cascade,
  target_id            uuid not null references public.profiles(id) on delete cascade,
  target_shift_id      uuid not null references public.shifts(id) on delete cascade,
  status               text not null default 'pending_peer'::text,
  created_at           timestamptz not null default now(),
  org_id               uuid not null references public.organisations(id) on delete cascade,
  constraint swap_not_self check (requester_id <> target_id),
  constraint swap_status_check check (status = any (array['pending_peer'::text, 'pending_manager'::text, 'denied'::text]))
);

-- ---------------------------------------------------------------------------
-- overtime_claims
-- ---------------------------------------------------------------------------
create table public.overtime_claims (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  time_log_id         uuid not null references public.time_logs(id) on delete cascade,
  claimed_clock_in    timestamptz,
  claimed_clock_out   timestamptz,
  reason              text,
  status              text not null default 'pending'::text,
  decided_by          uuid references public.profiles(id),
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  constraint overtime_has_claim check (claimed_clock_in is not null or claimed_clock_out is not null),
  constraint overtime_status_check check (status = any (array['pending'::text, 'approved'::text, 'denied'::text]))
);

-- ---------------------------------------------------------------------------
-- employee_notes — manager notes on an employee's profile. Not append-only:
-- an Administrator can soft-delete (deleted_at/deleted_by); there is still
-- no hard DELETE policy for anyone.
-- ---------------------------------------------------------------------------
create table public.employee_notes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  employee_id  uuid not null references public.profiles(id) on delete cascade,
  manager_id   uuid references public.profiles(id) on delete set null,
  note_text    text not null,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid references public.profiles(id) on delete set null,
  constraint note_not_empty check (length(trim(both from note_text)) > 0)
);

-- ---------------------------------------------------------------------------
-- task_templates — the recurring definition a day's tasks are generated from.
-- ---------------------------------------------------------------------------
create table public.task_templates (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organisations(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete cascade,
  title             text not null,
  description       text,
  assigned_role     text,
  assigned_user_id  uuid references public.profiles(id) on delete set null,
  requires_photo    boolean not null default false,
  recurrence        text not null default 'daily'::text,
  weekdays          smallint[] not null default '{0,1,2,3,4,5,6}'::smallint[],
  start_at          time not null,
  due_at            time not null,
  is_active         boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint tmpl_recurrence check (recurrence = any (array['daily'::text, 'weekly'::text])),
  constraint tmpl_target check (assigned_role is not null or assigned_user_id is not null)
);

-- ---------------------------------------------------------------------------
-- tasks — one day's generated instance. A role-assigned task is a shared
-- pool, not copied per person. task_day is derived, never written.
-- ---------------------------------------------------------------------------
create table public.tasks (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organisations(id) on delete cascade,
  template_id          uuid references public.task_templates(id) on delete set null,
  location_id          uuid references public.locations(id) on delete cascade,
  title                text not null,
  description          text,
  assigned_role        text,
  assigned_user_id     uuid references public.profiles(id) on delete set null,
  start_time           timestamptz not null,
  due_time             timestamptz not null,
  requires_photo       boolean not null default false,
  photo_path           text,
  status               text not null default 'pending'::text,
  completed_by         uuid references public.profiles(id) on delete set null,
  completed_at         timestamptz,
  reviewed_by          uuid references public.profiles(id) on delete set null,
  reviewed_at          timestamptz,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  task_day             date generated always as (((start_time at time zone 'Europe/London'::text))::date) stored,
  overdue_notified_at  timestamptz,
  constraint task_status check (status = any (array['pending'::text, 'submitted'::text, 'approved'::text, 'rejected'::text])),
  constraint task_target check (assigned_role is not null or assigned_user_id is not null),
  constraint task_time_order check (due_time > start_time)
);

-- ---------------------------------------------------------------------------
-- task_comments — a thread on one task, visible to the assignee(s) and
-- managers.
-- ---------------------------------------------------------------------------
create table public.task_comments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  task_id       uuid not null references public.tasks(id) on delete cascade,
  sender_id     uuid not null references public.profiles(id) on delete cascade,
  comment_text  text not null,
  created_at    timestamptz not null default now(),
  constraint comment_not_empty check (length(trim(both from comment_text)) > 0)
);


-- ============================================================================
-- Indexes (explicit — PK/UNIQUE-backed indexes above are already created)
-- ============================================================================

create index roles_org_idx on public.roles using btree (org_id, sort_order);

create index profiles_active_idx on public.profiles using btree (is_active);
create index profiles_org_idx on public.profiles using btree (org_id);

create index locations_org_idx on public.locations using btree (org_id);

create index idx_profile_locations_location_id on public.profile_locations using btree (location_id);
create index profile_locations_org_idx on public.profile_locations using btree (org_id);

create index shifts_assigned_start_idx on public.shifts using btree (assigned_user_id, start_time desc);
create index shifts_location_idx on public.shifts using btree (location_id);
create index shifts_open_idx on public.shifts using btree (start_time) where (assigned_user_id is null);
create index shifts_org_idx on public.shifts using btree (org_id);
create index shifts_series_idx on public.shifts using btree (series_id) where (series_id is not null);
create index shifts_start_time_idx on public.shifts using btree (start_time);

create unique index time_logs_one_open_per_user_idx on public.time_logs using btree (user_id) where (clock_out is null);
create index time_logs_org_idx on public.time_logs using btree (org_id);
create index time_logs_user_clockin_idx on public.time_logs using btree (user_id, clock_in desc);

create index live_locations_org_idx on public.live_locations using btree (org_id);
create index live_locations_updated_at_idx on public.live_locations using btree (updated_at desc);

create index idx_unavailability_requests_user_start on public.unavailability_requests using btree (user_id, start_date);
create index unavailability_requests_org_idx on public.unavailability_requests using btree (org_id);

create index idx_notifications_user_created on public.notifications using btree (user_id, created_at desc);
create index notifications_org_idx on public.notifications using btree (org_id);
create index notifications_user_created_idx on public.notifications using btree (user_id, created_at desc);

create index shift_applications_org_idx on public.shift_applications using btree (org_id);

create index shift_swaps_org_idx on public.shift_swaps using btree (org_id);

create index overtime_claims_org_idx on public.overtime_claims using btree (org_id);
create index overtime_user_idx on public.overtime_claims using btree (user_id, created_at desc);

create index employee_notes_employee_idx on public.employee_notes using btree (employee_id, created_at desc);

create index tmpl_org_idx on public.task_templates using btree (org_id, is_active);

create index tasks_org_due_idx on public.tasks using btree (org_id, due_time);
create index tasks_org_history_idx on public.tasks using btree (org_id, task_day desc, status);
create index tasks_role_idx on public.tasks using btree (org_id, assigned_role, status);
create unique index tasks_template_day_idx on public.tasks using btree (template_id, task_day) where (template_id is not null);
create index tasks_user_idx on public.tasks using btree (assigned_user_id, status);

create index task_comments_task_idx on public.task_comments using btree (task_id, created_at);


-- ============================================================================
-- Functions (dependency order — each only calls functions defined above it)
-- ============================================================================

create or replace function public.my_org_id()
 returns uuid
 language sql
 stable security definer
 set search_path to ''
as $function$
  select p.org_id from public.profiles p where p.id = (select auth.uid());
$function$;

create or replace function public.my_role()
 returns text
 language sql
 stable security definer
 set search_path to ''
as $function$
  select p.role from public.profiles p where p.id = (select auth.uid());
$function$;

create or replace function public.is_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1 from public.profiles p
    join public.roles r on r.org_id = p.org_id and r.name = p.role
    where p.id = (select auth.uid()) and p.is_active and r.is_admin
  );
$function$;

create or replace function public.is_manager()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1 from public.profiles p
    join public.roles r on r.org_id = p.org_id and r.name = p.role
    where p.id = (select auth.uid()) and p.is_active and r.can_manage
  );
$function$;

create or replace function public.is_active_user()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select coalesce((select p.is_active from public.profiles p where p.id = (select auth.uid())), false);
$function$;

create or replace function public.is_clocked_in(p_user_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1
    from public.time_logs t
    where t.user_id = p_user_id
      and t.clock_out is null
  );
$function$;

create or replace function public.my_can_view_map()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1 from public.profiles p
    join public.roles r on r.org_id = p.org_id and r.name = p.role
    where p.id = (select auth.uid()) and r.can_view_map
  );
$function$;

create or replace function public.my_late_grace_minutes()
 returns integer
 language sql
 stable security definer
 set search_path to ''
as $function$
  select coalesce(o.late_grace_minutes, 0)
  from public.organisations o
  where o.id = public.my_org_id();
$function$;

-- Location ids the signed-in user manages: every org location for an
-- Administrator, or just their own profile_locations rows for a
-- location-scoped Manager. manages_location()/manages_person() (below) are
-- what the RLS policies actually call; this is what they both read.
create or replace function public.my_managed_locations()
 returns setof uuid
 language sql
 stable security definer
 set search_path to ''
as $function$
  select l.id from public.locations l
  where l.org_id = public.my_org_id() and public.is_admin()
  union
  select pl.location_id from public.profile_locations pl
  where pl.profile_id = (select auth.uid()) and not public.is_admin();
$function$;

create or replace function public.manages_location(p_location_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case
    when public.is_admin() then true
    when p_location_id is null then false
    else exists (select 1 from public.my_managed_locations() m where m = p_location_id)
  end;
$function$;

create or replace function public.manages_person(p_user_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case
    when public.is_admin() then
      exists (select 1 from public.profiles p
              where p.id = p_user_id and p.org_id = public.my_org_id())
    else exists (
      select 1 from public.profile_locations pl
      where pl.profile_id = p_user_id
        and pl.location_id in (select * from public.my_managed_locations())
    )
  end;
$function$;

create or replace function public.can_see_task(p_task_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and t.org_id = public.my_org_id()
      and (public.is_manager()
           or t.assigned_user_id = (select auth.uid())
           or t.assigned_role = public.my_role())
  );
$function$;

create or replace function public.haversine_meters(p_lat1 double precision, p_long1 double precision, p_lat2 double precision, p_long2 double precision)
 returns double precision
 language sql
 immutable parallel safe
as $function$
  select 2 * 6371000 * asin(
    least(1.0, sqrt(
        power(sin(radians(p_lat2  - p_lat1)  / 2), 2)
      + cos(radians(p_lat1)) * cos(radians(p_lat2))
        * power(sin(radians(p_long2 - p_long1) / 2), 2)
    ))
  );
$function$;

-- Server-side geofence check, called before every clock-in/clock-out. The
-- offline queue (src/lib/offlineQueue.js) mirrors this math on-device so an
-- outage cannot be used to clock in from home.
create or replace function public.verify_geofenced_clock_in(p_user_id uuid, p_lat double precision, p_long double precision, p_location_id uuid)
 returns json
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_loc      public.locations%rowtype;
  v_distance double precision;
begin
  -- Authorisation: self-service only, unless the caller is a Manager.
  if p_user_id is distinct from (select auth.uid()) and not public.is_manager() then
    raise exception 'Not authorised to verify a geofence for another user'
      using errcode = '42501';
  end if;

  -- Input validation.
  if p_lat is null or p_long is null
     or p_lat  not between  -90 and  90
     or p_long not between -180 and 180
  then
    return json_build_object(
      'success',         false,
      'distance_meters', null,
      'allowed_radius',  null,
      'error',           'INVALID_COORDINATES'
    );
  end if;

  select * into v_loc
  from public.locations l
  where l.id = p_location_id
    and l.is_active;

  if not found then
    return json_build_object(
      'success',         false,
      'distance_meters', null,
      'allowed_radius',  null,
      'error',           'LOCATION_NOT_FOUND'
    );
  end if;

  v_distance := public.haversine_meters(p_lat, p_long, v_loc.latitude, v_loc.longitude);

  return json_build_object(
    'success',         (v_distance <= v_loc.radius_meters),
    'distance_meters', round(v_distance::numeric, 2)::double precision,
    'allowed_radius',  v_loc.radius_meters
  );
end;
$function$;

create or replace function public.notify_org_managers(p_org_id uuid, p_type text, p_title text, p_body text)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  insert into public.notifications (user_id, org_id, type, title, body)
  select p.id, p_org_id, p_type, p_title, p_body
  from public.profiles p
  where p.org_id = p_org_id and p.role = 'Manager' and p.is_active;
$function$;

create or replace function public.notify_location_managers(p_org_id uuid, p_location_id uuid, p_type text, p_title text, p_body text)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  insert into public.notifications (user_id, org_id, type, title, body)
  select distinct p.id, p_org_id, p_type, p_title, p_body
  from public.profiles p
  join public.roles r on r.org_id = p.org_id and r.name = p.role
  left join public.profile_locations pl on pl.profile_id = p.id
  where p.org_id = p_org_id
    and p.is_active
    and r.can_manage
    and (r.is_admin or pl.location_id = p_location_id);
$function$;

-- Cascading staff removal, scoped by manages_person(): a location-scoped
-- Manager can only delete staff at a location they manage.
create or replace function public.delete_staff_member(p_user_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not public.is_manager() then
    raise exception 'Only a manager may delete staff' using errcode = '42501';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot delete your own account';
  end if;
  if not public.manages_person(p_user_id) then
    raise exception 'That person is not at a location you manage'
      using errcode = '42501';
  end if;
  delete from auth.users where id = p_user_id;
end; $function$;

-- Approvals that change two rows go through a SECURITY DEFINER RPC so both
-- rows move together or neither does.
create or replace function public.approve_shift_swap(p_swap_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v public.shift_swaps%rowtype;
begin
  if not public.is_manager() then
    raise exception 'Only a manager may approve a swap' using errcode = '42501';
  end if;

  select * into v from public.shift_swaps
  where id = p_swap_id and org_id = public.my_org_id();
  if not found then raise exception 'Swap not found'; end if;

  -- Both sides must be within scope. A swap moves two people's shifts,
  -- so managing only one of them is not enough.
  if not (public.manages_person(v.requester_id)
          and public.manages_person(v.target_id)) then
    raise exception 'That swap involves staff outside the locations you manage'
      using errcode = '42501';
  end if;

  if v.status <> 'pending_manager' then
    raise exception 'The other employee has not accepted this swap yet';
  end if;

  update public.shifts set assigned_user_id = v.target_id    where id = v.requester_shift_id;
  update public.shifts set assigned_user_id = v.requester_id where id = v.target_shift_id;

  insert into public.notifications (user_id, org_id, type, title, body)
  values (v.requester_id, v.org_id, 'swap', 'Shift swap approved', 'Your manager approved the swap.'),
         (v.target_id,    v.org_id, 'swap', 'Shift swap approved', 'Your manager approved the swap.');

  delete from public.shift_swaps where id = p_swap_id;
end; $function$;

create or replace function public.approve_shift_application(p_application_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v public.shift_applications%rowtype;
  v_location uuid;
begin
  if not public.is_manager() then
    raise exception 'Only a manager may fill an open shift' using errcode = '42501';
  end if;

  select * into v from public.shift_applications
  where id = p_application_id and org_id = public.my_org_id();
  if not found then raise exception 'Application not found'; end if;

  -- Scope by the shift's location rather than the applicant, since the
  -- shift is the thing being filled.
  select location_id into v_location from public.shifts where id = v.shift_id;
  if not public.manages_location(v_location) then
    raise exception 'That shift is at a location you do not manage'
      using errcode = '42501';
  end if;

  update public.shifts
  set assigned_user_id = v.user_id, required_role = null
  where id = v.shift_id and assigned_user_id is null;

  if not found then raise exception 'That shift has already been filled'; end if;

  insert into public.notifications (user_id, org_id, type, title, body)
  select a.user_id, v.org_id, 'open_shift',
    case when a.user_id = v.user_id then 'You got the shift' else 'Shift filled' end,
    case when a.user_id = v.user_id
         then 'Your application was approved.'
         else 'The open shift went to someone else.' end
  from public.shift_applications a where a.shift_id = v.shift_id;

  delete from public.shift_applications where shift_id = v.shift_id;
end; $function$;

create or replace function public.decide_overtime_claim(p_claim_id uuid, p_approve boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v public.overtime_claims%rowtype;
begin
  if not public.is_manager() then
    raise exception 'Only a manager may decide an overtime claim' using errcode = '42501';
  end if;

  select * into v from public.overtime_claims
  where id = p_claim_id and status = 'pending' and org_id = public.my_org_id();
  if not found then raise exception 'Claim not found or already decided'; end if;

  if not public.manages_person(v.user_id) then
    raise exception 'That claim is from someone outside the locations you manage'
      using errcode = '42501';
  end if;

  if p_approve then
    update public.time_logs
    set clock_in  = coalesce(v.claimed_clock_in, clock_in),
        clock_out = coalesce(v.claimed_clock_out, clock_out),
        notes     = coalesce(notes || ' · ', '') || 'Overtime approved'
    where id = v.time_log_id;
  end if;

  update public.overtime_claims
  set status = case when p_approve then 'approved' else 'denied' end,
      decided_by = (select auth.uid()), decided_at = now()
  where id = p_claim_id;

  insert into public.notifications (user_id, org_id, type, title, body)
  values (v.user_id, v.org_id,'timesheet',
          case when p_approve then 'Overtime approved' else 'Overtime declined' end,
          case when p_approve then 'Your timesheet has been updated.'
               else 'Your overtime claim was not approved.' end);
end; $function$;

-- Cron target: generates today's task instances from active templates.
create or replace function public.generate_task_instances()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare made integer := 0;
begin
  insert into public.tasks (
    org_id, template_id, location_id, title, description,
    assigned_role, assigned_user_id, requires_photo,
    start_time, due_time, created_by
  )
  select t.org_id, t.id, t.location_id, t.title, t.description,
         t.assigned_role, t.assigned_user_id, t.requires_photo,
         (current_date + t.start_at), (current_date + t.due_at), t.created_by
  from public.task_templates t
  where t.is_active
    and (t.recurrence = 'daily'
         or extract(dow from current_date)::smallint = any(t.weekdays))
  on conflict do nothing;

  get diagnostics made = row_count;
  return made;
end; $function$;

-- Cron target: flags tasks past due_time with an overdue notification.
create or replace function public.notify_overdue_tasks()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare sent integer := 0;
begin
  insert into public.notifications (user_id, org_id, type, title, body)
  select p.id, t.org_id, 'task', 'Task overdue', t.title
  from public.tasks t
  join public.profiles p
    on p.org_id = t.org_id
   and p.is_active
   and (p.id = t.assigned_user_id or p.role = t.assigned_role)
  where t.status = 'pending'
    and t.due_time < now()
    and t.overdue_notified_at is null;

  update public.tasks
  set overdue_notified_at = now()
  where status = 'pending' and due_time < now() and overdue_notified_at is null;

  get diagnostics sent = row_count;
  return sent;
end; $function$;

-- Cron target: removes unfilled open shifts a day after they started.
create or replace function public.purge_expired_open_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare removed integer := 0;
begin
  delete from public.shifts
  where assigned_user_id is null
    and required_role is not null
    and start_time < now() - interval '1 day';

  get diagnostics removed = row_count;
  return removed;
end; $function$;

-- Cron target: purges task photos (storage object + photo_path) a month
-- after task completion.
create or replace function public.purge_old_task_photos()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare purged integer := 0;
begin
  delete from storage.objects o
  using public.tasks t
  where o.bucket_id = 'task-photos'
    and o.name = t.photo_path
    and t.completed_at < now() - interval '1 month';

  update public.tasks
  set photo_path = null
  where photo_path is not null
    and completed_at < now() - interval '1 month';

  get diagnostics purged = row_count;
  return purged;
end; $function$;

-- Cron target: auto-closes a time_log left open past its shift's end_time.
create or replace function public.sweep_open_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare closed integer := 0;
begin
  with matched as (
    select tl.id as log_id, s.end_time
    from public.time_logs tl
    join public.shifts s
      on (s.id = tl.shift_id
          or (s.assigned_user_id = tl.user_id
              and s.start_time::date = tl.clock_in::date))
     and s.org_id = tl.org_id
    where tl.clock_out is null
      and s.end_time < now()
      and s.end_time > tl.clock_in
  )
  update public.time_logs tl
  set clock_out = m.end_time,
      notes = 'Auto clocked-out at shift end'
  from matched m
  where tl.id = m.log_id and tl.clock_out is null;

  get diagnostics closed = row_count;
  return closed;
end; $function$;

create or replace function public.tg_set_updated_at()
 returns trigger
 language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

-- The invite Edge Function runs as service_role, where auth.uid() is null —
-- a trusted server context, not a privilege escalation attempt, so it is
-- allowed through. A logged-in non-manager is not.
create or replace function public.tg_protect_profile_role()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if (new.role is distinct from old.role) and not public.is_manager() then
    raise exception 'Only a Manager may change role' using errcode = '42501';
  end if;

  return new;
end; $function$;

-- profiles.email mirrors auth.users.email. Read it, never write it directly.
create or replace function public.tg_sync_profile_email()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end; $function$;

create or replace function public.tg_handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_org uuid;
begin
  v_org := coalesce(
    (new.raw_user_meta_data ->> 'org_id')::uuid,
    (select p.org_id from public.profiles p where p.id = (select auth.uid())),
    (select id from public.organisations where slug = 'org-1')
  );

  insert into public.profiles (id, org_id, email, full_name, first_name)
  values (
    new.id,
    v_org,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'first_name'
  )
  on conflict (id) do nothing;
  return new;
end; $function$;

create or replace function public.tg_role_deleted()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if old.is_protected then
    raise exception 'The % role cannot be deleted', old.name;
  end if;
  update public.profiles
  set role = null
  where org_id = old.org_id and role = old.name;
  return old;
end; $function$;

create or replace function public.tg_role_renamed()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if new.is_protected and new.name is distinct from old.name then
    raise exception 'The % role cannot be renamed', old.name;
  end if;
  if new.name is distinct from old.name then
    update public.profiles set role = new.name
      where org_id = new.org_id and role = old.name;
    update public.tasks set assigned_role = new.name
      where org_id = new.org_id and assigned_role = old.name;
    update public.task_templates set assigned_role = new.name
      where org_id = new.org_id and assigned_role = old.name;
  end if;
  return new;
end; $function$;

create or replace function public.tg_shift_insert_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare actor uuid := coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid);
begin
  if new.assigned_user_id is not null then
    if new.assigned_user_id <> actor then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.assigned_user_id, new.org_id, 'shift', 'New shift added',
              'You have been scheduled for a new shift.');
    end if;
  elsif new.required_role is not null then
    insert into public.notifications (user_id, org_id, type, title, body)
    select pl.profile_id, new.org_id, 'open_shift', 'New open shift',
           'A shift is available for ' || new.required_role || 's at your location.'
    from public.profile_locations pl
    join public.profiles p on p.id = pl.profile_id
    where pl.location_id = new.location_id
      and p.org_id = new.org_id
      and p.role = new.required_role
      and p.is_active
      and p.id <> actor;
  end if;
  return new;
end; $function$;

create or replace function public.tg_shift_update_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare actor uuid := coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid);
begin
  if new.assigned_user_id is distinct from old.assigned_user_id then
    if new.assigned_user_id is not null and new.assigned_user_id <> actor then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.assigned_user_id, new.org_id, 'shift', 'Shift assigned to you',
              'A shift has been added to your rota.');
    end if;
    if old.assigned_user_id is not null and old.assigned_user_id <> actor then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (old.assigned_user_id, new.org_id, 'shift', 'Shift removed',
              'A shift is no longer assigned to you.');
    end if;
  elsif new.assigned_user_id is not null
        and new.assigned_user_id <> actor
        and (new.start_time is distinct from old.start_time
             or new.end_time is distinct from old.end_time
             or new.location_id is distinct from old.location_id) then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.assigned_user_id, new.org_id, 'shift', 'Shift changed',
            'The time or location of one of your shifts has changed.');
  end if;
  return new;
end; $function$;

create or replace function public.tg_shift_delete_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if old.assigned_user_id is not null
     and old.assigned_user_id <> coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid) then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (old.assigned_user_id, old.org_id, 'shift', 'Shift cancelled',
            'One of your shifts has been removed from the rota.');
  end if;
  return old;
end; $function$;

create or replace function public.tg_application_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform public.notify_org_managers(new.org_id, 'open_shift',
    'Open shift application', 'Someone applied for an open shift.');
  return new;
end; $function$;

create or replace function public.tg_swap_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if TG_OP = 'INSERT' then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.target_id, new.org_id, 'swap', 'Shift swap request',
            'A colleague wants to swap a shift with you.');
  elsif new.status = 'pending_manager' and old.status = 'pending_peer' then
    perform public.notify_org_managers(new.org_id, 'swap', 'Swap needs approval',
      'A shift swap is waiting for your approval.');
  elsif new.status = 'denied' then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.requester_id, new.org_id, 'swap', 'Swap declined',
            'Your colleague declined the swap.');
  end if;
  return new;
end; $function$;

create or replace function public.tg_overtime_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  perform public.notify_org_managers(new.org_id, 'timesheet',
    'Overtime claim', 'An employee has submitted an overtime claim.');
  return new;
end; $function$;

create or replace function public.tg_unavailability_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if TG_OP = 'INSERT' then
    perform public.notify_org_managers(new.org_id, 'unavailability',
      'Unavailability request', 'An employee has requested time off.');
  elsif new.status is distinct from old.status and new.status in ('approved','denied') then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.user_id, new.org_id, 'unavailability',
            'Time off ' || new.status,
            'Your unavailability request was ' || new.status || '.');
  end if;
  return new;
end; $function$;

create or replace function public.tg_task_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare actor uuid := coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid);
begin
  -- One-off task assigned to a specific person.
  if TG_OP = 'INSERT' then
    if new.template_id is null
       and new.assigned_user_id is not null
       and new.assigned_user_id <> actor then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.assigned_user_id, new.org_id, 'task', 'New task',
              new.title);
    end if;
    return new;
  end if;

  -- Submitted for review.
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    perform public.notify_org_managers(new.org_id, 'task',
      'Task submitted', new.title || ' is ready for review.');

  -- Sent back. The person who did it needs to know, not the whole role.
  elsif new.status = 'rejected' and old.status is distinct from 'rejected' then
    if new.completed_by is not null then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.completed_by, new.org_id, 'task', 'Task needs redoing',
              new.title || ' — see the comment for what to change.');
    end if;

  elsif new.status = 'approved' and old.status is distinct from 'approved' then
    if new.completed_by is not null and new.completed_by <> actor then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.completed_by, new.org_id, 'task', 'Task approved', new.title);
    end if;
  end if;

  return new;
end; $function$;

create or replace function public.tg_task_comment_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_task public.tasks%rowtype;
  v_sender_is_manager boolean;
begin
  select * into v_task from public.tasks where id = new.task_id;
  select (p.role = 'Manager') into v_sender_is_manager
  from public.profiles p where p.id = new.sender_id;

  if v_sender_is_manager then
    -- Prefer whoever did the work; fall back to the assignee.
    if coalesce(v_task.completed_by, v_task.assigned_user_id) is not null then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (coalesce(v_task.completed_by, v_task.assigned_user_id),
              v_task.org_id, 'task', 'Comment on a task', v_task.title);
    end if;
  else
    perform public.notify_org_managers(v_task.org_id, 'task',
      'Comment on a task', v_task.title);
  end if;
  return new;
end; $function$;

create or replace function public.tg_timelog_update_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if new.user_id <> coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid)
     and (new.clock_in is distinct from old.clock_in
          or new.clock_out is distinct from old.clock_out) then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.user_id, new.org_id, 'timesheet', 'Timesheet updated',
            'Your manager adjusted one of your time entries.');
  end if;
  return new;
end; $function$;

-- Event trigger function (see "Event trigger" section at the bottom): auto
-- enables RLS on any newly created public table, so a table can never
-- accidentally ship without it.
create or replace function public.rls_auto_enable()
 returns event_trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;


-- ============================================================================
-- org_id defaults — deferred from the Tables section above because they
-- call my_org_id(), which needs the profiles table (and therefore had to
-- be defined after it).
-- ============================================================================

alter table public.locations               alter column org_id set default public.my_org_id();
alter table public.profile_locations        alter column org_id set default public.my_org_id();
alter table public.shifts                   alter column org_id set default public.my_org_id();
alter table public.time_logs                alter column org_id set default public.my_org_id();
alter table public.live_locations           alter column org_id set default public.my_org_id();
alter table public.unavailability_requests  alter column org_id set default public.my_org_id();
alter table public.notifications            alter column org_id set default public.my_org_id();
alter table public.shift_applications       alter column org_id set default public.my_org_id();
alter table public.shift_swaps              alter column org_id set default public.my_org_id();
alter table public.overtime_claims          alter column org_id set default public.my_org_id();
alter table public.employee_notes           alter column org_id set default public.my_org_id();
alter table public.task_templates           alter column org_id set default public.my_org_id();
alter table public.tasks                    alter column org_id set default public.my_org_id();
alter table public.task_comments            alter column org_id set default public.my_org_id();


-- ============================================================================
-- Triggers
-- ============================================================================

-- auth.users — Supabase-managed table; these are this project's additions.
create trigger on_auth_user_created after insert on auth.users for each row execute function public.tg_handle_new_user();
create trigger sync_profile_email after update of email on auth.users for each row execute function public.tg_sync_profile_email();

create trigger protect_profile_role before update on public.profiles for each row execute function public.tg_protect_profile_role();
create trigger set_updated_at before update on public.profiles for each row execute function public.tg_set_updated_at();

create trigger set_updated_at before update on public.locations for each row execute function public.tg_set_updated_at();

create trigger role_deleted before delete on public.roles for each row execute function public.tg_role_deleted();
create trigger role_renamed before update on public.roles for each row execute function public.tg_role_renamed();

create trigger set_updated_at before update on public.shifts for each row execute function public.tg_set_updated_at();
create trigger shift_insert_notify after insert on public.shifts for each row execute function public.tg_shift_insert_notify();
create trigger shift_update_notify after update on public.shifts for each row execute function public.tg_shift_update_notify();
create trigger shift_delete_notify after delete on public.shifts for each row execute function public.tg_shift_delete_notify();

create trigger set_updated_at before update on public.time_logs for each row execute function public.tg_set_updated_at();
create trigger timelog_update_notify after update on public.time_logs for each row execute function public.tg_timelog_update_notify();

create trigger set_updated_at before update on public.live_locations for each row execute function public.tg_set_updated_at();

create trigger unavailability_notify after insert or update on public.unavailability_requests for each row execute function public.tg_unavailability_notify();

create trigger application_notify after insert on public.shift_applications for each row execute function public.tg_application_notify();

create trigger swap_notify after insert or update on public.shift_swaps for each row execute function public.tg_swap_notify();

create trigger overtime_notify after insert on public.overtime_claims for each row execute function public.tg_overtime_notify();

create trigger task_notify after insert or update on public.tasks for each row execute function public.tg_task_notify();

create trigger task_comment_notify after insert on public.task_comments for each row execute function public.tg_task_comment_notify();


-- ============================================================================
-- Row Level Security
--
-- This is the actual security model. Every policy below is `authenticated`-
-- role and permissive; where more than one permissive policy applies to the
-- same command, Postgres OR's their USING clauses together and OR's their
-- WITH CHECK clauses together.
-- ============================================================================

alter table public.organisations             enable row level security;
alter table public.roles                      enable row level security;
alter table public.profiles                    enable row level security;
alter table public.profiles                    force row level security;
alter table public.locations                   enable row level security;
alter table public.locations                   force row level security;
alter table public.profile_locations           enable row level security;
alter table public.shifts                      enable row level security;
alter table public.shifts                      force row level security;
alter table public.time_logs                   enable row level security;
alter table public.time_logs                   force row level security;
alter table public.live_locations              enable row level security;
alter table public.live_locations              force row level security;
alter table public.unavailability_requests     enable row level security;
alter table public.notifications               enable row level security;
alter table public.shift_applications          enable row level security;
alter table public.shift_swaps                 enable row level security;
alter table public.overtime_claims             enable row level security;
alter table public.employee_notes              enable row level security;
alter table public.employee_notes              force row level security;
alter table public.task_templates              enable row level security;
alter table public.tasks                       enable row level security;
alter table public.task_comments               enable row level security;

-- ---------------------------------------------------------------------------
-- organisations
-- ---------------------------------------------------------------------------
create policy orgs_select_own on public.organisations for select
  to authenticated
  using (id = my_org_id());

create policy orgs_manager_update on public.organisations for update
  to authenticated
  using (id = my_org_id() and is_admin())
  with check (id = my_org_id() and is_admin());

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
create policy roles_select_org on public.roles for select
  to authenticated
  using (org_id = my_org_id());

create policy roles_manager_all on public.roles for all
  to authenticated
  using (is_admin() and org_id = my_org_id())
  with check (is_admin() and org_id = my_org_id());

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select_org on public.profiles for select
  to authenticated
  using (org_id = my_org_id());

create policy profiles_select_own on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy profiles_manager_all on public.profiles for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(id))
  with check (is_manager() and org_id = my_org_id() and manages_person(id));

-- ---------------------------------------------------------------------------
-- locations
--
-- Deliberate, not a bug: locations_manager_all's USING lets a Manager see
-- (and would let them target) a location they manage, but its WITH CHECK
-- requires is_admin() unconditionally, so only an Administrator can
-- actually save an edit — editing a location moves its geofence, which
-- changes where staff can clock in, so that is administrators only.
-- locations_manager_update duplicates the same is_admin()-only behaviour
-- for UPDATE specifically.
-- ---------------------------------------------------------------------------
create policy locations_select_org on public.locations for select
  to authenticated
  using (org_id = my_org_id());

create policy locations_manager_all on public.locations for all
  to authenticated
  using (org_id = my_org_id() and manages_location(id))
  with check (org_id = my_org_id() and is_admin());

create policy locations_manager_update on public.locations for update
  to authenticated
  using (org_id = my_org_id() and is_admin())
  with check (org_id = my_org_id() and is_admin());

-- ---------------------------------------------------------------------------
-- profile_locations
-- ---------------------------------------------------------------------------
create policy proflocs_select_org on public.profile_locations for select
  to authenticated
  using (org_id = my_org_id());

create policy proflocs_manager_all on public.profile_locations for all
  to authenticated
  using (is_manager() and org_id = my_org_id())
  with check (is_manager() and org_id = my_org_id());

-- ---------------------------------------------------------------------------
-- shifts
-- ---------------------------------------------------------------------------
create policy shifts_select_own on public.shifts for select
  to authenticated
  using (org_id = my_org_id() and assigned_user_id = (select auth.uid()));

create policy shifts_select_open on public.shifts for select
  to authenticated
  using (org_id = my_org_id() and assigned_user_id is null and required_role = my_role());

create policy shifts_select_same_role on public.shifts for select
  to authenticated
  using (org_id = my_org_id() and assigned_user_id in (
    select p.id from public.profiles p
    where p.org_id = my_org_id() and p.role = my_role()
  ));

create policy shifts_manager_all on public.shifts for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_location(location_id))
  with check (is_manager() and org_id = my_org_id() and manages_location(location_id));

-- ---------------------------------------------------------------------------
-- time_logs — payroll data.
-- ---------------------------------------------------------------------------
create policy time_logs_select_own on public.time_logs for select
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()));

create policy time_logs_insert_own on public.time_logs for insert
  to authenticated
  with check (user_id = (select auth.uid()) and org_id = my_org_id() and is_active_user());

create policy time_logs_update_own_open on public.time_logs for update
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()) and clock_out is null)
  with check (user_id = (select auth.uid()));

create policy time_logs_manager_all on public.time_logs for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(user_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(user_id));

-- ---------------------------------------------------------------------------
-- live_locations
-- ---------------------------------------------------------------------------
create policy live_locations_select_own on public.live_locations for select
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()));

create policy live_locations_map_viewers on public.live_locations for select
  to authenticated
  using (org_id = my_org_id() and my_can_view_map() and (not is_manager() or manages_person(user_id)));

create policy live_locations_insert_own_clocked on public.live_locations for insert
  to authenticated
  with check (user_id = (select auth.uid()) and org_id = my_org_id() and is_clocked_in((select auth.uid())));

create policy live_locations_update_own_clocked on public.live_locations for update
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()) and is_clocked_in((select auth.uid())))
  with check (user_id = (select auth.uid()));

create policy live_locations_manager_all on public.live_locations for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(user_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(user_id));

-- ---------------------------------------------------------------------------
-- unavailability_requests
-- ---------------------------------------------------------------------------
create policy unavail_select_own on public.unavailability_requests for select
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()));

create policy unavail_insert_own on public.unavailability_requests for insert
  to authenticated
  with check (user_id = (select auth.uid()) and org_id = my_org_id());

create policy unavail_manager_all on public.unavailability_requests for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(user_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(user_id));

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create policy notif_select_own on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy notif_update_own on public.notifications for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notif_delete_own on public.notifications for delete
  to authenticated
  using (user_id = (select auth.uid()));

create policy notif_manager_insert on public.notifications for insert
  to authenticated
  with check (is_manager() and org_id = my_org_id());

-- ---------------------------------------------------------------------------
-- shift_applications
-- ---------------------------------------------------------------------------
create policy apps_select_own on public.shift_applications for select
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()));

create policy apps_insert_own on public.shift_applications for insert
  to authenticated
  with check (
    user_id = (select auth.uid()) and org_id = my_org_id() and exists (
      select 1 from public.shifts s
      where s.id = shift_applications.shift_id
        and s.org_id = my_org_id()
        and s.assigned_user_id is null
        and s.required_role = my_role()
    )
  );

create policy apps_delete_own on public.shift_applications for delete
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()));

create policy apps_manager_all on public.shift_applications for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(user_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(user_id));

-- ---------------------------------------------------------------------------
-- shift_swaps
-- ---------------------------------------------------------------------------
create policy swaps_select_mine on public.shift_swaps for select
  to authenticated
  using (org_id = my_org_id() and (requester_id = (select auth.uid()) or target_id = (select auth.uid())));

create policy swaps_insert_own on public.shift_swaps for insert
  to authenticated
  with check (
    requester_id = (select auth.uid()) and org_id = my_org_id() and exists (
      select 1 from public.profiles p
      where p.id = shift_swaps.target_id and p.org_id = my_org_id() and p.role = my_role()
    )
  );

create policy swaps_update_target on public.shift_swaps for update
  to authenticated
  using (org_id = my_org_id() and target_id = (select auth.uid()) and status = 'pending_peer'::text)
  with check (target_id = (select auth.uid()));

create policy swaps_delete_requester on public.shift_swaps for delete
  to authenticated
  using (org_id = my_org_id() and requester_id = (select auth.uid()));

create policy swaps_manager_all on public.shift_swaps for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(requester_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(requester_id));

-- ---------------------------------------------------------------------------
-- overtime_claims
-- ---------------------------------------------------------------------------
create policy ot_select_own on public.overtime_claims for select
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()));

create policy ot_insert_own on public.overtime_claims for insert
  to authenticated
  with check (
    user_id = (select auth.uid()) and org_id = my_org_id() and exists (
      select 1 from public.time_logs t
      where t.id = overtime_claims.time_log_id and t.user_id = (select auth.uid())
    )
  );

create policy ot_manager_all on public.overtime_claims for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(user_id))
  with check (is_manager() and org_id = my_org_id() and manages_person(user_id));

-- ---------------------------------------------------------------------------
-- employee_notes — manager notes on an employee's profile.
-- ---------------------------------------------------------------------------
create policy notes_manager_select on public.employee_notes for select
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_person(employee_id));

create policy notes_manager_insert on public.employee_notes for insert
  to authenticated
  with check (
    is_manager() and org_id = my_org_id()
    and manager_id = (select auth.uid())
    and manages_person(employee_id)
  );

-- Soft-delete only (sets deleted_at/deleted_by). There is still no DELETE
-- policy for anyone — the row is never actually removed.
create policy notes_admin_delete on public.employee_notes for update
  to authenticated
  using (is_admin() and org_id = my_org_id())
  with check (is_admin() and org_id = my_org_id());

-- ---------------------------------------------------------------------------
-- task_templates
-- ---------------------------------------------------------------------------
create policy tmpl_manager_all on public.task_templates for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_location(location_id))
  with check (is_manager() and org_id = my_org_id() and manages_location(location_id));

-- ---------------------------------------------------------------------------
-- tasks — a role-assigned task is a shared pool, not copied per person.
-- ---------------------------------------------------------------------------
create policy tasks_select_assigned on public.tasks for select
  to authenticated
  using (org_id = my_org_id() and (assigned_user_id = (select auth.uid()) or assigned_role = my_role()));

create policy tasks_submit on public.tasks for update
  to authenticated
  using (
    org_id = my_org_id()
    and status = any (array['pending'::text, 'rejected'::text])
    and (assigned_user_id = (select auth.uid()) or assigned_role = my_role())
  )
  with check (status = any (array['pending'::text, 'submitted'::text]));

create policy tasks_manager_all on public.tasks for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_location(location_id))
  with check (is_manager() and org_id = my_org_id() and manages_location(location_id));

-- ---------------------------------------------------------------------------
-- task_comments — visible to the assignee(s) and managers, via can_see_task().
-- ---------------------------------------------------------------------------
create policy comments_select on public.task_comments for select
  to authenticated
  using (org_id = my_org_id() and can_see_task(task_id));

create policy comments_insert on public.task_comments for insert
  to authenticated
  with check (org_id = my_org_id() and sender_id = (select auth.uid()) and can_see_task(task_id));


-- ============================================================================
-- Storage
-- ============================================================================

insert into storage.buckets (id, name, public)
values
  ('org-logos', 'org-logos', true),
  ('task-photos', 'task-photos', false)
on conflict (id) do nothing;

-- org-logos: public read (served directly in both dashboard headers);
-- writes restricted to managers, at ${orgId}/logo.<ext>. Enforced client-
-- side: PNG/JPG/SVG, 1MB cap (ManagerMoreTab's Branding card).
create policy org_logos_read on storage.objects for select
  using (bucket_id = 'org-logos'::text);

create policy org_logos_write on storage.objects for insert
  to authenticated
  with check (bucket_id = 'org-logos'::text and is_manager());

create policy org_logos_update on storage.objects for update
  to authenticated
  using (bucket_id = 'org-logos'::text and is_manager());

-- task-photos: private bucket, purged one month after task completion by
-- the purge-task-photos cron job below.
create policy task_photos_read on storage.objects for select
  to authenticated
  using (bucket_id = 'task-photos'::text);

create policy task_photos_write on storage.objects for insert
  to authenticated
  with check (bucket_id = 'task-photos'::text);


-- ============================================================================
-- pg_cron job schedules
-- ============================================================================

select cron.schedule('sweep-open-shifts',        '*/15 * * * *', $$select public.sweep_open_shifts();$$);
select cron.schedule('generate-tasks',            '5 * * * *',    $$select public.generate_task_instances();$$);
select cron.schedule('notify-overdue-tasks',      '*/15 * * * *', $$select public.notify_overdue_tasks();$$);
select cron.schedule('purge-task-photos',         '30 3 * * *',   $$select public.purge_old_task_photos();$$);
select cron.schedule('purge-expired-open-shifts', '15 4 * * *',   $$select public.purge_expired_open_shifts();$$);


-- ============================================================================
-- Event trigger — keeps RLS from ever shipping disabled on a new table.
-- ============================================================================

create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
