-- ============================================================================
-- absence_requests.sql — student absence requests and staff decisions
-- ============================================================================
-- requires-table: public.absence_requests
--
-- Covers migration 20261020113000. One transaction, ROLLED BACK.
--
-- Asserts:
--   A  a student submits a valid request; the program is derived from the event
--   B  a duplicate active request is refused by the database, not the UI
--   C  a student cannot review or decide, and cannot edit request rows directly
--   D  a secretary or section leader gets no review queue until a director
--      grants absence.review through a custom role
--   E  another program's director can neither list nor decide
--   F  a director sees the pending request with the student and reason
--   G  approval records the reviewer and response, notifies the student, and
--      marks the student excused on that event's roll, with an audit row that
--      says the excuse came from an approved request
--   H  a decided request blocks a new one until a reviewer allows resubmission
--   I  a pending request can be withdrawn by its owner only
--   J  reasons are bounded and required
--   K  past / archived / no-attendance events are not eligible
--   L  a student cannot read another student's request
--   M  an explicitly granted reviewer (custom role) can decide
--   N  withdrawn and decided requests cannot be decided again
--   O  an approval never overwrites a recorded mark, and a denial writes no
--      attendance at all
--
-- On success: ABSENCE REQUESTS PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.create_absence_request(uuid, text)') is null then
    raise exception 'FAIL: AB-0 create_absence_request() missing — apply 20261020113000 first';
  end if;
  if to_regprocedure('public.decide_absence_request(uuid, text, text)') is null then
    raise exception 'FAIL: AB-0 decide_absence_request() missing';
  end if;
end
$$;

create or replace function public.ab_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (events before memberships, so no new-event fan-out is involved)
-- ---------------------------------------------------------------------------
insert into public.ensembles (id, slug, name, active) values
  ('53000000-0000-4000-8000-0000000000a1', 'ab-a', 'AB Program A', true),
  ('53000000-0000-4000-8000-0000000000b1', 'ab-b', 'AB Program B', true);

insert into public.sections (id, ensemble_id, name, sort_order) values
  ('53000000-0000-4000-8000-0000000000c1', '53000000-0000-4000-8000-0000000000a1', 'AB Violin', 1),
  ('53000000-0000-4000-8000-0000000000c2', '53000000-0000-4000-8000-0000000000a1', 'AB Trumpet', 2);

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('53000000-0000-4000-8000-000000000001', 'ab-dir',   'AB Director', 'AB Director'),
  ('53000000-0000-4000-8000-000000000002', 'ab-sec',   'AB Secretary', 'AB Secretary'),
  ('53000000-0000-4000-8000-000000000003', 'ab-lead',  'AB Leader', 'AB Leader'),
  ('53000000-0000-4000-8000-000000000004', 'ab-stu1',  'AB Student One', ''),
  ('53000000-0000-4000-8000-000000000005', 'ab-stu2',  'AB Student Two', ''),
  ('53000000-0000-4000-8000-000000000006', 'ab-dir-b', 'AB Director B', 'AB Director B');

insert into public.events
  (id, ensemble_id, name, type, event_type, date, checkin_mode, attendance_requirement, archived)
values
  ('53000000-0000-4000-8000-000000000101', '53000000-0000-4000-8000-0000000000a1',
   'AB Required Tomorrow', 'Rehearsal', 'rehearsal', now() + interval '1 day', 'toggle', 'required', false),
  ('53000000-0000-4000-8000-000000000102', '53000000-0000-4000-8000-0000000000a1',
   'AB Optional Next Week', 'Fundraiser', 'fundraiser', now() + interval '7 days', 'toggle', 'optional', false),
  ('53000000-0000-4000-8000-000000000103', '53000000-0000-4000-8000-0000000000a1',
   'AB No Attendance', 'Other', 'other', now() + interval '3 days', 'none', 'none', false),
  ('53000000-0000-4000-8000-000000000104', '53000000-0000-4000-8000-0000000000a1',
   'AB Already Happened', 'Rehearsal', 'rehearsal', now() - interval '1 day', 'toggle', 'required', false),
  ('53000000-0000-4000-8000-000000000105', '53000000-0000-4000-8000-0000000000a1',
   'AB Archived Future', 'Rehearsal', 'rehearsal', now() + interval '2 days', 'toggle', 'required', true),
  ('53000000-0000-4000-8000-000000000106', '53000000-0000-4000-8000-0000000000a1',
   'AB Denial Event', 'Rehearsal', 'rehearsal', now() + interval '5 days', 'toggle', 'required', false);

insert into public.memberships (user_id, ensemble_id, section_id, roles, active) values
  ('53000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-0000000000a1', null, '{director}', true),
  ('53000000-0000-4000-8000-000000000002', '53000000-0000-4000-8000-0000000000a1', null, '{secretary}', true),
  ('53000000-0000-4000-8000-000000000003', '53000000-0000-4000-8000-0000000000a1', '53000000-0000-4000-8000-0000000000c1', '{section_leader}', true),
  ('53000000-0000-4000-8000-000000000004', '53000000-0000-4000-8000-0000000000a1', '53000000-0000-4000-8000-0000000000c1', '{student}', true),
  ('53000000-0000-4000-8000-000000000005', '53000000-0000-4000-8000-0000000000a1', '53000000-0000-4000-8000-0000000000c2', '{student}', true),
  ('53000000-0000-4000-8000-000000000006', '53000000-0000-4000-8000-0000000000b1', null, '{director}', true);

-- ---------------------------------------------------------------------------
-- A / B / C. Submit, duplicate, and the student's own limits
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_request uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;

  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000101',
    '  Family trip to Portland.  ');
  perform public.ab_assert(v->>'ok' = 'true', 'A a student can submit a valid request');
  v_request := (v->>'request_id')::uuid;

  -- B: the partial unique index refuses a second active request.
  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000101',
    'Trying again');
  perform public.ab_assert(v->>'ok' = 'false' and v->>'message' like '%already have a request%',
    'B a duplicate active request is refused with a clear message');

  -- C: a student has no review surface.
  perform public.ab_assert(
    (public.list_absence_requests('53000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'C a student cannot list the review queue'
  );
  perform public.ab_assert(
    (public.decide_absence_request(v_request, 'approved', 'self-approval') ->> 'ok') = 'false',
    'C a student cannot approve their own request'
  );

  -- C: and cannot edit the row directly.
  begin
    update public.absence_requests set status = 'approved' where id = v_request;
    raise exception 'FAIL: C a student updated a request row directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.absence_requests (ensemble_id, event_id, student_id, reason)
    values ('53000000-0000-4000-8000-0000000000a1',
            '53000000-0000-4000-8000-000000000101',
            '53000000-0000-4000-8000-000000000004', 'direct insert');
    raise exception 'FAIL: C a student inserted a request row directly';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.absence_requests where id = v_request;
    raise exception 'FAIL: C a student deleted a request row directly';
  exception when insufficient_privilege then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ab_assert(
    (select count(*) from public.absence_requests
      where event_id = '53000000-0000-4000-8000-000000000101'
        and student_id = '53000000-0000-4000-8000-000000000004') = 1,
    'B only one request row exists'
  );
  perform public.ab_assert(
    (select status = 'pending' and ensemble_id = '53000000-0000-4000-8000-0000000000a1'
            and reason = 'Family trip to Portland.'
       from public.absence_requests
      where event_id = '53000000-0000-4000-8000-000000000101'
        and student_id = '53000000-0000-4000-8000-000000000004'),
    'A the request is pending, in the event''s program, with a trimmed reason'
  );

  -- A: only the director is asked to review — not the secretary, not the
  -- section leader, and not the student herself.
  perform public.ab_assert(
    (select count(*) from public.notifications
      where user_id = '53000000-0000-4000-8000-000000000001'
        and type = 'absence_request') = 1,
    'A the director is notified of the new request'
  );
  perform public.ab_assert(
    (select count(*) from public.notifications
      where user_id in ('53000000-0000-4000-8000-000000000002',
                        '53000000-0000-4000-8000-000000000003',
                        '53000000-0000-4000-8000-000000000004')
        and type = 'absence_request') = 0,
    'D the secretary, section leader and student are not asked to review by default'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- D / E. Who is refused
-- ---------------------------------------------------------------------------
do $$
declare
  v_request uuid;
begin
  select id into v_request from public.absence_requests where student_id = '53000000-0000-4000-8000-000000000004';

  perform set_config('request.jwt.claims', '{"sub":"ab-sec","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.list_absence_requests('53000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'D a secretary cannot review without absence.review'
  );
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"ab-lead","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.list_absence_requests('53000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'D a section leader cannot review without absence.review'
  );
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"ab-dir-b","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.list_absence_requests('53000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'E another program''s director cannot list this program''s requests'
  );
  perform public.ab_assert(
    (public.decide_absence_request(v_request, 'approved', 'not mine') ->> 'ok') = 'false',
    'E another program''s director cannot decide this request'
  );
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- F / G. Review, approve, and prove no attendance was written
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_request uuid;
begin
  select id into v_request from public.absence_requests where student_id = '53000000-0000-4000-8000-000000000004';

  perform set_config('request.jwt.claims', '{"sub":"ab-dir","role":"authenticated"}', true);
  set role authenticated;

  v := public.list_absence_requests('53000000-0000-4000-8000-0000000000a1', 'pending');
  perform public.ab_assert(jsonb_typeof(v) = 'array', 'F the review queue answers with rows');
  perform public.ab_assert(jsonb_array_length(v) = 1, 'F one pending request is listed');
  perform public.ab_assert((v->0->>'student_name') = 'AB Student One',
    'F the reviewer sees who asked');
  perform public.ab_assert((v->0->>'section') = 'AB Violin', 'F the section is included');
  perform public.ab_assert((v->0->>'reason') = 'Family trip to Portland.',
    'F the reviewer sees the reason');
  perform public.ab_assert((v->0->>'event_name') = 'AB Required Tomorrow',
    'F the event is named');

  v := public.decide_absence_request(v_request, 'approved', 'Have a good trip — bring the music.');
  perform public.ab_assert(v->>'ok' = 'true', 'G the director approves');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ab_assert(
    (select status = 'approved'
            and decided_by = '53000000-0000-4000-8000-000000000001'
            and decided_at is not null
            and decision_note = 'Have a good trip — bring the music.'
       from public.absence_requests where id = v_request),
    'G the decision records the reviewer, time and response'
  );

  -- Approval is now also a mark: the roll shows the student excused.
  perform public.ab_assert(
    (select status = 'excused'
            and attended = false
            and is_late = false
            and excuse_reason = 'Approved absence request'
            and marked_by = '53000000-0000-4000-8000-000000000001'
       from public.attendance_records
      where event_id = '53000000-0000-4000-8000-000000000101'
        and student_id = '53000000-0000-4000-8000-000000000004'),
    'G approval writes an excused mark, signed by the reviewer'
  );
  perform public.ab_assert(
    (select count(*) from public.attendance_records
      where event_id = '53000000-0000-4000-8000-000000000101') = 1,
    'G approval writes exactly one attendance record'
  );
  perform public.ab_assert(
    (select source = 'absence_request'
            and action = 'marked'
            and old_status is null
            and new_status = 'excused'
            and actor_id = '53000000-0000-4000-8000-000000000001'
       from public.attendance_audit
      where event_id = '53000000-0000-4000-8000-000000000101'
        and student_id = '53000000-0000-4000-8000-000000000004'),
    'G the audit trail attributes the excuse to the approved request'
  );

  perform public.ab_assert(
    (select count(*) from public.notifications
      where user_id = '53000000-0000-4000-8000-000000000004'
        and type = 'absence_decision') = 1,
    'G the student is notified of the decision'
  );
  perform public.ab_assert(
    (select payload->>'request_id' from public.notifications
      where user_id = '53000000-0000-4000-8000-000000000004'
        and type = 'absence_decision') = v_request::text,
    'G the notification points at the request'
  );

  -- The student sees the decision and the response.
  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.list_my_absence_requests('53000000-0000-4000-8000-0000000000a1');
  perform public.ab_assert(jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 1,
    'G the student can read their own request');
  perform public.ab_assert((v->0->>'status') = 'approved'
    and (v->0->>'decision_note') = 'Have a good trip — bring the music.'
    and (v->0->>'decided_by_name') = 'AB Director',
    'G the student sees the status, response and who decided');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- H. A decided request blocks a new one until resubmission is allowed
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_request uuid;
  v_second  uuid;
begin
  select id into v_request from public.absence_requests where student_id = '53000000-0000-4000-8000-000000000004';

  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000101', 'Plans changed');
  perform public.ab_assert(v->>'ok' = 'false', 'H a decided request still blocks a duplicate');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"ab-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.allow_absence_resubmission(v_request);
  perform public.ab_assert(v->>'ok' = 'true', 'H a reviewer can allow a resubmission');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000101', 'Plans changed after all');
  perform public.ab_assert(v->>'ok' = 'true', 'H the student can ask again once allowed');
  v_second := (v->>'request_id')::uuid;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ab_assert(
    (select count(*) from public.absence_requests
      where event_id = '53000000-0000-4000-8000-000000000101'
        and student_id = '53000000-0000-4000-8000-000000000004') = 2,
    'H the original is preserved and the new request exists'
  );
  perform public.ab_assert(
    (select resubmission_allowed from public.absence_requests where id = v_request),
    'H the reopened request is marked as such'
  );

  -- ---------------------------------------------------------------------
  -- I. Withdrawal — owner only, pending only
  -- ---------------------------------------------------------------------
  perform set_config('request.jwt.claims', '{"sub":"ab-stu2","role":"authenticated"}', true);
  set role authenticated;
  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000101', 'Trumpet lesson conflict');
  perform public.ab_assert(v->>'ok' = 'true', 'I a second student can ask about the same event');
  perform public.ab_assert(
    (public.withdraw_absence_request(v_second)->>'ok') = 'false',
    'I a student cannot withdraw somebody else''s request'
  );
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.withdraw_absence_request(v_second);
  perform public.ab_assert(v->>'ok' = 'true', 'I the owner can withdraw a pending request');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ab_assert(
    (select status = 'withdrawn' from public.absence_requests where id = v_second),
    'I the withdrawal is recorded'
  );

  -- N: a withdrawn request cannot be decided.
  perform set_config('request.jwt.claims', '{"sub":"ab-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.decide_absence_request(v_second, 'approved', '') ->> 'ok') = 'false',
    'N a withdrawn request cannot be approved'
  );
  perform public.ab_assert(
    (public.decide_absence_request(v_request, 'denied', '') ->> 'ok') = 'false',
    'N an already-decided request cannot be decided again'
  );
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- Withdrawal re-opens the event for that student (the index ignores it).
  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000101', 'One more time');
  perform public.ab_assert(v->>'ok' = 'true', 'H withdrawal allows a fresh request');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- J / K. Validation and eligibility
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;

  v := public.create_absence_request('53000000-0000-4000-8000-000000000102', '   ');
  perform public.ab_assert(v->>'ok' = 'false', 'J an empty reason is refused');

  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000102', repeat('x', 1001));
  perform public.ab_assert(v->>'ok' = 'false', 'J an over-long reason is refused');

  v := public.create_absence_request(
    '53000000-0000-4000-8000-000000000102', repeat('x', 1000));
  perform public.ab_assert(v->>'ok' = 'true', 'J a 1,000-character reason is allowed');

  perform public.ab_assert(
    (public.create_absence_request('53000000-0000-4000-8000-000000000104', 'late') ->> 'ok') = 'false',
    'K a past event is not eligible'
  );
  perform public.ab_assert(
    (public.create_absence_request('53000000-0000-4000-8000-000000000103', 'nothing to miss') ->> 'ok') = 'false',
    'K an event that takes no attendance is not eligible'
  );
  perform public.ab_assert(
    (public.create_absence_request('53000000-0000-4000-8000-000000000105', 'archived') ->> 'ok') = 'false',
    'K an archived event is not eligible'
  );

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- L. Another student's request is invisible
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  perform set_config('request.jwt.claims', '{"sub":"ab-stu2","role":"authenticated"}', true);
  set role authenticated;
  select count(*) into n from public.absence_requests
   where student_id = '53000000-0000-4000-8000-000000000004';
  perform public.ab_assert(n = 0, 'L a student cannot read another student''s requests');

  select count(*) into n from public.absence_requests
   where student_id = '53000000-0000-4000-8000-000000000005';
  perform public.ab_assert(n = 1, 'L a student can read their own');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- M. An explicitly granted reviewer can decide
-- ---------------------------------------------------------------------------
do $$
declare
  v        jsonb;
  v_role   uuid;
  v_req    uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"ab-dir","role":"authenticated"}', true);
  set role authenticated;

  v := public.create_custom_role(
    '53000000-0000-4000-8000-0000000000a1',
    'Absence reviewer', 'Reads and decides absence requests',
    array['absence.review'], 'program');
  perform public.ab_assert(v->>'ok' = 'true', 'M a director can delegate absence.review');
  v_role := (v->>'role_id')::uuid;

  v := public.assign_role(
    '53000000-0000-4000-8000-0000000000a1',
    '53000000-0000-4000-8000-000000000003',
    v_role, null);
  perform public.ab_assert(v->>'ok' = 'true', 'M the role is assigned to the section leader');
  reset role;

  select id into v_req from public.absence_requests
   where student_id = '53000000-0000-4000-8000-000000000005'
     and status = 'pending';

  perform set_config('request.jwt.claims', '{"sub":"ab-lead","role":"authenticated"}', true);
  set role authenticated;
  v := public.list_absence_requests('53000000-0000-4000-8000-0000000000a1', 'pending');
  perform public.ab_assert(jsonb_typeof(v) = 'array', 'M the granted reviewer now has a queue');
  v := public.decide_absence_request(v_req, 'denied', 'We need the full trumpet section.');
  perform public.ab_assert(v->>'ok' = 'true', 'M the granted reviewer can decide');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ab_assert(
    (select status = 'denied'
            and decided_by = '53000000-0000-4000-8000-000000000003'
       from public.absence_requests where id = v_req),
    'M the decision names the granted reviewer'
  );
  perform public.ab_assert(
    (select count(*) from public.notifications
      where user_id = '53000000-0000-4000-8000-000000000005'
        and type = 'absence_decision') = 1,
    'M the student is told about the denial'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- O. A recorded mark wins, and a denial writes nothing
-- ---------------------------------------------------------------------------
do $$
begin
  -- Student two asks to miss the optional event, and staff have already marked
  -- her present for it.
  perform set_config('request.jwt.claims', '{"sub":"ab-stu2","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.create_absence_request('53000000-0000-4000-8000-000000000102',
      'Family event that evening.') ->> 'ok') = 'true',
    'O a second student can ask about a different event');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  insert into public.attendance_records
    (event_id, student_id, attended, checked_in_at, status, excuse_reason, is_late, marked_by)
  values
    ('53000000-0000-4000-8000-000000000102', '53000000-0000-4000-8000-000000000005',
     true, now(), 'present', '', false, '53000000-0000-4000-8000-000000000001');

  perform set_config('request.jwt.claims', '{"sub":"ab-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.decide_absence_request(
       (select id from public.absence_requests
         where event_id = '53000000-0000-4000-8000-000000000102'
           and student_id = '53000000-0000-4000-8000-000000000005'),
       'approved', 'Approved, but she was there.') ->> 'roll') = 'kept',
    'O the approval reports that the recorded mark was kept');

  -- A denial, with no record to protect.
  reset role;
  perform set_config('request.jwt.claims', '{"sub":"ab-stu1","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.create_absence_request('53000000-0000-4000-8000-000000000106',
      'Asking about the denial path.') ->> 'ok') = 'true',
    'O a student can ask about a second event');
  reset role;
  perform set_config('request.jwt.claims', '{"sub":"ab-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.ab_assert(
    (public.decide_absence_request(
       (select id from public.absence_requests
         where event_id = '53000000-0000-4000-8000-000000000106'
           and student_id = '53000000-0000-4000-8000-000000000004'),
       'denied', 'We need the full section.') ->> 'ok') = 'true',
    'O the director denies');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ab_assert(
    (select status = 'present'
            and marked_by = '53000000-0000-4000-8000-000000000001'
       from public.attendance_records
      where event_id = '53000000-0000-4000-8000-000000000102'
        and student_id = '53000000-0000-4000-8000-000000000005'),
    'O an approval never overwrites a recorded present mark'
  );
  perform public.ab_assert(
    not exists (
      select 1 from public.attendance_audit
       where event_id = '53000000-0000-4000-8000-000000000102'
         and source = 'absence_request'
    ),
    'O no excused change is recorded where the roll already said present'
  );
  perform public.ab_assert(
    (select count(*) from public.attendance_records
      where event_id = '53000000-0000-4000-8000-000000000106') = 0,
    'O a denial writes no attendance record'
  );
  perform public.ab_assert(
    (select status = 'denied' from public.absence_requests
      where event_id = '53000000-0000-4000-8000-000000000106'
        and student_id = '53000000-0000-4000-8000-000000000004'),
    'O the denial itself is still saved'
  );
end
$$;

rollback;

select 'ABSENCE REQUESTS PASSED' as verification_result;
