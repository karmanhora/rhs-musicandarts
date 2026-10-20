-- ============================================================================
-- event_announcements.sql — the new-event email announcement rules
-- ============================================================================
-- requires-table: public.event_announcement_deliveries
--
-- Asserts, in one transaction that is ROLLED BACK:
--   1. Only manually created events after the cutover, still to come, in an
--      active program and for active subscribed students are selected. Synced,
--      archived, already-started, pre-cutover and stale events are excluded.
--   2. Directors, secretaries, deactivated accounts, unconfirmed or missing
--      addresses, opted-out/inactive members and the event's creator are out;
--      section leaders are students and stay in.
--   3. Claiming is atomic and idempotent, a failure can be retried, a stale
--      in-flight claim is reclaimable, and three attempts is the limit.
--   4. Client roles cannot read the logs or call the queue functions.
--
-- On success: EVENT ANNOUNCEMENTS PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.due_event_announcements(timestamptz, integer)') is null then
    raise exception 'FAIL: EA-0 due_event_announcements() missing — apply the announcement migration first';
  end if;
  if to_regprocedure('public.claim_event_announcement(uuid, uuid, timestamptz)') is null then
    raise exception 'FAIL: EA-0 claim_event_announcement() missing';
  end if;
  if to_regprocedure('public.complete_event_announcement(uuid, boolean, text, text)') is null then
    raise exception 'FAIL: EA-0 complete_event_announcement() missing';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
update public.event_announcement_settings
   set enabled_since = '2026-11-10 00:00:00+00'
 where id;

insert into public.ensembles (id, slug, name, active) values
  ('03700000-0000-4000-8000-000000000001', 'ea-program-a', 'Announcement Program A', true),
  ('03700000-0000-4000-8000-000000000002', 'ea-program-b', 'Announcement Program B', true),
  ('03700000-0000-4000-8000-000000000003', 'ea-program-c', 'Announcement Program C (archived)', false);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('03700000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'ea-director@example.test',     now(), now(), now()),
  ('03700000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'ea-student@example.test',      now(), now(), now()),
  ('03700000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'ea-leader@example.test',       now(), now(), now()),
  ('03700000-0000-4000-8000-000000000104', 'authenticated', 'authenticated', 'ea-secretary@example.test',    now(), now(), now()),
  ('03700000-0000-4000-8000-000000000105', 'authenticated', 'authenticated', 'ea-deactivated@example.test',  now(), now(), now()),
  ('03700000-0000-4000-8000-000000000106', 'authenticated', 'authenticated', 'ea-unconfirmed@example.test',  null,  now(), now()),
  ('03700000-0000-4000-8000-000000000107', 'authenticated', 'authenticated', 'ea-optout@example.test',       now(), now(), now()),
  ('03700000-0000-4000-8000-000000000108', 'authenticated', 'authenticated', 'ea-other@example.test',        now(), now(), now()),
  ('03700000-0000-4000-8000-000000000109', 'authenticated', 'authenticated', 'ea-inactive@example.test',     now(), now(), now()),
  ('03700000-0000-4000-8000-00000000010a', 'authenticated', 'authenticated', null,                            now(), now(), now());

insert into public.profiles (id, auth_user_id, full_name, display_name, deactivated) values
  ('03700000-0000-4000-8000-000000000201', '03700000-0000-4000-8000-000000000101', 'EA Director',    'Dana Director', false),
  ('03700000-0000-4000-8000-000000000202', '03700000-0000-4000-8000-000000000102', 'EA Student',     '',              false),
  ('03700000-0000-4000-8000-000000000203', '03700000-0000-4000-8000-000000000103', 'EA Leader',      'Lee Leader',    false),
  ('03700000-0000-4000-8000-000000000204', '03700000-0000-4000-8000-000000000104', 'EA Secretary',   'Sam Secretary', false),
  ('03700000-0000-4000-8000-000000000205', '03700000-0000-4000-8000-000000000105', 'EA Deactivated', '',              true),
  ('03700000-0000-4000-8000-000000000206', '03700000-0000-4000-8000-000000000106', 'EA Unconfirmed', '',              false),
  ('03700000-0000-4000-8000-000000000207', '03700000-0000-4000-8000-000000000107', 'EA Optout',      '',              false),
  ('03700000-0000-4000-8000-000000000208', '03700000-0000-4000-8000-000000000108', 'EA Other',       '',              false),
  ('03700000-0000-4000-8000-000000000209', '03700000-0000-4000-8000-000000000109', 'EA Inactive',    '',              false),
  ('03700000-0000-4000-8000-00000000020a', '03700000-0000-4000-8000-00000000010a', 'EA No Address',  '',              false),
  -- Never signed in: a roster row with no auth account.
  ('03700000-0000-4000-8000-00000000020b', null,                                     'EA No Account',  '',              false);

insert into public.memberships (user_id, ensemble_id, roles, active, email_upcoming_events) values
  ('03700000-0000-4000-8000-000000000201', '03700000-0000-4000-8000-000000000001', '{director}',       true, true),
  ('03700000-0000-4000-8000-000000000202', '03700000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03700000-0000-4000-8000-000000000203', '03700000-0000-4000-8000-000000000001', '{section_leader}', true, true),
  ('03700000-0000-4000-8000-000000000204', '03700000-0000-4000-8000-000000000001', '{secretary}',      true, true),
  ('03700000-0000-4000-8000-000000000205', '03700000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03700000-0000-4000-8000-000000000206', '03700000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03700000-0000-4000-8000-000000000207', '03700000-0000-4000-8000-000000000001', '{student}',        true, false),
  ('03700000-0000-4000-8000-000000000208', '03700000-0000-4000-8000-000000000002', '{student}',        true, true),
  ('03700000-0000-4000-8000-000000000209', '03700000-0000-4000-8000-000000000001', '{student}',        false, true),
  ('03700000-0000-4000-8000-00000000020a', '03700000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03700000-0000-4000-8000-00000000020b', '03700000-0000-4000-8000-000000000001', '{student}',        true, true);

-- Fixed clock: Sunday 2026-11-15 12:00 UTC (4am Pacific).
insert into public.events
  (id, name, type, date, end_date, all_day, location, ensemble_id, event_type,
   archived, event_source, created_by, created_at)
values
  -- Announced: future timed, future all-day (today), and the leader's own row.
  ('03700000-0000-4000-8000-000000000301', 'Fall Concert', 'Concert',
   '2026-11-20 23:00:00+00', '2026-11-21 01:00:00+00', false, 'RHS Auditorium',
   '03700000-0000-4000-8000-000000000001', 'concert', false, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-15 09:00:00+00'),

  ('03700000-0000-4000-8000-000000000302', 'Archived event', 'Rehearsal',
   '2026-11-21 20:00:00+00', null, false, '',
   '03700000-0000-4000-8000-000000000001', 'rehearsal', true, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-15 09:00:00+00'),

  ('03700000-0000-4000-8000-000000000303', 'Synced event', 'Rehearsal',
   '2026-11-22 20:00:00+00', null, false, '',
   '03700000-0000-4000-8000-000000000001', 'rehearsal', false, 'google_calendar',
   null, '2026-11-15 09:00:00+00'),

  ('03700000-0000-4000-8000-000000000304', 'Already started', 'Rehearsal',
   '2026-11-15 10:00:00+00', null, false, '',
   '03700000-0000-4000-8000-000000000001', 'rehearsal', false, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-15 09:00:00+00'),

  ('03700000-0000-4000-8000-000000000305', 'All-day festival', 'Event',
   '2026-11-15 08:00:00+00', null, true, 'RHS Campus',
   '03700000-0000-4000-8000-000000000001', 'event/activity', false, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-15 09:30:00+00'),

  -- Created before the cutover and before the seven-day lookback.
  ('03700000-0000-4000-8000-000000000306', 'Old announcement', 'Rehearsal',
   '2026-11-25 20:00:00+00', null, false, '',
   '03700000-0000-4000-8000-000000000001', 'rehearsal', false, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-01 09:00:00+00'),

  ('03700000-0000-4000-8000-000000000307', 'Stale announcement', 'Rehearsal',
   '2026-11-25 21:00:00+00', null, false, '',
   '03700000-0000-4000-8000-000000000001', 'rehearsal', false, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-07 09:00:00+00'),

  -- Archived program.
  ('03700000-0000-4000-8000-000000000308', 'Archived program event', 'Rehearsal',
   '2026-11-26 20:00:00+00', null, false, '',
   '03700000-0000-4000-8000-000000000003', 'rehearsal', false, 'manual',
   '03700000-0000-4000-8000-000000000201', '2026-11-15 09:00:00+00'),

  -- Created by the student: the creator is not mailed, the leader still is.
  ('03700000-0000-4000-8000-000000000309', 'Section warm-up', 'Section Meeting',
   '2026-11-27 20:00:00+00', null, false, 'Band Room',
   '03700000-0000-4000-8000-000000000001', 'section meeting', false, 'manual',
   '03700000-0000-4000-8000-000000000202', '2026-11-15 09:00:00+00');

-- ---------------------------------------------------------------------------
-- 1. The queue is exactly the five eligible (event, student) pairs
-- ---------------------------------------------------------------------------
create temp table ea_due on commit drop as
  select * from public.due_event_announcements('2026-11-15 12:00:00+00', 500);

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from ea_due;
  if v_count <> 5 then
    raise exception 'FAIL: EA-1 expected 5 due announcements, got % — %', v_count,
      (select string_agg(event_name || '/' || recipient, ', ' order by event_name) from ea_due);
  end if;

  if exists (select 1 from ea_due where event_id = '03700000-0000-4000-8000-000000000302') then
    raise exception 'FAIL: EA-1 an archived event was announced';
  end if;
  if exists (select 1 from ea_due where event_id = '03700000-0000-4000-8000-000000000303') then
    raise exception 'FAIL: EA-1 a calendar-synced event was announced';
  end if;
  if exists (select 1 from ea_due where event_id = '03700000-0000-4000-8000-000000000304') then
    raise exception 'FAIL: EA-1 an already-started timed event was announced';
  end if;
  if exists (select 1 from ea_due where event_id = '03700000-0000-4000-8000-000000000306') then
    raise exception 'FAIL: EA-1 an event created before the cutover was announced';
  end if;
  if exists (select 1 from ea_due where event_id = '03700000-0000-4000-8000-000000000307') then
    raise exception 'FAIL: EA-1 an event older than the lookback was announced';
  end if;
  if exists (select 1 from ea_due where event_id = '03700000-0000-4000-8000-000000000308') then
    raise exception 'FAIL: EA-1 an archived program event was announced';
  end if;

  -- The all-day event today is still announced.
  if (select count(*) from ea_due where event_id = '03700000-0000-4000-8000-000000000305') <> 2 then
    raise exception 'FAIL: EA-1 the all-day event did not reach both students';
  end if;

  -- The event creator (a student) is skipped; the section leader still gets it.
  if exists (
    select 1 from ea_due
     where event_id = '03700000-0000-4000-8000-000000000309'
       and user_id = '03700000-0000-4000-8000-000000000202'
  ) then
    raise exception 'FAIL: EA-1 the event creator was announced to themselves';
  end if;
  if not exists (
    select 1 from ea_due
     where event_id = '03700000-0000-4000-8000-000000000309'
       and user_id = '03700000-0000-4000-8000-000000000203'
  ) then
    raise exception 'FAIL: EA-1 the section leader did not get a section event';
  end if;

  if exists (
    select 1 from ea_due
     where user_id in (
       '03700000-0000-4000-8000-000000000201',
       '03700000-0000-4000-8000-000000000204',
       '03700000-0000-4000-8000-000000000205',
       '03700000-0000-4000-8000-000000000206',
       '03700000-0000-4000-8000-000000000207',
       '03700000-0000-4000-8000-000000000208',
       '03700000-0000-4000-8000-000000000209',
       '03700000-0000-4000-8000-00000000020a',
       '03700000-0000-4000-8000-00000000020b'
     )
  ) then
    raise exception 'FAIL: EA-1 an ineligible student was announced to';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Claim once, fail, retry, finish, and never send again
-- ---------------------------------------------------------------------------
do $$
declare
  v_first  uuid;
  v_again  uuid;
  v_retry  uuid;
  v_blocked uuid;
  v_count  integer;
begin
  v_first := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000301',
    '03700000-0000-4000-8000-000000000202',
    '2026-11-15 12:00:00+00');
  if v_first is null then
    raise exception 'FAIL: EA-2 the first claim was refused';
  end if;

  v_again := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000301',
    '03700000-0000-4000-8000-000000000202',
    '2026-11-15 12:00:00+00');
  if v_again is not null then
    raise exception 'FAIL: EA-2 an in-flight announcement was claimed twice';
  end if;

  if not public.complete_event_announcement(v_first, false, null, 'Resend said no') then
    raise exception 'FAIL: EA-2 the failure was not recorded';
  end if;

  v_retry := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000301',
    '03700000-0000-4000-8000-000000000202',
    '2026-11-15 12:00:00+00');
  if v_retry is null then
    raise exception 'FAIL: EA-2 a failed announcement was not retried';
  end if;

  select attempts into v_count
    from public.event_announcement_deliveries
   where event_id = '03700000-0000-4000-8000-000000000301'
     and user_id = '03700000-0000-4000-8000-000000000202';
  if v_count <> 2 then
    raise exception 'FAIL: EA-2 the retry did not increment attempts (got %)', v_count;
  end if;

  if not public.complete_event_announcement(v_retry, true, 'resend-id') then
    raise exception 'FAIL: EA-2 the accepted send was not recorded';
  end if;

  v_blocked := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000301',
    '03700000-0000-4000-8000-000000000202',
    '2026-11-15 12:00:00+00');
  if v_blocked is not null then
    raise exception 'FAIL: EA-2 a sent announcement was claimed again';
  end if;

  -- A stale in-flight claim is reclaimable, and the all-day event is eligible.
  v_first := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000305',
    '03700000-0000-4000-8000-000000000202',
    '2026-11-15 12:00:00+00');
  if v_first is null then
    raise exception 'FAIL: EA-2 the all-day announcement was refused';
  end if;
  update public.event_announcement_deliveries
     set claimed_at = now() - interval '20 minutes'
   where id = v_first;
  v_again := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000305',
    '03700000-0000-4000-8000-000000000202',
    '2026-11-15 12:00:00+00');
  if v_again is null then
    raise exception 'FAIL: EA-2 a stale in-flight claim was not reclaimable';
  end if;

  -- Three attempts is the limit.
  v_first := public.claim_event_announcement(
    '03700000-0000-4000-8000-000000000301',
    '03700000-0000-4000-8000-000000000203',
    '2026-11-15 12:00:00+00');
  if v_first is null then
    raise exception 'FAIL: EA-2 the section leader was refused';
  end if;
  update public.event_announcement_deliveries
     set status = 'failed', attempts = 3
   where event_id = '03700000-0000-4000-8000-000000000301'
     and user_id = '03700000-0000-4000-8000-000000000203';
  if public.claim_event_announcement(
       '03700000-0000-4000-8000-000000000301',
       '03700000-0000-4000-8000-000000000203',
       '2026-11-15 12:00:00+00') is not null then
    raise exception 'FAIL: EA-2 a fourth attempt was allowed';
  end if;

  -- Ineligible pairs cannot be claimed even by hand.
  if public.claim_event_announcement(
       '03700000-0000-4000-8000-000000000301',
       '03700000-0000-4000-8000-000000000201',
       '2026-11-15 12:00:00+00') is not null then
    raise exception 'FAIL: EA-2 a director was claimable';
  end if;
  if public.claim_event_announcement(
       '03700000-0000-4000-8000-000000000301',
       '03700000-0000-4000-8000-000000000207',
       '2026-11-15 12:00:00+00') is not null then
    raise exception 'FAIL: EA-2 an opted-out student was claimable';
  end if;
  if public.claim_event_announcement(
       '03700000-0000-4000-8000-000000000303',
       '03700000-0000-4000-8000-000000000202',
       '2026-11-15 12:00:00+00') is not null then
    raise exception 'FAIL: EA-2 a synced event was claimable';
  end if;
  if public.claim_event_announcement(
       '03700000-0000-4000-8000-000000000304',
       '03700000-0000-4000-8000-000000000202',
       '2026-11-15 12:00:00+00') is not null then
    raise exception 'FAIL: EA-2 an already-started event was claimable';
  end if;
  if public.claim_event_announcement(
       '03700000-0000-4000-8000-000000000309',
       '03700000-0000-4000-8000-000000000202',
       '2026-11-15 12:00:00+00') is not null then
    raise exception 'FAIL: EA-2 the creator was claimable';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Client roles can neither read the log nor call the mail functions
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
begin
  if has_table_privilege('authenticated', 'public.event_announcement_deliveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_announcement_deliveries', 'INSERT')
     or has_table_privilege('authenticated', 'public.event_announcement_settings', 'SELECT')
     or has_table_privilege('anon', 'public.event_announcement_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.event_announcement_settings', 'SELECT') then
    raise exception 'FAIL: EA-3 a client role holds a privilege on an announcement table';
  end if;

  if has_function_privilege('authenticated', 'public.due_event_announcements(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.due_event_announcements(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_event_announcement(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.complete_event_announcement(uuid, boolean, text, text)', 'EXECUTE') then
    raise exception 'FAIL: EA-3 a client role can call an announcement function';
  end if;

  if not has_function_privilege('service_role', 'public.due_event_announcements(timestamptz, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_event_announcement(uuid, uuid, timestamptz)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.complete_event_announcement(uuid, boolean, text, text)', 'EXECUTE') then
    raise exception 'FAIL: EA-3 service_role cannot call an announcement function';
  end if;

  perform set_config('request.jwt.claims',
    '{"sub":"03700000-0000-4000-8000-000000000101","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform count(*) from public.event_announcement_deliveries;
    v_blocked := false;
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  reset role;
  if not v_blocked then
    raise exception 'FAIL: EA-3 a director read the announcement log from a client session';
  end if;

  raise notice 'event announcements OK: cutover, eligibility, all-day window, claim idempotency, client logs closed';
end
$$;

rollback;

\echo 'EVENT ANNOUNCEMENTS PASSED'
