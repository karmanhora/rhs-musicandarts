-- ============================================================================
-- absence_request_emails.sql — who is emailed when a student asks to be excused
-- ============================================================================
-- requires-table: public.absence_request_email_deliveries
--
-- Covers migration 20261024223123. One transaction, ROLLED BACK.
--
-- Asserts:
--   AE-1  a program's director is due an email about a pending request, with
--         the student, event and reason the email renders
--   AE-2  the student asking is not mailed; a secretary, a section leader and
--         another program's director are not mailed either
--   AE-3  unconfirmed, missing, deactivated and inactive members are excluded
--   AE-4  a decided request, an archived event, a pre-cutover request and a
--         request older than the seven-day lookback are all excluded
--   AE-5  a claim is atomic: the second claim while in flight returns nothing
--   AE-6  a recorded failure can be retried, three attempts is the limit, and a
--         stale in-flight claim is reclaimable after fifteen minutes
--   AE-7  a request decided after it was queued is refused at claim time
--   AE-8  client roles can neither read the delivery log nor call the functions
--
-- On success: ABSENCE REQUEST EMAILS PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.due_absence_request_emails(timestamptz, integer)') is null then
    raise exception 'FAIL: AE-0 due_absence_request_emails() missing — apply 20261024223123 first';
  end if;
  if to_regprocedure('public.claim_absence_request_email(uuid, uuid, timestamptz)') is null then
    raise exception 'FAIL: AE-0 claim_absence_request_email() missing';
  end if;
  if to_regprocedure('public.complete_absence_request_email(uuid, boolean, text, text)') is null then
    raise exception 'FAIL: AE-0 complete_absence_request_email() missing';
  end if;
end
$$;

create or replace function public.ae_assert(condition boolean, label text)
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
-- A cutover in the past, so requests made "now" are eligible; one fixture
-- request is deliberately dated before it.
update public.absence_email_settings
   set enabled_since = '2026-10-01 00:00:00+00'
 where id;

insert into public.ensembles (id, slug, name, active) values
  ('6a000000-0000-4000-8000-0000000000a1', 'ae-program-a', 'AE Program A', true),
  ('6a000000-0000-4000-8000-0000000000b1', 'ae-program-b', 'AE Program B', true),
  ('6a000000-0000-4000-8000-0000000000c1', 'ae-program-c', 'AE Program C (archived)', false);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('6a000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'ae-director@example.test',    now(), now(), now()),
  ('6a000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'ae-secretary@example.test',   now(), now(), now()),
  ('6a000000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'ae-leader@example.test',      now(), now(), now()),
  ('6a000000-0000-4000-8000-000000000104', 'authenticated', 'authenticated', 'ae-student@example.test',     now(), now(), now()),
  ('6a000000-0000-4000-8000-000000000105', 'authenticated', 'authenticated', 'ae-director-b@example.test',  now(), now(), now()),
  ('6a000000-0000-4000-8000-000000000106', 'authenticated', 'authenticated', 'ae-unconfirmed@example.test', null,  now(), now()),
  ('6a000000-0000-4000-8000-000000000107', 'authenticated', 'authenticated', 'ae-deactivated@example.test', now(), now(), now()),
  ('6a000000-0000-4000-8000-000000000108', 'authenticated', 'authenticated', null,                          now(), now(), now());

insert into public.profiles (id, auth_user_id, full_name, display_name, deactivated) values
  ('6a000000-0000-4000-8000-000000000001', '6a000000-0000-4000-8000-000000000101', 'AE Director', 'AE Director', false),
  ('6a000000-0000-4000-8000-000000000002', '6a000000-0000-4000-8000-000000000102', 'AE Secretary', 'AE Secretary', false),
  ('6a000000-0000-4000-8000-000000000003', '6a000000-0000-4000-8000-000000000103', 'AE Leader', 'AE Leader', false),
  ('6a000000-0000-4000-8000-000000000004', '6a000000-0000-4000-8000-000000000104', 'AE Student One', '', false),
  ('6a000000-0000-4000-8000-000000000005', '6a000000-0000-4000-8000-000000000105', 'AE Director B', 'AE Director B', false),
  ('6a000000-0000-4000-8000-000000000006', '6a000000-0000-4000-8000-000000000106', 'AE Unconfirmed', 'AE Unconfirmed', false),
  ('6a000000-0000-4000-8000-000000000007', '6a000000-0000-4000-8000-000000000107', 'AE Deactivated', 'AE Deactivated', true),
  ('6a000000-0000-4000-8000-000000000008', '6a000000-0000-4000-8000-000000000108', 'AE No Email', 'AE No Email', false);

insert into public.events
  (id, ensemble_id, name, type, event_type, date, checkin_mode, attendance_requirement, archived)
values
  ('6a000000-0000-4000-8000-000000000201', '6a000000-0000-4000-8000-0000000000a1',
   'AE Concert Tomorrow', 'Concert', 'concert', now() + interval '1 day', 'toggle', 'required', false),
  -- Archived after its request exists: the guard trigger refuses a new request
  -- on an archived event, which is the behavior AE-4 relies on.
  ('6a000000-0000-4000-8000-000000000202', '6a000000-0000-4000-8000-0000000000a1',
   'AE Archived Event', 'Rehearsal', 'rehearsal', now() + interval '2 days', 'toggle', 'required', false),
  ('6a000000-0000-4000-8000-000000000203', '6a000000-0000-4000-8000-0000000000a1',
   'AE Decided Event', 'Rehearsal', 'rehearsal', now() + interval '3 days', 'toggle', 'required', false),
  ('6a000000-0000-4000-8000-000000000204', '6a000000-0000-4000-8000-0000000000a1',
   'AE Pre-Cutover Event', 'Rehearsal', 'rehearsal', now() + interval '4 days', 'toggle', 'required', false),
  ('6a000000-0000-4000-8000-000000000205', '6a000000-0000-4000-8000-0000000000a1',
   'AE Stale Event', 'Rehearsal', 'rehearsal', now() + interval '5 days', 'toggle', 'required', false);

insert into public.memberships (user_id, ensemble_id, roles, active) values
  ('6a000000-0000-4000-8000-000000000001', '6a000000-0000-4000-8000-0000000000a1', '{director}', true),
  ('6a000000-0000-4000-8000-000000000002', '6a000000-0000-4000-8000-0000000000a1', '{secretary}', true),
  ('6a000000-0000-4000-8000-000000000003', '6a000000-0000-4000-8000-0000000000a1', '{section_leader}', true),
  ('6a000000-0000-4000-8000-000000000004', '6a000000-0000-4000-8000-0000000000a1', '{student}', true),
  ('6a000000-0000-4000-8000-000000000005', '6a000000-0000-4000-8000-0000000000b1', '{director}', true),
  ('6a000000-0000-4000-8000-000000000006', '6a000000-0000-4000-8000-0000000000a1', '{director}', true),
  ('6a000000-0000-4000-8000-000000000007', '6a000000-0000-4000-8000-0000000000a1', '{director}', true),
  ('6a000000-0000-4000-8000-000000000008', '6a000000-0000-4000-8000-0000000000a1', '{director}', false);

-- Requests. Inserted directly so the fixture set covers states the RPCs would
-- not create (a pre-cutover row, a stale row, an already-decided row).
insert into public.absence_requests
  (id, ensemble_id, event_id, student_id, reason, status, created_at, updated_at)
values
  ('6a000000-0000-4000-8000-000000000301', '6a000000-0000-4000-8000-0000000000a1',
   '6a000000-0000-4000-8000-000000000201', '6a000000-0000-4000-8000-000000000004',
   'Family trip to Portland.', 'pending', now(), now()),
  ('6a000000-0000-4000-8000-000000000302', '6a000000-0000-4000-8000-0000000000a1',
   '6a000000-0000-4000-8000-000000000202', '6a000000-0000-4000-8000-000000000004',
   'Archived event request.', 'pending', now(), now()),
  ('6a000000-0000-4000-8000-000000000303', '6a000000-0000-4000-8000-0000000000a1',
   '6a000000-0000-4000-8000-000000000203', '6a000000-0000-4000-8000-000000000004',
   'Already approved.', 'pending', now(), now()),
  ('6a000000-0000-4000-8000-000000000304', '6a000000-0000-4000-8000-0000000000a1',
   '6a000000-0000-4000-8000-000000000204', '6a000000-0000-4000-8000-000000000004',
   'Before the cutover.', 'pending', '2026-09-01 12:00:00+00', '2026-09-01 12:00:00+00'),
  ('6a000000-0000-4000-8000-000000000305', '6a000000-0000-4000-8000-0000000000a1',
   '6a000000-0000-4000-8000-000000000205', '6a000000-0000-4000-8000-000000000004',
   'Stale, older than the lookback.', 'pending', '2026-10-10 12:00:00+00', '2026-10-10 12:00:00+00');

update public.events
   set archived = true
 where id = '6a000000-0000-4000-8000-000000000202';

update public.absence_requests
   set status = 'approved',
       decided_by = '6a000000-0000-4000-8000-000000000001',
       decided_at = now()
 where id = '6a000000-0000-4000-8000-000000000303';

-- ---------------------------------------------------------------------------
-- AE-1 / AE-2 / AE-3 / AE-4. Who is in the queue
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.due_absence_request_emails(now(), 200);
  perform public.ae_assert(v_count = 1,
    'AE-1 exactly one (request, reviewer) is due, got ' || v_count);

  -- The one due row is the live request, and it carries what the email renders.
  perform public.ae_assert(
    (select true from public.due_absence_request_emails(now(), 200)
      where request_id = '6a000000-0000-4000-8000-000000000301'
        and user_id = '6a000000-0000-4000-8000-000000000001'
        and email = 'ae-director@example.test'
        and recipient = 'AE Director'
        and program_name = 'AE Program A'
        and event_name = 'AE Concert Tomorrow'
        and student_name = 'AE Student One'
        and reason = 'Family trip to Portland.'),
    'AE-1 the due row carries the program, event, student and reason'
  );

  -- AE-2: the student, the secretary, the section leader and the other
  -- program's director are all outside the queue.
  perform public.ae_assert(
    not exists (
      select 1 from public.due_absence_request_emails(now(), 200)
       where user_id in ('6a000000-0000-4000-8000-000000000004',
                         '6a000000-0000-4000-8000-000000000002',
                         '6a000000-0000-4000-8000-000000000003',
                         '6a000000-0000-4000-8000-000000000005')
    ),
    'AE-2 the student, non-reviewers and another program''s director are not mailed'
  );

  -- AE-3: unconfirmed address, missing address, deactivated profile, inactive
  -- membership. Each of these holds the director role, so each would be in the
  -- queue on capability alone.
  perform public.ae_assert(
    not exists (
      select 1 from public.due_absence_request_emails(now(), 200)
       where user_id in ('6a000000-0000-4000-8000-000000000006',
                         '6a000000-0000-4000-8000-000000000007',
                         '6a000000-0000-4000-8000-000000000008')
    ),
    'AE-3 unconfirmed, missing, deactivated and inactive reviewers are excluded'
  );

  -- AE-4: a decided request, an archived event, a pre-cutover request and a
  -- request older than the seven-day lookback are all invisible.
  perform public.ae_assert(
    not exists (
      select 1 from public.due_absence_request_emails(now(), 200)
       where request_id in ('6a000000-0000-4000-8000-000000000302',
                            '6a000000-0000-4000-8000-000000000303',
                            '6a000000-0000-4000-8000-000000000304',
                            '6a000000-0000-4000-8000-000000000305')
    ),
    'AE-4 decided, archived, pre-cutover and stale requests are excluded'
  );

  -- The lookback is a window, not an absolute rule: the same request is due
  -- when the clock is close enough to it.
  perform public.ae_assert(
    exists (
      select 1 from public.due_absence_request_emails('2026-10-12 12:00:00+00', 200)
       where request_id = '6a000000-0000-4000-8000-000000000305'
    ),
    'AE-4b a request inside the lookback for its own clock is due'
  );

  -- A reviewer who is not on this program's roster never appears, even when
  -- they hold the capability elsewhere.
  perform public.ae_assert(
    not exists (
      select 1 from public.due_absence_request_emails('2026-10-12 12:00:00+00', 200)
       where user_id = '6a000000-0000-4000-8000-000000000005'
    ),
    'AE-4c another program''s director is never in this program''s queue'
  );

  -- Reading the queue changes nothing.
  perform public.ae_assert(
    (select count(*) from public.absence_request_email_deliveries) = 0,
    'AE-4d reading the queue writes no delivery row'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- AE-5 / AE-6 / AE-7. Claiming, retrying and deciding
-- ---------------------------------------------------------------------------
do $$
declare
  v_claim uuid;
  v_again uuid;
  v_status text;
  v_attempts integer;
begin
  -- AE-5: claim before sending. A second claim while the first is in flight is
  -- refused, which is what stops two overlapping cron runs mailing twice.
  v_claim := public.claim_absence_request_email(
    '6a000000-0000-4000-8000-000000000301',
    '6a000000-0000-4000-8000-000000000001',
    now());
  perform public.ae_assert(v_claim is not null, 'AE-5 the first claim succeeds');

  v_again := public.claim_absence_request_email(
    '6a000000-0000-4000-8000-000000000301',
    '6a000000-0000-4000-8000-000000000001',
    now());
  perform public.ae_assert(v_again is null, 'AE-5 a claim in flight cannot be taken twice');

  select status, attempts into v_status, v_attempts
    from public.absence_request_email_deliveries where id = v_claim;
  perform public.ae_assert(v_status = 'sending' and v_attempts = 1,
    'AE-5 the delivery row is claimed once, not incremented');

  -- A reviewed request leaves the queue while it is in flight.
  perform public.ae_assert(
    not exists (
      select 1 from public.due_absence_request_emails(now(), 200)
       where request_id = '6a000000-0000-4000-8000-000000000301'
    ),
    'AE-5 a claimed request is not offered again'
  );

  -- AE-6: a recorded failure is retryable, and the attempts are counted.
  perform public.ae_assert(
    public.complete_absence_request_email(v_claim, false, null, '421 sender blocked'),
    'AE-6 the failure is recorded');
  perform public.ae_assert(
    (select status = 'failed' and error = '421 sender blocked' and sent_at is null
       from public.absence_request_email_deliveries where id = v_claim),
    'AE-6 the row records the failure and no sent time');

  v_claim := public.claim_absence_request_email(
    '6a000000-0000-4000-8000-000000000301',
    '6a000000-0000-4000-8000-000000000001',
    now());
  perform public.ae_assert(v_claim is not null, 'AE-6 a failed send can be retried');
  perform public.ae_assert(
    (select attempts = 2 from public.absence_request_email_deliveries where id = v_claim),
    'AE-6 the retry increments the attempt count');
  perform public.complete_absence_request_email(v_claim, false, null, 'still blocked');

  v_claim := public.claim_absence_request_email(
    '6a000000-0000-4000-8000-000000000301',
    '6a000000-0000-4000-8000-000000000001',
    now());
  perform public.ae_assert(v_claim is not null, 'AE-6 a second retry is allowed');
  perform public.complete_absence_request_email(v_claim, false, null, 'third failure');

  -- Three attempts is the limit.
  v_again := public.claim_absence_request_email(
    '6a000000-0000-4000-8000-000000000301',
    '6a000000-0000-4000-8000-000000000001',
    now());
  perform public.ae_assert(v_again is null, 'AE-6 a fourth attempt is refused');
  perform public.ae_assert(
    not exists (
      select 1 from public.due_absence_request_emails(now(), 200)
       where request_id = '6a000000-0000-4000-8000-000000000301'
    ),
    'AE-6 an exhausted request is dropped from the queue'
  );

  -- A claim left behind by a crashed run is reclaimable after fifteen minutes.
  update public.absence_request_email_deliveries
     set status = 'sending', attempts = 1, error = null,
         claimed_at = now() - interval '20 minutes'
   where request_id = '6a000000-0000-4000-8000-000000000301'
     and user_id = '6a000000-0000-4000-8000-000000000001';
  v_again := public.claim_absence_request_email(
    '6a000000-0000-4000-8000-000000000301',
    '6a000000-0000-4000-8000-000000000001',
    now());
  perform public.ae_assert(v_again is not null, 'AE-6 a stale in-flight claim is reclaimable');

  -- A success is final: the row is never offered again.
  perform public.complete_absence_request_email(v_again, true, 'resend-id-1', null);
  perform public.ae_assert(
    (select status = 'sent' and resend_email_id = 'resend-id-1' and sent_at is not null
       from public.absence_request_email_deliveries where id = v_again),
    'AE-6 a success records the Resend id and the send time');
  perform public.ae_assert(
    public.claim_absence_request_email(
      '6a000000-0000-4000-8000-000000000301',
      '6a000000-0000-4000-8000-000000000001',
      now()) is null,
    'AE-6 a sent email is never claimed again'
  );

  -- AE-7: a request decided between the queue read and the claim is refused.
  perform public.ae_assert(
    public.claim_absence_request_email(
      '6a000000-0000-4000-8000-000000000303',
      '6a000000-0000-4000-8000-000000000001',
      now()) is null,
    'AE-7 an already-decided request cannot be claimed'
  );

  update public.absence_requests
     set status = 'withdrawn'
   where id = '6a000000-0000-4000-8000-000000000301';
  perform public.ae_assert(
    public.claim_absence_request_email(
      '6a000000-0000-4000-8000-000000000301',
      '6a000000-0000-4000-8000-000000000001',
      now()) is null,
    'AE-7 a withdrawn request cannot be claimed'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- AE-8. Client roles
-- ---------------------------------------------------------------------------
do $$
begin
  perform public.ae_assert(
    not has_table_privilege('authenticated', 'public.absence_request_email_deliveries', 'SELECT')
    and not has_table_privilege('authenticated', 'public.absence_request_email_deliveries', 'INSERT')
    and not has_table_privilege('authenticated', 'public.absence_email_settings', 'SELECT')
    and not has_table_privilege('anon', 'public.absence_request_email_deliveries', 'SELECT')
    and not has_table_privilege('anon', 'public.absence_email_settings', 'SELECT'),
    'AE-8 a client role holds a privilege on an absence-email table'
  );

  perform public.ae_assert(
    not has_function_privilege('authenticated', 'public.due_absence_request_emails(timestamptz, integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.due_absence_request_emails(timestamptz, integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_absence_request_email(uuid, uuid, timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.complete_absence_request_email(uuid, boolean, text, text)', 'EXECUTE'),
    'AE-8 a client role can execute an absence-email function'
  );

  perform public.ae_assert(
    has_function_privilege('service_role', 'public.due_absence_request_emails(timestamptz, integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_absence_request_email(uuid, uuid, timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_absence_request_email(uuid, boolean, text, text)', 'EXECUTE'),
    'AE-8 service_role can execute every absence-email function'
  );
end
$$;

rollback;

select 'ABSENCE REQUEST EMAILS PASSED' as verification_result;
