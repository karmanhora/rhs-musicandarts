-- ============================================================================
-- program_sections — a section holds programs; a program is what a teacher runs
-- ----------------------------------------------------------------------------
-- Purpose
--   The owner asked (2026-11-08) to stop treating a "team" as a program.
--   RHS Band, RHS Choir, RHS Drama and RHS Orchestra are sections of the music
--   program; the programs teachers create (Jazz, Choir, Mean Girls Pit) sit
--   inside them. A section is an organizing row only: it has no roster, events,
--   join code or attendance of its own.
--
-- Why a separate table
--   `ensembles.parent_ensemble_id` made a "team" a full program (20261104013553).
--   Reusing it would keep the very problem the owner reported: a section would
--   still be a program everywhere the app already reads `ensembles`. A small
--   `program_groups` table is the section, and `ensembles.program_group_id` is
--   the program's place in it. Existing program rows, their rosters, events and
--   attendance are untouched. The old column stays as history and is no longer
--   read by the app.
--
-- What this changes
--   1. `program_groups` — id, name, short name, sort order, active flag.
--   2. `ensembles.program_group_id` — the section a program belongs to. Null is
--      allowed only for legacy rows the migration could not place.
--   3. Existing data: top-level teams become sections and keep their programs.
--      RHS Band itself stays a program (it owns real event history) inside the
--      RHS Band section. RHS Choir, RHS Drama and RHS Orchestra are archived
--      shells once their children are placed; they have no events. Mean Girls
--      Pit is placed in RHS Drama.
--   4. `create_program_group()` / `create_program_in_group()` /
--      `move_program_to_group()` — the administrator's section controls.
--      `create_program_in_group()` is also the teacher's creation path: a
--      verified teacher creates a program in an existing section and becomes
--      its director.
--   5. The old team RPCs are revoked from clients. They created a section-shaped
--      program, which is the model this migration replaces.
--
-- Access
--   Every signed-in account may read active sections (a teacher needs the list
--   to choose one). Only `is_program_admin()` may create a section or move a
--   program. `create_program_in_group()` keeps the existing teacher gate
--   (`has_teacher_access()` or an existing director) and the server's rate
--   limit. A system administrator gets no membership, exactly as before.
--
-- Rollback
--   drop function if exists public.move_program_to_group(uuid, uuid);
--   drop function if exists public.create_program_in_group(uuid, text, text, text, text[]);
--   drop function if exists public.create_program_group(text, text);
--   drop policy if exists program_groups_read_authenticated on public.program_groups;
--   alter table public.ensembles drop column if exists program_group_id;
--   drop table if exists public.program_groups;
--   (The old team functions and `parent_ensemble_id` are untouched, so a
--   rollback restores the previous structure without deleting any program,
--   event, membership or attendance row. The archived shells stay archived;
--   set `active = true` on them if wanted.)
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The section layer
-- ---------------------------------------------------------------------------
create table if not exists public.program_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  short_name  text not null default '',
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index if not exists program_groups_name_unique
  on public.program_groups (lower(name));

comment on table public.program_groups is
  'Sections of the music program (RHS Band, RHS Choir …). A section groups programs; it has no roster, events, join code or attendance of its own.';

alter table public.program_groups enable row level security;

revoke all on public.program_groups from anon;
revoke insert, update, delete on public.program_groups from authenticated;
grant select on public.program_groups to authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'program_groups'
       and policyname = 'program_groups_read_authenticated'
  ) then
    create policy program_groups_read_authenticated
      on public.program_groups
      for select
      to authenticated
      using (active or public.is_program_admin());
  end if;
end
$$;

alter table public.ensembles add column if not exists program_group_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ensembles_program_group_id_fkey'
  ) then
    alter table public.ensembles
      add constraint ensembles_program_group_id_fkey
      foreign key (program_group_id) references public.program_groups(id) on delete set null;
  end if;
end
$$;

create index if not exists ensembles_program_group_id_idx
  on public.ensembles (program_group_id);

comment on column public.ensembles.program_group_id is
  'The section this program belongs to. A section is a grouping row, not a program: it has no roster, events or join code.';

-- ---------------------------------------------------------------------------
-- 2. Put the existing teams and programs into sections
-- ---------------------------------------------------------------------------
-- Every existing team becomes a section with the same name. The explicit four
-- departments cover the empty team shells the owner created before adding
-- programs. `on conflict do nothing` keeps this safe to re-run.
insert into public.program_groups (name)
select distinct e.name
  from public.ensembles e
 where e.parent_ensemble_id is null
   and (
     e.name in ('RHS Band', 'RHS Choir', 'RHS Drama', 'RHS Orchestra')
     or exists (select 1 from public.ensembles c where c.parent_ensemble_id = e.id)
   )
on conflict do nothing;

-- A team row is itself the department's main program when it has history.
-- Keep it active and put it in the same section; the child programs join it.
update public.ensembles e
   set program_group_id = g.id
  from public.program_groups g
 where e.parent_ensemble_id is null
   and e.program_group_id is null
   and lower(e.name) = lower(g.name);

update public.ensembles child
   set program_group_id = parent.program_group_id
  from public.ensembles parent
 where child.parent_ensemble_id = parent.id
   and child.program_group_id is null
   and parent.program_group_id is not null;

-- Mean Girls Pit is a Drama program. The owner did not name a different
-- section for it; leaving it ungrouped would hide a real program, so place it
-- where it belongs and let an administrator move it later.
update public.ensembles e
   set program_group_id = g.id
  from public.program_groups g
 where e.name = 'Mean Girls Pit'
   and e.program_group_id is null
   and g.name = 'RHS Drama';

-- The empty department shells are sections now, not programs. RHS Band stays
-- active because it owns the band's event history and real roster activity;
-- the other three have no events, so archiving their shells removes duplicate
-- program rows without losing attendance or events.
update public.ensembles e
   set active = false
 where e.parent_ensemble_id is null
   and e.program_group_id is not null
   and e.name in ('RHS Choir', 'RHS Drama', 'RHS Orchestra')
   and not exists (select 1 from public.events ev where ev.ensemble_id = e.id);

-- ---------------------------------------------------------------------------
-- 3. Administrator: create a section
-- ---------------------------------------------------------------------------
create or replace function public.create_program_group(
  p_name       text,
  p_short_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth   text := public.current_auth_id();
  v_name   text;
  v_short  text;
  v_order  integer;
  v_id     uuid;
begin
  if v_auth is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if not public.is_program_admin() then
    return jsonb_build_object(
      'ok', false,
      'message', 'Only a system administrator can create a section.'
    );
  end if;

  v_name := left(btrim(coalesce(p_name, '')), 80);
  if length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'message', 'Give the section a name — at least two letters.');
  end if;

  v_short := left(coalesce(nullif(btrim(coalesce(p_short_name, '')), ''), v_name), 40);

  select coalesce(max(sort_order), -1) + 1 into v_order
    from public.program_groups;

  insert into public.program_groups (name, short_name, sort_order, created_by)
  values (v_name, v_short, v_order, public.current_profile_id())
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'group_id', v_id,
    'name', v_name,
    'message', v_name || ' is ready — add its programs next.'
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'message', 'A section with that name already exists.');
  when others then
    return jsonb_build_object('ok', false, 'message', 'Could not create the section — try again.');
end
$$;

comment on function public.create_program_group(text, text) is
  'System administrator: create a section (a grouping row that holds programs).';

revoke all on function public.create_program_group(text, text) from public, anon;
grant execute on function public.create_program_group(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Create a program inside a section — teacher or administrator
-- ---------------------------------------------------------------------------
create or replace function public.create_program_in_group(
  p_group        uuid,
  p_name         text,
  p_short_name   text default null,
  p_display_name text default null,
  p_instruments  text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_name text;
  v_result     jsonb;
  v_program    uuid;
  v_added      integer := 0;
  v_raw        text;
  v_section    text;
  v_seen       text[] := '{}';
begin
  if public.current_auth_id() is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  select name into v_group_name
    from public.program_groups
   where id = p_group and active;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That section could not be found.');
  end if;

  if public.is_program_admin() then
    -- An administrator is not rate-limited and gains no roster row. The
    -- unchecked path is the same one `create_program()` uses internally.
    v_result := public.create_program_unchecked(
      p_name,
      p_short_name,
      p_display_name,
      null
    );

    if coalesce(v_result ->> 'ok', 'false') <> 'true' then
      return v_result;
    end if;

    v_program := (v_result ->> 'program_id')::uuid;

    if p_instruments is not null then
      foreach v_raw in array p_instruments loop
        exit when v_added >= 60;

        v_section := public.normalize_section_name(v_raw);
        continue when v_section = '';
        continue when lower(v_section) = any (v_seen);

        v_seen := array_append(v_seen, lower(v_section));
        insert into public.sections (ensemble_id, name, sort_order)
        values (v_program, v_section, v_added)
        on conflict (ensemble_id, name) do nothing;
        v_added := v_added + 1;
      end loop;
    end if;
  else
    -- The teacher path keeps every rule `create_program()` already enforces:
    -- redeemed invitation (or existing director), pause, and the hourly limit.
    v_result := public.create_program(
      p_name,
      p_short_name,
      p_display_name,
      null,
      p_instruments
    );

    if coalesce(v_result ->> 'ok', 'false') <> 'true' then
      return v_result;
    end if;

    v_program := (v_result ->> 'program_id')::uuid;
    v_added := coalesce((v_result ->> 'section_count')::integer, 0);
  end if;

  update public.ensembles
     set program_group_id = p_group
   where id = v_program;

  return v_result || jsonb_build_object(
    'group_id', p_group,
    'group_name', v_group_name,
    'section_count', v_added,
    'message', coalesce(v_result ->> 'name', btrim(p_name)) || ' is ready in ' || v_group_name || '.'
  );
exception
  when others then
    return jsonb_build_object('ok', false, 'message', 'Could not create the program — try again.');
end
$$;

comment on function public.create_program_in_group(uuid, text, text, text, text[]) is
  'Start a program inside a section. A verified teacher becomes its director; a system administrator gets no membership.';

revoke all on function public.create_program_in_group(uuid, text, text, text, text[]) from public, anon;
grant execute on function public.create_program_in_group(uuid, text, text, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Administrator: move a program between sections
-- ---------------------------------------------------------------------------
create or replace function public.move_program_to_group(
  p_program uuid,
  p_group   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name       text;
  v_group_name text;
begin
  if public.current_auth_id() is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if not public.is_program_admin() then
    return jsonb_build_object(
      'ok', false,
      'message', 'Only a system administrator can move a program between sections.'
    );
  end if;

  select name into v_name
    from public.ensembles
   where id = p_program and active;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That program could not be found.');
  end if;

  if p_group is not null then
    select name into v_group_name
      from public.program_groups
     where id = p_group and active;

    if not found then
      return jsonb_build_object('ok', false, 'message', 'That section could not be found.');
    end if;
  end if;

  update public.ensembles
     set program_group_id = p_group
   where id = p_program;

  return jsonb_build_object(
    'ok', true,
    'program_id', p_program,
    'group_id', p_group,
    'message', case
      when p_group is null then v_name || ' is no longer in a section.'
      else v_name || ' is now in ' || v_group_name || '.'
    end
  );
end
$$;

comment on function public.move_program_to_group(uuid, uuid) is
  'System administrator: move a program into a section, or leave it ungrouped when p_group is null. Memberships, events and attendance are untouched.';

revoke all on function public.move_program_to_group(uuid, uuid) from public, anon;
grant execute on function public.move_program_to_group(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Retire the old "team is a program" client paths
-- ---------------------------------------------------------------------------
-- The functions remain for service-role history and for a rollback, but no
-- signed-in client may create another section-shaped program through them.
revoke execute on function public.create_team(text, text, text[]) from authenticated;
revoke execute on function public.create_program_in_team(uuid, text, text, text[]) from authenticated;
revoke execute on function public.move_program_to_team(uuid, uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 7. Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_anon text;
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'program_groups'
  ) then
    raise exception 'FAIL: program_groups was not created';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ensembles'
       and column_name = 'program_group_id'
  ) then
    raise exception 'FAIL: ensembles.program_group_id was not created';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'program_groups'
       and policyname = 'program_groups_read_authenticated'
  ) then
    raise exception 'FAIL: program_groups has no read policy';
  end if;

  if to_regprocedure('public.create_program_group(text, text)') is null then
    raise exception 'FAIL: create_program_group() was not created';
  end if;
  if to_regprocedure('public.create_program_in_group(uuid, text, text, text, text[])') is null then
    raise exception 'FAIL: create_program_in_group() was not created';
  end if;
  if to_regprocedure('public.move_program_to_group(uuid, uuid)') is null then
    raise exception 'FAIL: move_program_to_group() was not created';
  end if;

  select string_agg(p.proname, ', ') into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_program_group', 'create_program_in_group', 'move_program_to_group')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_anon is not null then
    raise exception 'FAIL: anon can execute: %', v_anon;
  end if;

  -- Existing teams became sections, and their child programs kept their place.
  if exists (select 1 from public.ensembles where name = 'RHS Band' and parent_ensemble_id is null) then
    if not exists (select 1 from public.program_groups where name = 'RHS Band') then
      raise exception 'FAIL: RHS Band did not become a section';
    end if;
  end if;

  if exists (select 1 from public.ensembles where name = 'Jazz') then
    if not exists (
      select 1
        from public.ensembles e
        join public.program_groups g on g.id = e.program_group_id
       where e.name = 'Jazz' and g.name = 'RHS Band'
    ) then
      raise exception 'FAIL: Jazz was not placed in the RHS Band section';
    end if;
  end if;

  if exists (select 1 from public.ensembles where name = 'Choir') then
    if not exists (
      select 1
        from public.ensembles e
        join public.program_groups g on g.id = e.program_group_id
       where e.name = 'Choir' and g.name = 'RHS Choir'
    ) then
      raise exception 'FAIL: Choir was not placed in the RHS Choir section';
    end if;
  end if;

  if exists (select 1 from public.ensembles where name = 'Mean Girls Pit') then
    if not exists (
      select 1
        from public.ensembles e
        join public.program_groups g on g.id = e.program_group_id
       where e.name = 'Mean Girls Pit' and g.name = 'RHS Drama'
    ) then
      raise exception 'FAIL: Mean Girls Pit was not placed in the RHS Drama section';
    end if;
  end if;
end
$$;

-- Functional check, rolled back on purpose (the pattern 022/035 use): the
-- section, program, membership and section rows below never survive this block.
do $$
declare
  v_admin   uuid := '20261108-1800-4000-8000-000000000001';
  v_group   uuid;
  v_program uuid;
  v_r       jsonb;
  v_head_g  integer;
  v_head_p  integer;
  v_done    boolean := false;
begin
  select count(*) into v_head_g from public.program_groups;
  select count(*) into v_head_p from public.ensembles;

  begin
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values (v_admin, '20261108-1800-4000-8000-0000000000aa', 'Section Checker', 'Section Checker')
    on conflict (id) do nothing;

    insert into public.program_admins (user_id) values (v_admin)
    on conflict (user_id) do nothing;

    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261108-1800-4000-8000-0000000000aa","role":"authenticated"}',
      true
    );

    v_r := public.create_program_group('ZZ Section Check', 'ZZS');
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: create_program_group refused: %', v_r ->> 'message';
    end if;
    v_group := (v_r ->> 'group_id')::uuid;

    v_r := public.create_program_in_group(
      v_group,
      'ZZ Section Program',
      'ZZSP',
      'Section Checker',
      array['Violin', 'violin ', 'Cello']
    );
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: create_program_in_group refused: %', v_r ->> 'message';
    end if;
    v_program := (v_r ->> 'program_id')::uuid;

    if not exists (
      select 1 from public.ensembles
       where id = v_program and program_group_id = v_group
    ) then
      raise exception 'FAIL: the new program was not placed in the section';
    end if;
    if (v_r ->> 'section_count')::int <> 2 then
      raise exception 'FAIL: instrument sections were not de-duplicated (count = %)', v_r ->> 'section_count';
    end if;
    if exists (select 1 from public.memberships where user_id = v_admin and ensemble_id = v_program) then
      raise exception 'FAIL: the administrator was added to the roster';
    end if;

    v_r := public.move_program_to_group(v_program, null);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: moving the program out of its section was refused: %', v_r ->> 'message';
    end if;
    if exists (select 1 from public.ensembles where id = v_program and program_group_id is not null) then
      raise exception 'FAIL: the program still has a section';
    end if;

    v_r := public.move_program_to_group(v_program, v_group);
    if coalesce(v_r ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: moving the program back was refused: %', v_r ->> 'message';
    end if;

    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261108-1800-4000-8000-0000000000bb","role":"authenticated"}',
      true
    );
    if (public.create_program_group('ZZ Not Allowed')) ->> 'ok' <> 'false' then
      raise exception 'FAIL: a non-administrator created a section';
    end if;
    if (public.move_program_to_group(v_program, null)) ->> 'ok' <> 'false' then
      raise exception 'FAIL: a non-administrator moved a program';
    end if;

    v_done := true;
    raise exception 'ROLLBACK_PROGRAM_SECTIONS_CHECK';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROGRAM_SECTIONS_CHECK' then
        raise;
      end if;
  end;

  if not v_done then
    raise exception 'FAIL: the program-sections functional check did not reach its end';
  end if;

  if (select count(*) from public.program_groups) <> v_head_g then
    raise exception 'FAIL: the verification left a section behind';
  end if;
  if (select count(*) from public.ensembles) <> v_head_p then
    raise exception 'FAIL: the verification left a program behind';
  end if;

  raise notice 'program_sections OK: sections group programs, administrators move them, the teacher path is preserved, fixtures rolled back';
end
$$;
