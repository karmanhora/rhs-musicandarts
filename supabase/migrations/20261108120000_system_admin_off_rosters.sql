-- ============================================================================
-- system_admin_off_rosters — a system administrator is never put on a roster
-- ----------------------------------------------------------------------------
-- Purpose
--   The owner asked (2026-11-08): creating a team as the admin account
--   (lebronyuh64@gmail.com) must not give that account a role or a roster row —
--   "I should be invisible". Until now `create_program_in_team()` (and with it
--   `create_team()`) wrote the caller's `{director}` membership, so every team
--   the administrator started put them on that roster as its director.
--
-- What this changes
--   1. `create_program_in_team()` — every caller is a system administrator (the
--      `is_program_admin()` gate refuses everybody else), so it no longer
--      inserts a membership. The program, `created_by`, its join code and its
--      sections are unchanged.
--   2. `create_program_unchecked()` — for a system administrator it skips the
--      caller's membership and returns `membership_id: null`. A teacher with no
--      `program_admins` row still becomes the director of the program they
--      started, exactly as before.
--   3. Removes the roster rows those creations already left on system
--      administrator accounts. Membership is the roster link only: the account
--      keeps every capability through `program_admins` (`has_permission()`
--      short-circuits to `is_program_admin()`), so it loses nothing but its
--      visible place on the roster. Custom role grants
--      (`user_role_assignments`) and attendance are deliberately left alone —
--      this changes who appears on a roster, it does not rewrite history.
--
-- Why this is the right shape
--   System-administrator status was always "a `program_admins` row and no roster
--   membership": 20261025010444 grants it that way and
--   [system_admin.sql §B] asserts the administrator "is not on this program's
--   roster". Team creation was the one path that contradicted it.
--
-- Access
--   No grant changes. `create_program_in_team()` remains system-administrator
--   only and SECURITY DEFINER; `create_program_unchecked()` remains unavailable
--   to `authenticated`. Nothing here lets a director or a student do anything
--   they could not do before.
--
-- Rollback
--   Re-applying 20261104014155 and 023 restores the previous bodies, which put
--   the caller back on the roster. The removed memberships are not restored by
--   that (nor by anything else) — re-add one by hand if it is ever wanted:
--     insert into public.memberships (user_id, ensemble_id, roles, active)
--     values (<profile>, <program>, '{director}'::public.app_role[], true);
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. create_program_in_team(): no membership for the administrator
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
  -- create_program() both do. `ensembles.created_by` needs the profile row.
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

  -- The creator is a system administrator (the gate above) and therefore stays
  -- off the roster: `has_permission()` already gives that account every
  -- capability in every program, so a `{director}` row would only make them a
  -- visible member of a roster they do not belong on (owner request
  -- 2026-11-08). The branch is kept so the intent survives if the gate ever
  -- admits anybody else.
  if not public.is_program_admin() then
    insert into public.memberships (user_id, ensemble_id, roles, active)
    values (v_profile, v_ens, '{director}'::public.app_role[], true);
  end if;

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
  'System administrator: create a program inside a team, or a new top-level team when p_parent is null, with a join code and its sections. Creates no membership for the administrator, who already holds every capability.';

revoke all on function public.create_program_in_team(uuid, text, text, text[]) from public, anon;
grant execute on function public.create_program_in_team(uuid, text, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. create_program_unchecked(): a system administrator gains no roster row
-- ---------------------------------------------------------------------------
-- Body carried forward from 022 (as renamed by 023); the only change is the
-- guarded membership insert and a nullable `membership_id`. 031 and 035 call
-- this function to create a program and then grant the caller's access
-- themselves, so the guard is what keeps those paths from reappearing as
-- roster rows too.
create or replace function public.create_program_unchecked(
  p_name         text,
  p_short_name   text default null,
  p_display_name text default null,
  p_theme_color  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth    text := public.current_auth_id();
  v_profile uuid;
  v_paused  boolean;
  v_name    text;
  v_short   text;
  v_color   text;
  v_slug    text;
  v_try     text;
  v_n       int := 1;
  v_created int;
  v_ens     uuid;
  v_code    text;
  v_member  uuid;
begin
  if v_auth is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  v_name := left(btrim(coalesce(p_name, '')), 80);
  if length(v_name) < 2 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Give your program a name — at least two letters.'
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

  -- Abuse guard (see 022's header): five an hour is plenty for real teaching.
  if v_profile is not null then
    select count(*) into v_created
      from public.ensembles
     where created_by = v_profile
       and created_at > now() - interval '1 hour';

    if v_created >= 5 then
      return jsonb_build_object(
        'ok', false,
        'message', 'You have started several programs already — try again in an hour.'
      );
    end if;
  end if;

  -- Their first anything: create the person, exactly as join_program() does.
  if v_profile is null then
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values (
      gen_random_uuid(),
      v_auth,
      left(btrim(coalesce(p_display_name, '')), 80),
      left(btrim(coalesce(p_display_name, '')), 80)
    )
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

  -- Only a literal hex colour is accepted; anything else falls back to the
  -- house default rather than painting the app something invalid.
  v_color := lower(btrim(coalesce(p_theme_color, '')));
  if v_color !~ '^#[0-9a-f]{6}$' then
    v_color := '#214d35';
  end if;

  insert into public.ensembles (slug, name, short_name, theme_color, created_by)
  values (v_slug, v_name, v_short, v_color, v_profile)
  returning id into v_ens;

  -- Closed by default: nobody joins without the code the director can rotate.
  v_code := public.generate_join_code(8);
  insert into public.ensemble_settings (ensemble_id, join_code)
  values (v_ens, v_code)
  on conflict (ensemble_id) do update set join_code = excluded.join_code;

  -- A teacher becomes the director of the program they started. A system
  -- administrator does not: their authority is the `program_admins` row, and a
  -- membership would put them on the roster they asked not to appear on
  -- (2026-11-08).
  if not public.is_program_admin() then
    insert into public.memberships (user_id, ensemble_id, roles, active)
    values (v_profile, v_ens, '{director}'::public.app_role[], true)
    returning id into v_member;
  end if;

  return jsonb_build_object(
    'ok', true,
    'program_id', v_ens,
    'slug', v_slug,
    'name', v_name,
    'join_code', v_code,
    'profile_id', v_profile,
    'membership_id', v_member,
    'message', 'Your program is ready.'
  );
exception
  when others then
    return jsonb_build_object(
      'ok', false,
      'message', 'Could not create the program — try again.'
    );
end
$$;

comment on function public.create_program_unchecked(text, text, text, text) is
  'Start a program. A teacher becomes its director; a system administrator gets no membership and keeps every capability through program_admins.';

revoke all on function public.create_program_unchecked(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_program_unchecked(text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Remove the roster rows earlier creations left behind
-- ---------------------------------------------------------------------------
-- Scoped to memberships: the person keeps their profile, their sign-in account
-- and every capability. A system administrator is not a member of a program —
-- this is the state system_admin.sql §B already asserts.
do $$
declare
  v_removed int;
begin
  with gone as (
    delete from public.memberships m
     using public.program_admins pa
     where pa.user_id = m.user_id
    returning 1
  )
  select count(*) into v_removed from gone;

  raise notice 'system_admin_off_rosters: % roster row(s) removed from system administrator accounts', v_removed;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------
-- Structural first: no writes, so nothing to clean up.
do $$
declare
  v_anon text;
begin
  if to_regprocedure('public.create_program_in_team(uuid, text, text, text[])') is null then
    raise exception 'FAIL: create_program_in_team() is missing';
  end if;
  if to_regprocedure('public.create_program_unchecked(text, text, text, text)') is null then
    raise exception 'FAIL: create_program_unchecked() is missing';
  end if;

  if not exists (
    select 1 from pg_proc
     where oid = 'public.create_program_in_team(uuid, text, text, text[])'::regprocedure
       and prosecdef
  ) then
    raise exception 'FAIL: create_program_in_team() must be SECURITY DEFINER';
  end if;

  select string_agg(p.proname, ', ') into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_program_in_team', 'create_program_unchecked')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_anon is not null then
    raise exception 'FAIL: anon can execute: %', v_anon;
  end if;

  if has_function_privilege(
       'authenticated',
       'public.create_program_unchecked(text, text, text, text)',
       'EXECUTE'
     ) then
    raise exception 'FAIL: authenticated can execute create_program_unchecked()';
  end if;

  raise notice 'system_admin_off_rosters structure OK: both functions present, SECURITY DEFINER intact, anon denied';
end
$$;

-- Functional check, rolled back on purpose (the pattern 022/035/20261104014155
-- use): the profile, the teams, the programs and their sections below never
-- survive this block.
do $$
declare
  v_admin   uuid := '20261108-0000-4000-8000-000000000001';
  v_auth    text := '20261108-0000-4000-8000-0000000000a1';
  v_team    uuid;
  v_child   uuid;
  v_prog    uuid;
  v_r       jsonb;
  v_head    int;
  v_left    int;
  v_done    boolean := false;
begin
  -- The cleanup's post-state: no system administrator holds a roster row.
  select count(*) into v_left
    from public.memberships m
    join public.program_admins pa on pa.user_id = m.user_id;
  if v_left <> 0 then
    raise exception 'FAIL: % roster row(s) still belong to a system administrator', v_left;
  end if;

  select count(*) into v_head from public.ensembles;

  begin
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values (v_admin, v_auth, 'Roster Ghost', 'Roster Ghost')
    on conflict (id) do nothing;

    insert into public.program_admins (user_id) values (v_admin)
    on conflict (user_id) do nothing;

    insert into public.signup_account_types (auth_user_id, account_type)
    values (v_auth, 'teacher')
    on conflict (auth_user_id) do nothing;

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', v_auth, 'role', 'authenticated')::text,
      true
    );

    -- A team: created, with its join code and sections, and no roster row.
    v_r := public.create_team('ZZ Ghost Team', 'ZZGT', array['Violin']);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: create_team refused: %', v_r ->> 'message';
    end if;
    v_team := (v_r ->> 'program_id')::uuid;

    if coalesce(v_r ->> 'join_code', '') = '' then
      raise exception 'FAIL: the new team was left open (no join code)';
    end if;
    if not exists (select 1 from public.sections where ensemble_id = v_team and name = 'Violin') then
      raise exception 'FAIL: the sections named at creation were not made';
    end if;
    if exists (select 1 from public.memberships where user_id = v_admin) then
      raise exception 'FAIL: creating a team put the administrator on a roster';
    end if;

    -- And it can hold a program, which also gains no roster row.
    v_r := public.create_program_in_team(v_team, 'ZZ Ghost Ensemble');
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: a program could not be added to the team: %', v_r ->> 'message';
    end if;
    v_child := (v_r ->> 'program_id')::uuid;

    if (select parent_ensemble_id from public.ensembles where id = v_child) is distinct from v_team then
      raise exception 'FAIL: the program was not put inside the team';
    end if;
    if exists (select 1 from public.memberships where user_id = v_admin) then
      raise exception 'FAIL: adding a program put the administrator on a roster';
    end if;

    -- The teacher door: same rule for the administrator, no membership row and
    -- no membership id to hand back.
    v_r := public.create_program('ZZ Ghost Program', 'ZZGP', null, null);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: create_program refused: %', v_r ->> 'message';
    end if;
    v_prog := (v_r ->> 'program_id')::uuid;

    if (v_r ->> 'membership_id') is not null then
      raise exception 'FAIL: create_program returned a membership for the administrator';
    end if;
    if exists (select 1 from public.memberships where user_id = v_admin) then
      raise exception 'FAIL: create_program put the administrator on a roster';
    end if;
    if (select created_by from public.ensembles where id = v_prog) is distinct from v_admin then
      raise exception 'FAIL: created_by was not recorded for the administrator';
    end if;

    -- Invisible, not powerless: the grant still answers every capability.
    if not public.is_program_admin() then
      raise exception 'FAIL: the administrator lost system-administrator status';
    end if;
    if not public.has_permission(v_team, 'program.manage_settings') then
      raise exception 'FAIL: the administrator cannot manage a program they are not on';
    end if;

    v_done := true;
    raise exception 'ROLLBACK_SYSTEM_ADMIN_OFF_ROSTERS_CHECK';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_SYSTEM_ADMIN_OFF_ROSTERS_CHECK' then
        raise;
      end if;
  end;

  if not v_done then
    raise exception 'FAIL: the off-roster functional check did not reach its end';
  end if;

  if (select count(*) from public.ensembles) <> v_head then
    raise exception 'FAIL: the verification left a program behind';
  end if;
  if exists (select 1 from public.program_admins where user_id = v_admin) then
    raise exception 'FAIL: the verification left a program_admins row behind';
  end if;

  raise notice 'system_admin_off_rosters OK: team and program creation leave the administrator off every roster, all capabilities intact, fixtures rolled back';
end
$$;
