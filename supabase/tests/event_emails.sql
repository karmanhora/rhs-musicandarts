-- ============================================================================
-- event_emails.sql — the 48-hour reminder and post-event make-up email rules
-- ============================================================================
-- requires-table: public.event_reminder_deliveries
--
-- Asserts, in one transaction that is ROLLED BACK:
--   Reminders
--   1. The due window: exactly 48 hours is due, 49 is not, under 12 hours is
--      not, a past event is not, an archived event is not, an inactive program
--      is not, and an event created after its own 48-hour mark is skipped.
--   2. Only the event's own program, active members, confirmed addresses,
--      subscribed members and student roles are selected. Directors, secretaries,
--      deactivated accounts, inactive memberships and unconfirmed/no addresses
--      are excluded.
--   3. Claiming is atomic and idempotent for one schedule. A reschedule creates
--      a new schedule version; a claim for the old one does not block the new
--      one and repeating the same one is a no-op.
--   4. A failed reminder can be retried, three attempts maximum, and the result
--      is recorded.
--   5. Two reminders 48 hours apart across both 2026 daylight-saving changes are
--      due at the same instant arithmetic.
--
--   Make-up email
--   6. The context is staff-only (director/secretary), with one reason per
--      disabled case: not ended, no end time, archived event, archived program.
--   7. Recipients are exactly confirmed absent + active + reachable students.
--      Present/late/excused, staff, deactivated, unconfirmed, removed and
--      other-program students are out; no-record students are listed separately.
--   8. The context carries no addresses.
--   9. Beginning a campaign refuses premature/unauthorized/archived sends, is
--      idempotent per operation, never re-sends an accepted recipient, allows a
--      deliberate new operation, and enforces the rate limit.
--  10. Client roles cannot reach the delivery tables or the service-role
--      functions.
--
-- On success: EVENT EMAILS PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.due_event_reminders(timestamptz, integer)') is null then
    raise exception 'FAIL: EE-0 due_event_reminders() missing — apply migration 036 first';
  end if;
  if to_regprocedure('public.makeup_email_context(uuid)') is null then
    raise exception 'FAIL: EE-0 makeup_email_context() missing — apply migration 036 first';
  end if;
  if to_regprocedure('public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[])') is null then
    raise exception 'FAIL: EE-0 begin_makeup_email_campaign() missing — apply migration 036 first';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into public.ensembles (id, slug, name, active) values
  ('03600000-0000-4000-8000-000000000001', 'mail-a', 'Mail Program A', true),
  ('03600000-0000-4000-8000-000000000002', 'mail-b', 'Mail Program B', true),
  ('03600000-0000-4000-8000-000000000003', 'mail-c', 'Mail Program C (archived)', false);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('03600000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'mail-director@example.test',      now(), now(), now()),
  ('03600000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'mail-student@example.test',       now(), now(), now()),
  ('03600000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'mail-leader@example.test',        now(), now(), now()),
  ('03600000-0000-4000-8000-000000000104', 'authenticated', 'authenticated', 'mail-secretary@example.test',     now(), now(), now()),
  ('03600000-0000-4000-8000-000000000105', 'authenticated', 'authenticated', 'mail-deactivated@example.test',   now(), now(), now()),
  ('03600000-0000-4000-8000-000000000106', 'authenticated', 'authenticated', 'mail-unconfirmed@example.test',   null,  now(), now()),
  ('03600000-0000-4000-8000-000000000107', 'authenticated', 'authenticated', 'mail-optout@example.test',        now(), now(), now()),
  ('03600000-0000-4000-8000-000000000108', 'authenticated', 'authenticated', 'mail-other-student@example.test', now(), now(), now()),
  ('03600000-0000-4000-8000-000000000109', 'authenticated', 'authenticated', 'mail-inactive@example.test',      now(), now(), now()),
  ('03600000-0000-4000-8000-00000000010a', 'authenticated', 'authenticated', null,                              now(), now(), now()),
  ('03600000-0000-4000-8000-00000000010c', 'authenticated', 'authenticated', 'mail-other-director@example.test',now(), now(), now()),
  ('03600000-0000-4000-8000-00000000010d', 'authenticated', 'authenticated', 'mail-unmarked@example.test',      now(), now(), now()),
  ('03600000-0000-4000-8000-00000000010e', 'authenticated', 'authenticated', 'mail-excused@example.test',       now(), now(), now()),
  ('03600000-0000-4000-8000-00000000010f', 'authenticated', 'authenticated', 'mail-present@example.test',       now(), now(), now()),
  ('03600000-0000-4000-8000-000000000110', 'authenticated', 'authenticated', 'mail-c-director@example.test',    now(), now(), now());

insert into public.profiles (id, auth_user_id, full_name, display_name, deactivated) values
  ('03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-000000000101', 'Mail Director',       'Dana Director',   false),
  ('03600000-0000-4000-8000-000000000202', '03600000-0000-4000-8000-000000000102', 'Mail Student',        '',                false),
  ('03600000-0000-4000-8000-000000000203', '03600000-0000-4000-8000-000000000103', 'Mail Leader',         'Lee Leader',      false),
  ('03600000-0000-4000-8000-000000000204', '03600000-0000-4000-8000-000000000104', 'Mail Secretary',      'Sam Secretary',   false),
  ('03600000-0000-4000-8000-000000000205', '03600000-0000-4000-8000-000000000105', 'Mail Deactivated',    '',                true),
  ('03600000-0000-4000-8000-000000000206', '03600000-0000-4000-8000-000000000106', 'Mail Unconfirmed',    '',                false),
  ('03600000-0000-4000-8000-000000000207', '03600000-0000-4000-8000-000000000107', 'Mail Optout',         '',                false),
  ('03600000-0000-4000-8000-000000000208', '03600000-0000-4000-8000-000000000108', 'Mail Other Student',  '',                false),
  ('03600000-0000-4000-8000-000000000209', '03600000-0000-4000-8000-000000000109', 'Mail Inactive',       '',                false),
  ('03600000-0000-4000-8000-00000000020a', '03600000-0000-4000-8000-00000000010a', 'Mail No Address',     '',                false),
  -- Never signed in: a roster row with no auth account.
  ('03600000-0000-4000-8000-00000000020b', null,                                     'Mail No Account',     '',                false),
  ('03600000-0000-4000-8000-00000000020c', '03600000-0000-4000-8000-00000000010c', 'Mail Other Director', 'Ollie Other',     false),
  ('03600000-0000-4000-8000-00000000020d', '03600000-0000-4000-8000-00000000010d', 'Mail Unmarked',       '',                false),
  ('03600000-0000-4000-8000-00000000020e', '03600000-0000-4000-8000-00000000010e', 'Mail Excused',        '',                false),
  ('03600000-0000-4000-8000-00000000020f', '03600000-0000-4000-8000-00000000010f', 'Mail Present',        '',                false),
  ('03600000-0000-4000-8000-000000000210', '03600000-0000-4000-8000-000000000110', 'Mail C Director',     '',                false);

insert into public.memberships (user_id, ensemble_id, roles, active, email_upcoming_events) values
  ('03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-000000000001', '{director}',       true, true),
  ('03600000-0000-4000-8000-000000000202', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-000000000203', '03600000-0000-4000-8000-000000000001', '{section_leader}', true, true),
  ('03600000-0000-4000-8000-000000000204', '03600000-0000-4000-8000-000000000001', '{secretary}',      true, true),
  ('03600000-0000-4000-8000-000000000205', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-000000000206', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-000000000207', '03600000-0000-4000-8000-000000000001', '{student}',        true, false),
  ('03600000-0000-4000-8000-000000000208', '03600000-0000-4000-8000-000000000002', '{student}',        true, true),
  ('03600000-0000-4000-8000-000000000209', '03600000-0000-4000-8000-000000000001', '{student}',        false, true),
  ('03600000-0000-4000-8000-00000000020a', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-00000000020b', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-00000000020c', '03600000-0000-4000-8000-000000000002', '{director}',       true, true),
  ('03600000-0000-4000-8000-00000000020d', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-00000000020e', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-00000000020f', '03600000-0000-4000-8000-000000000001', '{student}',        true, true),
  ('03600000-0000-4000-8000-000000000210', '03600000-0000-4000-8000-000000000003', '{director}',       true, true);

-- Reminder events. `now` is pinned so every boundary is exact.
--   2026-10-21 15:00 UTC
insert into public.events
  (id, name, type, date, end_date, ensemble_id, event_type, archived, created_at)
values
  ('03600000-0000-4000-8000-000000000001', 'Mail Due',        'Rehearsal', '2026-10-23 15:00:00+00', '2026-10-23 17:00:00+00', '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000002', 'Mail Too Far',    'Rehearsal', '2026-10-23 16:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000003', 'Mail Too Soon',   'Rehearsal', '2026-10-22 01:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000004', 'Mail Past',       'Rehearsal', '2026-10-21 14:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000005', 'Mail Archived',   'Rehearsal', '2026-10-23 15:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', true,  '2026-10-01 00:00:00+00'),
  -- Created AFTER its own 48-hour mark: must be skipped, never mailed at once.
  ('03600000-0000-4000-8000-000000000006', 'Mail Created Late','Rehearsal','2026-10-23 15:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-21 15:01:00+00'),
  ('03600000-0000-4000-8000-000000000007', 'Mail Program B',  'Rehearsal', '2026-10-23 15:00:00+00', null,                     '03600000-0000-4000-8000-000000000002', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000008', 'Mail Program C',  'Rehearsal', '2026-10-23 15:00:00+00', null,                     '03600000-0000-4000-8000-000000000003', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  -- 48 hours across each 2026 US daylight-saving change.
  ('03600000-0000-4000-8000-000000000009', 'Mail Fall Back',  'Rehearsal', '2026-11-02 16:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-00000000000a', 'Mail Spring Ahead','Rehearsal','2027-03-14 15:00:00+00', null,                     '03600000-0000-4000-8000-000000000001', 'rehearsal', false, '2026-10-01 00:00:00+00');

-- Make-up events, relative to the pinned reminder clock.
insert into public.events
  (id, name, type, date, end_date, ensemble_id, event_type, archived, created_at)
values
  ('03600000-0000-4000-8000-000000000011', 'Mail Make-Up Event',   'Concert', now() - interval '3 hours', now() - interval '1 hour', '03600000-0000-4000-8000-000000000001', 'concert',   false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000012', 'Mail Not Ended',       'Concert', now() - interval '1 hour', now() + interval '1 hour', '03600000-0000-4000-8000-000000000001', 'concert',   false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000013', 'Mail No End',          'Concert', now() - interval '3 hours', null,                     '03600000-0000-4000-8000-000000000001', 'concert',   false, '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000014', 'Mail Archived Make-Up','Concert', now() - interval '3 hours', now() - interval '1 hour', '03600000-0000-4000-8000-000000000001', 'concert',   true,  '2026-10-01 00:00:00+00'),
  ('03600000-0000-4000-8000-000000000015', 'Mail Archived Program','Concert', now() - interval '3 hours', now() - interval '1 hour', '03600000-0000-4000-8000-000000000003', 'concert',   false, '2026-10-01 00:00:00+00');

insert into public.attendance_records (event_id, student_id, status, attended) values
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000202', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000203', 'late',    true),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000204', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000205', 'present', true),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000206', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000207', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000208', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000209', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-00000000020a', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-00000000020b', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-000000000201', 'absent',  false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-00000000020e', 'excused', false),
  ('03600000-0000-4000-8000-000000000011', '03600000-0000-4000-8000-00000000020f', 'present', true);

-- ---------------------------------------------------------------------------
-- 1. Reminder eligibility: only this program's students, reachable and subscribed
-- ---------------------------------------------------------------------------
do $$
declare
  v_count int;
  v_ids   text;
begin
  select count(*), string_agg(d.user_id::text, ',' order by d.user_id)
    into v_count, v_ids
    from public.due_event_reminders('2026-10-21 15:00:00+00') d
   where d.event_id = '03600000-0000-4000-8000-000000000001';

  -- Student, section leader, unmarked, excused and present are the five students
  -- who are reachable and subscribed.
  if v_count <> 5 then
    raise exception 'FAIL: EE-1 event A owes % reminders, expected 5 (%)', v_count, v_ids;
  end if;
  if v_ids not like '%202%' or v_ids not like '%203%'
     or v_ids not like '%20d%' or v_ids not like '%20e%' or v_ids not like '%20f%' then
    raise exception 'FAIL: EE-1 an eligible student is missing: %', v_ids;
  end if;

  if exists (
    select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
     where d.event_id = '03600000-0000-4000-8000-000000000001'
       and (d.user_id in (
         '03600000-0000-4000-8000-000000000201', -- director
         '03600000-0000-4000-8000-000000000204', -- secretary
         '03600000-0000-4000-8000-000000000205', -- deactivated
         '03600000-0000-4000-8000-000000000206', -- unconfirmed
         '03600000-0000-4000-8000-000000000207', -- opted out
         '03600000-0000-4000-8000-000000000209', -- inactive membership
         '03600000-0000-4000-8000-00000000020a', -- no address
         '03600000-0000-4000-8000-00000000020b'  -- no auth account
       ))
  ) then
    raise exception 'FAIL: EE-1 an ineligible member was due a reminder';
  end if;

  -- The other program is never in this event's queue, and this program never
  -- receives that event.
  if exists (
    select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
     where d.event_id = '03600000-0000-4000-8000-000000000001'
       and d.ensemble_id <> '03600000-0000-4000-8000-000000000001'
  ) then
    raise exception 'FAIL: EE-1 an event leaked into another program''s recipients';
  end if;
  if exists (
    select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
     where d.event_id = '03600000-0000-4000-8000-000000000007'
       and d.ensemble_id = '03600000-0000-4000-8000-000000000001'
  ) then
    raise exception 'FAIL: EE-1 a program-B event mailed program-A students';
  end if;
  if not exists (
    select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
     where d.event_id = '03600000-0000-4000-8000-000000000007'
       and d.user_id = '03600000-0000-4000-8000-000000000208'
  ) then
    raise exception 'FAIL: EE-1 program B did not reach its own student';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The due window, cancellation, archived programs and late creation
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000002') then
    raise exception 'FAIL: EE-2 an event 49 hours away was due';
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000003') then
    raise exception 'FAIL: EE-2 a stale reminder under 12 hours was due';
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000004') then
    raise exception 'FAIL: EE-2 a past event was due';
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000005') then
    raise exception 'FAIL: EE-2 an archived event was due';
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000008') then
    raise exception 'FAIL: EE-2 an event in an archived program was due';
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000006') then
    raise exception 'FAIL: EE-2 an event created after its 48-hour mark was mailed immediately';
  end if;

  -- Exactly 48 hours is due; one minute earlier is not.
  if not exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
                  where d.event_id = '03600000-0000-4000-8000-000000000001') then
    raise exception 'FAIL: EE-2 exactly 48 hours was not due';
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-21 14:59:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000001') then
    raise exception 'FAIL: EE-2 a reminder fired more than 48 hours early';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Daylight saving: 48 hours is an instant, not a wall-clock difference
-- ---------------------------------------------------------------------------
do $$
declare
  v_fall int;
  v_spring int;
begin
  select count(*) into v_fall
    from public.due_event_reminders('2026-10-31 16:00:00+00') d
   where d.event_id = '03600000-0000-4000-8000-000000000009';
  if v_fall <> 5 then
    raise exception 'FAIL: EE-3 the fall-back reminder reached % students, expected 5', v_fall;
  end if;
  if exists (select 1 from public.due_event_reminders('2026-10-31 15:59:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000009') then
    raise exception 'FAIL: EE-3 the fall-back reminder fired early';
  end if;

  select count(*) into v_spring
    from public.due_event_reminders('2027-03-12 15:00:00+00') d
   where d.event_id = '03600000-0000-4000-8000-00000000000a';
  if v_spring <> 5 then
    raise exception 'FAIL: EE-3 the spring-ahead reminder reached % students, expected 5', v_spring;
  end if;
  if exists (select 1 from public.due_event_reminders('2027-03-12 14:59:00+00') d
              where d.event_id = '03600000-0000-4000-8000-00000000000a') then
    raise exception 'FAIL: EE-3 the spring-ahead reminder fired early';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Claiming is atomic, idempotent per schedule, and retryable
-- ---------------------------------------------------------------------------
do $$
declare
  v_claim  uuid;
  v_again  uuid;
  v_status text;
  v_tries  int;
begin
  -- First claim wins.
  v_claim := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000202',
    '2026-10-21 15:00:00+00');
  if v_claim is null then
    raise exception 'FAIL: EE-4 an eligible reminder could not be claimed';
  end if;

  -- A second run for the same schedule gets nothing.
  v_again := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000202',
    '2026-10-21 15:00:00+00');
  if v_again is not null then
    raise exception 'FAIL: EE-4 the same reminder was claimed twice';
  end if;

  if exists (select 1 from public.due_event_reminders('2026-10-21 15:00:00+00') d
              where d.event_id = '03600000-0000-4000-8000-000000000001'
                and d.user_id = '03600000-0000-4000-8000-000000000202') then
    raise exception 'FAIL: EE-4 a claimed reminder is still in the queue';
  end if;

  perform public.complete_event_reminder(v_claim, true, 'resend-id', null);
  select status into v_status
    from public.event_reminder_deliveries
   where id = v_claim;
  if v_status <> 'sent' then
    raise exception 'FAIL: EE-4 a successful reminder was recorded as %', v_status;
  end if;

  -- A claim left behind by a crashed run is reclaimable after 15 minutes.
  v_claim := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-00000000020e',
    '2026-10-21 15:00:00+00');
  update public.event_reminder_deliveries
     set claimed_at = now() - interval '20 minutes'
   where id = v_claim;
  v_again := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-00000000020e',
    '2026-10-21 15:00:00+00');
  if v_again is null then
    raise exception 'FAIL: EE-4 a stale claim was never reclaimable';
  end if;
  perform public.complete_event_reminder(v_again, true, 'resend-recovered', null);

  -- A failure is recorded and retried, up to three attempts.
  v_claim := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000203',
    '2026-10-21 15:00:00+00');
  perform public.complete_event_reminder(v_claim, false, null, 'smtp rejected');
  v_claim := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000203',
    '2026-10-21 15:00:00+00');
  if v_claim is null then
    raise exception 'FAIL: EE-4 a failed reminder was not retried';
  end if;
  perform public.complete_event_reminder(v_claim, false, null, 'smtp rejected');
  v_claim := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000203',
    '2026-10-21 15:00:00+00');
  perform public.complete_event_reminder(v_claim, false, null, 'smtp rejected');

  v_again := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000203',
    '2026-10-21 15:00:00+00');
  if v_again is not null then
    raise exception 'FAIL: EE-4 a fourth reminder attempt was allowed';
  end if;
  select attempts, status into v_tries, v_status
    from public.event_reminder_deliveries
   where event_id = '03600000-0000-4000-8000-000000000001'
     and user_id = '03600000-0000-4000-8000-000000000203'
     and event_start = '2026-10-23 15:00:00+00';
  if v_tries <> 3 or v_status <> 'failed' then
    raise exception 'FAIL: EE-4 failed reminder recorded as attempts=% status=%', v_tries, v_status;
  end if;

  -- Ineligible people can never be claimed directly, even if a caller asks.
  if public.claim_event_reminder('03600000-0000-4000-8000-000000000001',
       '03600000-0000-4000-8000-000000000205', '2026-10-21 15:00:00+00') is not null
     or public.claim_event_reminder('03600000-0000-4000-8000-000000000001',
       '03600000-0000-4000-8000-000000000206', '2026-10-21 15:00:00+00') is not null
     or public.claim_event_reminder('03600000-0000-4000-8000-000000000001',
       '03600000-0000-4000-8000-000000000207', '2026-10-21 15:00:00+00') is not null
     or public.claim_event_reminder('03600000-0000-4000-8000-000000000001',
       '03600000-0000-4000-8000-000000000209', '2026-10-21 15:00:00+00') is not null
     or public.claim_event_reminder('03600000-0000-4000-8000-000000000001',
       '03600000-0000-4000-8000-000000000201', '2026-10-21 15:00:00+00') is not null
     or public.claim_event_reminder('03600000-0000-4000-8000-000000000006',
       '03600000-0000-4000-8000-000000000202', '2026-10-21 15:00:00+00') is not null
     or public.claim_event_reminder('03600000-0000-4000-8000-000000000005',
       '03600000-0000-4000-8000-000000000202', '2026-10-21 15:00:00+00') is not null then
    raise exception 'FAIL: EE-4 an ineligible reminder was claimable';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Rescheduling: a new schedule version, not a duplicate of the old one
-- ---------------------------------------------------------------------------
do $$
declare
  v_claim uuid;
  v_rows  int;
begin
  update public.events
     set date = '2026-10-23 18:00:00+00'
   where id = '03600000-0000-4000-8000-000000000001';

  -- The old reminder (for 15:00) does not make the new time due, and does not
  -- block it either. Move it inside the window.
  update public.events
     set date = '2026-10-23 14:00:00+00'
   where id = '03600000-0000-4000-8000-000000000001';

  v_claim := public.claim_event_reminder(
    '03600000-0000-4000-8000-000000000001',
    '03600000-0000-4000-8000-000000000202',
    '2026-10-21 15:00:00+00');
  if v_claim is null then
    raise exception 'FAIL: EE-5 a rescheduled event was not reminded for its new time';
  end if;

  select count(*) into v_rows
    from public.event_reminder_deliveries
   where event_id = '03600000-0000-4000-8000-000000000001'
     and user_id = '03600000-0000-4000-8000-000000000202';
  if v_rows <> 2 then
    raise exception 'FAIL: EE-5 expected two schedule versions, found %', v_rows;
  end if;

  -- Back to the original start: the first, already-sent row still blocks it.
  update public.events
     set date = '2026-10-23 15:00:00+00'
   where id = '03600000-0000-4000-8000-000000000001';
  if public.claim_event_reminder(
       '03600000-0000-4000-8000-000000000001',
       '03600000-0000-4000-8000-000000000202',
       '2026-10-21 15:00:00+00') is not null then
    raise exception 'FAIL: EE-5 reverting the schedule duplicated the original reminder';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Make-up context: staff only, and one reason per disabled state
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_ids text;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"03600000-0000-4000-8000-000000000101","role":"authenticated"}', true);

  v := public.makeup_email_context('03600000-0000-4000-8000-000000000011');
  if coalesce(v ->> 'ok', 'false') <> 'true' then
    raise exception 'FAIL: EE-6 a director could not open the make-up context: %', v;
  end if;
  if coalesce(v ->> 'can_send', 'false') <> 'true' then
    raise exception 'FAIL: EE-6 an ended event was not sendable: %', v ->> 'reason';
  end if;

  select string_agg(r ->> 'user_id', ',' order by r ->> 'user_id')
    into v_ids
    from jsonb_array_elements(v -> 'recipients') r;
  if v_ids is distinct from '03600000-0000-4000-8000-000000000202,03600000-0000-4000-8000-000000000207' then
    raise exception 'FAIL: EE-6 wrong make-up recipients: %', v_ids;
  end if;

  if v::text like '%@%' then
    raise exception 'FAIL: EE-6 the context leaked an email address: %', v;
  end if;

  select string_agg(r ->> 'user_id', ',' order by r ->> 'user_id')
    into v_ids
    from jsonb_array_elements(v -> 'unmarked') r;
  if v_ids is distinct from '03600000-0000-4000-8000-00000000020d' then
    raise exception 'FAIL: EE-6 the unmarked group is wrong: %', v_ids;
  end if;

  -- Not ended.
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000012');
  if coalesce(v ->> 'can_send', 'true') <> 'false'
     or coalesce(v ->> 'reason', '') not like '%after this event ends%' then
    raise exception 'FAIL: EE-6 a running event was sendable: %', v;
  end if;

  -- No end time.
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000013');
  if coalesce(v ->> 'can_send', 'true') <> 'false'
     or coalesce(v ->> 'reason', '') not like '%no end time%' then
    raise exception 'FAIL: EE-6 an event with no end time was sendable: %', v;
  end if;

  -- Archived event / archived program.
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000014');
  if coalesce(v ->> 'can_send', 'true') <> 'false'
     or coalesce(v ->> 'reason', '') not like '%archived%' then
    raise exception 'FAIL: EE-6 an archived event was sendable: %', v;
  end if;
  perform set_config('request.jwt.claims',
    '{"sub":"03600000-0000-4000-8000-000000000110","role":"authenticated"}', true);
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000015');
  if coalesce(v ->> 'can_send', 'true') <> 'false'
     or coalesce(v ->> 'reason', '') not like '%program is archived%' then
    raise exception 'FAIL: EE-6 an archived program was sendable: %', v;
  end if;
  perform set_config('request.jwt.claims',
    '{"sub":"03600000-0000-4000-8000-000000000101","role":"authenticated"}', true);

  -- A student of the program, another program's director, and a signed-out
  -- caller are all refused.
  perform set_config('request.jwt.claims',
    '{"sub":"03600000-0000-4000-8000-000000000102","role":"authenticated"}', true);
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000011');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-6 a student read the make-up recipient list: %', v;
  end if;

  perform set_config('request.jwt.claims',
    '{"sub":"03600000-0000-4000-8000-00000000010c","role":"authenticated"}', true);
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000011');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-6 another program''s director read this roster: %', v;
  end if;

  perform set_config('request.jwt.claims', '{}', true);
  v := public.makeup_email_context('03600000-0000-4000-8000-000000000011');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-6 an anonymous caller read the make-up context: %', v;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Beginning a campaign: authority, end time, idempotency, partial retry
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_campaign uuid;
  v_again    uuid;
  v_count    int;
  v_ids      text;
  v_status   text;
  v_op       uuid := '03600000-0000-4000-8000-0000000000a1';
begin
  -- Not ended / no end / archived / unauthorized, all refused.
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000012',
    '03600000-0000-4000-8000-000000000201', v_op,
    'Subject', '', 'Body');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-7 a premature campaign was created';
  end if;

  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000013',
    '03600000-0000-4000-8000-000000000201', v_op,
    'Subject', '', 'Body');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-7 a campaign without an end time was created';
  end if;

  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000014',
    '03600000-0000-4000-8000-000000000201', v_op,
    'Subject', '', 'Body');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-7 an archived event campaign was created';
  end if;

  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000202', v_op,
    'Subject', '', 'Body');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-7 a student created a campaign';
  end if;

  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-00000000020c', v_op,
    'Subject', '', 'Body');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-7 another program''s director created a campaign';
  end if;

  -- A valid campaign: the two confirmed absent students.
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', v_op,
    'Make-Up Instructions for Mail Make-Up Event',
    'Come to Thursday''s make-up rehearsal.',
    'Hello {student_name}, please follow these instructions: {makeup_instructions}');
  if coalesce(v ->> 'ok', 'false') <> 'true' then
    raise exception 'FAIL: EE-7 a valid campaign was refused: %', v;
  end if;
  v_campaign := (v ->> 'campaign_id')::uuid;
  v_count := jsonb_array_length(v -> 'recipients');
  if v_count <> 2 then
    raise exception 'FAIL: EE-7 campaign has % recipients, expected 2', v_count;
  end if;
  select string_agg(r ->> 'user_id', ',' order by r ->> 'user_id')
    into v_ids
    from jsonb_array_elements(v -> 'recipients') r;
  if v_ids is distinct from '03600000-0000-4000-8000-000000000202,03600000-0000-4000-8000-000000000207' then
    raise exception 'FAIL: EE-7 wrong campaign recipients: %', v_ids;
  end if;
  -- This is the server-to-server answer; it may carry addresses, but never to
  -- a client (the client-callable context above refused to).
  if v::text not like '%@%' then
    raise exception 'FAIL: EE-7 the sender received no addresses: %', v;
  end if;

  -- The same operation is the same campaign, not a second one.
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', v_op,
    'Make-Up Instructions for Mail Make-Up Event',
    'Come to Thursday''s make-up rehearsal.',
    'Hello {student_name}, please follow these instructions: {makeup_instructions}');
  v_again := (v ->> 'campaign_id')::uuid;
  if v_again <> v_campaign then
    raise exception 'FAIL: EE-7 the same operation created a second campaign';
  end if;

  -- One accepted, one failed: a retry of the same operation only offers the
  -- failed one, and an accepted result is never overwritten.
  perform public.record_makeup_email_delivery(
    v_campaign, '03600000-0000-4000-8000-000000000202', true, 'resend-1', null);
  perform public.record_makeup_email_delivery(
    v_campaign, '03600000-0000-4000-8000-000000000207', false, null, 'rate limited');

  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', v_op,
    'Make-Up Instructions for Mail Make-Up Event',
    'Come to Thursday''s make-up rehearsal.',
    'Hello {student_name}');
  if jsonb_array_length(v -> 'recipients') <> 1
     or (v -> 'recipients' -> 0 ->> 'user_id') <> '03600000-0000-4000-8000-000000000207' then
    raise exception 'FAIL: EE-7 a retry offered an already-accepted recipient: %', v;
  end if;

  if public.record_makeup_email_delivery(
       v_campaign, '03600000-0000-4000-8000-000000000202', false, null, 'late failure') then
    raise exception 'FAIL: EE-7 an accepted delivery was overwritten by a failure';
  end if;
  select status into v_status
    from public.event_makeup_deliveries
   where campaign_id = v_campaign
     and user_id = '03600000-0000-4000-8000-000000000202';
  if v_status <> 'accepted' then
    raise exception 'FAIL: EE-7 accepted status is now %', v_status;
  end if;

  -- A deliberate follow-up is a new operation, and a real new campaign.
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-0000000000a2',
    'Follow-up', '', 'Hello {student_name}');
  if (v ->> 'campaign_id')::uuid = v_campaign then
    raise exception 'FAIL: EE-7 a follow-up reused the earlier campaign';
  end if;
  if jsonb_array_length(v -> 'recipients') <> 2 then
    raise exception 'FAIL: EE-7 a follow-up did not include both absentees: %', v;
  end if;

  -- Narrowing works; widening to a late student does not.
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-0000000000a3',
    'Narrow', '', 'Hello {student_name}',
    array['03600000-0000-4000-8000-000000000202']::uuid[]);
  if jsonb_array_length(v -> 'recipients') <> 1 then
    raise exception 'FAIL: EE-7 the recipient subset was not respected: %', v;
  end if;
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-0000000000a4',
    'Widen', '', 'Hello {student_name}',
    array['03600000-0000-4000-8000-000000000203']::uuid[]);
  if jsonb_array_length(v -> 'recipients') <> 0 then
    raise exception 'FAIL: EE-7 a late student was added to a make-up campaign: %', v;
  end if;

  -- Changing the schedule to not-ended re-checks at begin time.
  update public.events
     set end_date = now() + interval '4 hours'
   where id = '03600000-0000-4000-8000-000000000011';
  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-0000000000a5',
    'Moved', '', 'Hello {student_name}');
  if coalesce(v ->> 'ok', 'true') <> 'false' then
    raise exception 'FAIL: EE-7 a moved, unended event was still sendable: %', v;
  end if;
  update public.events
     set end_date = now() - interval '1 hour'
   where id = '03600000-0000-4000-8000-000000000011';

  -- Rate limit: ten campaigns in ten minutes is the ceiling.
  insert into public.event_makeup_campaigns
    (event_id, created_by, client_operation_id, subject, instructions, body_template,
     event_start, event_end, created_at)
  select '03600000-0000-4000-8000-000000000011',
         '03600000-0000-4000-8000-000000000201',
         gen_random_uuid(), 'Bulk', '', 'Hello', now(), now(), now()
    from generate_series(1, 10);

  v := public.begin_makeup_email_campaign(
    '03600000-0000-4000-8000-000000000011',
    '03600000-0000-4000-8000-000000000201', '03600000-0000-4000-8000-0000000000a6',
    'Too many', '', 'Hello {student_name}');
  if coalesce(v ->> 'ok', 'true') <> 'false'
     or coalesce(v ->> 'message', '') not like '%Too many%' then
    raise exception 'FAIL: EE-7 the send rate limit was not enforced: %', v;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Actor-scoped staff authority (used by the service-role sender)
-- ---------------------------------------------------------------------------
do $$
begin
  if not public.has_permission_for(
       '03600000-0000-4000-8000-000000000201',
       '03600000-0000-4000-8000-000000000001',
       'attendance.mark_present') then
    raise exception 'FAIL: EE-8 a director lost the staff capability';
  end if;
  if not public.has_permission_for(
       '03600000-0000-4000-8000-000000000204',
       '03600000-0000-4000-8000-000000000001',
       'attendance.mark_present') then
    raise exception 'FAIL: EE-8 a secretary lost the staff capability';
  end if;
  if public.has_permission_for(
       '03600000-0000-4000-8000-000000000202',
       '03600000-0000-4000-8000-000000000001',
       'attendance.mark_present') then
    raise exception 'FAIL: EE-8 a student holds the staff capability';
  end if;
  if public.has_permission_for(
       '03600000-0000-4000-8000-00000000020c',
       '03600000-0000-4000-8000-000000000001',
       'attendance.mark_present') then
    raise exception 'FAIL: EE-8 another program''s director holds it here';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Client roles cannot reach the logs or the service-role functions
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean;
  v_members text;
begin
  if has_table_privilege('authenticated', 'public.event_reminder_deliveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_makeup_campaigns', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_makeup_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.event_reminder_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.event_makeup_campaigns', 'SELECT')
     or has_table_privilege('anon', 'public.event_makeup_deliveries', 'SELECT') then
    raise exception 'FAIL: EE-9 a client role can read a mail delivery table';
  end if;

  if has_function_privilege('authenticated', 'public.due_event_reminders(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.due_event_reminders(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.claim_event_reminder(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.has_permission_for(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.makeup_email_context(uuid)', 'EXECUTE') then
    raise exception 'FAIL: EE-9 a client role can call a service-role mail function';
  end if;

  -- Even the director cannot read either log from a client session.
  perform set_config('request.jwt.claims',
    '{"sub":"03600000-0000-4000-8000-000000000101","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform count(*) from public.event_reminder_deliveries;
    v_blocked := false;
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  reset role;
  if not v_blocked then
    raise exception 'FAIL: EE-9 a director read the reminder log from a client session';
  end if;

  -- The one client-callable function works for staff and returns no addresses.
  set local role authenticated;
  v_members := public.makeup_email_context('03600000-0000-4000-8000-000000000011')::text;
  reset role;
  if v_members like '%@%' then
    raise exception 'FAIL: EE-9 the client-callable context carried an address';
  end if;

  raise notice 'event emails OK: 48-hour window, schedule-version idempotency, staff-only make-up recipients, client logs closed';
end
$$;

rollback;

\echo 'EVENT EMAILS PASSED'
