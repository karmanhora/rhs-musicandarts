-- Program archiving hides it from new joins without deleting historical data.
begin;

do $$
begin
  if to_regprocedure('public.set_program_active(uuid, boolean)') is null then
    raise exception 'FAIL: AP-0 set_program_active() missing — apply migration 026 first';
  end if;
  if has_function_privilege('anon', 'public.set_program_active(uuid, boolean)', 'execute') then
    raise exception 'FAIL: AP-0a anon can call set_program_active()';
  end if;
  if not has_function_privilege('authenticated', 'public.set_program_active(uuid, boolean)', 'execute') then
    raise exception 'FAIL: AP-0b authenticated cannot call set_program_active()';
  end if;
end
$$;

insert into public.profiles (id, auth_user_id, full_name, display_name)
values
  ('02600000-0000-4000-8000-000000000001', '026-director', 'Archive Director', 'Archive Director'),
  ('02600000-0000-4000-8000-000000000002', '026-student', 'Archive Student', 'Archive Student'),
  ('02600000-0000-4000-8000-000000000005', '026-admin', 'Archive Admin', 'Archive Admin');

insert into public.program_admins (user_id)
values ('02600000-0000-4000-8000-000000000005');

insert into public.ensembles (id, slug, name)
values ('02600000-0000-4000-8000-000000000003', 'archive-test-program', 'Archive Test Program');

insert into public.memberships (user_id, ensemble_id, roles)
values
  ('02600000-0000-4000-8000-000000000001', '02600000-0000-4000-8000-000000000003', '{director}'),
  ('02600000-0000-4000-8000-000000000002', '02600000-0000-4000-8000-000000000003', '{student}');

insert into public.events (id, ensemble_id, name, type, date)
values (
  '02600000-0000-4000-8000-000000000004',
  '02600000-0000-4000-8000-000000000003',
  'Archive Test Event',
  'rehearsal',
  now()
);

select set_config(
  'request.jwt.claims',
  '{"sub":"026-director","role":"authenticated"}',
  true
);
select public.set_program_active('02600000-0000-4000-8000-000000000003', false);

do $$
begin
  if (select active from public.ensembles where id = '02600000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: AP-1 director could not archive the program';
  end if;
  if not exists (select 1 from public.events where id = '02600000-0000-4000-8000-000000000004') then
    raise exception 'FAIL: AP-2 archiving deleted event history';
  end if;
  if not exists (
    select 1 from public.memberships
     where ensemble_id = '02600000-0000-4000-8000-000000000003'
       and user_id = '02600000-0000-4000-8000-000000000002'
  ) then
    raise exception 'FAIL: AP-3 archiving deleted program memberships';
  end if;
end
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"026-student","role":"authenticated"}',
  true
);

do $$
declare
  v_result jsonb;
begin
  v_result := public.set_program_active('02600000-0000-4000-8000-000000000003', true);
  if coalesce(v_result ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: AP-4 a student restored a program';
  end if;
  if (select active from public.ensembles where id = '02600000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: AP-5 refused restore changed the program';
  end if;
end
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"026-director","role":"authenticated"}',
  true
);
select public.set_program_active('02600000-0000-4000-8000-000000000003', true);

do $$
begin
  if not (select active from public.ensembles where id = '02600000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: AP-6 director could not restore the program';
  end if;
end
$$;

-- A system administrator is not on this program's roster, but the owner asked
-- for the administrator to be able to delete programs as well.
select set_config(
  'request.jwt.claims',
  '{"sub":"026-admin","role":"authenticated"}',
  true
);
select public.set_program_active('02600000-0000-4000-8000-000000000003', false);

do $$
begin
  if (select active from public.ensembles where id = '02600000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: AP-7 administrator could not archive an off-roster program';
  end if;
  if not exists (select 1 from public.events where id = '02600000-0000-4000-8000-000000000004') then
    raise exception 'FAIL: AP-8 administrator archive deleted event history';
  end if;
end
$$;

select public.set_program_active('02600000-0000-4000-8000-000000000003', true);

do $$
begin
  if not (select active from public.ensembles where id = '02600000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: AP-9 administrator could not restore the program';
  end if;
end
$$;

rollback;
select 'ARCHIVE PROGRAM PASSED' as verification_result;
