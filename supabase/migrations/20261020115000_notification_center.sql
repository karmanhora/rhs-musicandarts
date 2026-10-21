-- ============================================================================
-- RHS Music Platform — unified notification centre (fan-out)
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Feature 5 of the 2026-10 expansion. The table, RLS and the bell already
-- existed; 20261020110000 added the type vocabulary and the dedupe key, and the
-- absence migration added its two writers. This migration adds the last two
-- things the centre can honestly show:
--
--   * event_changed / event_cancelled — when a future event moves, moves room,
--     is cancelled (archived) or is restored. The dedupe key contains a hash of
--     the schedule, so saving an unrelated field twice notifies nobody twice,
--     while a genuine second reschedule is news again. An event that has already
--     started never produces one: stale reminders are worse than none.
--     The calendar sync sets `app.suppress_event_notifications`, so a feed
--     refresh does not fan out to the roster — the same rule 017 already uses
--     for `new_event`.
--
--   * workflow_failed — a make-up email Resend refused. One notification per
--     campaign (not per recipient), addressed to the staff member who ran it,
--     with a link back to the event. This is the "staff action required" case
--     the app really has; nothing is invented for workflows that do not exist.
--
-- NOT added, on purpose:
--   * no in-app copy of the 48-hour reminder. That system is email-only and
--     already scheduled every 15 minutes (036); duplicating it would double
--     every reminder a student receives.
--   * no digest, no chat. Chat was retired in 018 and the digest is a weekly
--     email with its own ledger.
--   * no new cron job, no new table, no email send. In-app `read` and an email's
--     `sent` state stay independent facts in independent places.
--
-- Rollback: drop the three triggers and the two functions. Existing
-- notification rows remain (they are the user's own inbox).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A future event moved, was cancelled, or came back
-- ---------------------------------------------------------------------------
create or replace function public.notify_event_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type   text;
  v_title  text;
  v_body   text;
  v_key    text;
  v_hash   text;
  v_when   text;
begin
  if current_setting('app.suppress_event_notifications', true) = 'true' then
    return new;
  end if;

  -- Moving an event between programs is an administrative correction, not a
  -- member-facing change for the old roster.
  if new.ensemble_id is distinct from old.ensemble_id then
    return new;
  end if;

  -- Neither a moved nor a cancelled past event is news a student can act on.
  if new.date <= now() and old.date <= now() then
    return new;
  end if;

  v_when := case
    when new.all_day then to_char(new.date at time zone 'America/Los_Angeles', 'Mon DD')
    else to_char(new.date at time zone 'America/Los_Angeles', 'Mon DD, HH12:MI AM')
  end;

  if new.archived and not old.archived then
    v_type  := 'event_cancelled';
    v_title := 'Event cancelled';
    v_body  := format('%s on %s was cancelled.', new.name, v_when);
    v_key   := 'event:' || new.id::text || ':cancelled';
  elsif not new.archived
        and (
          old.archived
          or new.date is distinct from old.date
          or new.end_date is distinct from old.end_date
          or new.location is distinct from old.location
          or new.name is distinct from old.name
        ) then
    -- A change to something that already happened is history, not news.
    if new.date <= now() then
      return new;
    end if;

    v_title := case when old.archived then 'Event restored' else 'Event updated' end;
    v_body  := format(
      '%s is now %s%s.',
      new.name,
      v_when,
      case when coalesce(new.location, '') <> '' then ' at ' || new.location else '' end
    );
    -- The schedule is the identity of the change: an unrelated save produces the
    -- same key and inserts nothing, a real second move produces a new one.
    v_hash := md5(
      coalesce(new.name, '') || '|' || coalesce(new.date::text, '') || '|' ||
      coalesce(new.end_date::text, '') || '|' || coalesce(new.location, '') || '|' ||
      -- A restore is a different message from the reschedule that preceded the
      -- cancellation, so the archive state is part of the identity of the news.
      new.archived::text
    );
    v_type := 'event_changed';
    -- "restored" is its own message: an event coming back at the same time it
    -- had before is still news, so the transition is part of the key.
    v_key  := 'event:' || new.id::text || ':'
              || case when old.archived then 'restored' else 'changed' end
              || ':' || v_hash;
  else
    return new;
  end if;

  insert into public.notifications (user_id, type, title, body, payload, dedupe_key)
  select m.user_id,
         v_type,
         v_title,
         v_body,
         jsonb_build_object('event_id', new.id, 'event_name', new.name),
         v_key
    from public.memberships m
   where m.ensemble_id = new.ensemble_id
     and m.active
     and m.user_id is distinct from new.created_by
     and m.user_id is distinct from public.current_profile_id()
  on conflict (user_id, dedupe_key) do nothing;

  return new;
end
$$;

comment on function public.notify_event_change() is
  'Notifies a program''s active members when a future event is rescheduled, re-located, cancelled or restored. Deduplicated per schedule; never fires for a past event or during a suppressed calendar sync.';

drop trigger if exists events_notify_change on public.events;
create trigger events_notify_change
  after update of name, date, end_date, location, archived on public.events
  for each row execute function public.notify_event_change();

-- ---------------------------------------------------------------------------
-- 2. A make-up email the mail provider refused
-- ---------------------------------------------------------------------------
create or replace function public.notify_workflow_failure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner      uuid;
  v_event_id   uuid;
  v_event_name text;
begin
  if new.status <> 'failed' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'failed' then
    return new;  -- already reported; a retry that fails again is the same problem
  end if;

  select c.created_by, c.event_id into v_owner, v_event_id
    from public.event_makeup_campaigns c
   where c.id = new.campaign_id;

  if v_owner is null or v_event_id is null then
    return new;
  end if;

  select e.name into v_event_name from public.events e where e.id = v_event_id;

  insert into public.notifications (user_id, type, title, body, payload, dedupe_key)
  values (
    v_owner,
    'workflow_failed',
    'A make-up email did not send',
    format('At least one make-up email for %s was refused by the mail provider. Open the event to review and retry.', coalesce(v_event_name, 'an event')),
    jsonb_build_object('event_id', v_event_id, 'event_name', v_event_name),
    'makeup:' || new.campaign_id::text || ':failed'
  )
  on conflict (user_id, dedupe_key) do nothing;

  return new;
end
$$;

comment on function public.notify_workflow_failure() is
  'One notification per failed make-up campaign, to the staff member who ran it. Never one per recipient.';

drop trigger if exists event_makeup_deliveries_notify_failure on public.event_makeup_deliveries;
create trigger event_makeup_deliveries_notify_failure
  after insert or update of status on public.event_makeup_deliveries
  for each row execute function public.notify_workflow_failure();

-- ---------------------------------------------------------------------------
-- 3. Grants — trigger-only
-- ---------------------------------------------------------------------------
revoke all on function public.notify_event_change() from public, anon;
revoke all on function public.notify_workflow_failure() from public, anon;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'events_notify_change'
       and tgrelid = 'public.events'::regclass
  ) then
    raise exception 'FAIL: events_notify_change trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'event_makeup_deliveries_notify_failure'
       and tgrelid = 'public.event_makeup_deliveries'::regclass
  ) then
    raise exception 'FAIL: make-up failure trigger is missing';
  end if;

  if has_function_privilege('anon', 'public.notify_event_change()', 'EXECUTE')
     or has_function_privilege('anon', 'public.notify_workflow_failure()', 'EXECUTE') then
    raise exception 'FAIL: anon can execute a notification trigger';
  end if;

  raise notice 'notification centre OK: event changes, cancellations, failed workflows';
end
$$;
