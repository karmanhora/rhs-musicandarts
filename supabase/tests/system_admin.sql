-- ============================================================================
-- RHS Music Platform — the system administrator (program_admins)
-- ============================================================================
-- requires-table: public.program_admins
--
-- Covers the account the owner asked for on 2026-10-24: one person who can
-- administer every program, including the ones they are not on, because a
-- program director deliberately cannot change a co-director's roles and so
-- cannot undo a temporary promotion.
--
-- Nothing here is new authority. `is_program_admin()` (013) is already the
-- cross-program branch of `has_permission()` (029), of every RLS policy and of
-- `revoke_role()`/`remove_member()`. This suite proves the reach that grant
-- actually gives — and, just as importantly, that it did not loosen the rules
-- for everybody else.
--
-- Scenarios:
--   A  a director still cannot demote a co-director or remove them
--   B  a system administrator in no program can read that program's roster
--   C  …and can demote its director; the person is left as a student
--   D  …and can remove a director from the roster, but never the last one
--   E  system administrator status itself is still not grantable from the app
--   F  a plain student gains nothing
--
-- Every fixture is fictional and the whole suite runs in ONE transaction that is
-- ROLLED BACK — it never touches real records.
--
-- Prints SYSTEM ADMIN PASSED on success.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.program_admins') is null then
    raise exception 'FAIL: SYS-0 program_admins missing — apply 009 first';
  end if;
  if to_regprocedure('public.is_program_admin()') is null then
    raise exception 'FAIL: SYS-0 is_program_admin() missing — apply 013 first';
  end if;
end
$$;

create or replace function public.sysadmin_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures — a second program the administrator is not a member of
-- ---------------------------------------------------------------------------
insert into public.ensembles (id, slug, name, short_name, active)
values ('dddddddd-0000-4000-8000-0000000000a1', 'sys-admin-orch', 'Sys Admin Orchestra', 'Sys Orch', true)
on conflict (slug) do nothing;

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('dddddddd-0000-4000-8000-000000000001', 'sys-dir-a',  'Sys Director A', 'Sys Director A'),
  ('dddddddd-0000-4000-8000-000000000002', 'sys-dir-b',  'Sys Director B', 'Sys Director B'),
  ('dddddddd-0000-4000-8000-000000000003', 'sys-evy',    'Sys Evy',        'Sys Evy'),
  ('dddddddd-0000-4000-8000-000000000004', 'sys-admin',  'Sys Admin',      'Sys Admin'),
  ('dddddddd-0000-4000-8000-000000000005', 'sys-student','Sys Student',    'Sys Student')
on conflict (id) do nothing;

-- Two directors (so "never the last director" does not mask the demotion), and
-- Evy exactly as the app left her: a student who was also given the director
-- role for a look around.
insert into public.memberships (user_id, ensemble_id, roles, active) values
  ('dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-0000000000a1',
   '{director}'::public.app_role[], true),
  ('dddddddd-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-0000000000a1',
   '{director}'::public.app_role[], true),
  ('dddddddd-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-0000000000a1',
   '{student,director}'::public.app_role[], true)
on conflict (user_id, ensemble_id) do nothing;

-- The system administrator: a program_admins row, and no membership anywhere.
insert into public.program_admins (user_id) values ('dddddddd-0000-4000-8000-000000000004')
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- A. A director still cannot demote or remove a co-director
-- ---------------------------------------------------------------------------
do $$
declare
  v_prog uuid := 'dddddddd-0000-4000-8000-0000000000a1';
  v_dir  uuid;
  v      jsonb;
begin
  select id into v_dir from public.roles where key = 'director';

  perform set_config('request.jwt.claims', '{"sub":"sys-dir-a","role":"authenticated"}', true);
  set role authenticated;

  perform public.sysadmin_assert(public.is_program_admin() = false,
    'A1 a director is not a system administrator');

  v := public.revoke_role(v_prog, 'dddddddd-0000-4000-8000-000000000003', v_dir);
  perform public.sysadmin_assert(v->>'ok' = 'false',
    'A2 a director cannot take the director role off a co-director');
  perform public.sysadmin_assert(
    (select roles from public.memberships
      where user_id = 'dddddddd-0000-4000-8000-000000000003'
        and ensemble_id = v_prog) @> '{director}'::public.app_role[],
    'A2 the co-director keeps the role after the refusal');

  v := public.remove_member(v_prog, 'dddddddd-0000-4000-8000-000000000002');
  perform public.sysadmin_assert(v->>'ok' = 'false',
    'A3 a director cannot remove a co-director from the roster');

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- B. The system administrator reaches a program they are not on
-- ---------------------------------------------------------------------------
do $$
declare
  v_prog   uuid := 'dddddddd-0000-4000-8000-0000000000a1';
  v_roster int;
  v_evy    int;
  v        jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"sys-admin","role":"authenticated"}', true);
  set role authenticated;

  perform public.sysadmin_assert(public.is_program_admin(),
    'B1 the administrator is a system administrator');
  perform public.sysadmin_assert(public.is_member_of(v_prog) = false,
    'B1 …and is not on this program''s roster');

  -- RLS, not a client-side filter: the roster rows and the profile rows behind
  -- them are readable by this account.
  select count(*) into v_roster from public.memberships where ensemble_id = v_prog;
  perform public.sysadmin_assert(v_roster = 3,
    format('B2 the administrator reads all %s roster rows (saw %s)', 3, v_roster));

  select count(*) into v_evy from public.profiles
   where id = 'dddddddd-0000-4000-8000-000000000003';
  perform public.sysadmin_assert(v_evy = 1,
    'B2 …and the profile row of somebody they share no program with');
  perform public.sysadmin_assert(
    (select count(*) from public.ensembles where id = v_prog) = 1,
    'B2 …and the program itself');

  -- The interface renders from this; every code the app can ask for is present.
  v := public.my_permissions(v_prog);
  perform public.sysadmin_assert(v->>'ok' = 'true', 'B3 my_permissions answers for a non-member administrator');
  perform public.sysadmin_assert(
    (v->'permissions') @> '["roles.view","roles.assign","roles.revoke","program.manage_settings","attendance.view_program","absence.review"]'::jsonb,
    'B3 the administrator holds the staff capabilities of a program they are not in');

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- C. …and can demote its director, leaving them a student
-- ---------------------------------------------------------------------------
do $$
declare
  v_prog uuid := 'dddddddd-0000-4000-8000-0000000000a1';
  v_dir  uuid;
  v_evy  uuid := 'dddddddd-0000-4000-8000-000000000003';
  v      jsonb;
  v_role public.app_role[];
  v_bool boolean;
begin
  select id into v_dir from public.roles where key = 'director';

  perform set_config('request.jwt.claims', '{"sub":"sys-admin","role":"authenticated"}', true);
  set role authenticated;

  v := public.revoke_role(v_prog, v_evy, v_dir);
  perform public.sysadmin_assert(v->>'ok' = 'true',
    format('C1 the administrator demotes the co-director (%s)', coalesce(v->>'message', 'no message')));
  reset role;

  select roles, active into v_role, v_bool
    from public.memberships where user_id = v_evy and ensemble_id = v_prog;
  perform public.sysadmin_assert(v_role = '{student}'::public.app_role[],
    format('C2 the demoted member is left as a student (roles = %s)', v_role));
  perform public.sysadmin_assert(v_bool,
    'C2 …and stays on the roster rather than being removed');

  -- The demotion is effective on the next request, not just in the table.
  perform set_config('request.jwt.claims', '{"sub":"sys-evy","role":"authenticated"}', true);
  set role authenticated;
  v := public.my_permissions(v_prog);
  perform public.sysadmin_assert(not ((v->'permissions') @> '["roles.assign","roles.revoke"]'::jsonb),
    'C3 the demoted member has lost the director capabilities');
  reset role;

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform public.sysadmin_assert(
    exists (
      select 1 from public.audit_logs
       where action = 'role.revoke'
         and ensemble_id = v_prog
         and target_user_id = v_evy
         and actor_id = 'dddddddd-0000-4000-8000-000000000004'
    ),
    'C4 the demotion is audited against the administrator who did it');

  -- Doing it twice is refused with a readable message, never a silent success.
  perform set_config('request.jwt.claims', '{"sub":"sys-admin","role":"authenticated"}', true);
  set role authenticated;
  v := public.revoke_role(v_prog, v_evy, v_dir);
  perform public.sysadmin_assert(v->>'ok' = 'false', 'C5 a second demotion is refused');
  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- D. Removing a director, but never orphaning the program
-- ---------------------------------------------------------------------------
do $$
declare
  v_prog uuid := 'dddddddd-0000-4000-8000-0000000000a1';
  v_dir  uuid;
  v      jsonb;
begin
  select id into v_dir from public.roles where key = 'director';

  perform set_config('request.jwt.claims', '{"sub":"sys-admin","role":"authenticated"}', true);
  set role authenticated;

  v := public.remove_member(v_prog, 'dddddddd-0000-4000-8000-000000000002');
  perform public.sysadmin_assert(v->>'ok' = 'true',
    'D1 the administrator removes a director from the roster');
  reset role;

  perform public.sysadmin_assert(
    not exists (
      select 1 from public.memberships
       where user_id = 'dddddddd-0000-4000-8000-000000000002' and ensemble_id = v_prog
    ),
    'D1 the removed director''s membership is gone');

  -- Superuser status is not a licence to leave a program with no director.
  perform set_config('request.jwt.claims', '{"sub":"sys-admin","role":"authenticated"}', true);
  set role authenticated;
  v := public.revoke_role(v_prog, 'dddddddd-0000-4000-8000-000000000001', v_dir);
  perform public.sysadmin_assert(v->>'ok' = 'false',
    'D2 the only remaining director still cannot be stripped');
  reset role;

  perform public.sysadmin_assert(
    not exists (
      select 1 from public.memberships where user_id = 'dddddddd-0000-4000-8000-000000000004'
    ),
    'D3 administering a program does not quietly add the administrator to it');
end
$$;

-- ---------------------------------------------------------------------------
-- E. System administrator status is still not assignable from the app
-- ---------------------------------------------------------------------------
do $$
declare
  v_prog uuid := 'dddddddd-0000-4000-8000-0000000000a1';
  v_sys  uuid;
  v      jsonb;
begin
  select id into v_sys from public.roles where key = 'system_admin';

  perform set_config('request.jwt.claims', '{"sub":"sys-admin","role":"authenticated"}', true);
  set role authenticated;
  v := public.assign_role(v_prog, 'dddddddd-0000-4000-8000-000000000005', v_sys);
  perform public.sysadmin_assert(v->>'ok' = 'false',
    'E1 even an administrator cannot hand out system administrator status from the app');
  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- F. A plain student gains nothing from any of it
-- ---------------------------------------------------------------------------
do $$
declare
  v_prog uuid := 'dddddddd-0000-4000-8000-0000000000a1';
  v_dir  uuid;
  v      jsonb;
begin
  insert into public.memberships (user_id, ensemble_id, roles, active)
  values ('dddddddd-0000-4000-8000-000000000005', v_prog, '{student}'::public.app_role[], true)
  on conflict (user_id, ensemble_id) do nothing;

  select id into v_dir from public.roles where key = 'director';

  perform set_config('request.jwt.claims', '{"sub":"sys-student","role":"authenticated"}', true);
  set role authenticated;

  v := public.revoke_role(v_prog, 'dddddddd-0000-4000-8000-000000000001', v_dir);
  perform public.sysadmin_assert(v->>'ok' = 'false', 'F1 a student cannot revoke roles');
  v := public.remove_member(v_prog, 'dddddddd-0000-4000-8000-000000000001');
  perform public.sysadmin_assert(v->>'ok' = 'false', 'F2 a student cannot remove members');
  reset role;
end
$$;

reset role;

rollback;

select 'SYSTEM ADMIN PASSED' as verification_result;
