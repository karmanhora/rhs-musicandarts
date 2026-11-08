-- ============================================================================
-- RHS Music Platform — feedback submissions
-- ============================================================================
-- requires-table: public.feedback_submissions
--
-- Covers migration 20261108150000: the form's write path, the owner-only read
-- path, and every way a caller could try to cross between them.
--
-- Scenarios:
--   A  a student submits, cannot read or manage anything
--   B  a teacher submits, with the same limits
--   C  a program administrator — including a `program_admins` row — cannot read
--      or manage feedback, and gains nothing from existing program authority
--   D  the owner reads every submission, moves status both ways, and deletes one
--   E  invalid input is refused and writes nothing
--   F  a duplicate is refused, and a burst is rate-limited
--   G  an unconfirmed owner address is not the owner; anon holds no privilege
--
-- Every fixture is fictional and the whole suite runs in ONE transaction that is
-- ROLLED BACK — it never touches real records.
--
-- Prints FEEDBACK PASSED on success.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.feedback_submissions') is null then
    raise exception 'FAIL: FB-0 feedback_submissions missing — apply 20261108150000 first';
  end if;
  if to_regprocedure('public.is_feedback_owner()') is null then
    raise exception 'FAIL: FB-0 is_feedback_owner() missing';
  end if;
end
$$;

create or replace function public.feedback_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end
$$;

-- The auth uid behind the owner address — the real account on a project that
-- has one, the fixture above on a fresh rebuild.
create or replace function public.feedback_owner_auth_uid()
returns uuid
language sql
stable
as $$
  select id from auth.users where lower(email) = 'lebronyuh64@gmail.com' limit 1
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: four accounts and four profiles.
--
-- `auth.users` is where the owner predicate reads the address, so these rows
-- have to exist for the owner half to mean anything. The passwordless accounts
-- are enough: identity resolves through `auth.jwt() ->> 'sub'`, exactly as it
-- does for a real session.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('11111111-1111-4111-8111-222222222222', 'feedback.student@example.org', now()),
  ('11111111-1111-4111-8111-333333333333', 'feedback.teacher@example.org', now()),
  ('11111111-1111-4111-8111-444444444444', 'feedback.admin@example.org', now()),
  ('11111111-1111-4111-8111-555555555555', 'feedback.noise@example.org', now())
on conflict (id) do nothing;

-- The owner account is reused when this suite is rehearsed against a project
-- that already has one (auth.users holds a unique address), and inserted only
-- on a fresh rebuild, where the auth schema is empty.
do $$
begin
  if not exists (
    select 1 from auth.users where lower(email) = 'lebronyuh64@gmail.com'
  ) then
    insert into auth.users (id, email, email_confirmed_at)
    values ('11111111-1111-4111-8111-111111111111', 'lebronyuh64@gmail.com', now());
  end if;
end
$$;

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('fbfbfbfb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-222222222222', 'Feedback Student', 'Student'),
  ('fbfbfbfb-0000-4000-8000-000000000003', '11111111-1111-4111-8111-333333333333', 'Feedback Teacher', 'Teacher'),
  ('fbfbfbfb-0000-4000-8000-000000000004', '11111111-1111-4111-8111-444444444444', 'Feedback Admin', 'Admin'),
  ('fbfbfbfb-0000-4000-8000-000000000005', '11111111-1111-4111-8111-555555555555', 'Feedback Noise', 'Noise')
on conflict (id) do nothing;

-- The owner's profile: the real one when the account is already linked, a
-- fixture when it is not. The id is never used directly — every owner session
-- below resolves its token from `feedback_owner_auth_uid()`.
insert into public.profiles (id, auth_user_id, full_name, display_name)
select coalesce(p.id, 'fbfbfbfb-0000-4000-8000-000000000001'),
       u.id::text, 'Feedback Owner', 'Owner'
  from auth.users u
  left join public.profiles p on p.auth_user_id = u.id::text
 where lower(u.email) = 'lebronyuh64@gmail.com'
on conflict (id) do nothing;

-- A program administrator row: the strongest cross-program grant that exists.
-- It must still not reach feedback.
insert into public.program_admins (user_id) values ('fbfbfbfb-0000-4000-8000-000000000004')
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- A. Student: may send, may not read or manage
-- ---------------------------------------------------------------------------
do $$
declare
  v_id   uuid;
  v      jsonb;
  v_rows int;
  v_n    int;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-8111-222222222222","role":"authenticated"}',
    true
  );
  set role authenticated;

  v := public.submit_feedback(
    p_category => 'bug',
    p_message => 'The check-in button does nothing after I scan the code.',
    p_affected_feature => 'Check in',
    p_contact_email => 'feedback.student@example.org'
  );
  perform public.feedback_assert(v->>'ok' = 'true', format('A1 a student can send feedback (%s)', coalesce(v->>'message', 'no message')));
  v_id := (v->>'id')::uuid;

  v := public.feedback_owner_status();
  perform public.feedback_assert(v->>'owner' = 'false', 'A2 a student is not the owner');

  -- RLS, not a client filter: the table grants SELECT, the policy returns no row.
  select count(*) into v_rows from public.feedback_submissions;
  perform public.feedback_assert(v_rows = 0, 'A3 a student cannot read feedback submissions');
  select count(*) into v_rows from public.feedback_submissions where id = v_id;
  perform public.feedback_assert(v_rows = 0, 'A3 …not even the row they just sent');

  begin
    insert into public.feedback_submissions (category, message, submitted_by)
    values ('bug', 'A directly inserted message that should never land.', 'fbfbfbfb-0000-4000-8000-000000000002');
    raise exception 'FAIL: A4 a student inserted a feedback row directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.feedback_submissions set status = 'resolved';
    raise exception 'FAIL: A5 a student updated feedback directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.feedback_submissions;
    raise exception 'FAIL: A6 a student deleted feedback directly';
  exception
    when insufficient_privilege then null;
  end;

  v := public.set_feedback_status(v_id, 'resolved');
  perform public.feedback_assert(v->>'ok' = 'false', 'A7 a student cannot change a status through the RPC');

  v := public.delete_feedback(v_id);
  perform public.feedback_assert(v->>'ok' = 'false', 'A8 a student cannot delete through the RPC');

  reset role;

  -- The row exists exactly once, attributed to the caller, and is still new.
  select count(*) into v_n from public.feedback_submissions
   where id = v_id
     and submitted_by = 'fbfbfbfb-0000-4000-8000-000000000002'
     and status = 'new';
  perform public.feedback_assert(v_n = 1,
    'A9 the message was stored once, attributed to the sender, with status new');
end
$$;

-- ---------------------------------------------------------------------------
-- B. Teacher: same write, same limits
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_rows int;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-8111-333333333333","role":"authenticated"}',
    true
  );
  set role authenticated;

  v := public.submit_feedback(
    p_category => 'feature',
    p_message => 'It would help to see next week at a glance on the home screen.',
    p_affected_feature => 'Home'
  );
  perform public.feedback_assert(v->>'ok' = 'true', 'B1 a teacher can send feedback');
  perform public.feedback_assert(v->>'owner' is null, 'B2 the submit response carries no owner claim');

  select count(*) into v_rows from public.feedback_submissions;
  perform public.feedback_assert(v_rows = 0, 'B3 a teacher cannot read feedback submissions');

  v := public.feedback_owner_status();
  perform public.feedback_assert(v->>'owner' = 'false', 'B4 a teacher is not the owner');

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- C. Program administrator: authority elsewhere is authority nowhere here
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_rows int;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-8111-444444444444","role":"authenticated"}',
    true
  );
  set role authenticated;

  perform public.feedback_assert(public.is_program_admin(), 'C1 the fixture really is a program administrator');

  v := public.submit_feedback(
    p_category => 'suggestion',
    p_message => 'The calendar could label the program name on each event.',
    p_affected_feature => 'Calendar'
  );
  perform public.feedback_assert(v->>'ok' = 'true', 'C2 an administrator may send feedback like anybody else');

  select count(*) into v_rows from public.feedback_submissions;
  perform public.feedback_assert(v_rows = 0, 'C3 a program administrator cannot read feedback');

  v := public.feedback_owner_status();
  perform public.feedback_assert(v->>'owner' = 'false',
    'C4 system-administrator authority does not make somebody the feedback owner');

  v := public.set_feedback_status(
    (select id from public.feedback_submissions limit 1),
    'resolved'
  );
  perform public.feedback_assert(v->>'ok' = 'false',
    'C5 an administrator cannot manage statuses');

  v := public.delete_feedback(
    (select id from public.feedback_submissions limit 1)
  );
  perform public.feedback_assert(v->>'ok' = 'false',
    'C6 an administrator cannot delete feedback');

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- D. Owner: read everything, move status both ways, delete
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_rows int;
  v_id uuid;
  v_status text;
  v_before timestamptz;
  v_after timestamptz;
begin
  perform set_config(
    'request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', public.feedback_owner_auth_uid()),
    true
  );
  set role authenticated;

  v := public.feedback_owner_status();
  perform public.feedback_assert(v->>'owner' = 'true', 'D1 the confirmed owner account is recognised');
  perform public.feedback_assert(public.is_feedback_owner(), 'D1 …by the predicate itself');

  select count(*) into v_rows from public.feedback_submissions;
  perform public.feedback_assert(v_rows = 3,
    format('D2 the owner reads every submission (saw %s, expected 3)', v_rows));

  select id, created_at into v_id, v_before
    from public.feedback_submissions
   where submitted_by = 'fbfbfbfb-0000-4000-8000-000000000002';

  v := public.set_feedback_status(v_id, 'reviewing');
  perform public.feedback_assert(v->>'ok' = 'true', 'D3 the owner marks a submission as reviewing');
  select status into v_status from public.feedback_submissions where id = v_id;
  perform public.feedback_assert(v_status = 'reviewing', 'D4 the status is stored');

  v := public.set_feedback_status(v_id, 'resolved');
  perform public.feedback_assert(v->>'ok' = 'true', 'D5 the owner marks it resolved');
  select status, updated_at into v_status, v_after
    from public.feedback_submissions where id = v_id;
  perform public.feedback_assert(v_status = 'resolved', 'D6 the resolution is stored');
  perform public.feedback_assert(v_after >= v_before, 'D7 updated_at moved forward');

  -- Reopening is a real path, not a one-way door.
  v := public.set_feedback_status(v_id, 'new');
  perform public.feedback_assert(v->>'ok' = 'true', 'D8 the owner can return it to new');
  v := public.set_feedback_status(v_id, 'reviewing');
  perform public.feedback_assert(v->>'ok' = 'true', 'D9 …and back to reviewing');

  v := public.set_feedback_status(v_id, 'archived');
  perform public.feedback_assert(v->>'ok' = 'false', 'D10 an unknown status is refused');

  select id into v_id from public.feedback_submissions
   where submitted_by = 'fbfbfbfb-0000-4000-8000-000000000004';
  v := public.delete_feedback(v_id);
  perform public.feedback_assert(v->>'ok' = 'true', 'D11 the owner deletes a submission');
  reset role;

  select count(*) into v_rows from public.feedback_submissions;
  perform public.feedback_assert(v_rows = 2, 'D12 the deleted submission is gone');

  perform set_config(
    'request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', public.feedback_owner_auth_uid()),
    true
  );
  set role authenticated;
  v := public.delete_feedback(v_id);
  perform public.feedback_assert(v->>'ok' = 'false', 'D13 deleting it twice says it is gone');
  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- E. Invalid input writes nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_before int;
  v_after int;
begin
  select count(*) into v_before from public.feedback_submissions;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-8111-222222222222","role":"authenticated"}',
    true
  );
  set role authenticated;

  v := public.submit_feedback('question', 'A message long enough to pass the length check.');
  perform public.feedback_assert(v->>'ok' = 'false', 'E1 an unknown category is refused');

  v := public.submit_feedback('', 'A message long enough to pass the length check.');
  perform public.feedback_assert(v->>'ok' = 'false', 'E2 a missing category is refused');

  v := public.submit_feedback('bug', '');
  perform public.feedback_assert(v->>'ok' = 'false', 'E3 an empty message is refused');

  v := public.submit_feedback('bug', '   too short   ');
  perform public.feedback_assert(v->>'ok' = 'false', 'E4 a 9-character message is refused');

  v := public.submit_feedback('bug', repeat('a', 4001));
  perform public.feedback_assert(v->>'ok' = 'false', 'E5 a 4001-character message is refused');

  v := public.submit_feedback(
    'bug',
    'A message long enough to pass the length check.',
    repeat('x', 201)
  );
  perform public.feedback_assert(v->>'ok' = 'false', 'E6 a 201-character affected feature is refused');

  v := public.submit_feedback(
    'bug',
    'A message long enough to pass the length check.',
    null,
    'not-an-address'
  );
  perform public.feedback_assert(v->>'ok' = 'false', 'E7 a malformed contact email is refused');

  v := public.submit_feedback(
    'bug',
    'A message long enough to pass the length check.',
    null,
    repeat('a', 246) || '@example.org'
  );
  perform public.feedback_assert(v->>'ok' = 'false', 'E8 an over-long contact email is refused');

  reset role;

  select count(*) into v_after from public.feedback_submissions;
  perform public.feedback_assert(v_after = v_before,
    format('E9 refusals wrote nothing (%s before, %s after)', v_before, v_after));
end
$$;

-- ---------------------------------------------------------------------------
-- F. Duplicate and burst protection
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  i int;
  v_count int;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"11111111-1111-4111-8111-555555555555","role":"authenticated"}',
    true
  );
  set role authenticated;

  v := public.submit_feedback('other', 'The same message sent twice by one person.');
  perform public.feedback_assert(v->>'ok' = 'true', 'F1 the first message is accepted');

  v := public.submit_feedback('other', 'The same message sent twice by one person.');
  perform public.feedback_assert(v->>'ok' = 'false',
    'F2 an exact repeat inside ten minutes is refused');
  perform public.feedback_assert(position('already sent' in v->>'message') > 0,
    'F3 the duplicate refusal says why');

  -- Case and surrounding whitespace do not make it a new report: a retried
  -- request must not create a second row.
  v := public.submit_feedback('other', '  THE SAME MESSAGE SENT TWICE BY ONE PERSON.  ');
  perform public.feedback_assert(v->>'ok' = 'false', 'F4 a case/space variant is still the duplicate');

  for i in 2..5 loop
    v := public.submit_feedback('other', format('A distinct follow-up message number %s.', i));
    perform public.feedback_assert(v->>'ok' = 'true',
      format('F5 message %s of the allowed five is accepted', i));
  end loop;

  v := public.submit_feedback('other', 'A sixth message inside the same ten minutes.');
  perform public.feedback_assert(v->>'ok' = 'false', 'F6 a sixth message in ten minutes is refused');
  perform public.feedback_assert(position('wait' in v->>'message') > 0,
    'F7 the burst refusal asks them to wait');

  reset role;

  select count(*) into v_count from public.feedback_submissions
   where submitted_by = 'fbfbfbfb-0000-4000-8000-000000000005';
  perform public.feedback_assert(v_count = 5,
    format('F8 exactly the five accepted messages were stored (found %s)', v_count));
end
$$;

-- ---------------------------------------------------------------------------
-- G. An unconfirmed owner address is not the owner; anon holds nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_rows int;
begin
  reset role;

  update auth.users
     set email_confirmed_at = null
   where id = public.feedback_owner_auth_uid();

  perform set_config(
    'request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', public.feedback_owner_auth_uid()),
    true
  );
  set role authenticated;

  v := public.feedback_owner_status();
  perform public.feedback_assert(v->>'owner' = 'false',
    'G1 an unconfirmed account claiming the owner address is not the owner');
  perform public.feedback_assert(public.is_feedback_owner() = false,
    'G2 the predicate itself refuses it');

  select count(*) into v_rows from public.feedback_submissions;
  perform public.feedback_assert(v_rows = 0,
    'G3 the owner-read policy reveals nothing to an unconfirmed account');

  v := public.set_feedback_status(
    (select id from public.feedback_submissions limit 1),
    'resolved'
  );
  perform public.feedback_assert(v->>'ok' = 'false',
    'G4 the management RPC refuses it');

  reset role;

  update auth.users
     set email_confirmed_at = now()
   where id = public.feedback_owner_auth_uid();

  perform public.feedback_assert(
    not has_function_privilege('anon', 'public.submit_feedback(text, text, text, text)', 'EXECUTE'),
    'G5 anon cannot execute submit_feedback()'
  );
  perform public.feedback_assert(
    not has_function_privilege('anon', 'public.set_feedback_status(uuid, text)', 'EXECUTE'),
    'G6 anon cannot execute set_feedback_status()'
  );
  perform public.feedback_assert(
    not has_function_privilege('anon', 'public.delete_feedback(uuid)', 'EXECUTE'),
    'G7 anon cannot execute delete_feedback()'
  );
  perform public.feedback_assert(
    not has_table_privilege('anon', 'public.feedback_submissions', 'SELECT'),
    'G8 anon cannot read feedback_submissions'
  );
  perform public.feedback_assert(
    not has_table_privilege('authenticated', 'public.feedback_submissions', 'INSERT')
    and not has_table_privilege('authenticated', 'public.feedback_submissions', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.feedback_submissions', 'DELETE'),
    'G9 authenticated holds no direct write grant'
  );
end
$$;

rollback;

select 'FEEDBACK PASSED' as verification_result;
