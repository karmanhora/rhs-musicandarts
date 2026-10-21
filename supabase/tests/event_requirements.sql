-- ============================================================================
-- event_requirements.sql — required / optional / excluded event classification
-- ============================================================================
-- requires-table: public.attendance_requirement is a column, so gate on the
-- function this suite is really about.
--
-- Covers migration 20261020111000. One transaction, ROLLED BACK.
--
-- Asserts:
--   A  the director sees a required average, optional turnout and excluded count
--      with the calculation basis spelled out
--   B  the required average counts present/late, drops excused from the
--      denominator and does not average in a program with no required events
--   C  optional events never change the required rate
--   D  a missing attendance row is reported as unrecorded, never as "absent"
--   E  the trend names each event's requirement
--   F  re-classifying an event rewrites no attendance and no audit history
--   G  only authorized staff may change a requirement; students cannot
--   H  non-directors, another program's director and non-members are refused
--
-- On success: EVENT REQUIREMENTS PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.get_event_requirement_stats(uuid)') is null then
    raise exception 'FAIL: ER-0 get_event_requirement_stats() missing — apply 20261020111000 first';
  end if;
end
$$;

create or replace function public.er_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into public.ensembles (id, slug, name, short_name, active) values
  ('42000000-0000-4000-8000-0000000000a1', 'er-a', 'ER Program A', 'ER A', true),
  ('42000000-0000-4000-8000-0000000000b1', 'er-b', 'ER Program B', 'ER B', true);

insert into public.sections (id, ensemble_id, name, sort_order) values
  ('42000000-0000-4000-8000-0000000000c1', '42000000-0000-4000-8000-0000000000a1', 'ER Violin', 1),
  ('42000000-0000-4000-8000-0000000000c2', '42000000-0000-4000-8000-0000000000a1', 'ER Trumpet', 2);

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('42000000-0000-4000-8000-000000000001', 'er-dir',   'ER Director', 'ER Director'),
  ('42000000-0000-4000-8000-000000000002', 'er-sec',   'ER Secretary', 'ER Secretary'),
  ('42000000-0000-4000-8000-000000000003', 'er-stu1',  'ER Student One', ''),
  ('42000000-0000-4000-8000-000000000004', 'er-stu2',  'ER Student Two', ''),
  ('42000000-0000-4000-8000-000000000005', 'er-dir-b', 'ER Director B', 'ER Director B'),
  ('42000000-0000-4000-8000-000000000006', 'er-out',   'ER Outsider', 'ER Outsider');

insert into public.memberships (user_id, ensemble_id, section_id, roles, active) values
  ('42000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-0000000000a1', null, '{director}', true),
  ('42000000-0000-4000-8000-000000000002', '42000000-0000-4000-8000-0000000000a1', null, '{secretary}', true),
  ('42000000-0000-4000-8000-000000000003', '42000000-0000-4000-8000-0000000000a1', '42000000-0000-4000-8000-0000000000c1', '{student}', true),
  ('42000000-0000-4000-8000-000000000004', '42000000-0000-4000-8000-0000000000a1', '42000000-0000-4000-8000-0000000000c2', '{student}', true),
  ('42000000-0000-4000-8000-000000000005', '42000000-0000-4000-8000-0000000000b1', null, '{director}', true);

-- Events. The new-event trigger fans out to the roster as it exists at insert
-- time; this suite asserts nothing about those notifications, and the rollback
-- removes them.
insert into public.events
  (id, ensemble_id, name, type, event_type, date, checkin_mode, attendance_requirement, archived)
values
  ('42000000-0000-4000-8000-000000000101', '42000000-0000-4000-8000-0000000000a1',
   'ER Required Past', 'Rehearsal', 'rehearsal', now() - interval '2 days', 'toggle', 'required', false),
  ('42000000-0000-4000-8000-000000000102', '42000000-0000-4000-8000-0000000000a1',
   'ER Optional Past', 'Fundraiser', 'fundraiser', now() - interval '3 days', 'toggle', 'optional', false),
  ('42000000-0000-4000-8000-000000000103', '42000000-0000-4000-8000-0000000000a1',
   'ER No Attendance', 'Other', 'other', now() - interval '4 days', 'none', 'none', false),
  ('42000000-0000-4000-8000-000000000104', '42000000-0000-4000-8000-0000000000a1',
   'ER Required Future', 'Rehearsal', 'rehearsal', now() + interval '1 day', 'qr', 'required', false),
  ('42000000-0000-4000-8000-000000000105', '42000000-0000-4000-8000-0000000000a1',
   'ER Archived Required', 'Rehearsal', 'rehearsal', now() - interval '5 days', 'toggle', 'required', true);

-- Attendance: one present, one late, one excused. Nothing at all for the
-- future event — that is the "unrecorded" case.
insert into public.attendance_records (event_id, student_id, attended, status, is_late, checked_in_at)
values
  ('42000000-0000-4000-8000-000000000101', '42000000-0000-4000-8000-000000000003', true,  'present', false, now() - interval '2 days'),
  ('42000000-0000-4000-8000-000000000102', '42000000-0000-4000-8000-000000000003', true,  'late',    true,  now() - interval '3 days'),
  ('42000000-0000-4000-8000-000000000101', '42000000-0000-4000-8000-000000000004', false, 'excused', false, null);

-- ---------------------------------------------------------------------------
-- A / B / C. The breakdown, and what each number means
-- ---------------------------------------------------------------------------
do $$
declare
  v   jsonb;
  v_a uuid := '42000000-0000-4000-8000-0000000000a1';
begin
  perform set_config('request.jwt.claims', '{"sub":"er-dir","role":"authenticated"}', true);
  set role authenticated;

  v := public.get_event_requirement_stats(v_a);

  perform public.er_assert(v->>'ok' = 'true', 'A director gets a breakdown');
  perform public.er_assert((v->>'required_events')::int = 1, 'A one past required event is counted');
  perform public.er_assert((v->>'optional_events')::int = 1, 'A one past optional event is counted');
  perform public.er_assert((v->>'excluded_events')::int = 1, 'A the no-attendance event is counted as excluded');
  -- The measured roster is every active member who is not a director — the same
  -- rule the roll and every existing analytics RPC use (a secretary is on it).
  perform public.er_assert((v->>'students')::int = 3, 'A three non-director members are measured');
  perform public.er_assert((v->>'required_average_pct')::int = 33,
    'B required average is 100, 0 and 0 rounded to 33 (excused leaves no denominator)');
  perform public.er_assert((v->>'optional_turnout_pct')::int = 33,
    'C optional turnout is 1 attended of 3 possible marks');
  perform public.er_assert(v->>'basis' like '%excused absence is left out%'
    and v->>'basis' like '%never change the required rate%',
    'A the answer states which events and statuses it includes');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- C: the optional event is not in the required count, and the required rate
  --    is unchanged when the optional event's attendance changes. (Writes are
  --    superuser here: clients have no UPDATE grant on attendance_records.)
  update public.attendance_records
     set status = 'excused', attended = false, is_late = false
   where event_id = '42000000-0000-4000-8000-000000000102'
     and student_id = '42000000-0000-4000-8000-000000000003';

  perform set_config('request.jwt.claims', '{"sub":"er-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.get_event_requirement_stats(v_a);
  perform public.er_assert((v->>'required_average_pct')::int = 33,
    'C an optional event''s marks never move the required rate');
  perform public.er_assert((v->>'optional_turnout_pct')::int = 0,
    'C optional turnout does move on its own, separately');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- B: with no required past events the average is null, not a fake 0%.
  update public.events set attendance_requirement = 'optional'
   where id = '42000000-0000-4000-8000-000000000101';

  perform set_config('request.jwt.claims', '{"sub":"er-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.get_event_requirement_stats(v_a);
  perform public.er_assert(v->'required_average_pct' = 'null'::jsonb,
    'B no required events means no required average');
  perform public.er_assert((v->>'required_events')::int = 0, 'B the required count is honest');
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
  update public.events set attendance_requirement = 'required'
   where id = '42000000-0000-4000-8000-000000000101';

  -- H: not a director, another program, or not on a roster at all.
  perform set_config('request.jwt.claims', '{"sub":"er-sec","role":"authenticated"}', true);
  set role authenticated;
  perform public.er_assert((public.get_event_requirement_stats(v_a)->>'ok') = 'false',
    'H a secretary without analytics is refused');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"er-dir-b","role":"authenticated"}', true);
  set role authenticated;
  perform public.er_assert((public.get_event_requirement_stats(v_a)->>'ok') = 'false',
    'H another program''s director is refused');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"er-out","role":"authenticated"}', true);
  set role authenticated;
  perform public.er_assert((public.get_event_requirement_stats(v_a)->>'ok') = 'false',
    'H somebody on no roster is refused');
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- D. Missing rows are not "absent"
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"er-dir","role":"authenticated"}', true);
  set role authenticated;

  v := public.get_event_attendance_summary('42000000-0000-4000-8000-000000000104');
  perform public.er_assert(v->>'ok' = 'true', 'D the future event summary answers');
  perform public.er_assert((v->>'unrecorded')::int = 3, 'D all three non-director members are unrecorded');
  perform public.er_assert((v->>'absent')::int = 0, 'D nobody is reported absent from a missing row');
  perform public.er_assert((v->>'total')::int = 3, 'D the roster total is still reported');
  perform public.er_assert(v->>'attendance_requirement' = 'required',
    'D the summary says how the event counts');
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- E. Trend rows carry the requirement
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"er-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.get_attendance_trend('42000000-0000-4000-8000-0000000000a1', 10);
  perform public.er_assert(jsonb_typeof(v) = 'array', 'E the trend answers with rows');
  perform public.er_assert(
    (select count(*) from jsonb_array_elements(v) e
      where e->>'attendance_requirement' = 'required') = jsonb_array_length(v),
    'E every trend row names its requirement'
  );
  perform public.er_assert(jsonb_array_length(v) = 1,
    'E only the non-archived past required event is in the trend');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"er-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.my_attendance_trend('42000000-0000-4000-8000-0000000000a1', 10);
  perform public.er_assert(
    (select count(*) from jsonb_array_elements(v) e
      where e->>'attendance_requirement' = 'required') = jsonb_array_length(v),
    'E a student''s own trend also names the requirement'
  );
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- F. Re-classification rewrites no attendance and no history
-- ---------------------------------------------------------------------------
do $$
declare
  v_before   jsonb;
  v_after    jsonb;
  v_audit    int;
  v_rows     int;
begin
  select jsonb_agg(jsonb_build_object('e', event_id, 's', student_id, 'st', status, 'l', is_late))
    into v_before
    from public.attendance_records
   where event_id in (
     '42000000-0000-4000-8000-000000000101',
     '42000000-0000-4000-8000-000000000102'
   );

  select count(*) into v_audit from public.attendance_audit;
  select count(*) into v_rows from public.attendance_records;

  perform set_config('request.jwt.claims', '{"sub":"er-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events
     set attendance_requirement = 'optional'
   where id = '42000000-0000-4000-8000-000000000101';
  reset role;

  perform set_config('request.jwt.claims', '{}', true);

  select jsonb_agg(jsonb_build_object('e', event_id, 's', student_id, 'st', status, 'l', is_late))
    into v_after
    from public.attendance_records
   where event_id in (
     '42000000-0000-4000-8000-000000000101',
     '42000000-0000-4000-8000-000000000102'
   );

  perform public.er_assert(v_before = v_after, 'F re-classification changed no attendance row');
  perform public.er_assert((select count(*) from public.attendance_records) = v_rows,
    'F no attendance row was created or removed');
  perform public.er_assert((select count(*) from public.attendance_audit) = v_audit,
    'F no audit entry was fabricated by re-classification');

  update public.events set attendance_requirement = 'required'
   where id = '42000000-0000-4000-8000-000000000101';
end
$$;

-- ---------------------------------------------------------------------------
-- G. Who may change a requirement
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  -- A student's UPDATE is filtered by RLS: zero rows, no error.
  perform set_config('request.jwt.claims', '{"sub":"er-stu1","role":"authenticated"}', true);
  set role authenticated;
  update public.events set attendance_requirement = 'optional'
   where id = '42000000-0000-4000-8000-000000000104';
  get diagnostics n = row_count;
  perform public.er_assert(n = 0, 'G a student cannot change an event requirement');
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
  perform public.er_assert(
    (select attendance_requirement = 'required' from public.events
      where id = '42000000-0000-4000-8000-000000000104'),
    'G the requirement is unchanged after the refused update'
  );

  -- A secretary holds attendance.manage_events, so staff may classify an event.
  perform set_config('request.jwt.claims', '{"sub":"er-sec","role":"authenticated"}', true);
  set role authenticated;
  update public.events set attendance_requirement = 'optional'
   where id = '42000000-0000-4000-8000-000000000104';
  get diagnostics n = row_count;
  perform public.er_assert(n = 1, 'G authorized program staff may classify an event');
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
  update public.events set attendance_requirement = 'required'
   where id = '42000000-0000-4000-8000-000000000104';
end
$$;

rollback;

select 'EVENT REQUIREMENTS PASSED' as verification_result;
