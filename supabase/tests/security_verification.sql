-- ============================================================================
-- RHS Band Attendance Manager — security & attendance hardening verification
-- ============================================================================
-- requires-nullable-column: events ensemble_id
-- Run this in Supabase Dashboard → SQL Editor AFTER applying migrations 005
-- and 006.
--
-- Design:
--   * Everything runs inside one explicit transaction and is ROLLED BACK at
--     the end — fixture rows (users, events, sessions, attendance) only exist
--     for the duration of the test; the database is left untouched.
--   * Each check raises 'FAIL: <test id> …' on failure, so the first failing
--     assertion aborts the script with a clear message.
--   * Personas are simulated the way PostgREST sees real clients:
--       set role authenticated;
--       set local request.jwt.claims = {"sub":"<uuid>",…};
--     so RLS, auth.uid() and the SECURITY DEFINER role checks all behave
--     exactly as they do for direct Supabase/RPC calls.
--   * On success the script prints: ALL SECURITY TESTS PASSED.
--
-- Test ids map to the spec's edge-case list (early/late/ended check-ins,
-- expired + invalidated QR tokens, section-scoping, staff-note privacy,
-- direct analytics/RPC abuse, excused + QR, duplicates, requirement/mode
-- combinations, multi-role and NULL-instrument users).

begin;

-- ---------------------------------------------------------------------------
-- 0. Prerequisites — fail fast if migration 005 has not been applied
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_requirement_mode_check'
  ) then
    raise exception 'FAIL: events_requirement_mode_check missing — apply migration 005 first';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'attendance_records_status_attended_check'
  ) then
    raise exception 'FAIL: attendance_records_status_attended_check missing — apply migration 005 first';
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'events_checkin_mode_changed'
  ) then
    raise exception 'FAIL: events_checkin_mode_changed trigger missing — apply migration 005 first';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'attendance_staff_notes'
       and policyname = 'attendance_staff_notes_read_staff'
  ) then
    raise exception 'FAIL: staff-notes policy missing — apply migration 005 first';
  end if;
  -- Since 20261024090000_checkin_any_time.sql the opener has no early window;
  -- the ended-event guard is the one that must remain.
  if position('already ended' in
      pg_get_functiondef('public.start_checkin_session(uuid)'::regprocedure)) = 0 then
    raise exception 'FAIL: QR opening guard missing — the ended-event check must stay';
  end if;
  if position('Check-in opens 15 minutes' in
      pg_get_functiondef('public.start_checkin_session(uuid)'::regprocedure)) > 0 then
    raise exception 'FAIL: the 15-minute early window is back in start_checkin_session';
  end if;
end $$;

-- Assertion helper (created inside the transaction — rolled back with it).
create or replace function public.t_assert(condition boolean, label text)
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
-- 1. Fixtures (created as the SQL editor superuser, rolled back at the end)
-- ---------------------------------------------------------------------------

-- Personas: 01 director, 02 secretary, 03 section leader (Violin),
-- 04 section leader (no instrument), 05 student (Violin), 06 student
-- (Trumpet), 07 student + section_leader (Violin), 08 section leader
-- (Trumpet), 09 director + section_leader (Violin).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token,
  reauthentication_token
)
select
  v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  v.email, '', now(),
  '{"provider":"email","providers":["email"],"invited_by_director":true}'::jsonb,
  jsonb_build_object('full_name', v.name, 'display_name', v.name),
  now(), now(), '', '', '', '', '', '', '', ''
from (values
  ('ffffffff-0000-4000-8000-000000000001'::uuid, 'tst-01-dir@example.test',    'TST Director'),
  ('ffffffff-0000-4000-8000-000000000002'::uuid, 'tst-02-sec@example.test',    'TST Secretary'),
  ('ffffffff-0000-4000-8000-000000000003'::uuid, 'tst-03-slv@example.test',    'TST Leader Violin'),
  ('ffffffff-0000-4000-8000-000000000004'::uuid, 'tst-04-sl0@example.test',    'TST Leader None'),
  ('ffffffff-0000-4000-8000-000000000005'::uuid, 'tst-05-stv@example.test',    'TST Student Violin'),
  ('ffffffff-0000-4000-8000-000000000006'::uuid, 'tst-06-stt@example.test',    'TST Student Trumpet'),
  ('ffffffff-0000-4000-8000-000000000007'::uuid, 'tst-07-mr@example.test',     'TST Multi Role'),
  ('ffffffff-0000-4000-8000-000000000008'::uuid, 'tst-08-slt@example.test',    'TST Leader Trumpet'),
  ('ffffffff-0000-4000-8000-000000000009'::uuid, 'tst-09-dl@example.test',     'TST Director Leader')
) as v(id, email, name)
on conflict (id) do nothing;

-- The signup trigger may have created profiles with the default 'student'
-- role — remove them and insert the personas with their real role sets.
delete from public.profiles
 where id in (
   'ffffffff-0000-4000-8000-000000000001','ffffffff-0000-4000-8000-000000000002',
   'ffffffff-0000-4000-8000-000000000003','ffffffff-0000-4000-8000-000000000004',
   'ffffffff-0000-4000-8000-000000000005','ffffffff-0000-4000-8000-000000000006',
   'ffffffff-0000-4000-8000-000000000007','ffffffff-0000-4000-8000-000000000008',
   'ffffffff-0000-4000-8000-000000000009'
 );

insert into public.profiles (id, full_name, display_name, instrument, roles) values
  ('ffffffff-0000-4000-8000-000000000001', 'TST Director',        'TST Director',        '',        '{director}'),
  ('ffffffff-0000-4000-8000-000000000002', 'TST Secretary',        'TST Secretary',       '',        '{secretary}'),
  ('ffffffff-0000-4000-8000-000000000003', 'TST Leader Violin',    'TST Leader Violin',   'Violin',  '{section_leader}'),
  ('ffffffff-0000-4000-8000-000000000004', 'TST Leader None',      'TST Leader None',     '',        '{section_leader}'),
  ('ffffffff-0000-4000-8000-000000000005', 'TST Student Violin',   'TST Student Violin',  'Violin',  '{student}'),
  ('ffffffff-0000-4000-8000-000000000006', 'TST Student Trumpet',  'TST Student Trumpet', 'Trumpet', '{student}'),
  ('ffffffff-0000-4000-8000-000000000007', 'TST Multi Role',       'TST Multi Role',      'Violin',  '{student,section_leader}'),
  ('ffffffff-0000-4000-8000-000000000008', 'TST Leader Trumpet',   'TST Leader Trumpet',  'Trumpet', '{section_leader}'),
  ('ffffffff-0000-4000-8000-000000000009', 'TST Director Leader',  'TST Director Leader', 'Violin',  '{director,section_leader}');

-- Fixture events covering every timing/mode/requirement combination.
insert into public.events
  (id, name, type, date, end_date, checkin_mode, attendance_requirement, created_by, late_minutes)
values
  ('eeeeeeee-0000-4000-8000-000000000001', 'TST Early',     'rehearsal', now() + interval '30 minutes', null,                     'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000002', 'TST Open',      'rehearsal', now() + interval '10 minutes', null,                     'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000003', 'TST Late',      'rehearsal', now() - interval '30 minutes', now() + interval '2 hours', 'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000004', 'TST Over',      'rehearsal', now() - interval '4 hours',    now() - interval '1 hour',  'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000005', 'TST None',      'rehearsal', now() + interval '10 minutes', null,                     'none',   'none',     'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000006', 'TST Mode',      'rehearsal', now() + interval '10 minutes', null,                     'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000007', 'TST Both',      'rehearsal', now() + interval '10 minutes', null,                     'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000008', 'TST Excused',   'rehearsal', now() - interval '30 minutes', now() + interval '2 hours', 'qr',     'required', 'ffffffff-0000-4000-8000-000000000001', 10),
  ('eeeeeeee-0000-4000-8000-000000000009', 'TST Optional',  'rehearsal', now() + interval '10 minutes', null,                     'qr',     'optional', 'ffffffff-0000-4000-8000-000000000001', 10);

-- Fixture QR sessions (the record RPCs accept any unexpired token, so direct
-- inserts are enough to exercise the check-in state machine).
insert into public.checkin_sessions (event_id, token, entry_code, created_by, expires_at) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'tst-tok-early', 'EARLY123', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000002', 'tst-tok-open',  'OPEN1234', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000002', 'tst-tok-exp',   'EXPIRED1', 'ffffffff-0000-4000-8000-000000000001', now() - interval '1 minute'),
  ('eeeeeeee-0000-4000-8000-000000000003', 'tst-tok-late',  'LATE1234', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000004', 'tst-tok-over',  'OVER1234', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000005', 'tst-tok-none',  'NONE1234', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000006', 'tst-tok-mode',  'MODE1234', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000007', 'tst-tok-both',  'BOTH1234', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000008', 'tst-tok-exc',   'EXC12345', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes'),
  ('eeeeeeee-0000-4000-8000-000000000009', 'tst-tok-opt',   'OPT12345', 'ffffffff-0000-4000-8000-000000000001', now() + interval '5 minutes');

-- ---------------------------------------------------------------------------
-- 2. Student (06, Trumpet): manual-code window, late check-in, idempotent
--    re-scan — spec tests 2, 12.
-- ---------------------------------------------------------------------------
do $$
declare
  v  jsonb;
  t0 timestamptz;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000006","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000006', true);
  set role authenticated;

  -- A1: manual code 30 minutes before start → accepted (no early window).
  v := public.record_attendance_by_code('EARLY123');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Checked in',
    'A1 manual code 30 min before start must be accepted');
  perform public.t_assert(
    (select ar.attended and ar.status = 'present'
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000001'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000006'),
    'A1 early check-in must be present, never late');

  -- A2: manual code 10 minutes before start → allowed.
  v := public.record_attendance_by_code('OPEN1234');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Checked in',
    'A2 manual code 10 min before start must be accepted');
  perform public.t_assert(
    (select ar.attended and ar.status = 'present'
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000002'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000006'),
    'A2 row must be attended=true / status=present');

  -- A3: QR scan on an event past its late grace period → late, attended.
  v := public.record_attendance('tst-tok-late');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Checked in (late)' and (v->>'is_late')::boolean,
    'A3 scan after grace period must be late');
  perform public.t_assert(
    (select ar.attended and ar.status = 'late' and ar.is_late
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000003'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000006'),
    'A3 row must be attended=true / status=late');

  -- A4: second scan → idempotent, first check-in time and status preserved.
  select checked_in_at into t0
    from public.attendance_records
   where event_id = 'eeeeeeee-0000-4000-8000-000000000003'
     and student_id = 'ffffffff-0000-4000-8000-000000000006';
  v := public.record_attendance('tst-tok-late');
  perform public.t_assert(v->>'ok' = 'true', 'A4 second scan must succeed');
  perform public.t_assert(
    (select ar.checked_in_at = t0 and ar.status = 'late' and ar.attended
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000003'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000006'),
    'A4 first check-in time and late status must be preserved');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Student (05, Violin): check-in window, expired code, non-QR event,
--    direct-table and direct-RPC abuse, analytics denial — spec tests 1, 3,
--    4, 9, 10, 13, 14.
-- ---------------------------------------------------------------------------
do $$
declare
  v  jsonb;
  t0 timestamptz;
  n  int;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000005","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000005', true);
  set role authenticated;

  -- B1: 30 minutes before start → accepted, because check-in opens as soon as
  -- the event exists.
  v := public.record_attendance('tst-tok-early');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Checked in',
    'B1 QR scan 30 min before start must be accepted');
  perform public.t_assert(
    (select ar.attended and ar.status = 'present'
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000001'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000005'),
    'B1 early QR check-in must be present, never late');

  -- B2: expired session → rejected.
  v := public.record_attendance('tst-tok-exp');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'That code has expired — ask for a fresh one.',
    'B2 expired QR session must be rejected');

  -- B3: after the event ended → rejected.
  v := public.record_attendance('tst-tok-over');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'That event has already ended — attendance is closed.',
    'B3 check-in after event end must be rejected');

  -- B4: event that does not collect QR attendance → rejected.
  v := public.record_attendance('tst-tok-none');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'This event doesn''t use QR check-in.',
    'B4 QR token on a non-QR event must be rejected');

  -- B5: in-window scan → present, consistent row.
  v := public.record_attendance('tst-tok-open');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Checked in',
    'B5 in-window scan must succeed');
  perform public.t_assert(
    (select ar.attended and ar.status = 'present'
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000002'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000005'),
    'B5 row must be attended=true / status=present');

  -- B6: second scan → idempotent (duplicate rows are impossible anyway).
  select checked_in_at into t0
    from public.attendance_records
   where event_id = 'eeeeeeee-0000-4000-8000-000000000002'
     and student_id = 'ffffffff-0000-4000-8000-000000000005';
  v := public.record_attendance('tst-tok-open');
  perform public.t_assert(v->>'ok' = 'true', 'B6 second scan must succeed');
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where event_id = 'eeeeeeee-0000-4000-8000-000000000002'
        and student_id = 'ffffffff-0000-4000-8000-000000000005') = 1,
    'B6 no duplicate attendance rows');
  perform public.t_assert(
    (select ar.checked_in_at = t0
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000002'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000005'),
    'B6 first check-in time preserved on re-scan');

  -- B7: student cannot write attendance through the RPC (self or others).
  v := public.override_attendance('eeeeeeee-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Only staff may override attendance.',
    'B7a student must not override their own attendance');
  v := public.override_attendance('eeeeeeee-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000006', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Only staff may override attendance.',
    'B7b student must not write another student''s attendance via RPC');

  -- B8: student cannot UPDATE attendance directly (RLS: no policy → 0 rows).
  update public.attendance_records set attended = false
   where event_id = 'eeeeeeee-0000-4000-8000-000000000002'
     and student_id = 'ffffffff-0000-4000-8000-000000000005';
  get diagnostics n = row_count;
  perform public.t_assert(n = 0, 'B8 student direct UPDATE must affect 0 rows');

  -- B9: student cannot INSERT attendance directly (RLS: no policy → error).
  begin
    insert into public.attendance_records (event_id, student_id, attended, status)
    values ('eeeeeeee-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000006', true, 'present');
    raise exception 'FAIL: B9 student inserted an attendance row directly';
  exception
    when insufficient_privilege then null; -- expected: no INSERT policy
  end;

  -- B10: every analytics RPC denied to a student (spec test 9).
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005');
  perform public.t_assert(v->>'ok' = 'false' and v->>'percentage' is null,
    'B10a student must not call get_student_attendance_pct');
  v := public.get_section_attendance_stats();
  perform public.t_assert(v->>'ok' = 'false', 'B10b student must not call get_section_attendance_stats');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000002');
  perform public.t_assert(v->>'ok' = 'false', 'B10c student must not call get_event_attendance_summary');
  v := public.get_attendance_trend(5);
  perform public.t_assert(v->>'ok' = 'false', 'B10d student must not call get_attendance_trend');

  -- B11: student cannot start a check-in session.
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000002');
  perform public.t_assert(v->>'ok' = 'false'
    and v->>'message' = 'Only directors, secretaries and section leaders can generate codes.',
    'B11 student must not generate QR codes');

  -- B12/B13: read scoping — own rows visible, other students'' not.
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000005') >= 1,
    'B12 student can read their own attendance');
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000006') = 0,
    'B13 student cannot read another student''s attendance');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Director (01): excuse + staff note, full analytics, QR-session
--    invalidation on mode change, session creation rules, director does not
--    check in — spec tests 5, 11, 15 and the director rows of test 11.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_expiry timestamptz;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000001","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000001', true);
  set role authenticated;

  -- C1: excuse a student and attach a staff note.
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000008',
    'ffffffff-0000-4000-8000-000000000005',
    'excused', 'Family', 'TST-NOTE');
  perform public.t_assert(v->>'ok' = 'true', 'C1 director can excuse with a staff note');
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000009',
    'ffffffff-0000-4000-8000-000000000006',
    'present', '', 'TST-CROSS-NOTE');
  perform public.t_assert(v->>'ok' = 'true', 'C1 director can add another-section staff note');
  perform public.t_assert(
    (select ar.attended = false and ar.status = 'excused'
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000008'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000005'),
    'C1 excuse must produce attended=false / status=excused');

  -- C2: full analytics for a director.
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005');
  perform public.t_assert(v->>'ok' = 'true' and v->>'percentage' is not null,
    'C2a director gets student attendance pct');
  v := public.get_section_attendance_stats();
  perform public.t_assert(v is null or jsonb_typeof(v) = 'array',
    'C2b director gets section stats array');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000004');
  perform public.t_assert(v->>'ok' = 'true',
    'C2c director gets event summary (event with no attendance records)');
  v := public.get_attendance_trend(5);
  perform public.t_assert(v is null or jsonb_typeof(v) = 'array',
    'C2d director gets attendance trend array');

  -- C3: changing check-in mode away from QR deletes active sessions
  --     (the events UPDATE runs through RLS like the real UI does).
  update public.events set checkin_mode = 'toggle'
   where id = 'eeeeeeee-0000-4000-8000-000000000006';
  perform public.t_assert(
    (select count(*) from public.checkin_sessions
      where event_id = 'eeeeeeee-0000-4000-8000-000000000006') = 0,
    'C3 QR session must be deleted when mode changes qr → toggle');

  -- C4: qr → both keeps the session (still QR-enabled).
  update public.events set checkin_mode = 'both'
   where id = 'eeeeeeee-0000-4000-8000-000000000007';
  perform public.t_assert(
    (select count(*) from public.checkin_sessions
      where event_id = 'eeeeeeee-0000-4000-8000-000000000007') = 1,
    'C4 QR session must survive qr → both');

  -- C5: session creation still respects mode and the ended-event guard, but
  -- no longer has an early window.
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000006'); -- now toggle
  perform public.t_assert(v->>'ok' = 'false'
    and v->>'message' = 'This event uses toggle check-in — mark attendance with the buttons on the Check-In screen.',
    'C5 no QR session for a toggle event');
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000005'); -- none/none
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'This event doesn''t collect attendance.',
    'C5b no QR session for a non-collecting event');
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000001'); -- 30 min early
  perform public.t_assert(v->>'ok' = 'true',
    'C5c QR creation 30 min early must be accepted');

  update public.events set date = now() + interval '16 minutes'
   where id = 'eeeeeeee-0000-4000-8000-000000000001';
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000001');
  perform public.t_assert(v->>'ok' = 'true',
    'C5d QR creation 16 min early must be accepted');

  update public.events set date = now() + interval '15 minutes'
   where id = 'eeeeeeee-0000-4000-8000-000000000001';
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000001');
  perform public.t_assert(v->>'ok' = 'true',
    'C5e QR creation at the 15-minute boundary must be accepted');

  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000002'); -- 10 min early
  perform public.t_assert(v->>'ok' = 'true',
    'C5f QR creation 10 min early must be accepted');
  select expires_at into v_expiry from public.checkin_sessions
   where event_id = 'eeeeeeee-0000-4000-8000-000000000002';
  perform public.t_assert(v_expiry = now() + interval '5 minutes',
    'C5g generated QR session must last exactly 5 minutes');

  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000003'); -- during event
  perform public.t_assert(v->>'ok' = 'true' and v->>'token' is not null and v->>'entry_code' is not null,
    'C5h staff can generate a QR session during the event');
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000004'); -- ended
  perform public.t_assert(v->>'ok' = 'false'
    and v->>'message' = 'That event has already ended — check-in is closed.',
    'C5i QR creation after event end must be rejected');

  -- C6: directors never check in.
  v := public.record_attendance('tst-tok-opt');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Directors don''t check in.',
    'C6 director must not check in');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Secretary (02): full staff-note read, override anyone, analytics
--    denied (the app never grants secretaries analytics), event updates.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000002","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000002', true);
  set role authenticated;

  -- S1: secretary reads every staff note (unchanged permission model).
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes
      where staff_note in ('TST-NOTE', 'TST-CROSS-NOTE')) = 2,
    'S1 secretary can read staff notes');

  -- S2: secretary can override any student (no section scoping).
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000009',
    'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'true', 'S2 secretary can mark any student');

  -- S3: secretary reads all attendance rows.
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000006') >= 1,
    'S3 secretary can read all attendance');

  -- S4: analytics remain director-only.
  v := public.get_section_attendance_stats();
  perform public.t_assert(v->>'ok' = 'false', 'S4a secretary denied section stats');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000004');
  perform public.t_assert(v->>'ok' = 'false', 'S4b secretary denied event summary');
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005');
  perform public.t_assert(v->>'ok' = 'false', 'S4c secretary denied student attendance analytics');
  v := public.get_attendance_trend(5);
  perform public.t_assert(v->>'ok' = 'false', 'S4d secretary denied attendance trend');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Section leader, Violin (03): cross-section writes and note reads
--    denied; own section allowed; analytics denied — spec tests 7, 8.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000003","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000003', true);
  set role authenticated;

  -- L1: cannot mark a trumpet student.
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000006', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'You can only mark students in your own section.',
    'L1 section leader cannot mark another section');

  -- L2: can mark a violin student.
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'true', 'L2 section leader can mark own section');

  -- L3: reads staff notes only for their own section.
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes where staff_note = 'TST-NOTE') = 1,
    'L3 section leader reads own-section staff notes');
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes where staff_note = 'TST-CROSS-NOTE') = 0,
    'L3 section leader cannot read another section staff notes');

  -- L4: attendance rows scoped to the section.
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000005') >= 1
    and (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000006') = 0,
    'L4 section leader reads only own-section attendance');

  -- L5: analytics denied.
  v := public.get_section_attendance_stats();
  perform public.t_assert(v->>'ok' = 'false', 'L5a section leader denied section stats');
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005');
  perform public.t_assert(v->>'ok' = 'false', 'L5b section leader denied student pct');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000002');
  perform public.t_assert(v->>'ok' = 'false', 'L5c section leader denied event summary');
  v := public.get_attendance_trend(5);
  perform public.t_assert(v->>'ok' = 'false', 'L5d section leader denied attendance trend');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Section leader, Trumpet (08): cannot read a violin student's note —
--    the direct-table query the old policy allowed — spec test 8.
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000008","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000008', true);
  set role authenticated;

  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes where staff_note = 'TST-NOTE') = 0,
    'M1 cross-section staff note must be invisible');
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000005') = 0
    and (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000006') >= 1,
    'M2 attendance scoped to own section');
  perform public.t_assert(
    (select public.get_attendance_trend(5)->>'ok') = 'false',
    'M3 section leader denied trend analytics');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Section leader with no instrument (04): no section, no access —
--    spec test 19.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000004","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000004', true);
  set role authenticated;

  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'You can only mark students in your own section.',
    'N1 leader without an instrument cannot mark anyone');
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes) = 0,
    'N2 leader without an instrument reads no staff notes');
  perform public.t_assert(
    (select count(*) from public.attendance_records) = 0,
    'N2b leader without an instrument reads no attendance rows');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Multi-role student + section_leader (07): behaves as a section leader
--    for writes/notes and as a student for analytics — spec test 18.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000007","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000007', true);
  set role authenticated;

  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000006', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'You can only mark students in your own section.',
    'R1 multi-role leader still section-scoped');
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'true', 'R2 multi-role leader marks own section');
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes where staff_note = 'TST-NOTE') = 1,
    'R3 multi-role leader reads own-section notes');
  v := public.get_section_attendance_stats();
  perform public.t_assert(v->>'ok' = 'false', 'R4 multi-role student+leader denied analytics');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Multi-role director + section_leader (09): director privileges win —
--     section scoping must not trap a director (spec: directors manage all
--     attendance and access analytics).
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000009","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000009', true);
  set role authenticated;

  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000006', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'true',
    'DL1 director+section_leader is not section-scoped');
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005');
  perform public.t_assert(v->>'ok' = 'true',
    'DL2 director+section_leader keeps analytics access');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Student (06) again: dead token after mode change, staff notes and
--     other students' attendance invisible — spec tests 6, 2, 8.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000006","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000006', true);
  set role authenticated;

  -- The session row for this token was deleted when the event switched to
  -- toggle mode, so the old QR code must be dead.
  v := public.record_attendance('tst-tok-mode');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'That code was not recognized.',
    'E1 old QR token must be dead after check-in mode change');

  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes) = 0,
    'E2 students cannot read staff notes');
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000005') = 0,
    'E3 students cannot read other students'' attendance');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 12. Student (05): excused record survives a QR scan — spec test 11.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"ffffffff-0000-4000-8000-000000000005","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000005', true);
  set role authenticated;

  v := public.record_attendance('tst-tok-exc');
  perform public.t_assert(v->>'ok' = 'false'
    and v->>'message' = 'You''ve been excused for this event — no check-in needed.',
    'X1 QR scan on an excused record must be rejected with a clear message');
  perform public.t_assert(
    (select ar.status = 'excused' and ar.attended = false
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000008'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000005'),
    'X1 excuse must be preserved (never excused + attended=true)');
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes
      where attendance_record_id in (
        select id from public.attendance_records
         where event_id = 'eeeeeeee-0000-4000-8000-000000000008'
           and student_id = 'ffffffff-0000-4000-8000-000000000005')) = 0,
    'X2 students cannot read the note on their own record');

  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- 13. Global invariants (superuser view, still inside the transaction)
-- ---------------------------------------------------------------------------
do $$
begin
  -- status × attended agrees on every row the test run can see.
  if exists (
    select 1 from public.attendance_records
     where attended is distinct from (status in ('present', 'late'))
  ) then
    raise exception 'FAIL: G1 status/attended inconsistency found';
  end if;

  -- Fixture outcomes that must hold at the end.
  if not exists (
    select 1 from public.attendance_records
     where event_id = 'eeeeeeee-0000-4000-8000-000000000003'
       and student_id = 'ffffffff-0000-4000-8000-000000000006'
       and status = 'late' and attended = true
  ) then
    raise exception 'FAIL: G2 late check-in row missing';
  end if;
  if not exists (
    select 1 from public.attendance_records
     where event_id = 'eeeeeeee-0000-4000-8000-000000000008'
       and student_id = 'ffffffff-0000-4000-8000-000000000005'
       and status = 'excused' and attended = false
  ) then
    raise exception 'FAIL: G3 excused row was altered';
  end if;

  -- Constraint rejects contradictory event configurations (spec test 15/16/17).
  begin
    insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
    values (gen_random_uuid(), 'TST Bad 1', 'rehearsal', now() + interval '1 day', 'qr', 'none');
    raise exception 'FAIL: G4 attendance_requirement=none with QR mode must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
    values (gen_random_uuid(), 'TST Bad 2', 'rehearsal', now() + interval '1 day', 'none', 'required');
    raise exception 'FAIL: G5 required attendance with no check-in method must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
    values (gen_random_uuid(), 'TST Bad 3', 'rehearsal', now() + interval '1 day', 'none', 'optional');
    raise exception 'FAIL: G6 optional attendance with no check-in method must be rejected';
  exception when check_violation then null;
  end;
  -- Valid combinations still insert.
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
  values (gen_random_uuid(), 'TST Good 1', 'rehearsal', now() + interval '1 day', 'toggle', 'optional');
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
  values (gen_random_uuid(), 'TST Good 2', 'rehearsal', now() + interval '1 day', 'none', 'none');
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
  values (gen_random_uuid(), 'TST Good 3', 'rehearsal', now() + interval '1 day', 'qr', 'optional');
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement)
  values (gen_random_uuid(), 'TST Good 4', 'rehearsal', now() + interval '1 day', 'both', 'optional');

  -- Defense-in-depth grants: analytics unreachable for anon, reachable for
  -- authenticated (the in-function director check is the actual gate).
  if has_function_privilege('anon', 'public.get_section_attendance_stats()', 'execute') then
    raise exception 'FAIL: G7 anon still has EXECUTE on get_section_attendance_stats';
  end if;
  if has_function_privilege('anon', 'public.get_attendance_trend(integer)', 'execute') then
    raise exception 'FAIL: G7b anon still has EXECUTE on get_attendance_trend';
  end if;
  if not has_function_privilege('authenticated', 'public.get_section_attendance_stats()', 'execute') then
    raise exception 'FAIL: G8 authenticated (directors) lost EXECUTE on analytics';
  end if;
  if not has_function_privilege('authenticated', 'public.record_attendance(text)', 'execute') then
    raise exception 'FAIL: G9 students lost EXECUTE on record_attendance';
  end if;
end $$;

rollback;

select 'ALL SECURITY TESTS PASSED' as verification_result;
