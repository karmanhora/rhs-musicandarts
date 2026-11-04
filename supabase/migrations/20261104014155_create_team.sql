-- ============================================================================
-- create_team — a system administrator can start an empty team
-- ----------------------------------------------------------------------------
-- Purpose
--   20261104013553 made a program able to sit inside a team, but the only way to
--   get a team was to have a top-level program already (RHS Band). The owner
--   asked (2026-11-04) for the missing half: an option to create a team itself,
--   then put programs in it.
--
-- What this changes
--   1. `create_program_in_team()` accepts `p_parent = null` and creates a
--      top-level program instead of refusing. Everything else is unchanged: the
--      join code, the sections, the caller's `{director}` membership and the
--      `is_program_admin()` gate.
--   2. `create_team()` — the named door for that case, so the screen and its
--      tests say what they mean. It is a thin wrapper; there is one
--      implementation, not two that can drift.
--
-- A team is still a program
--   Nothing new is stored. An empty team is an ordinary program with no children
--   and no parent; adding the first program inside it (`create_program_in_team`)
--   is what makes it read as a team. That keeps one identity, one permission
--   model and one roster per object, exactly as 20261104013553 established.
--
-- Access
--   Both functions are system-administrator only (`is_program_admin()`), refuse
--   anon, and are SECURITY DEFINER with a pinned `search_path`. A director gains
--   nothing: they cannot create a team, and they cannot create a program inside
--   one.
--
-- Rollback
--   delete the wrapper and restore the parent-required body:
--     drop function if exists public.create_team(text, text, text[]);
--   (Re-applying 20261104013553 recreates `create_program_in_team()` byte for
--   byte as it was. No program, membership, event or attendance row is touched
--   by this migration, so its rollback touches none either.)
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. create_program_in_team(): a null parent means "a new team"
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

  -- A parent is optional: null starts a new team at the top level.
  if p_parent is not null then
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
    'message', case
      when p_parent is null then v_name || ' is ready — add its programs next.'
      else v_name || ' is now part of ' || v_parent_name || '.'
    end
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
  'System administrator: create a program inside a team, or a new top-level team when p_parent is null, with a join code, its sections and the caller as director.';

revoke all on function public.create_program_in_team(uuid, text, text, text[]) from public, anon;
grant execute on function public.create_program_in_team(uuid, text, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. create_team(): the named door for the empty team
-- ---------------------------------------------------------------------------
create or replace function public.create_team(
  p_name        text,
  p_short_name  text default null,
  p_instruments text[] default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.create_program_in_team(null, p_name, p_short_name, p_instruments)
$$;

comment on function public.create_team(text, text, text[]) is
  'System administrator: start an empty team (a top-level program) that can then hold programs.';

revoke all on function public.create_team(text, text, text[]) from public, anon;
grant execute on function public.create_team(text, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_anon text;
begin
  if to_regprocedure('public.create_team(text, text, text[])') is null then
    raise exception 'FAIL: create_team() was not created';
  end if;

  if not exists (
    select 1 from pg_proc
     where oid = 'public.create_team(text, text, text[])'::regprocedure
       and prosecdef
  ) then
    raise exception 'FAIL: create_team() must be SECURITY DEFINER';
  end if;

  select string_agg(p.proname, ', ') into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_team', 'create_program_in_team')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_anon is not null then
    raise exception 'FAIL: anon can execute: %', v_anon;
  end if;

  raise notice 'create_team structure OK: wrapper exists, SECURITY DEFINER, anon denied';
end
$$;

-- Functional check, rolled back on purpose (the pattern 022/035/20261104013553
-- use): the team, its program, the memberships and the sections below never
-- survive this block.
do $$
declare
  v_admin uuid := '20261104-0000-4000-8000-000000000002';
  v_team  uuid;
  v_child uuid;
  v_r     jsonb;
  v_parent uuid;
  v_head  int;
  v_done  boolean := false;
begin
  select count(*) into v_head from public.ensembles;

  begin
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values (v_admin, '20261104-0000-4000-8000-0000000000cc', 'Team Starter', 'Team Starter')
    on conflict (id) do nothing;

    insert into public.program_admins (user_id) values (v_admin)
    on conflict (user_id) do nothing;

    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261104-0000-4000-8000-0000000000cc","role":"authenticated"}',
      true
    );

    -- A team is created with no parent, and the caller directs it.
    v_r := public.create_team('ZZ Brand New Team', 'ZZBNT', array['Violin']);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: create_team refused: %', v_r ->> 'message';
    end if;
    v_team := (v_r ->> 'program_id')::uuid;

    select parent_ensemble_id into v_parent from public.ensembles where id = v_team;
    if v_parent is not null then
      raise exception 'FAIL: a new team was created inside another program';
    end if;
    if coalesce(v_r ->> 'join_code', '') = '' then
      raise exception 'FAIL: the new team was left open (no join code)';
    end if;
    if not exists (
      select 1 from public.memberships
       where user_id = v_admin and ensemble_id = v_team and roles = '{director}'::public.app_role[]
    ) then
      raise exception 'FAIL: the caller is not director of the team they made';
    end if;

    -- And it can hold a program straight away.
    v_r := public.create_program_in_team(v_team, 'ZZ First Ensemble');
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: a program could not be added to the new team: %', v_r ->> 'message';
    end if;
    v_child := (v_r ->> 'program_id')::uuid;
    select parent_ensemble_id into v_parent from public.ensembles where id = v_child;
    if v_parent is distinct from v_team then
      raise exception 'FAIL: the program was not put inside the new team';
    end if;

    -- Nobody but a system administrator may start a team.
    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261104-0000-4000-8000-0000000000dd","role":"authenticated"}',
      true
    );
    if (public.create_team('ZZ Not Allowed')) ->> 'ok' <> 'false' then
      raise exception 'FAIL: a non-administrator created a team';
    end if;
    if (public.create_program_in_team(null, 'ZZ Also Not Allowed')) ->> 'ok' <> 'false' then
      raise exception 'FAIL: a non-administrator created a top-level program this way';
    end if;

    v_done := true;
    raise exception 'ROLLBACK_CREATE_TEAM_CHECK';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_CREATE_TEAM_CHECK' then
        raise;
      end if;
  end;

  if not v_done then
    raise exception 'FAIL: the create-team functional check did not reach its end';
  end if;

  if (select count(*) from public.ensembles) <> v_head then
    raise exception 'FAIL: the verification left a program behind';
  end if;

  raise notice 'create_team OK: an administrator started a team and put a program in it; everybody else refused; fixtures rolled back';
end
$$;
