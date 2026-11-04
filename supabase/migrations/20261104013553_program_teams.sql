-- ============================================================================
-- program_teams — a team holds programs (Jazz Ensemble inside RHS Band)
-- ----------------------------------------------------------------------------
-- Purpose
--   The owner asked (2026-11-04) to keep several programs inside one team —
--   "Jazz Ensemble, Jazz Band, Pit Band" inside RHS Band — and, with system
--   administrator access, to create one there and move it between teams at any
--   time. Only a system administrator may do either.
--
-- What this changes
--   1. `ensembles.parent_ensemble_id` — the team a program sits inside. Null is
--      a top-level program, which is what every existing row already is.
--   2. A guard trigger makes the shape a hierarchy of at most two levels: a
--      program cannot contain itself, a program inside a team cannot hold
--      programs, and a team that holds programs cannot be moved inside another.
--   3. `create_program_in_team()` — system administrator only: creates a program
--      under one team, with a join code, its sections and the caller as director.
--   4. `move_program_to_team()` — system administrator only: puts a program in a
--      team, or takes it out (p_parent = null).
--
-- Why a column on `ensembles` rather than a new `teams` table
--   A team is a program: RHS Band keeps its own roster, events and attendance.
--   Adding a table would mean a second identity, a second permission model and a
--   migration of the row that already exists; a nullable self-reference adds
--   none of that. Nothing else about a program changes: RLS, RPCs and queries
--   keep working on flat ids, and only the switcher and the administrator screen
--   read the new column.
--
-- Access
--   The column is additive and harmless: RLS still decides which programs a
--   person may read (`ensembles_read_members`), and a team's members are *not*
--   members of the programs inside it. Creating or moving is refused unless
--   `is_program_admin()` is true, so no director gains the ability to reorganize
--   programs. Reads of the column require nothing new.
--
-- Rollback
--   drop function if exists public.create_program_in_team(uuid, text, text, text[]);
--   drop function if exists public.move_program_to_team(uuid, uuid);
--   drop trigger if exists ensembles_guard_parent on public.ensembles;
--   drop function if exists public.guard_ensemble_parent();
--   alter table public.ensembles drop column if exists parent_ensemble_id;
--   (Dropping the column detaches every program; no program, event, membership
--   or attendance row is deleted by this migration or its rollback.)
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The team a program sits inside
-- ---------------------------------------------------------------------------
alter table public.ensembles add column if not exists parent_ensemble_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ensembles_parent_ensemble_id_fkey'
  ) then
    alter table public.ensembles
      add constraint ensembles_parent_ensemble_id_fkey
      -- Deleting a team detaches its programs instead of destroying them: the
      -- repository's rule everywhere else is that history is archived, not lost.
      foreign key (parent_ensemble_id) references public.ensembles(id) on delete set null;
  end if;
end
$$;

create index if not exists ensembles_parent_ensemble_id_idx
  on public.ensembles (parent_ensemble_id);

comment on column public.ensembles.parent_ensemble_id is
  'The team this program sits inside, or null for a top-level program. One level: a program inside a team cannot itself hold programs.';

-- ---------------------------------------------------------------------------
-- 2. Keep the shape two levels deep
-- ---------------------------------------------------------------------------
create or replace function public.guard_ensemble_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grandparent uuid;
begin
  if new.parent_ensemble_id is null then
    return new;
  end if;

  if new.parent_ensemble_id = new.id then
    raise exception 'A program cannot sit inside itself.';
  end if;

  select parent_ensemble_id into v_grandparent
    from public.ensembles
   where id = new.parent_ensemble_id;

  if not found then
    raise exception 'That team no longer exists.';
  end if;

  if v_grandparent is not null then
    raise exception 'A program inside a team cannot hold programs of its own.';
  end if;

  if exists (
    select 1 from public.ensembles where parent_ensemble_id = new.id
  ) then
    raise exception 'A team that holds programs cannot be moved inside another team.';
  end if;

  return new;
end
$$;

comment on function public.guard_ensemble_parent() is
  'Keeps programs two levels deep: no self-parenting, no team inside a team, no moving a populated team.';

drop trigger if exists ensembles_guard_parent on public.ensembles;
create trigger ensembles_guard_parent
  before insert or update of parent_ensemble_id on public.ensembles
  for each row execute function public.guard_ensemble_parent();

-- A trigger function needs no client path: Postgres does not check EXECUTE
-- when a trigger fires it. Revoking it is what keeps the "anon can execute"
-- security suite honest (SEC-v2-A1 caught it missing here first).
revoke all on function public.guard_ensemble_parent() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Create a program inside a team — system administrator only
-- ---------------------------------------------------------------------------
create or replace function public.create_program_in_team(
  p_parent      uuid,
  p_name        text,
  p_short_name  text default null,
  p_instruments text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth        text := public.current_auth_id();
  v_profile     uuid;
  v_paused      boolean;
  v_name        text;
  v_short       text;
  v_slug        text;
  v_try         text;
  v_n           int := 1;
  v_ens         uuid;
  v_code        text;
  v_added       int := 0;
  v_raw         text;
  v_section     text;
  v_seen        text[] := '{}';
  v_parent_name text;
  v_parent_of   uuid;
begin
  if v_auth is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  -- Administrator-only, and checked here rather than in the browser: the app
  -- hides the screen, the server is what refuses it.
  if not public.is_program_admin() then
    return jsonb_build_object(
      'ok', false,
      'message', 'Only a system administrator can create a program inside a team.'
    );
  end if;

  select name, parent_ensemble_id into v_parent_name, v_parent_of
    from public.ensembles
   where id = p_parent and active;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That team could not be found.');
  end if;

  if v_parent_of is not null then
    return jsonb_build_object(
      'ok', false,
      'message', 'A program inside a team cannot hold programs of its own.'
    );
  end if;

  v_name := left(btrim(coalesce(p_name, '')), 80);
  if length(v_name) < 2 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Give the program a name — at least two letters.'
    );
  end if;

  select id, deactivated into v_profile, v_paused
    from public.profiles
   where auth_user_id = v_auth;

  if v_profile is not null and v_paused then
    return jsonb_build_object(
      'ok', false,
      'message', 'This account has been paused — talk to your director.'
    );
  end if;

  -- Their first anything: create the person, as join_program() and
  -- create_program() both do.
  if v_profile is null then
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values (gen_random_uuid(), v_auth, 'Administrator', 'Administrator')
    returning id into v_profile;
  end if;

  ---------------------------------------------------------------------------
  -- A slug nobody has: from the name, then -2, -3 … (same rule as 022).
  ---------------------------------------------------------------------------
  v_slug := left(
    coalesce(
      nullif(btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-'), ''),
      'program'
    ),
    40
  );

  v_try := v_slug;
  while exists (select 1 from public.ensembles where slug = v_try) loop
    v_n := v_n + 1;
    exit when v_n > 50;
    v_try := left(v_slug, 34) || '-' || v_n;
  end loop;

  if exists (select 1 from public.ensembles where slug = v_try) then
    v_try := left(v_slug, 30) || '-' || substr(gen_random_uuid()::text, 1, 8);
  end if;
  v_slug := v_try;

  v_short := left(coalesce(nullif(btrim(coalesce(p_short_name, '')), ''), v_name), 40);

  insert into public.ensembles (slug, name, short_name, created_by, parent_ensemble_id)
  values (v_slug, v_name, v_short, v_profile, p_parent)
  returning id into v_ens;

  -- Closed by default, exactly like a program started from the teacher screen.
  v_code := public.generate_join_code(8);
  insert into public.ensemble_settings (ensemble_id, join_code)
  values (v_ens, v_code)
  on conflict (ensemble_id) do update set join_code = excluded.join_code;

  insert into public.memberships (user_id, ensemble_id, roles, active)
  values (v_profile, v_ens, '{director}'::public.app_role[], true);

  -- Sections from the instruments named, with 031's rules: blanks skipped,
  -- case-insensitive duplicates collapsed, capped at 60.
  if p_instruments is not null then
    foreach v_raw in array p_instruments loop
      exit when v_added >= 60;

      v_section := public.normalize_section_name(v_raw);
      continue when v_section = '';
      continue when lower(v_section) = any (v_seen);

      v_seen := array_append(v_seen, lower(v_section));
      insert into public.sections (ensemble_id, name, sort_order)
      values (v_ens, v_section, v_added)
      on conflict (ensemble_id, name) do nothing;
      v_added := v_added + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'program_id', v_ens,
    'parent_id', p_parent,
    'parent_name', v_parent_name,
    'slug', v_slug,
    'name', v_name,
    'join_code', v_code,
    'profile_id', v_profile,
    'section_count', v_added,
    'message', v_name || ' is now part of ' || v_parent_name || '.'
  );
exception
  when others then
    return jsonb_build_object(
      'ok', false,
      'message', 'Could not create the program — try again.'
    );
end
$$;

comment on function public.create_program_in_team(uuid, text, text, text[]) is
  'System administrator: create a program inside a team, with a join code, its sections and the caller as director.';

revoke all on function public.create_program_in_team(uuid, text, text, text[]) from public, anon;
grant execute on function public.create_program_in_team(uuid, text, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Move a program between teams — system administrator only
-- ---------------------------------------------------------------------------
create or replace function public.move_program_to_team(
  p_program uuid,
  p_parent  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name        text;
  v_current     uuid;
  v_parent_name text;
  v_parent_of   uuid;
begin
  if public.current_auth_id() is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if not public.is_program_admin() then
    return jsonb_build_object(
      'ok', false,
      'message', 'Only a system administrator can move a program between teams.'
    );
  end if;

  select name, parent_ensemble_id into v_name, v_current
    from public.ensembles
   where id = p_program
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That program could not be found.');
  end if;

  if p_parent is not null then
    if p_parent = p_program then
      return jsonb_build_object('ok', false, 'message', 'A program cannot sit inside itself.');
    end if;

    select name, parent_ensemble_id into v_parent_name, v_parent_of
      from public.ensembles
     where id = p_parent and active;

    if not found then
      return jsonb_build_object('ok', false, 'message', 'That team could not be found.');
    end if;

    if v_parent_of is not null then
      return jsonb_build_object(
        'ok', false,
        'message', 'A program inside a team cannot hold programs of its own.'
      );
    end if;

    if exists (select 1 from public.ensembles where parent_ensemble_id = p_program) then
      return jsonb_build_object(
        'ok', false,
        'message', 'This program holds its own programs, so it cannot move inside a team.'
      );
    end if;
  end if;

  if v_current is distinct from p_parent then
    update public.ensembles
       set parent_ensemble_id = p_parent
     where id = p_program;
  end if;

  return jsonb_build_object(
    'ok', true,
    'program_id', p_program,
    'parent_id', p_parent,
    'message', case
      when p_parent is null then v_name || ' is no longer in a team.'
      else v_name || ' is now part of ' || v_parent_name || '.'
    end
  );
end
$$;

comment on function public.move_program_to_team(uuid, uuid) is
  'System administrator: move a program into a team, or out of one when p_parent is null. Keeps every membership, event and attendance row.';

revoke all on function public.move_program_to_team(uuid, uuid) from public, anon;
grant execute on function public.move_program_to_team(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Verification
-- ---------------------------------------------------------------------------
-- Structural first: no writes, so nothing to clean up.
do $$
declare
  v_anon   text;
  v_action "char";
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ensembles'
       and column_name = 'parent_ensemble_id'
  ) then
    raise exception 'FAIL: ensembles.parent_ensemble_id was not created';
  end if;

  select confdeltype into v_action
    from pg_constraint
   where conname = 'ensembles_parent_ensemble_id_fkey';
  if v_action is distinct from 'n' then
    raise exception 'FAIL: deleting a team must detach its programs, not delete or block them (confdeltype = %)', v_action;
  end if;

  if to_regprocedure('public.create_program_in_team(uuid, text, text, text[])') is null then
    raise exception 'FAIL: create_program_in_team() was not created';
  end if;
  if to_regprocedure('public.move_program_to_team(uuid, uuid)') is null then
    raise exception 'FAIL: move_program_to_team() was not created';
  end if;

  select string_agg(p.proname, ', ') into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_program_in_team', 'move_program_to_team')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_anon is not null then
    raise exception 'FAIL: anon can execute: %', v_anon;
  end if;

  if not exists (
    select 1 from pg_proc
     where oid = 'public.create_program_in_team(uuid, text, text, text[])'::regprocedure
       and prosecdef
  ) then
    raise exception 'FAIL: create_program_in_team() must be SECURITY DEFINER';
  end if;

  -- The trigger function must not be callable by a client role.
  select string_agg(r.rolname, ', ') into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(rolname)
   where n.nspname = 'public'
     and p.proname = 'guard_ensemble_parent'
     and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  if v_anon is not null then
    raise exception 'FAIL: a client role can execute guard_ensemble_parent(): %', v_anon;
  end if;

  raise notice 'program_teams structure OK: column, detaching FK, two SECURITY DEFINER RPCs, anon denied';
end
$$;

-- Functional check, rolled back on purpose (022/035's pattern): the program,
-- its team, the membership and the sections below never survive this block.
do $$
declare
  v_admin   uuid := '20261104-0000-4000-8000-000000000001';
  v_team    uuid;
  v_child   uuid;
  v_r       jsonb;
  v_parent  uuid;
  v_head    int;
  v_done    boolean := false;
begin
  select count(*) into v_head from public.ensembles;

  begin
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values (v_admin, '20261104-0000-4000-8000-0000000000aa', 'Team Checker', 'Team Checker')
    on conflict (id) do nothing;

    insert into public.program_admins (user_id) values (v_admin)
    on conflict (user_id) do nothing;

    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261104-0000-4000-8000-0000000000aa","role":"authenticated"}',
      true
    );

    insert into public.ensembles (slug, name, short_name)
    values ('zz-team-check', 'ZZ Team Check', 'ZZ')
    on conflict (slug) do nothing;
    select id into v_team from public.ensembles where slug = 'zz-team-check';

    -- A program appears inside the team, with a director membership.
    v_r := public.create_program_in_team(v_team, 'ZZ Jazz Band', 'ZZJB', array['Trumpet', 'trumpet ', ' Sax ']);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: create_program_in_team refused: %', v_r ->> 'message';
    end if;
    v_child := (v_r ->> 'program_id')::uuid;

    select parent_ensemble_id into v_parent from public.ensembles where id = v_child;
    if v_parent is distinct from v_team then
      raise exception 'FAIL: the new program was not put inside the team';
    end if;
    if coalesce(v_r ->> 'join_code', '') = '' then
      raise exception 'FAIL: the new program was left open (no join code)';
    end if;
    if (v_r ->> 'section_count')::int <> 2 then
      raise exception 'FAIL: sections were not de-duplicated (section_count = %)', v_r ->> 'section_count';
    end if;
    if not exists (
      select 1 from public.memberships
       where user_id = v_admin and ensemble_id = v_child and roles = '{director}'::public.app_role[]
    ) then
      raise exception 'FAIL: the caller is not director of the program they made';
    end if;

    -- A program that holds programs cannot move inside another team.
    v_r := public.move_program_to_team(v_team, v_child);
    if coalesce(v_r ->> 'ok', 'true') <> 'false' then
      raise exception 'FAIL: a team holding programs was moved inside a program';
    end if;

    -- It can move out of the team, then back in.
    v_r := public.move_program_to_team(v_child, null);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: moving a program out of its team was refused: %', v_r ->> 'message';
    end if;
    select parent_ensemble_id into v_parent from public.ensembles where id = v_child;
    if v_parent is not null then
      raise exception 'FAIL: the program is still inside a team';
    end if;

    -- A team inside a team is refused by the trigger.
    begin
      update public.ensembles set parent_ensemble_id = v_team where id = v_team;
      raise exception 'FAIL: a program was allowed to sit inside itself';
    exception
      when others then
        if sqlerrm not ilike '%cannot sit inside itself%' then
          raise;
        end if;
    end;

    -- Nobody but a system administrator may create or move.
    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261104-0000-4000-8000-0000000000bb","role":"authenticated"}',
      true
    );
    if (public.create_program_in_team(v_team, 'ZZ Not Allowed')) ->> 'ok' <> 'false' then
      raise exception 'FAIL: a non-administrator created a program inside a team';
    end if;
    if (public.move_program_to_team(v_child, v_team)) ->> 'ok' <> 'false' then
      raise exception 'FAIL: a non-administrator moved a program';
    end if;

    v_done := true;
    raise exception 'ROLLBACK_PROGRAM_TEAMS_CHECK';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROGRAM_TEAMS_CHECK' then
        raise;
      end if;
  end;

  if not v_done then
    raise exception 'FAIL: the program-teams functional check did not reach its end';
  end if;

  if (select count(*) from public.ensembles) <> v_head then
    raise exception 'FAIL: the verification left a program behind';
  end if;

  raise notice 'program_teams OK: create/move work for an administrator, both refused for anybody else, fixtures rolled back';
end
$$;
