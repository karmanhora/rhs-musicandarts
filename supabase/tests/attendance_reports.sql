-- ============================================================================
-- attendance_reports.sql — exportable attendance report rows
-- ============================================================================
-- requires-function: public.attendance_report_rows
--
-- Covers migration 20261020114000. One transaction, ROLLED BACK.
--
-- Asserts:
--   A  a director gets one row per event and student, with no duplicates
--   B  a missing attendance record is "not_recorded", never "absent"
--   C  past events only by default; an explicitly named future event is allowed
--   D  archived events are excluded
--   E  every filter (event, date range, student, section, status, requirement)
--      is applied server-side and narrows correctly
--   F  the total and truncation flags describe the filtered set
--   G  the payload contains no address, auth id, excuse reason or staff note
--   H  unauthorized roles are refused by the server
--   I  the capability is delegable: a director can let a secretary export
--   J  another program's data never appears
--   K  invalid filter values are refused, not ignored
--
-- On success: ATTENDANCE REPORTS PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.attendance_report_rows(uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, integer)') is null then
    raise exception 'FAIL: RP-0 attendance_report_rows() missing — apply 20261020114000 first';
  end if;
end
$$;

create or replace function public.rp_assert(condition boolean, label text)
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
insert into public.ensembles (id, slug, name, active) values
  ('54000000-0000-4000-8000-0000000000a1', 'rp-a', 'RP Program A', true),
  ('54000000-0000-4000-8000-0000000000b1', 'rp-b', 'RP Program B', true);

insert into public.sections (id, ensemble_id, name, sort_order) values
  ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-0000000000a1', 'RP Violin', 1),
  ('54000000-0000-4000-8000-0000000000c2', '54000000-0000-4000-8000-0000000000a1', 'RP Trumpet', 2);

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('54000000-0000-4000-8000-000000000001', 'rp-dir',   'RP Director', 'RP Director'),
  ('54000000-0000-4000-8000-000000000002', 'rp-sec',   'RP Secretary', 'RP Secretary'),
  ('54000000-0000-4000-8000-000000000003', 'rp-lead',  'RP Leader', 'RP Leader'),
  ('54000000-0000-4000-8000-000000000004', 'rp-stu1',  'RP Student One', ''),
  ('54000000-0000-4000-8000-000000000005', 'rp-stu2',  'RP Student Two', ''),
  ('54000000-0000-4000-8000-000000000006', 'rp-out',   'RP Outsider', 'RP Outsider'),
  ('54000000-0000-4000-8000-000000000007', 'rp-dir-b', 'RP Director B', 'RP Director B');

insert into public.events
  (id, ensemble_id, name, type, event_type, date, checkin_mode, attendance_requirement, archived)
values
  ('54000000-0000-4000-8000-000000000101', '54000000-0000-4000-8000-0000000000a1',
   'RP Required Past', 'Rehearsal', 'rehearsal', now() - interval '2 days', 'toggle', 'required', false),
  ('54000000-0000-4000-8000-000000000102', '54000000-0000-4000-8000-0000000000a1',
   'RP Optional Past', 'Fundraiser', 'fundraiser', now() - interval '3 days', 'toggle', 'optional', false),
  ('54000000-0000-4000-8000-000000000103', '54000000-0000-4000-8000-0000000000a1',
   'RP No Attendance', 'Other', 'other', now() - interval '4 days', 'none', 'none', false),
  ('54000000-0000-4000-8000-000000000104', '54000000-0000-4000-8000-0000000000a1',
   'RP Required Future', 'Rehearsal', 'rehearsal', now() + interval '1 day', 'qr', 'required', false),
  ('54000000-0000-4000-8000-000000000105', '54000000-0000-4000-8000-0000000000a1',
   'RP Archived Past', 'Rehearsal', 'rehearsal', now() - interval '5 days', 'toggle', 'required', true);

insert into public.memberships (user_id, ensemble_id, section_id, roles, active) values
  ('54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-0000000000a1', null, '{director}', true),
  ('54000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-0000000000a1', null, '{secretary}', true),
  ('54000000-0000-4000-8000-000000000003', '54000000-0000-4000-8000-0000000000a1', '54000000-0000-4000-8000-0000000000c1', '{section_leader}', true),
  ('54000000-0000-4000-8000-000000000004', '54000000-0000-4000-8000-0000000000a1', '54000000-0000-4000-8000-0000000000c1', '{student}', true),
  ('54000000-0000-4000-8000-000000000005', '54000000-0000-4000-8000-0000000000a1', '54000000-0000-4000-8000-0000000000c2', '{student}', true),
  ('54000000-0000-4000-8000-000000000007', '54000000-0000-4000-8000-0000000000b1', null, '{director}', true);

insert into public.attendance_records (event_id, student_id, attended, status, is_late, checked_in_at, excuse_reason)
values
  ('54000000-0000-4000-8000-000000000101', '54000000-0000-4000-8000-000000000004',
   true, 'present', false, now() - interval '2 days', ''),
  ('54000000-0000-4000-8000-000000000102', '54000000-0000-4000-8000-000000000004',
   true, 'late', true, now() - interval '3 days', ''),
  ('54000000-0000-4000-8000-000000000101', '54000000-0000-4000-8000-000000000005',
   false, 'excused', false, null, 'A private medical detail');
insert into public.attendance_staff_notes (attendance_record_id, staff_note, created_by)
select ar.id, 'A private staff note', '54000000-0000-4000-8000-000000000001'
  from public.attendance_records ar
 where ar.event_id = '54000000-0000-4000-8000-000000000101'
   and ar.student_id = '54000000-0000-4000-8000-000000000004';

-- ---------------------------------------------------------------------------
-- A / B / C / D. The whole report
-- ---------------------------------------------------------------------------
do $$
declare
  v       jsonb;
  v_rows  jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"rp-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.rp_assert(v->>'ok' = 'true', 'A the director gets a report');
  v_rows := v->'rows';

  -- 4 measured members (secretary, section leader, two students) × 3 past,
  -- non-archived events. A director is never measured, exactly like the roll.
  perform public.rp_assert((v->>'total')::int = 12, 'A twelve rows for four members and three events');
  perform public.rp_assert(jsonb_array_length(v_rows) = 12, 'A every row is returned');

  perform public.rp_assert(
    (select count(distinct (r->>'event_id') || '|' || (r->>'student_id')) from jsonb_array_elements(v_rows) r) = 12,
    'A every (event, student) pair appears exactly once'
  );

  -- B
  perform public.rp_assert(
    (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'absent') = 0,
    'B no missing record is labelled absent'
  );
  perform public.rp_assert(
    (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'not_recorded') = 9,
    'B nine rows are explicitly not recorded'
  );
  perform public.rp_assert(
    (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'excused') = 1
    and (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'late') = 1
    and (select count(*) from jsonb_array_elements(v_rows) r where r->>'status' = 'present') = 1,
    'B present, late and excused are distinguished where they exist'
  );

  -- C / D
  perform public.rp_assert(
    (select count(*) from jsonb_array_elements(v_rows) r
      where r->>'event_id' = '54000000-0000-4000-8000-000000000104') = 0,
    'C a future event is not in a report of what happened'
  );
  perform public.rp_assert(
    (select count(*) from jsonb_array_elements(v_rows) r
      where r->>'event_id' = '54000000-0000-4000-8000-000000000105') = 0,
    'D an archived event is excluded'
  );

  -- Timezone/format: the row's date is the event's own instant.
  perform public.rp_assert(
    (select (r->>'event_date')::timestamptz from jsonb_array_elements(v_rows) r
      where r->>'event_id' = '54000000-0000-4000-8000-000000000101' limit 1) =
    (select date from public.events where id = '54000000-0000-4000-8000-000000000101'),
    'A the event date is the stored instant, formatted by the client'
  );

  -- B: an explicitly named future event shows its unrecorded rows.
  perform set_config('request.jwt.claims', '{"sub":"rp-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1',
    '54000000-0000-4000-8000-000000000104');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform public.rp_assert((v->>'total')::int = 4
    and (select count(*) from jsonb_array_elements(v->'rows') r where r->>'status' = 'not_recorded') = 4,
    'C an explicitly requested future event is reported as unrecorded');
end
$$;

-- ---------------------------------------------------------------------------
-- E / F. Filters and paging
-- ---------------------------------------------------------------------------
do $$
declare
  v         jsonb;
  v_from    timestamptz;
  v_to      timestamptz;
begin
  select date - interval '1 hour', date + interval '4 hours'
    into v_from, v_to
    from public.events where id = '54000000-0000-4000-8000-000000000101';

  perform set_config('request.jwt.claims', '{"sub":"rp-dir","role":"authenticated"}', true);
  set role authenticated;

  -- Event
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1',
    '54000000-0000-4000-8000-000000000101');
  perform public.rp_assert((v->>'total')::int = 4
    and (select count(*) from jsonb_array_elements(v->'rows') r
          where r->>'event_id' <> '54000000-0000-4000-8000-000000000101') = 0,
    'E the event filter narrows to that event');

  -- Date range (over the required event's own day)
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1', null, v_from, v_to);
  perform public.rp_assert((v->>'total')::int = 4,
    'E the date range applies consistently');
  perform public.rp_assert(
    (select count(*) from jsonb_array_elements(v->'rows') r
      where (r->>'event_date')::timestamptz < v_from
         or (r->>'event_date')::timestamptz >= v_to) = 0,
    'E no row falls outside the requested range'
  );

  -- Student
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1', null, null, null,
    '54000000-0000-4000-8000-000000000005');
  perform public.rp_assert((v->>'total')::int = 3
    and (select count(*) from jsonb_array_elements(v->'rows') r
          where r->>'student_id' <> '54000000-0000-4000-8000-000000000005') = 0,
    'E the student filter narrows to that student');

  -- Section
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1', null, null, null, null,
    '54000000-0000-4000-8000-0000000000c1');
  perform public.rp_assert((v->>'total')::int = 6
    and (select count(*) from jsonb_array_elements(v->'rows') r
          where r->>'section' <> 'RP Violin') = 0,
    'E the section filter narrows to that section');

  -- Status
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1', null, null, null, null, null, 'not_recorded');
  perform public.rp_assert((v->>'total')::int = 9
    and (select count(*) from jsonb_array_elements(v->'rows') r
          where r->>'status' <> 'not_recorded') = 0,
    'E the status filter selects only that status');

  -- Requirement
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, 'optional');
  perform public.rp_assert((v->>'total')::int = 4
    and (select count(*) from jsonb_array_elements(v->'rows') r
          where r->>'attendance_requirement' <> 'optional') = 0,
    'E the requirement filter narrows to that classification');

  -- Total describes the filtered set, not the page.
  v := public.attendance_report_rows(
    '54000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, null, 2);
  perform public.rp_assert((v->>'total')::int = 12, 'F the total is the filtered count');
  perform public.rp_assert((v->>'returned')::int = 2 and (v->>'truncated')::boolean,
    'F a smaller limit reports the truncation honestly');

  -- K
  perform public.rp_assert(
    (public.attendance_report_rows(
      '54000000-0000-4000-8000-0000000000a1', null, null, null, null, null, 'unknown') ->> 'ok') = 'false',
    'K an invalid status is refused');
  perform public.rp_assert(
    (public.attendance_report_rows(
      '54000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, 'special') ->> 'ok') = 'false',
    'K an invalid requirement is refused');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- G. No sensitive field, and a stable short student reference
-- ---------------------------------------------------------------------------
do $$
declare
  v      jsonb;
  v_keys text;
begin
  perform set_config('request.jwt.claims', '{"sub":"rp-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  select string_agg(k, ',') into v_keys
    from jsonb_object_keys(v->'rows'->0) k;

  perform public.rp_assert(v_keys not like '%email%', 'G no email address is exposed');
  perform public.rp_assert(v_keys not like '%auth_user_id%', 'G no auth id is exposed');
  perform public.rp_assert(v_keys not like '%excuse_reason%', 'G no excuse reason is exposed');
  perform public.rp_assert(v_keys not like '%staff_note%', 'G no staff note is exposed');
  perform public.rp_assert(v_keys not like '%marked_by%', 'G no marker identity is exposed');

  perform public.rp_assert(
    (select length(r->>'student_ref') from jsonb_array_elements(v->'rows') r limit 1) = 8,
    'G the student reference is a short, non-identifying code');
  perform public.rp_assert(
    (select r->>'student_ref' <> r->>'student_id' from jsonb_array_elements(v->'rows') r limit 1),
    'G the reference is not the raw uuid');
  perform public.rp_assert(
    not exists (
      select 1 from jsonb_array_elements(v->'rows') r
       where r->>'student_ref' ilike '%@%'
    ),
    'G the reference is not an address'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- H / I / J. Authorization, delegation, isolation
-- ---------------------------------------------------------------------------
do $$
declare
  v      jsonb;
  v_role uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"rp-sec","role":"authenticated"}', true);
  set role authenticated;
  perform public.rp_assert(
    (public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'H a secretary cannot export by default');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"rp-lead","role":"authenticated"}', true);
  set role authenticated;
  perform public.rp_assert(
    (public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'H a section leader cannot export');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"rp-stu1","role":"authenticated"}', true);
  set role authenticated;
  perform public.rp_assert(
    (public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'H a student cannot export');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"rp-dir-b","role":"authenticated"}', true);
  set role authenticated;
  perform public.rp_assert(
    (public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'H another program''s director cannot export this program');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"rp-out","role":"authenticated"}', true);
  set role authenticated;
  perform public.rp_assert(
    (public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'H somebody on no roster cannot export');
  reset role;

  perform set_config('request.jwt.claims', '{}', true);

  -- I: the capability is delegable on purpose.
  perform set_config('request.jwt.claims', '{"sub":"rp-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.create_custom_role(
    '54000000-0000-4000-8000-0000000000a1',
    'Report runner', 'Pulls attendance reports',
    array['attendance.export_reports'], 'program');
  perform public.rp_assert(v->>'ok' = 'true', 'I a director can delegate report export');
  v_role := (v->>'role_id')::uuid;
  perform public.rp_assert(
    (public.assign_role(
      '54000000-0000-4000-8000-0000000000a1',
      '54000000-0000-4000-8000-000000000002',
      v_role, null)->>'ok') = 'true',
    'I the role is assigned to the secretary');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"rp-sec","role":"authenticated"}', true);
  set role authenticated;
  v := public.attendance_report_rows('54000000-0000-4000-8000-0000000000a1');
  perform public.rp_assert(v->>'ok' = 'true', 'I the delegated secretary can export');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- J: a program with no events yields nothing, never another program's rows.
  perform set_config('request.jwt.claims', '{"sub":"rp-dir-b","role":"authenticated"}', true);
  set role authenticated;
  v := public.attendance_report_rows('54000000-0000-4000-8000-0000000000b1');
  perform public.rp_assert(v->>'ok' = 'true' and (v->>'total')::int = 0
    and jsonb_array_length(v->'rows') = 0,
    'J the other program''s report is empty and contains nothing from program A');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

rollback;

select 'ATTENDANCE REPORTS PASSED' as verification_result;
