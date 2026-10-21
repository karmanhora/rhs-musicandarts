-- ============================================================================
-- notifications_center.sql — in-app notification behaviour
-- ============================================================================
-- requires-table: public.notifications
--
-- Covers 20261020110000 (dedupe key, type vocabulary, mark-all-read) and
-- 20261020115000 (event changes, cancellations, failed workflows). One
-- transaction, ROLLED BACK.
--
-- Asserts:
--   A  a new event notifies the roster and not its author
--   B  a reschedule notifies once, not once per save
--   C  a second real reschedule is news again
--   D  a cancellation notifies once, and a restore is its own message
--   E  a past event produces nothing
--   F  a suppressed calendar sync produces nothing
--   G  a failed make-up campaign notifies its author once, not per recipient
--   H  the dedupe key is enforced by the database
--   I  a user sees only their own notifications, and can only mark their own
--   J  mark-all-read affects only the caller
--   K  clients cannot create or delete notifications
--   L  in-app read state is separate from every email delivery ledger
--
-- On success: NOTIFICATIONS CENTER PASSED
-- ============================================================================

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications'
       and column_name = 'dedupe_key'
  ) then
    raise exception 'FAIL: NC-0 notifications.dedupe_key missing — apply 20261020110000 first';
  end if;
  if to_regprocedure('public.mark_all_notifications_read()') is null then
    raise exception 'FAIL: NC-0 mark_all_notifications_read() missing';
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'events_notify_change'
  ) then
    raise exception 'FAIL: NC-0 events_notify_change missing — apply 20261020115000 first';
  end if;
end
$$;

create or replace function public.nc_assert(condition boolean, label text)
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
  ('55000000-0000-4000-8000-0000000000a1', 'nc-a', 'NC Program A', true),
  ('55000000-0000-4000-8000-0000000000b1', 'nc-b', 'NC Program B', true);

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('55000000-0000-4000-8000-000000000001', 'nc-dir',   'NC Director', 'NC Director'),
  ('55000000-0000-4000-8000-000000000002', 'nc-stu1',  'NC Student One', ''),
  ('55000000-0000-4000-8000-000000000003', 'nc-stu2',  'NC Student Two', ''),
  ('55000000-0000-4000-8000-000000000004', 'nc-out',   'NC Outsider', 'NC Outsider'),
  ('55000000-0000-4000-8000-000000000005', 'nc-dir-b', 'NC Director B', 'NC Director B');

insert into public.memberships (user_id, ensemble_id, roles, active) values
  ('55000000-0000-4000-8000-000000000001', '55000000-0000-4000-8000-0000000000a1', '{director}', true),
  ('55000000-0000-4000-8000-000000000002', '55000000-0000-4000-8000-0000000000a1', '{student}', true),
  ('55000000-0000-4000-8000-000000000003', '55000000-0000-4000-8000-0000000000a1', '{student}', true),
  ('55000000-0000-4000-8000-000000000005', '55000000-0000-4000-8000-0000000000b1', '{director}', true);

-- A future event, written by the director: the 016 trigger fans this out.
insert into public.events
  (id, ensemble_id, name, type, event_type, date, checkin_mode, attendance_requirement, created_by)
values
  ('55000000-0000-4000-8000-000000000101', '55000000-0000-4000-8000-0000000000a1',
   'NC Rehearsal', 'Rehearsal', 'rehearsal', now() + interval '3 days', 'toggle', 'required',
   '55000000-0000-4000-8000-000000000001'),
  ('55000000-0000-4000-8000-000000000102', '55000000-0000-4000-8000-0000000000a1',
   'NC Past Rehearsal', 'Rehearsal', 'rehearsal', now() - interval '3 days', 'toggle', 'required',
   '55000000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- A. The existing new-event fan-out still works
-- ---------------------------------------------------------------------------
do $$
begin
  -- Two events exist (one future, one past), so two new-event rows each.
  perform public.nc_assert(
    (select count(*) from public.notifications
      where type = 'new_event'
        and user_id = '55000000-0000-4000-8000-000000000002') = 2,
    'A the first student is told about each new event'
  );
  perform public.nc_assert(
    (select count(*) from public.notifications
      where type = 'new_event'
        and user_id = '55000000-0000-4000-8000-000000000003') = 2,
    'A the second student is told'
  );
  perform public.nc_assert(
    (select count(*) from public.notifications
      where type = 'new_event'
        and user_id = '55000000-0000-4000-8000-000000000001') = 0,
    'A the author is not notified of their own event'
  );
  perform public.nc_assert(
    (select count(*) from public.notifications
      where type = 'new_event'
        and user_id = '55000000-0000-4000-8000-000000000004') = 0,
    'A somebody outside the program is not notified'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- B / C. Reschedules: once per schedule, again only for a real change
-- ---------------------------------------------------------------------------
do $$
declare
  v_first timestamptz;
begin
  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events
     set date = now() + interval '3 days 2 hours'
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_changed') = 1,
    'B a reschedule reaches the student once'
  );
  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000001'
        and type = 'event_changed') = 0,
    'B the staff member who made the change is not notified of it'
  );
  perform public.nc_assert(
    (select payload->>'event_id' from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_changed' limit 1) = '55000000-0000-4000-8000-000000000101',
    'B the notification carries the event so the bell can navigate'
  );

  -- The same save again: the trigger fires, the dedupe key does not change.
  select date into v_first from public.events where id = '55000000-0000-4000-8000-000000000101';
  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events
     set date = v_first, location = coalesce(location, '')
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_changed') = 1,
    'B saving the same schedule twice does not notify twice'
  );

  -- C: a genuine second move is news.
  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events
     set date = now() + interval '4 days'
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_changed') = 2,
    'C a second real reschedule is a second notification'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- D. Cancellation and restore
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events set archived = true
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_cancelled') = 1,
    'D a cancellation notifies once'
  );
  perform public.nc_assert(
    (select body from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_cancelled') like '%cancelled%',
    'D the cancellation says what happened'
  );

  -- Saving "still archived" is not a second cancellation.
  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events set archived = true
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_cancelled') = 1,
    'D repeating the cancellation does nothing'
  );

  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events set archived = false
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_changed') = 3,
    'D a restore is its own message, even at an unchanged time'
  );
  perform public.nc_assert(
    (select title from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000002'
        and type = 'event_changed'
        and dedupe_key like '%:restored:%') = 'Event restored',
    'D the restore is labelled as one'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- E / F. Past events and a suppressed sync
-- ---------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_after  int;
begin
  select count(*) into v_before from public.notifications
   where user_id = '55000000-0000-4000-8000-000000000002';

  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events
     set location = 'Old Gym'
   where id = '55000000-0000-4000-8000-000000000102';
  reset role;

  select count(*) into v_after from public.notifications
   where user_id = '55000000-0000-4000-8000-000000000002';
  perform public.nc_assert(v_after = v_before,
    'E changing an event that already happened notifies nobody');

  -- The calendar sync's own suppression flag.
  perform set_config('app.suppress_event_notifications', 'true', true);
  perform set_config('request.jwt.claims', '{"sub":"nc-dir","role":"authenticated"}', true);
  set role authenticated;
  update public.events
     set date = now() + interval '5 days'
   where id = '55000000-0000-4000-8000-000000000101';
  reset role;
  perform set_config('app.suppress_event_notifications', '', true);

  select count(*) into v_after from public.notifications
   where user_id = '55000000-0000-4000-8000-000000000002';
  perform public.nc_assert(v_after = v_before,
    'F a suppressed calendar sync fans out nothing');
end
$$;

-- ---------------------------------------------------------------------------
-- G. A failed make-up campaign: once per campaign, to its author
-- ---------------------------------------------------------------------------
do $$
declare
  v_campaign uuid := '55000000-0000-4000-8000-0000000000d1';
begin
  insert into public.event_makeup_campaigns
    (id, event_id, created_by, client_operation_id, subject, instructions,
     body_template, event_start, event_end)
  values
    (v_campaign,
     '55000000-0000-4000-8000-000000000102',
     '55000000-0000-4000-8000-000000000001',
     gen_random_uuid(), 'Missing music', '', 'Hello',
     now() - interval '3 days', now() - interval '3 days' + interval '2 hours');

  insert into public.event_makeup_deliveries (campaign_id, user_id, status)
  values (v_campaign, '55000000-0000-4000-8000-000000000002', 'queued');

  update public.event_makeup_deliveries
     set status = 'failed', error = 'Resend refused'
   where campaign_id = v_campaign
     and user_id = '55000000-0000-4000-8000-000000000002';

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000001'
        and type = 'workflow_failed') = 1,
    'G the staff member who ran the campaign is notified'
  );

  -- A second failed recipient in the same campaign is the same problem.
  insert into public.event_makeup_deliveries (campaign_id, user_id, status)
  values (v_campaign, '55000000-0000-4000-8000-000000000003', 'failed');

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000001'
        and type = 'workflow_failed') = 1,
    'G the campaign is reported once, not once per recipient'
  );
  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id in ('55000000-0000-4000-8000-000000000002',
                        '55000000-0000-4000-8000-000000000003')
        and type = 'workflow_failed') = 0,
    'G students are never sent staff workflow failures'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- H. The database enforces the dedupe key
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int;
begin
  insert into public.notifications (user_id, type, title, body, dedupe_key)
  values ('55000000-0000-4000-8000-000000000003', 'event_changed', 'One', '', 'nc:test:key');

  begin
    insert into public.notifications (user_id, type, title, body, dedupe_key)
    values ('55000000-0000-4000-8000-000000000003', 'event_changed', 'Two', '', 'nc:test:key');
    raise exception 'FAIL: H a duplicate dedupe key was accepted';
  exception when unique_violation then null;
  end;

  insert into public.notifications (user_id, type, title, body, dedupe_key)
  values ('55000000-0000-4000-8000-000000000003', 'event_changed', 'Two', '', 'nc:test:key')
  on conflict (user_id, dedupe_key) do nothing;

  select count(*) into v_n from public.notifications
   where user_id = '55000000-0000-4000-8000-000000000003'
     and dedupe_key = 'nc:test:key';
  perform public.nc_assert(v_n = 1, 'H the same key is stored once');

  -- A different recipient with the same key is a different notification.
  insert into public.notifications (user_id, type, title, body, dedupe_key)
  values ('55000000-0000-4000-8000-000000000002', 'event_changed', 'One', '', 'nc:test:key');
  perform public.nc_assert(
    (select count(*) from public.notifications where dedupe_key = 'nc:test:key') = 2,
    'H dedupe is per recipient, not global'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- I / J. Ownership and read state
-- ---------------------------------------------------------------------------
do $$
declare
  v        jsonb;
  v_other  int;
  v_before int;
  v_after  int;
begin
  perform set_config('request.jwt.claims', '{"sub":"nc-stu1","role":"authenticated"}', true);
  set role authenticated;

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id <> '55000000-0000-4000-8000-000000000002') = 0,
    'I a student sees only their own notifications'
  );

  -- Marking somebody else's read affects nothing (RLS filters the row).
  update public.notifications set read = true
   where user_id = '55000000-0000-4000-8000-000000000003';
  get diagnostics v_other = row_count;
  perform public.nc_assert(v_other = 0, 'I a student cannot mark another person''s notification read');

  -- Mark-all-read: only the caller's rows.
  select count(*) into v_before from public.notifications
   where user_id = '55000000-0000-4000-8000-000000000002' and read = false;

  v := public.mark_all_notifications_read();
  perform public.nc_assert(v->>'ok' = 'true', 'J mark-all-read answers');
  perform public.nc_assert((v->>'updated')::int = v_before,
    'J it reports how many rows it changed');

  select count(*) into v_after from public.notifications
   where user_id = '55000000-0000-4000-8000-000000000002' and read = false;
  perform public.nc_assert(v_after = 0, 'J nothing of the caller''s is left unread');

  -- Read somebody else's count without their session: their unread state is
  -- untouched by the caller's mark-all-read.
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.nc_assert(
    (select count(*) from public.notifications
      where user_id = '55000000-0000-4000-8000-000000000003' and read = false) > 0,
    'J another person''s unread state is untouched'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- K. Clients cannot create or delete
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"nc-stu1","role":"authenticated"}', true);
  set role authenticated;

  begin
    insert into public.notifications (user_id, type, title)
    values ('55000000-0000-4000-8000-000000000002', 'event_changed', 'forged');
    raise exception 'FAIL: K a student inserted a notification';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.notifications where user_id = '55000000-0000-4000-8000-000000000002';
    raise exception 'FAIL: K a student deleted a notification';
  exception when insufficient_privilege then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- L. In-app state is not email state
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
begin
  select string_agg(column_name, ',') into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'notifications';

  perform public.nc_assert(v_cols not like '%sent%', 'L notifications carry no email delivery state');
  perform public.nc_assert(v_cols not like '%resend%', 'L notifications carry no provider state');
  perform public.nc_assert(v_cols like '%read%', 'L the in-app read flag is its own column');

  -- No reminder was "sent" by anything that inserted an in-app row.
  perform public.nc_assert(
    (select count(*) from public.event_reminder_deliveries) = 0,
    'L an in-app notification did not create an email delivery row'
  );
  perform public.nc_assert(
    (select count(*) from public.event_digest_deliveries) = 0,
    'L nor a digest delivery row'
  );
end
$$;

rollback;

select 'NOTIFICATIONS CENTER PASSED' as verification_result;
