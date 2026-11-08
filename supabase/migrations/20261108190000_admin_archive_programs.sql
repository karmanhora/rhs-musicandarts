-- ============================================================================
-- admin_archive_programs — a system administrator can archive or restore a program
-- ----------------------------------------------------------------------------
-- Purpose
--   A program's director has been able to archive and restore it since 026.
--   A system administrator (a `program_admins` row) holds every capability in
--   every program but is deliberately not written onto a program's roster
--   (20261108032109), so `has_role_in(..., 'director')` refused them. The owner
--   asked for the administrator account to be able to delete programs as well.
--
-- What this changes
--   `set_program_active()` now accepts either the program's director or a system
--   administrator. It is still a soft delete: the program is hidden from new
--   joins and active lists, while its memberships, events and attendance remain.
--   Restoring flips the same flag back.
--
-- Rollback
--   Re-apply the function body from 026_archive_program.sql (director-only).
--   No table, row or grant is otherwise changed by this migration.
--
-- Idempotent — safe to re-run.
-- ============================================================================

create or replace function public.set_program_active(
  p_ensemble uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active boolean;
begin
  if public.current_profile_id() is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if p_active is null then
    return jsonb_build_object('ok', false, 'message', 'Choose whether to archive or restore the program.');
  end if;

  if not (public.is_program_admin() or public.has_role_in(p_ensemble, 'director')) then
    return jsonb_build_object(
      'ok', false,
      'message', 'Only this program''s director or a system administrator can archive or restore it.'
    );
  end if;

  select active
    into v_active
    from public.ensembles
   where id = p_ensemble
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That program could not be found.');
  end if;

  if v_active is distinct from p_active then
    update public.ensembles
       set active = p_active
     where id = p_ensemble;
  end if;

  return jsonb_build_object(
    'ok', true,
    'active', p_active,
    'message', case when p_active then 'Program restored.' else 'Program archived.' end
  );
end
$$;

comment on function public.set_program_active(uuid, boolean) is
  'Archive or restore a program for its director or a system administrator; keeps memberships, events and attendance history.';

revoke all on function public.set_program_active(uuid, boolean) from public, anon;
grant execute on function public.set_program_active(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verification: an off-roster administrator can archive and restore, history
-- survives, and a student still cannot. Fixtures roll back with the block.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin    uuid := '20261108-1900-4000-8000-000000000001';
  v_director uuid := '20261108-1900-4000-8000-000000000002';
  v_student  uuid := '20261108-1900-4000-8000-000000000003';
  v_program  uuid := '20261108-1900-4000-8000-000000000004';
  v_event    uuid := '20261108-1900-4000-8000-000000000005';
  v_result   jsonb;
  v_done     boolean := false;
  v_profiles integer;
  v_admins   integer;
  v_programs integer;
  v_members  integer;
  v_events   integer;
begin
  if to_regprocedure('public.set_program_active(uuid, boolean)') is null then
    raise exception 'FAIL: set_program_active() is missing';
  end if;

  select count(*) into v_profiles from public.profiles;
  select count(*) into v_admins   from public.program_admins;
  select count(*) into v_programs from public.ensembles;
  select count(*) into v_members  from public.memberships;
  select count(*) into v_events   from public.events;

  begin
    insert into public.profiles (id, auth_user_id, full_name, display_name)
    values
      (v_admin,    '20261108-1900-4000-8000-0000000000aa', 'Archive Admin',    'Archive Admin'),
      (v_director, '20261108-1900-4000-8000-0000000000bb', 'Archive Director', 'Archive Director'),
      (v_student,  '20261108-1900-4000-8000-0000000000cc', 'Archive Student',  'Archive Student');

    insert into public.program_admins (user_id) values (v_admin);

    insert into public.ensembles (id, slug, name)
    values (v_program, 'admin-archive-check', 'Admin Archive Check');

    insert into public.memberships (user_id, ensemble_id, roles)
    values
      (v_director, v_program, '{director}'),
      (v_student,  v_program, '{student}');

    insert into public.events (id, ensemble_id, name, type, date)
    values (v_event, v_program, 'Admin Archive Event', 'rehearsal', now());

    -- The administrator has no membership in this program.
    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261108-1900-4000-8000-0000000000aa","role":"authenticated"}',
      true
    );

    v_result := public.set_program_active(v_program, false);
    if coalesce(v_result ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: administrator could not archive: %', v_result ->> 'message';
    end if;
    if (select active from public.ensembles where id = v_program) then
      raise exception 'FAIL: administrator archive left the program active';
    end if;
    if not exists (select 1 from public.events where id = v_event) then
      raise exception 'FAIL: administrator archive deleted event history';
    end if;
    if (select count(*) from public.memberships where ensemble_id = v_program) <> 2 then
      raise exception 'FAIL: administrator archive deleted memberships';
    end if;

    v_result := public.set_program_active(v_program, true);
    if coalesce(v_result ->> 'ok', 'false') <> 'true' then
      raise exception 'FAIL: administrator could not restore: %', v_result ->> 'message';
    end if;
    if not (select active from public.ensembles where id = v_program) then
      raise exception 'FAIL: administrator restore left the program archived';
    end if;

    -- A student still cannot archive it.
    perform set_config(
      'request.jwt.claims',
      '{"sub":"20261108-1900-4000-8000-0000000000cc","role":"authenticated"}',
      true
    );
    v_result := public.set_program_active(v_program, false);
    if coalesce(v_result ->> 'ok', 'true') <> 'false' then
      raise exception 'FAIL: a student archived a program';
    end if;
    if not (select active from public.ensembles where id = v_program) then
      raise exception 'FAIL: a refused student archive changed the program';
    end if;

    v_done := true;
    raise exception 'ROLLBACK_ADMIN_ARCHIVE_CHECK';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_ADMIN_ARCHIVE_CHECK' then
        raise;
      end if;
  end;

  if not v_done then
    raise exception 'FAIL: admin archive check did not reach its end';
  end if;

  if (select count(*) from public.profiles) <> v_profiles then
    raise exception 'FAIL: admin archive check left a profile behind';
  end if;
  if (select count(*) from public.program_admins) <> v_admins then
    raise exception 'FAIL: admin archive check left a program_admins row behind';
  end if;
  if (select count(*) from public.ensembles) <> v_programs then
    raise exception 'FAIL: admin archive check left a program behind';
  end if;
  if (select count(*) from public.memberships) <> v_members then
    raise exception 'FAIL: admin archive check left a membership behind';
  end if;
  if (select count(*) from public.events) <> v_events then
    raise exception 'FAIL: admin archive check left an event behind';
  end if;

  raise notice 'admin_archive_programs OK: administrators archive/restore off-roster programs; history and role gates preserved';
end
$$;
