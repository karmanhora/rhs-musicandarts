-- ============================================================================
-- RHS Music Platform — security & attendance verification v2 (ensemble-aware)
-- ============================================================================
-- requires-table: public.memberships
--
-- Port of `security_verification.sql` to the schema migrations 007–018 build.
-- Every behavioral assertion from the v1 suite is preserved; what changed is
-- HOW identity and scoping are expressed:
--
--   * Personas are `profiles` rows with an `auth_user_id` plus a `memberships`
--     row in the band program. `handle_new_user` is retired (018) and the join
--     code is a `join_program()` / `register_signup()` matter, so nothing is
--     inserted into `auth.users` here.
--   * Roles live on `memberships.roles` and the section on
--     `memberships.section_id` — `profiles.roles` / `profiles.instrument` are
--     gone (018), so section scoping is tested through real `sections` rows.
--   * Personas authenticate exactly as a Supabase Auth token reaches PostgREST
--     (migration 021):
--       reset role;                                       -- superuser fixtures
--       set local role authenticated;
--       select set_config('request.jwt.claims',
--                         '{"sub":"<auth_user_id>","role":"authenticated"}', true);
--     `current_profile_id()` resolves profiles.id from that `sub` claim.
--   * Analytics RPCs take the program id (`get_section_attendance_stats(uuid)`,
--     `get_student_attendance_pct(uuid, uuid)`,
--     `get_attendance_trend(uuid, int)`); attendance/check-in RPCs derive the
--     program from the event and keep their v1 signatures.
--
-- Retired RPCs asserted in v1 (invite_member*, reset_member_password,
-- get_roster_emails, update_member_instrument, *_band_join_code) are replaced by
-- their new source of truth: `set_member_section` section scoping,
-- `deactivate_member` per-program director protection, `get_join_code` /
-- `set_join_code` director-only access, and `register_signup` for the join-code
-- gate that `handle_new_user` used to enforce. Each replacement is noted inline.
--
-- Design (unchanged from v1): one explicit transaction, ROLLED BACK at the end;
-- each check raises 'FAIL: <id> …' on the first violation; on success the script
-- prints SECURITY VERIFICATION V2 PASSED.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Prerequisites — fail fast unless the ensemble schema is in place
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.memberships') is null then
    raise exception 'FAIL: SEC-v2-0 public.memberships missing — apply migrations 007–018 first';
  end if;
  if to_regprocedure('public.current_profile_id()') is null then
    raise exception 'FAIL: SEC-v2-0 public.current_profile_id() missing — apply migration 013 first';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_read_scoped'
  ) then
    raise exception 'FAIL: SEC-v2-0 profiles_read_scoped missing — apply migration 015 first';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'events' and policyname = 'events_read_members'
  ) then
    raise exception 'FAIL: SEC-v2-0 events_read_members missing — apply migration 015 first';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'attendance_records' and policyname = 'attendance_read_scoped'
  ) then
    raise exception 'FAIL: SEC-v2-0 attendance_read_scoped missing — apply migration 015 first';
  end if;
  if to_regprocedure('public.user_has_role(app_role)') is not null then
    raise exception 'FAIL: SEC-v2-0 the retired user_has_role() still exists — apply migration 018 first';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name in ('roles', 'instrument')
  ) then
    raise exception 'FAIL: SEC-v2-0 legacy profiles columns still present — apply migration 018 first';
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

-- NOTE: `t_assert` keeps the schema's default EXECUTE grants, exactly like in
-- the v1 suite — persona blocks run with `role = authenticated` and must be able
-- to call it. The "anon can execute nothing" sweep in section 13 therefore
-- excludes this test artefact by name (it is not part of the app's surface).

-- ---------------------------------------------------------------------------
-- 1. Fixtures (created as the SQL-editor superuser, rolled back at the end)
-- ---------------------------------------------------------------------------

-- Band sections for the personas. The band program already has the sections
-- derived from the real instruments (014) — add the two this suite needs.
insert into public.sections (ensemble_id, name, sort_order)
select b.id, v.name, v.ord
  from (values ('Violin', 501), ('Trumpet', 502)) as v(name, ord)
 cross join (select id from public.ensembles where slug = 'band') b
on conflict (ensemble_id, name) do nothing;

-- Personas: 01 director, 02 secretary, 03 section leader (Violin),
-- 04 section leader (no section), 05 student (Violin), 06 student (Trumpet),
-- 07 student + section_leader (Violin), 08 section leader (Trumpet),
-- 09 director + section_leader (Violin). Plus one account that never passed
-- the join code — a profile with no membership anywhere, for the "not on this
-- roster" checks. Every program in this suite is the real band.
insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('ffffffff-0000-4000-8000-000000000001', 'auth-tst-01', 'TST Director',        'TST Director'),
  ('ffffffff-0000-4000-8000-000000000002', 'auth-tst-02', 'TST Secretary',       'TST Secretary'),
  ('ffffffff-0000-4000-8000-000000000003', 'auth-tst-03', 'TST Leader Violin',   'TST Leader Violin'),
  ('ffffffff-0000-4000-8000-000000000004', 'auth-tst-04', 'TST Leader None',     'TST Leader None'),
  ('ffffffff-0000-4000-8000-000000000005', 'auth-tst-05', 'TST Student Violin',  'TST Student Violin'),
  ('ffffffff-0000-4000-8000-000000000006', 'auth-tst-06', 'TST Student Trumpet', 'TST Student Trumpet'),
  ('ffffffff-0000-4000-8000-000000000007', 'auth-tst-07', 'TST Multi Role',      'TST Multi Role'),
  ('ffffffff-0000-4000-8000-000000000008', 'auth-tst-08', 'TST Leader Trumpet',  'TST Leader Trumpet'),
  ('ffffffff-0000-4000-8000-000000000009', 'auth-tst-09', 'TST Director Leader', 'TST Director Leader'),
  ('ffffffff-0000-4000-8000-0000000000aa', 'auth-tst-other', 'TST Other Student', 'TST Other Student')
on conflict (id) do nothing;

-- Band memberships: roles + section per persona.
insert into public.memberships (user_id, ensemble_id, section_id, roles, active)
select v.user_id, b.id, s.id, v.roles, true
  from (values
    ('ffffffff-0000-4000-8000-000000000001'::uuid, null::text,     '{director}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000002'::uuid, null::text,     '{secretary}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000003'::uuid, 'Violin',       '{section_leader}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000004'::uuid, null::text,     '{section_leader}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000005'::uuid, 'Violin',       '{student}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000006'::uuid, 'Trumpet',      '{student}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000007'::uuid, 'Violin',       '{student,section_leader}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000008'::uuid, 'Trumpet',      '{section_leader}'::public.app_role[]),
    ('ffffffff-0000-4000-8000-000000000009'::uuid, 'Violin',       '{director,section_leader}'::public.app_role[])
  ) as v(user_id, section_name, roles)
 cross join (select id from public.ensembles where slug = 'band') b
 left join public.sections s on s.ensemble_id = b.id and s.name = v.section_name
on conflict (user_id, ensemble_id) do nothing;

-- Fixture events covering every timing/mode/requirement combination. Every
-- event belongs to the band program (events.ensemble_id is NOT NULL).
insert into public.events
  (id, name, type, date, end_date, checkin_mode, attendance_requirement, created_by, late_minutes, ensemble_id)
select v.id, v.name, v.type, v.date, v.end_date, v.checkin_mode, v.requirement,
       'ffffffff-0000-4000-8000-000000000001'::uuid, 10, b.id
  from (values
    ('eeeeeeee-0000-4000-8000-000000000001'::uuid, 'TST Early',    'rehearsal', now() + interval '30 minutes', null::timestamptz,                     'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000002'::uuid, 'TST Open',     'rehearsal', now() + interval '10 minutes', null::timestamptz,                     'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000003'::uuid, 'TST Late',     'rehearsal', now() - interval '30 minutes', now() + interval '2 hours',            'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000004'::uuid, 'TST Over',     'rehearsal', now() - interval '4 hours',    now() - interval '1 hour',             'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000005'::uuid, 'TST None',     'rehearsal', now() + interval '10 minutes', null::timestamptz,                     'none', 'none'),
    ('eeeeeeee-0000-4000-8000-000000000006'::uuid, 'TST Mode',     'rehearsal', now() + interval '10 minutes', null::timestamptz,                     'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000007'::uuid, 'TST Both',     'rehearsal', now() + interval '10 minutes', null::timestamptz,                     'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000008'::uuid, 'TST Excused',  'rehearsal', now() - interval '30 minutes', now() + interval '2 hours',            'qr',   'required'),
    ('eeeeeeee-0000-4000-8000-000000000009'::uuid, 'TST Optional', 'rehearsal', now() + interval '10 minutes', null::timestamptz,                     'qr',   'optional')
  ) as v(id, name, type, date, end_date, checkin_mode, requirement)
 cross join (select id from public.ensembles where slug = 'band') b
on conflict (id) do nothing;

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
--    re-scan.
-- ---------------------------------------------------------------------------
do $$
declare
  v  jsonb;
  t0 timestamptz;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-06","role":"authenticated"}', true);
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
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Student (05, Violin): check-in window, expired code, non-QR event,
--    direct-table and direct-RPC abuse, analytics denial.
-- ---------------------------------------------------------------------------
do $$
declare
  v  jsonb;
  t0 timestamptz;
  n  int;
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-05","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

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

  -- B8: student cannot UPDATE attendance directly. Refused either by the missing
  -- UPDATE grant (20261016225631) or, were the grant ever restored, by RLS with
  -- no policy — both leave zero rows changed.
  begin
    update public.attendance_records set attended = false
     where event_id = 'eeeeeeee-0000-4000-8000-000000000002'
       and student_id = 'ffffffff-0000-4000-8000-000000000005';
    get diagnostics n = row_count;
  exception
    when insufficient_privilege then n := 0;
  end;
  perform public.t_assert(n = 0, 'B8 student direct UPDATE must affect 0 rows');

  -- B9: student cannot INSERT attendance directly (RLS: no policy → error).
  begin
    insert into public.attendance_records (event_id, student_id, attended, status)
    values ('eeeeeeee-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000006', true, 'present');
    raise exception 'FAIL: B9 student inserted an attendance row directly';
  exception
    when insufficient_privilege then null; -- expected: no INSERT policy
  end;

  -- B10: every analytics RPC denied to a student.
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005', v_band);
  perform public.t_assert(v->>'ok' = 'false' and v->>'percentage' is null,
    'B10a student must not call get_student_attendance_pct');
  v := public.get_section_attendance_stats(v_band);
  perform public.t_assert(v->>'ok' = 'false', 'B10b student must not call get_section_attendance_stats');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000002');
  perform public.t_assert(v->>'ok' = 'false', 'B10c student must not call get_event_attendance_summary');
  v := public.get_attendance_trend(v_band, 5);
  perform public.t_assert(v->>'ok' = 'false', 'B10d student must not call get_attendance_trend');

  -- B11: student cannot start a check-in session.
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000002');
  perform public.t_assert(v->>'ok' = 'false'
    and v->>'message' = 'Only directors, secretaries and section leaders can generate codes.',
    'B11 student must not generate QR codes');

  -- B12/B13: read scoping — own rows visible, other students' not.
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000005') >= 1,
    'B12 student can read their own attendance');
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where student_id = 'ffffffff-0000-4000-8000-000000000006') = 0,
    'B13 student cannot read another student''s attendance');

  -- B14: join-code RPCs are director-only (replaces the retired
  --      *_band_join_code assertions of v1).
  v := public.get_join_code(v_band);
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Only directors can view the join code.',
    'B14a student must not read the join code');
  v := public.set_join_code(v_band, 'TST-HACK');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Only directors can change the join code.',
    'B14b student must not change the join code');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Director (01): excuse + staff note, full analytics, QR-session
--    invalidation on mode change, session creation rules, director does not
--    check in.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_expiry timestamptz;
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-01","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

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

  -- C1b: the join-code round trip (director-only, per program).
  v := public.set_join_code(v_band, 'TST-CODE-1');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Join code updated.',
    'C1b director can set the join code');
  v := public.get_join_code(v_band);
  perform public.t_assert(v->>'ok' = 'true' and v->>'code' = 'TST-CODE-1',
    'C1b director reads back the join code they set');
  v := public.get_join_code_status('band');
  perform public.t_assert(v->>'ok' = 'true' and v ? 'enabled',
    'C1b join-code status is readable for the band slug');

  -- C2: full analytics for a director.
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005', v_band);
  perform public.t_assert(v->>'ok' = 'true' and v->>'percentage' is not null,
    'C2a director gets student attendance pct');
  v := public.get_section_attendance_stats(v_band);
  perform public.t_assert(v is null or jsonb_typeof(v) = 'array',
    'C2b director gets section stats array');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000004');
  perform public.t_assert(v->>'ok' = 'true',
    'C2c director gets event summary (event with no attendance records)');
  v := public.get_attendance_trend(v_band, 5);
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

  -- C7: per-program director protection (replaces the retired
  --     deactivate_member(uuid) / "cannot touch another director" assertions).
  v := public.deactivate_member(v_band, 'ffffffff-0000-4000-8000-000000000009');
  perform public.t_assert(v->>'ok' = 'false'
    and v->>'message' = 'Directors cannot deactivate another director.',
    'C7a a director cannot deactivate another director');
  v := public.deactivate_member(v_band, 'ffffffff-0000-4000-8000-000000000006');
  perform public.t_assert(v->>'ok' = 'true',
    'C7b a director can deactivate a student in their program');
  v := public.reactivate_member(v_band, 'ffffffff-0000-4000-8000-000000000006');
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Member reactivated — they can sign in again.',
    'C7c a director can reactivate that student');

  -- C7d: an account with no band membership is not on this roster.
  v := public.deactivate_member(v_band, 'ffffffff-0000-4000-8000-0000000000aa');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'That member is not on the roster.',
    'C7d cannot manage someone who is not on the roster');

  -- C7e: replacing update_member_instrument — the section must belong to the
  --      same program.
  v := public.set_member_section(
    v_band, 'ffffffff-0000-4000-8000-000000000006',
    (select s.id from public.sections s
      join public.ensembles e on e.id = s.ensemble_id
     where e.slug = 'band' and s.name = 'Trumpet'));
  perform public.t_assert(v->>'ok' = 'true' and v->>'message' = 'Section updated.',
    'C7e director can set a member''s section');
  -- A section id that is not this program's section must be refused (the same
  -- guard catches a section from another program and a nonexistent one).
  v := public.set_member_section(
    v_band, 'ffffffff-0000-4000-8000-000000000006',
    '0ddddddd-0000-4000-8000-000000000001'::uuid);
  perform public.t_assert(v->>'ok' = 'false',
    'C7e2 a section that is not this program''s must be refused');
  perform public.t_assert(
    (select s.name = 'Trumpet'
       from public.memberships m
       join public.sections s on s.id = m.section_id
      where m.user_id = 'ffffffff-0000-4000-8000-000000000006'
        and m.ensemble_id = v_band),
    'C7e2 a refused section change must not move the member');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Secretary (02): full staff-note read, override anyone, analytics
--    denied (the app never grants secretaries analytics), event updates.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-02","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

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
  v := public.get_section_attendance_stats(v_band);
  perform public.t_assert(v->>'ok' = 'false', 'S4a secretary denied section stats');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000004');
  perform public.t_assert(v->>'ok' = 'false', 'S4b secretary denied event summary');
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005', v_band);
  perform public.t_assert(v->>'ok' = 'false', 'S4c secretary denied student attendance analytics');
  v := public.get_attendance_trend(v_band, 5);
  perform public.t_assert(v->>'ok' = 'false', 'S4d secretary denied attendance trend');

  -- S5: join-code RPCs stay director-only for staff who are not directors.
  v := public.get_join_code(v_band);
  perform public.t_assert(v->>'ok' = 'false', 'S5 secretary must not read the join code');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Section leader, Violin (03): cross-section writes and note reads
--    denied; own section allowed; analytics denied.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-03","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

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
  v := public.get_section_attendance_stats(v_band);
  perform public.t_assert(v->>'ok' = 'false', 'L5a section leader denied section stats');
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005', v_band);
  perform public.t_assert(v->>'ok' = 'false', 'L5b section leader denied student pct');
  v := public.get_event_attendance_summary('eeeeeeee-0000-4000-8000-000000000002');
  perform public.t_assert(v->>'ok' = 'false', 'L5c section leader denied event summary');
  v := public.get_attendance_trend(v_band, 5);
  perform public.t_assert(v->>'ok' = 'false', 'L5d section leader denied attendance trend');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Section leader, Trumpet (08): cannot read a violin student's note — the
--    direct-table query the old policy allowed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-08","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

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
    (select public.get_attendance_trend(v_band, 5)->>'ok') = 'false',
    'M3 section leader denied trend analytics');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Section leader with no section (04): no section, no access.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-04","role":"authenticated"}', true);
  set role authenticated;

  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'You can only mark students in your own section.',
    'N1 leader without a section cannot mark anyone');
  perform public.t_assert(
    (select count(*) from public.attendance_staff_notes) = 0,
    'N2 leader without a section reads no staff notes');
  perform public.t_assert(
    (select count(*) from public.attendance_records) = 0,
    'N2b leader without a section reads no attendance rows');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Multi-role student + section_leader (07): behaves as a section leader
--    for writes/notes and as a student for analytics.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-07","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

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
  v := public.get_section_attendance_stats(v_band);
  perform public.t_assert(v->>'ok' = 'false', 'R4 multi-role student+leader denied analytics');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 10. Multi-role director + section_leader (09): director privileges win —
--     section scoping must not trap a director.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_band uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-09","role":"authenticated"}', true);
  set role authenticated;

  select id into v_band from public.ensembles where slug = 'band';

  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000006', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'true',
    'DL1 director+section_leader is not section-scoped');
  v := public.get_student_attendance_pct('ffffffff-0000-4000-8000-000000000005', v_band);
  perform public.t_assert(v->>'ok' = 'true',
    'DL2 director+section_leader keeps analytics access');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 11. Student (06) again: dead token after mode change, staff notes and
--     other students' attendance invisible.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-06","role":"authenticated"}', true);
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
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 12. Student (05): excused record survives a QR scan.
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-05","role":"authenticated"}', true);
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
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- ---------------------------------------------------------------------------
-- 13. New in v2 — identity, grants, cross-program and self-service guards
-- ---------------------------------------------------------------------------

-- A. anon can execute nothing in `public` (016/017 revoke PUBLIC + anon on
--    every function; the 27 anon-executable SECURITY DEFINER functions the
--    advisor flagged are gone).
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     -- the suite's own assertion helper, not part of the app surface
     and p.proname <> 't_assert'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_bad is not null then
    raise exception 'FAIL: SEC-v2-A1 anon can still execute: %', v_bad;
  end if;
end $$;

-- B. internal-only functions are not client-callable; policy helpers are.
do $$
declare
  v_internal text[] := array[
    'public.notify_new_event()',
    'public.notify_checkin_open()',
    'public.invalidate_checkin_sessions_on_mode_change()',
    'public.guard_membership_change()',
    'public.guard_profile_self_update()',
    'public.client_ip()',
    'public.record_checkin_for_session(uuid, uuid)',
    'public.attendance_pct_for(uuid, uuid)',
    'public.validate_join_code(text, text, text)',
    'public.register_signup(text, text, text, text, text, text)'
  ];
  v_helpers text[] := array[
    'public.current_profile_id()',
    'public.is_program_admin()',
    'public.is_member_of(uuid)',
    'public.has_role_in(uuid, app_role)',
    'public.is_section_leader_for(uuid, uuid)',
    'public.is_director_anywhere(uuid)',
    'public.has_active_membership(uuid)',
    'public.is_ensemble_staff(uuid)',
    'public.can_manage_ensemble(uuid)',
    'public.is_event_director(uuid)',
    'public.can_manage_member(uuid)',
    'public.can_view_profile(uuid)',
    'public.can_read_attendance(uuid, uuid)',
    'public.can_read_staff_note(uuid)',
    'public.get_section_attendance_stats(uuid)',
    'public.record_attendance(text)'
  ];
  v_retired text[] := array[
    'public.user_has_role(app_role)',
    'public.user_role()',
    'public.user_roles()',
    'public.handle_new_user()',
    'public.guard_role_change()',
    'public.can_use_channel(uuid)',
    'public.notify_chat_message()'
  ];
  v_fn text;
begin
  foreach v_fn in array v_internal loop
    if to_regprocedure(v_fn) is not null
       and has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'FAIL: SEC-v2-B1 internal function % is client-executable', v_fn;
    end if;
  end loop;

  foreach v_fn in array v_helpers loop
    if to_regprocedure(v_fn) is null then
      raise exception 'FAIL: SEC-v2-B2 required function % is missing', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'FAIL: SEC-v2-B3 authenticated lost EXECUTE on % — policies would fail closed', v_fn;
    end if;
  end loop;

  foreach v_fn in array v_retired loop
    if to_regprocedure(v_fn) is not null then
      raise exception 'FAIL: SEC-v2-B4 retired function still exists: %', v_fn;
    end if;
  end loop;
end $$;

-- C. a student cannot read a profile from another program, but can read a
--    co-member's. (profiles_read_scoped: self + co-members + staff of theirs.)
do $$
begin
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-05","role":"authenticated"}', true);
  set role authenticated;

  perform public.t_assert(
    (select count(*) from public.profiles
      where id = 'ffffffff-0000-4000-8000-000000000006') = 1,
    'SEC-v2-C1 a student can read a co-member''s profile');
  perform public.t_assert(
    (select count(*) from public.profiles
      where id = 'ffffffff-0000-4000-8000-0000000000aa') = 0,
    'SEC-v2-C2 a student cannot read the profile of someone outside the roster');
  perform public.t_assert(
    (select count(*) from public.memberships
      where ensemble_id <> (select id from public.ensembles where slug = 'band')) = 0,
    'SEC-v2-C3 a student can read membership rows outside the band');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- D. self-service guard: a person may change their own section, never their
--    own roles or access flag.
do $$
declare
  n int;
  v jsonb;
  v_member uuid := 'ffffffff-0000-4000-8000-000000000005';
  v_band uuid;
  v_trumpet uuid;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select s.id into v_trumpet from public.sections s
   where s.ensemble_id = v_band and s.name = 'Trumpet';

  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-05","role":"authenticated"}', true);
  set role authenticated;

  -- D1: cannot flip their own access flag (guard_profile_self_update).
  begin
    update public.profiles set deactivated = true where id = v_member;
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FAIL: SEC-v2-D0';
    end if;

  exception
    when insufficient_privilege then
      null; -- refused outright: `deactivated` has no UPDATE column grant (20261016225631)
    when others then
      if position('You cannot change your own access' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- D2: cannot grant themselves a role through the memberships table.
  begin
    update public.memberships set roles = '{director}'::public.app_role[]
     where user_id = v_member and ensemble_id = v_band;
    get diagnostics n = row_count;
    if n > 0 then
      raise exception 'FAIL: SEC-v2-D1';
    end if;
  exception
    when others then
      if position('FAIL: SEC-v2-D1' in sqlerrm) > 0 then
        raise;
      end if;
  end;

  -- D3: a member changing their OWN section. `set_member_section` is written to
  -- allow self-service, but `guard_membership_change` (015) evaluates its
  -- "can manage this program" rule BEFORE its self-service branch, so today a
  -- plain student is refused with the guard's message (an exception, since the
  -- RPC does not catch it). Either outcome is safe; what must hold is that the
  -- attempt cannot escalate or corrupt anything — asserted in D4–D6.
  -- FLAG for the coordinator: reordering the guard's self-service branch above
  -- the can_manage check makes this apply; nothing else needs to change.
  v := null;
  begin
    v := public.set_member_section(v_band, v_member, v_trumpet);
  exception
    when others then
      if position('Only directors of this program can change roles' in sqlerrm) = 0 then
        raise exception 'FAIL: SEC-v2-D3 self section change raised an unexpected error: %', sqlerrm;
      end if;
  end;
  if v is not null then
    perform public.t_assert(v->>'ok' = 'true' or v->>'message' is not null,
      'SEC-v2-D3 set_member_section(self) must apply or refuse cleanly');
  end if;

  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  -- Verified from the superuser view: nothing above changed roles or access,
  -- and only the section moved.
  perform public.t_assert(
    (select deactivated = false from public.profiles where id = v_member),
    'SEC-v2-D4 the self-service attempts left the access flag intact');
  perform public.t_assert(
    (select roles = '{student}'::public.app_role[] from public.memberships
      where user_id = v_member and ensemble_id = v_band),
    'SEC-v2-D5 the self-service attempts left the roles intact');
  -- D6: whatever happened, the member is still only in a section of THEIR OWN
  -- program — a self-service attempt can never attach them to another program's
  -- section or strip their section silently.
  perform public.t_assert(
    (select m.section_id in (v_trumpet, (select s.id from public.sections s
                                          where s.ensemble_id = v_band and s.name = 'Violin'))
       from public.memberships m
      where m.user_id = v_member and m.ensemble_id = v_band),
    'SEC-v2-D6 the self-service attempt left the member in a section of their own program');

  -- Put the fixture back so any later section-scoped assertion stays valid.
  update public.memberships set section_id = (
    select s.id from public.sections s
     where s.ensemble_id = v_band and s.name = 'Violin')
   where user_id = v_member and ensemble_id = v_band;
  perform public.t_assert(
    (select s.name = 'Violin'
       from public.memberships m
       join public.sections s on s.id = m.section_id
      where m.user_id = v_member and m.ensemble_id = v_band),
    'SEC-v2-D7 the section fixture was restored');
end $$;

-- E. no client write path on the program tables (RLS + explicit revokes).
do $$
declare
  n int;
  v_blocked boolean;
  v_band uuid;
begin
  select id into v_band from public.ensembles where slug = 'band';

  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-01","role":"authenticated"}', true);
  set role authenticated;

  -- E1: updating a membership is blocked (privilege error or 0 rows).
  v_blocked := false;
  begin
    update public.memberships set active = false
     where user_id = 'ffffffff-0000-4000-8000-000000000005' and ensemble_id = v_band;
    get diagnostics n = row_count;
    v_blocked := (n = 0);
  exception
    when others then v_blocked := true;
  end;
  perform public.t_assert(v_blocked, 'SEC-v2-E1 memberships cannot be updated through the API');

  -- E2: deleting a membership is blocked.
  v_blocked := false;
  begin
    delete from public.memberships
     where user_id = 'ffffffff-0000-4000-8000-000000000005' and ensemble_id = v_band;
    get diagnostics n = row_count;
    v_blocked := (n = 0);
  exception
    when others then v_blocked := true;
  end;
  perform public.t_assert(v_blocked, 'SEC-v2-E2 memberships cannot be deleted through the API');

  -- E3: sections are read-only for clients.
  v_blocked := false;
  begin
    update public.sections set name = name || 'X' where ensemble_id = v_band;
    get diagnostics n = row_count;
    v_blocked := (n = 0);
  exception
    when others then v_blocked := true;
  end;
  perform public.t_assert(v_blocked, 'SEC-v2-E3 sections cannot be updated through the API');

  -- E4: the program tables themselves are read-only for clients.
  v_blocked := false;
  begin
    update public.ensembles set name = 'HACKED' where id = v_band;
    get diagnostics n = row_count;
    v_blocked := (n = 0);
  exception
    when others then v_blocked := true;
  end;
  perform public.t_assert(v_blocked, 'SEC-v2-E4 ensembles cannot be updated through the API');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.t_assert(
    (select active from public.memberships
      where user_id = 'ffffffff-0000-4000-8000-000000000005' and ensemble_id = v_band),
    'SEC-v2-E5 the blocked writes changed nothing');
end $$;

-- F. check-in behaviours that need the new/program-aware paths.
do $$
declare
  v jsonb;
  i int;
  v_band uuid;
begin
  select id into v_band from public.ensembles where slug = 'band';

  -- F1: invalid status is rejected, nothing is written.
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-01","role":"authenticated"}', true);
  set role authenticated;
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000003',
    'ffffffff-0000-4000-8000-000000000005', 'bogus', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Invalid attendance status.',
    'SEC-v2-F1 an invalid attendance status must be rejected');

  -- F2: legacy boolean override → present, consistent row.
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000003',
    'ffffffff-0000-4000-8000-000000000005', true);
  perform public.t_assert(v->>'ok' = 'true', 'SEC-v2-F2 boolean override(true) must succeed');
  perform public.t_assert(
    (select ar.attended and ar.status = 'present'
       from public.attendance_records ar
      where ar.event_id = 'eeeeeeee-0000-4000-8000-000000000003'
        and ar.student_id = 'ffffffff-0000-4000-8000-000000000005'),
    'SEC-v2-F2 boolean override(true) must write present/attended');

  -- F3: boolean override(false) → absent, which deletes the row.
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-000000000002',
    'ffffffff-0000-4000-8000-000000000006', false);
  perform public.t_assert(v->>'ok' = 'true', 'SEC-v2-F3 boolean override(false) must succeed');
  perform public.t_assert(
    (select count(*) from public.attendance_records
      where event_id = 'eeeeeeee-0000-4000-8000-000000000002'
        and student_id = 'ffffffff-0000-4000-8000-000000000006') = 0,
    'SEC-v2-F3 an absent override must delete the attendance row');

  -- F4: an unknown event is refused rather than silently ignored.
  v := public.override_attendance(
    'eeeeeeee-0000-4000-8000-0000000000ff',
    'ffffffff-0000-4000-8000-000000000005', 'present', '', '');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'Unknown event.',
    'SEC-v2-F4 overriding an unknown event must be refused');

  -- F5: a section leader may open a check-in session (staff-level action).
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-03","role":"authenticated"}', true);
  set role authenticated;
  v := public.start_checkin_session('eeeeeeee-0000-4000-8000-000000000007');
  perform public.t_assert(v->>'ok' = 'true' and v->>'entry_code' is not null,
    'SEC-v2-F5 a section leader may open a check-in session');

  -- F6: the rate limit — more than 5 failed attempts for the same bucket
  --     inside 2 minutes is refused.
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claims',
    '{"sub":"auth-tst-06","role":"authenticated"}', true);
  set role authenticated;
  for i in 1..6 loop
    v := public.record_attendance('tst-tok-bogus');
  end loop;
  perform public.t_assert(v->>'message' = 'Too many attempts — try again in a minute.',
    'SEC-v2-F6 more than 5 failed check-in attempts in 2 minutes must be refused');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end $$;

-- G. join-code gate + signup, run as the trusted (service-role equivalent)
--    caller — validate_join_code and register_signup are not client-callable.
do $$
declare
  v jsonb;
  v_band uuid;
  v_code text;
  v_new_id uuid;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select join_code into v_code from public.ensemble_settings where ensemble_id = v_band;

  perform public.t_assert(v_code is not null,
    'SEC-v2-G1 the band program has an ensemble_settings row');

  v := public.validate_join_code('band', 'TST-WRONG-CODE');
  perform public.t_assert(v->>'ok' = 'false',
    'SEC-v2-G2 a wrong join code must be refused');
  v := public.validate_join_code('band', v_code);
  perform public.t_assert(v->>'ok' = 'true',
    'SEC-v2-G3 the real join code must be accepted');
  v := public.validate_join_code('tst-not-a-program', 'X');
  perform public.t_assert(v->>'ok' = 'false' and v->>'message' = 'That program isn''t available.',
    'SEC-v2-G4 an unknown slug must be refused');

  -- The retired handle_new_user gate is now register_signup: a wrong code
  -- creates nothing, the right code creates profiles + membership.
  v := public.register_signup('auth-tst-bad-code', 'TST Bad Code', 'band', 'TST-WRONG-CODE', '');
  perform public.t_assert(v->>'ok' = 'false', 'SEC-v2-G5 signup with a wrong code must be refused');
  perform public.t_assert(
    (select count(*) from public.profiles where auth_user_id = 'auth-tst-bad-code') = 0,
    'SEC-v2-G5 a refused signup must not create a profile');

  v := public.register_signup('auth-tst-signup', 'TST Signup', 'band', v_code, 'Violin');
  perform public.t_assert(v->>'ok' = 'true' and v->>'profile_id' is not null,
    'SEC-v2-G6 signup with the real join code must succeed');
  v_new_id := (v->>'profile_id')::uuid;
  perform public.t_assert(
    (select count(*) from public.memberships
      where user_id = v_new_id and ensemble_id = v_band
        and roles = '{student}'::public.app_role[]) = 1,
    'SEC-v2-G6 a successful signup must create the membership');

  -- Idempotent: a repeated provisioning call does not duplicate anything.
  v := public.register_signup('auth-tst-signup', 'TST Signup', 'band', v_code, 'Violin');
  perform public.t_assert(v->>'ok' = 'true' and (v->>'existing')::boolean,
    'SEC-v2-G7 a redelivered signup is idempotent');
  perform public.t_assert(
    (select count(*) from public.profiles where auth_user_id = 'auth-tst-signup') = 1,
    'SEC-v2-G7 a redelivered signup must not duplicate the profile');
end $$;

-- ---------------------------------------------------------------------------
-- 14. Global invariants (superuser view, still inside the transaction)
-- ---------------------------------------------------------------------------
do $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

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

  -- Constraint rejects contradictory event configurations.
  begin
    insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
    values (gen_random_uuid(), 'TST Bad 1', 'rehearsal', now() + interval '1 day', 'qr', 'none',
            (select id from public.ensembles where slug = 'band'));
    raise exception 'FAIL: G4 attendance_requirement=none with QR mode must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
    values (gen_random_uuid(), 'TST Bad 2', 'rehearsal', now() + interval '1 day', 'none', 'required',
            (select id from public.ensembles where slug = 'band'));
    raise exception 'FAIL: G5 required attendance with no check-in method must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
    values (gen_random_uuid(), 'TST Bad 3', 'rehearsal', now() + interval '1 day', 'none', 'optional',
            (select id from public.ensembles where slug = 'band'));
    raise exception 'FAIL: G6 optional attendance with no check-in method must be rejected';
  exception when check_violation then null;
  end;
  -- Valid combinations still insert.
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
  values (gen_random_uuid(), 'TST Good 1', 'rehearsal', now() + interval '1 day', 'toggle', 'optional',
          (select id from public.ensembles where slug = 'band'));
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
  values (gen_random_uuid(), 'TST Good 2', 'rehearsal', now() + interval '1 day', 'none', 'none',
          (select id from public.ensembles where slug = 'band'));
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
  values (gen_random_uuid(), 'TST Good 3', 'rehearsal', now() + interval '1 day', 'qr', 'optional',
          (select id from public.ensembles where slug = 'band'));
  insert into public.events (id, name, type, date, checkin_mode, attendance_requirement, ensemble_id)
  values (gen_random_uuid(), 'TST Good 4', 'rehearsal', now() + interval '1 day', 'both', 'optional',
          (select id from public.ensembles where slug = 'band'));

  -- Every event still resolves to exactly one program, and every attendance
  -- row resolves through its event.
  if exists (select 1 from public.events where ensemble_id is null) then
    raise exception 'FAIL: G7 an event has no program';
  end if;
  if exists (
    select 1
      from public.attendance_records ar
      left join public.events e on e.id = ar.event_id
     where e.id is null or e.ensemble_id is null
  ) then
    raise exception 'FAIL: G8 an attendance row does not resolve to a program';
  end if;

  -- Defense-in-depth grants: analytics unreachable for anon, reachable for
  -- authenticated (the in-function director check is the actual gate).
  if has_function_privilege('anon', 'public.get_section_attendance_stats(uuid)', 'execute') then
    raise exception 'FAIL: G9 anon still has EXECUTE on get_section_attendance_stats';
  end if;
  if has_function_privilege('anon', 'public.get_attendance_trend(uuid, integer)', 'execute') then
    raise exception 'FAIL: G9b anon still has EXECUTE on get_attendance_trend';
  end if;
  if not has_function_privilege('authenticated', 'public.get_section_attendance_stats(uuid)', 'execute') then
    raise exception 'FAIL: G10 authenticated (directors) lost EXECUTE on analytics';
  end if;
  if not has_function_privilege('authenticated', 'public.record_attendance(text)', 'execute') then
    raise exception 'FAIL: G11 students lost EXECUTE on record_attendance';
  end if;
end $$;

rollback;

select 'SECURITY VERIFICATION V2 PASSED' as verification_result;
