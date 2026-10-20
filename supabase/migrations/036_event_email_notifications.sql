-- ============================================================================
-- RHS Music Platform — Migration 036
-- Event reminder emails (48 hours before) and post-event make-up emails
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Two features, one delivery pattern: the database decides *who* may be mailed
-- and keeps the idempotency record; an Edge Function renders and sends through
-- Resend's API (the same transport as the event digest, 032). Nothing here
-- sends mail on its own, so applying this migration changes no email behavior
-- until the functions are deployed and scheduled.
--
-- 1. Reminders (scheduled)
--    `event_reminder_deliveries` is keyed by (event, member, event_start).
--    `event_start` is the schedule version: rescheduling an event creates a new
--    key, so the new time can be announced, while a repeated run for the same
--    schedule cannot duplicate. It is claimed *before* the send, so overlapping
--    cron runs cannot both mail the same person.
--
--    `due_event_reminders()` applies every eligibility rule in one place:
--      * active event, active program, active membership;
--      * not a deactivated account, not an unconfirmed/absent address;
--      * respects `memberships.email_upcoming_events` (the existing opt-out);
--      * not a staff account (director/secretary);
--      * the event is still in the future, at most 48 hours away, and at least
--        12 hours away (a late run must not send a "in two days" email hours
--        before the event);
--      * the event existed before its 48-hour mark — an event created after
--        that point is skipped, not mailed immediately;
--      * no reminder already sent/claimed for this (event, member, start).
--
-- 2. Make-up emails (manual)
--    `event_makeup_campaigns` is one send operation, idempotent by
--    (teacher, client operation id). `event_makeup_deliveries` is one row per
--    recipient, unique per campaign, with queued/accepted/failed state. A retry
--    of the same operation therefore skips anyone already accepted, while a
--    deliberate new operation starts a new campaign.
--
--    `makeup_email_context()` is the staff-only read behind the composer. It
--    returns names and statuses, never addresses, because the browser does not
--    need them: addresses are resolved server-side by the sending function.
--
-- 3. Access
--    Both delivery tables are deny-all to clients. Recipient queries and the
--    send bookkeeping are service-role only. The only client-callable function
--    is `makeup_email_context()`, and it refuses anyone who is not staff of the
--    event's program.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Reminder deliveries
-- ---------------------------------------------------------------------------
create table if not exists public.event_reminder_deliveries (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  -- The start the reminder was about. A reschedule changes this, which is the
  -- whole idempotency key; the event id alone would let a moved event pass
  -- silently or repeat forever.
  event_start     timestamptz not null,
  status          text not null default 'sending'
                    check (status in ('sending', 'sent', 'failed')),
  attempts        integer not null default 1 check (attempts > 0),
  resend_email_id text,
  error           text,
  claimed_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint event_reminder_deliveries_once_per_schedule
    unique (event_id, user_id, event_start)
);

comment on table public.event_reminder_deliveries is
  'One row per (event, member, event start) the 48-hour reminder was claimed for. The unique key is the anti-duplicate guard; event_start is the schedule version, so a rescheduled event can be reminded again without repeating the old one. Service-role only.';

create index if not exists event_reminder_deliveries_due_idx
  on public.event_reminder_deliveries (status, claimed_at);

alter table public.event_reminder_deliveries enable row level security;

drop policy if exists event_reminder_deliveries_no_client_access
  on public.event_reminder_deliveries;
create policy event_reminder_deliveries_no_client_access
  on public.event_reminder_deliveries
  for all to authenticated using (false) with check (false);

revoke all on table public.event_reminder_deliveries from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Make-up campaigns and deliveries
-- ---------------------------------------------------------------------------
create table if not exists public.event_makeup_campaigns (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references public.events (id) on delete cascade,
  created_by          uuid references public.profiles (id) on delete set null,
  -- The browser's operation id. Two submissions of the same composer session
  -- share it; a deliberate follow-up email gets a new one.
  client_operation_id uuid not null,
  subject             text not null,
  instructions        text not null default '',
  body_template       text not null,
  -- The schedule the email described, captured at send time. It keeps the log
  -- truthful if the event is edited afterwards.
  event_start         timestamptz not null,
  event_end           timestamptz not null,
  created_at          timestamptz not null default now(),
  constraint event_makeup_campaigns_one_operation
    unique (created_by, client_operation_id)
);

comment on table public.event_makeup_campaigns is
  'One manual make-up email operation: who ran it, for which event, with which subject/body, and the schedule it described. The (created_by, client_operation_id) key makes a double-click or a retried request the same campaign. Service-role only.';

create index if not exists event_makeup_campaigns_event_idx
  on public.event_makeup_campaigns (event_id, created_at desc);

alter table public.event_makeup_campaigns enable row level security;

drop policy if exists event_makeup_campaigns_no_client_access
  on public.event_makeup_campaigns;
create policy event_makeup_campaigns_no_client_access
  on public.event_makeup_campaigns
  for all to authenticated using (false) with check (false);

revoke all on table public.event_makeup_campaigns from public, anon, authenticated;

create table if not exists public.event_makeup_deliveries (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.event_makeup_campaigns (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  status          text not null default 'queued'
                    check (status in ('queued', 'accepted', 'failed')),
  attempts        integer not null default 0,
  resend_email_id text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint event_makeup_deliveries_once_per_recipient
    unique (campaign_id, user_id)
);

comment on table public.event_makeup_deliveries is
  'One row per recipient of a make-up campaign. Unique per campaign: a retry updates the row, it never creates a second send. Status is queued, accepted (Resend accepted it for delivery) or failed. Service-role only.';

create index if not exists event_makeup_deliveries_campaign_idx
  on public.event_makeup_deliveries (campaign_id, status);

alter table public.event_makeup_deliveries enable row level security;

drop policy if exists event_makeup_deliveries_no_client_access
  on public.event_makeup_deliveries;
create policy event_makeup_deliveries_no_client_access
  on public.event_makeup_deliveries
  for all to authenticated using (false) with check (false);

revoke all on table public.event_makeup_deliveries from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Actor-scoped capability check (for service-role calls)
-- ---------------------------------------------------------------------------
-- `has_permission()` resolves the caller from `auth.jwt()`, which a service-role
-- request does not carry. The sending function has already verified the user's
-- JWT, so it needs the same resolver for a named profile. This is deliberately
-- service-role only: it answers about *another* person's authority.
create or replace function public.has_permission_for(
  p_user      uuid,
  p_ensemble  uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.program_admins pa where pa.user_id = p_user
    )
    or exists (
      select 1
        from public.memberships m
        join public.roles r          on r.key = any (m.roles::text[]) and r.is_system
        join public.role_permissions rp on rp.role_id = r.id
       where m.user_id = p_user
         and m.ensemble_id = p_ensemble
         and m.active
         and rp.permission = any (public.permission_implications(p_permission))
    )
    or exists (
      select 1
        from public.user_role_assignments a
        join public.role_permissions rp on rp.role_id = a.role_id
        join public.roles r            on r.id = a.role_id and r.active
       where a.user_id = p_user
         and a.ensemble_id = p_ensemble
         and a.revoked_at is null
         and rp.permission = any (public.permission_implications(p_permission))
    )
$$;

comment on function public.has_permission_for(uuid, uuid, text) is
  'has_permission() for a named profile instead of the JWT caller. Used by service-role senders after they verify the teacher''s JWT. Service-role only — it reports another person''s authority.';

revoke all on function public.has_permission_for(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.has_permission_for(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Reminder queue: who is owed a reminder, and about what
-- ---------------------------------------------------------------------------
create or replace function public.due_event_reminders(
  p_now   timestamptz default now(),
  p_limit integer     default 500
)
returns table (
  event_id      uuid,
  user_id       uuid,
  auth_user_id  uuid,
  email         text,
  recipient     text,
  ensemble_id   uuid,
  program_name  text,
  event_name    text,
  event_start   timestamptz,
  event_end     timestamptz,
  all_day       boolean,
  location      text,
  event_type    text
)
language sql
security definer
set search_path = public
stable
as $$
  select ev.id,
         m.user_id,
         u.id,
         u.email::text,
         coalesce(nullif(p.display_name, ''), nullif(p.full_name, ''), 'there')::text,
         ev.ensemble_id,
         e.name::text,
         ev.name::text,
         ev.date,
         ev.end_date,
         ev.all_day,
         ev.location,
         ev.event_type
    from public.events ev
    join public.ensembles e  on e.id = ev.ensemble_id
    join public.memberships m on m.ensemble_id = ev.ensemble_id
    join public.profiles p   on p.id = m.user_id
    join auth.users u        on u.id::text = p.auth_user_id
   where not ev.archived
     and e.active
     and m.active
     and not p.deactivated
     and u.email is not null
     and u.email <> ''
     and u.email_confirmed_at is not null
     -- The existing "Upcoming events by email" switch is the app's one email
     -- preference. A reminder is an event email, so it follows it.
     and m.email_upcoming_events
     -- Student recipients only: director and secretary are staff accounts.
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles))
     -- Due window: at most 48 hours out, still far enough away that a delayed
     -- run is not a stale "in two days" message.
     and ev.date <= p_now + interval '48 hours'
     and ev.date >= p_now + interval '12 hours'
     -- An event created after its own 48-hour mark is skipped, never mailed
     -- immediately. This is checked at claim time too.
     and ev.created_at <= ev.date - interval '48 hours'
     and not exists (
       select 1
         from public.event_reminder_deliveries d
        where d.event_id = ev.id
          and d.user_id = m.user_id
          and d.event_start = ev.date
          and (
            -- Sent, or in flight right now: not due.
            d.status = 'sent'
            or (d.status = 'sending' and d.claimed_at > now() - interval '15 minutes')
            -- A wiped-out attempt budget is not retried automatically.
            or d.attempts >= 3
          )
     )
   order by ev.date, u.email
   limit greatest(coalesce(p_limit, 500), 1);
$$;

comment on function public.due_event_reminders(timestamptz, integer) is
  'Every (event, member) owed the 48-hour reminder at p_now: active, subscribed, confirmed address, student, event in the future and inside the due window, event older than its 48-hour mark, and no reminder already claimed for this schedule. Returns email addresses, so it is service-role only.';

revoke all on function public.due_event_reminders(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.due_event_reminders(timestamptz, integer) to service_role;

-- Claim before sending. Re-reads the event and the membership so a cancellation,
-- reschedule, removal or deactivation that lands between the queue query and the
-- send cannot slip through. Returns the claim id, or null when someone else has
-- it / it is no longer due.
create or replace function public.claim_event_reminder(
  p_event uuid,
  p_user  uuid,
  p_now   timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start   timestamptz;
  v_id      uuid;
begin
  select ev.date into v_start
    from public.events ev
    join public.ensembles e   on e.id = ev.ensemble_id
    join public.memberships m on m.ensemble_id = ev.ensemble_id
    join public.profiles p    on p.id = m.user_id
    join auth.users u         on u.id::text = p.auth_user_id
   where ev.id = p_event
     and m.user_id = p_user
     and not ev.archived
     and e.active
     and m.active
     and not p.deactivated
     and coalesce(u.email, '') <> ''
     and u.email_confirmed_at is not null
     and m.email_upcoming_events
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles))
     and ev.date <= p_now + interval '48 hours'
     and ev.date >= p_now + interval '12 hours'
     and ev.created_at <= ev.date - interval '48 hours';

  if v_start is null then
    return null;
  end if;

  insert into public.event_reminder_deliveries
    (event_id, user_id, event_start, status, attempts)
  values
    (p_event, p_user, v_start, 'sending', 1)
  on conflict (event_id, user_id, event_start) do update
    set status     = 'sending',
        attempts   = public.event_reminder_deliveries.attempts + 1,
        error      = null,
        claimed_at = now()
    where public.event_reminder_deliveries.attempts < 3
      and (
        -- A recorded failure is retryable.
        public.event_reminder_deliveries.status = 'failed'
        -- A claim left behind by a crashed run is reclaimable after 15 minutes;
        -- before that it is treated as in flight.
        or (
          public.event_reminder_deliveries.status = 'sending'
          and public.event_reminder_deliveries.claimed_at < now() - interval '15 minutes'
        )
      )
  returning id into v_id;

  return v_id;
end
$$;

comment on function public.claim_event_reminder(uuid, uuid, timestamptz) is
  'Atomically claims one reminder for (event, member, current schedule). Returns null when it is no longer due, already sent, being sent, or out of attempts. Re-checks every eligibility rule. Service-role only.';

revoke all on function public.claim_event_reminder(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_event_reminder(uuid, uuid, timestamptz) to service_role;

create or replace function public.complete_event_reminder(
  p_id              uuid,
  p_ok              boolean,
  p_resend_email_id text default null,
  p_error           text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.event_reminder_deliveries
     set status          = case when coalesce(p_ok, false) then 'sent' else 'failed' end,
         resend_email_id = case when coalesce(p_ok, false) then left(p_resend_email_id, 200) else null end,
         error           = case when coalesce(p_ok, false) then null else left(coalesce(p_error, 'unknown error'), 500) end,
         sent_at         = case when coalesce(p_ok, false) then now() else sent_at end
   where id = p_id;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$$;

comment on function public.complete_event_reminder(uuid, boolean, text, text) is
  'Records the result of one claimed reminder. A failure keeps the row (and its attempt count), so it is auditable and can be retried up to three times. Service-role only.';

revoke all on function public.complete_event_reminder(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.complete_event_reminder(uuid, boolean, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Make-up composer context (staff only, no addresses)
-- ---------------------------------------------------------------------------
create or replace function public.makeup_email_context(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_profile   uuid := public.current_profile_id();
  v_event     record;
  v_reason    text;
  v_can_send  boolean := false;
  v_recipients jsonb;
  v_unmarked  jsonb;
begin
  select ev.id, ev.name, ev.date, ev.end_date, ev.all_day, ev.location, ev.archived,
         ev.ensemble_id, e.name as program_name, e.active as program_active
    into v_event
    from public.events ev
    join public.ensembles e on e.id = ev.ensemble_id
   where ev.id = p_event;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That event does not exist.');
  end if;

  if v_profile is null or not public.is_ensemble_staff(v_event.ensemble_id) then
    return jsonb_build_object(
      'ok', false,
      'message', 'Only this program''s staff can email students about an event.'
    );
  end if;

  -- The same checks the sender repeats, in the order the screen explains them.
  if v_event.archived then
    v_reason := 'This event is archived, so make-up emails are off.';
  elsif not v_event.program_active then
    v_reason := 'This program is archived, so make-up emails are off.';
  elsif v_event.end_date is null then
    v_reason := 'This event has no end time. Add one before make-up emails can be sent.';
  elsif v_event.end_date <= v_event.date then
    v_reason := 'This event''s end time is not after its start, so make-up emails stay off.';
  elsif now() < v_event.end_date then
    v_reason := 'Available after this event ends.';
  else
    v_can_send := true;
  end if;

  -- Confirmed absent + still on the roster + reachable + not a staff account.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'user_id',    m.user_id,
               'name',       coalesce(nullif(p.display_name, ''), nullif(p.full_name, ''), 'Student'),
               'section',    coalesce(s.name, ''),
               'status',     ar.status
             )
             order by coalesce(nullif(p.display_name, ''), p.full_name)
           ),
           '[]'::jsonb
         )
    into v_recipients
    from public.attendance_records ar
    join public.memberships m on m.user_id = ar.student_id
                             and m.ensemble_id = v_event.ensemble_id
                             and m.active
    join public.profiles p on p.id = m.user_id
    join auth.users u      on u.id::text = p.auth_user_id
    left join public.sections s on s.id = m.section_id
   where ar.event_id = p_event
     and ar.status = 'absent'
     and not p.deactivated
     and coalesce(u.email, '') <> ''
     and u.email_confirmed_at is not null
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles));

  -- No attendance row is NOT an absence. These are shown separately, so a
  -- teacher can go and mark the roll instead of mailing an assumption.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'user_id', m.user_id,
               'name',    coalesce(nullif(p.display_name, ''), nullif(p.full_name, ''), 'Student'),
               'section', coalesce(s.name, '')
             )
             order by coalesce(nullif(p.display_name, ''), p.full_name)
           ),
           '[]'::jsonb
         )
    into v_unmarked
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    left join public.sections s on s.id = m.section_id
   where m.ensemble_id = v_event.ensemble_id
     and m.active
     and not p.deactivated
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles))
     and not exists (
       select 1 from public.attendance_records ar
        where ar.event_id = p_event and ar.student_id = m.user_id
     );

  return jsonb_build_object(
    'ok',          true,
    'can_send',    v_can_send,
    'reason',      v_reason,
    'event', jsonb_build_object(
      'id',       v_event.id,
      'name',     v_event.name,
      'date',     v_event.date,
      'end_date', v_event.end_date,
      'all_day',  v_event.all_day,
      'location', v_event.location,
      'archived', v_event.archived
    ),
    'program_name',   v_event.program_name,
    'teacher_name',   coalesce(
                        (select coalesce(nullif(display_name, ''), nullif(full_name, ''), '')
                           from public.profiles where id = v_profile),
                        ''),
    'recipients',     v_recipients,
    'unmarked',       v_unmarked
  );
end
$$;

comment on function public.makeup_email_context(uuid) is
  'For one event, staff only: whether make-up email is allowed right now and why not, the event/program/teacher names, confirmed-absent recipients (name, section, status) and — separately — active students with no attendance record. Returns no addresses.';

revoke all on function public.makeup_email_context(uuid) from public, anon;
grant execute on function public.makeup_email_context(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Begin (or resume) one make-up campaign
-- ---------------------------------------------------------------------------
-- Service-role only, called after the Edge Function has verified the caller's
-- JWT. It accepts the actor's profile id, re-checks their authority, re-checks
-- the event's end time, and freezes the recipient set from attendance records —
-- never from the browser. Addresses are returned only to that server caller.
create or replace function public.begin_makeup_email_campaign(
  p_event        uuid,
  p_actor        uuid,
  p_operation    uuid,
  p_subject      text,
  p_instructions text,
  p_body_template text,
  p_recipients   uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event       record;
  v_campaign    public.event_makeup_campaigns%rowtype;
  v_subject     text := btrim(coalesce(p_subject, ''));
  v_instructions text := coalesce(p_instructions, '');
  v_body        text := coalesce(p_body_template, '');
  v_recent      integer;
  v_eligible    integer;
  v_rows        jsonb;
begin
  if p_event is null or p_actor is null or p_operation is null then
    return jsonb_build_object('ok', false, 'message', 'The event, teacher and operation are required.');
  end if;
  if v_subject = '' then
    return jsonb_build_object('ok', false, 'message', 'Add a subject before sending.');
  end if;
  if length(v_subject) > 200 then
    return jsonb_build_object('ok', false, 'message', 'The subject must be 200 characters or fewer.');
  end if;
  if length(v_instructions) > 4000 then
    return jsonb_build_object('ok', false, 'message', 'The make-up instructions must be 4,000 characters or fewer.');
  end if;
  if length(v_body) > 8000 then
    return jsonb_build_object('ok', false, 'message', 'The message must be 8,000 characters or fewer.');
  end if;
  if v_body = '' then
    return jsonb_build_object('ok', false, 'message', 'Add a message before sending.');
  end if;

  select ev.id, ev.name, ev.date, ev.end_date, ev.archived,
         ev.ensemble_id, e.name as program_name, e.active as program_active
    into v_event
    from public.events ev
    join public.ensembles e on e.id = ev.ensemble_id
   where ev.id = p_event;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That event does not exist.');
  end if;

  if not public.has_permission_for(p_actor, v_event.ensemble_id, 'attendance.mark_present') then
    return jsonb_build_object(
      'ok', false,
      'message', 'You do not have permission to email students in this program.'
    );
  end if;

  if v_event.archived then
    return jsonb_build_object('ok', false, 'message', 'This event is archived, so make-up emails are off.');
  end if;
  if not v_event.program_active then
    return jsonb_build_object('ok', false, 'message', 'This program is archived, so make-up emails are off.');
  end if;
  if v_event.end_date is null or v_event.end_date <= v_event.date then
    return jsonb_build_object('ok', false, 'message', 'This event has no valid end time.');
  end if;
  if now() < v_event.end_date then
    return jsonb_build_object('ok', false, 'message', 'Available after this event ends.');
  end if;

  -- One operation id, one campaign. A repeated request resumes it instead of
  -- creating a second send, and accepted recipients are never selected again.
  select * into v_campaign
    from public.event_makeup_campaigns c
   where c.created_by = p_actor
     and c.client_operation_id = p_operation;

  if v_campaign.id is not null and v_campaign.event_id <> p_event then
    return jsonb_build_object(
      'ok', false,
      'message', 'That send operation belongs to a different event. Reload and try again.'
    );
  end if;

  if v_campaign.id is null then
    select count(*) into v_recent
      from public.event_makeup_campaigns c
     where c.created_by = p_actor
       and c.created_at > now() - interval '10 minutes';
    if v_recent >= 10 then
      return jsonb_build_object(
        'ok', false,
        'message', 'Too many email runs in a short time. Wait a few minutes and try again.'
      );
    end if;

    insert into public.event_makeup_campaigns
      (event_id, created_by, client_operation_id, subject, instructions, body_template, event_start, event_end)
    values
      (p_event, p_actor, p_operation, v_subject, v_instructions, v_body, v_event.date, v_event.end_date)
    returning * into v_campaign;
  end if;

  -- Freeze the recipient set from the database at this moment. The browser can
  -- narrow it with p_recipients, never widen it.
  select count(*) into v_eligible
    from public.attendance_records ar
    join public.memberships m on m.user_id = ar.student_id
                             and m.ensemble_id = v_event.ensemble_id
                             and m.active
    join public.profiles p on p.id = m.user_id
    join auth.users u      on u.id::text = p.auth_user_id
   where ar.event_id = p_event
     and ar.status = 'absent'
     and not p.deactivated
     and coalesce(u.email, '') <> ''
     and u.email_confirmed_at is not null
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles))
     and (p_recipients is null or m.user_id = any (p_recipients));

  if v_eligible > 500 then
    return jsonb_build_object(
      'ok', false,
      'message', 'This event has more than 500 eligible recipients. Send in smaller groups.'
    );
  end if;

  insert into public.event_makeup_deliveries (campaign_id, user_id)
  select v_campaign.id, m.user_id
    from public.attendance_records ar
    join public.memberships m on m.user_id = ar.student_id
                             and m.ensemble_id = v_event.ensemble_id
                             and m.active
    join public.profiles p on p.id = m.user_id
    join auth.users u      on u.id::text = p.auth_user_id
   where ar.event_id = p_event
     and ar.status = 'absent'
     and not p.deactivated
     and coalesce(u.email, '') <> ''
     and u.email_confirmed_at is not null
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles))
     and (p_recipients is null or m.user_id = any (p_recipients))
  on conflict (campaign_id, user_id) do nothing;

  -- Return only work still to do: an accepted recipient is never re-sent by a
  -- retry of this operation.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'delivery_id', d.id,
               'user_id',     d.user_id,
               'name',        coalesce(nullif(p.display_name, ''), nullif(p.full_name, ''), 'Student'),
               'email',       u.email,
               'section',     coalesce(s.name, ''),
               'status',      d.status,
               'attempts',    d.attempts
             )
             order by coalesce(nullif(p.display_name, ''), p.full_name)
           ),
           '[]'::jsonb
         )
    into v_rows
    from public.event_makeup_deliveries d
    join public.profiles p on p.id = d.user_id
    join auth.users u      on u.id::text = p.auth_user_id
    left join public.memberships m on m.user_id = d.user_id
                                  and m.ensemble_id = v_event.ensemble_id
    left join public.sections s on s.id = m.section_id
   where d.campaign_id = v_campaign.id
     and d.status <> 'accepted'
     -- A chunked send asks for its own slice. Without this, the second chunk
     -- would also pick up the first chunk's failures and retry them
     -- automatically, which is exactly what a failed-recipient retry is for.
     and (p_recipients is null or d.user_id = any (p_recipients));

  return jsonb_build_object(
    'ok',          true,
    'campaign_id', v_campaign.id,
    'event_id',    v_event.id,
    'event_name',  v_event.name,
    'event_start', v_event.date,
    'event_end',   v_event.end_date,
    'event_archived', v_event.archived,
    'program_name', v_event.program_name,
    'teacher_name', coalesce(
                      (select coalesce(nullif(display_name, ''), nullif(full_name, ''), '')
                         from public.profiles where id = p_actor),
                      ''),
    'recipients',  v_rows
  );
end
$$;

comment on function public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[]) is
  'Starts or resumes one make-up email operation for a teacher. Re-checks staff authority, the event end time, archived state and the frozen absent-recipient set; returns only recipients not yet accepted. Service-role only, called after the Edge Function verifies the JWT.';

revoke all on function public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[]) from public, anon, authenticated;
grant execute on function public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Record one make-up delivery result
-- ---------------------------------------------------------------------------
create or replace function public.record_makeup_email_delivery(
  p_campaign        uuid,
  p_user            uuid,
  p_ok              boolean,
  p_resend_email_id text default null,
  p_error           text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.event_makeup_deliveries
     set status          = case when coalesce(p_ok, false) then 'accepted' else 'failed' end,
         attempts        = attempts + 1,
         resend_email_id = case when coalesce(p_ok, false) then left(p_resend_email_id, 200) else null end,
         error           = case when coalesce(p_ok, false) then null else left(coalesce(p_error, 'unknown error'), 500) end,
         updated_at      = now()
   where campaign_id = p_campaign
     and user_id = p_user
     and status <> 'accepted';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$$;

comment on function public.record_makeup_email_delivery(uuid, uuid, boolean, text, text) is
  'Records one Resend result for a make-up recipient. An already-accepted delivery is never overwritten, so a retry cannot turn a success into a failure. Service-role only.';

revoke all on function public.record_makeup_email_delivery(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.record_makeup_email_delivery(uuid, uuid, boolean, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.due_event_reminders(timestamptz, integer)') is null then
    raise exception 'FAIL: due_event_reminders() was not created';
  end if;
  if to_regprocedure('public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[])') is null then
    raise exception 'FAIL: begin_makeup_email_campaign() was not created';
  end if;

  -- The tables carry addresses and delivery history: no client may read them.
  if has_table_privilege('authenticated', 'public.event_reminder_deliveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_reminder_deliveries', 'INSERT')
     or has_table_privilege('authenticated', 'public.event_makeup_campaigns', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_makeup_campaigns', 'INSERT')
     or has_table_privilege('authenticated', 'public.event_makeup_deliveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_makeup_deliveries', 'INSERT')
     or has_table_privilege('anon', 'public.event_reminder_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.event_makeup_campaigns', 'SELECT')
     or has_table_privilege('anon', 'public.event_makeup_deliveries', 'SELECT') then
    raise exception 'FAIL: a client role holds a privilege on an email delivery table';
  end if;

  -- Address-bearing / bookkeeping functions are service-role only.
  if has_function_privilege('authenticated', 'public.due_event_reminders(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.due_event_reminders(timestamptz, integer)', 'EXECUTE') then
    raise exception 'FAIL: a client role can execute due_event_reminders()';
  end if;
  if has_function_privilege('authenticated',
       'public.begin_makeup_email_campaign(uuid, uuid, uuid, text, text, text, uuid[])', 'EXECUTE') then
    raise exception 'FAIL: authenticated can execute begin_makeup_email_campaign()';
  end if;
  if has_function_privilege('authenticated', 'public.has_permission_for(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated can query another person''s permissions';
  end if;
  if not has_function_privilege('service_role', 'public.due_event_reminders(timestamptz, integer)', 'EXECUTE') then
    raise exception 'FAIL: service_role cannot execute due_event_reminders()';
  end if;

  -- The composer context is the one client-callable function.
  if not has_function_privilege('authenticated', 'public.makeup_email_context(uuid)', 'EXECUTE') then
    raise exception 'FAIL: authenticated cannot execute makeup_email_context()';
  end if;
  if has_function_privilege('anon', 'public.makeup_email_context(uuid)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute makeup_email_context()';
  end if;

  -- The two idempotency keys exist.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.event_reminder_deliveries'::regclass
       and conname = 'event_reminder_deliveries_once_per_schedule'
  ) then
    raise exception 'FAIL: the reminder once-per-schedule key is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.event_makeup_deliveries'::regclass
       and conname = 'event_makeup_deliveries_once_per_recipient'
  ) then
    raise exception 'FAIL: the make-up once-per-recipient key is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.event_makeup_campaigns'::regclass
       and conname = 'event_makeup_campaigns_one_operation'
  ) then
    raise exception 'FAIL: the make-up one-operation key is missing';
  end if;

  raise notice '036 OK: reminder and make-up delivery logs are private, idempotency keys exist, and only the staff composer context is client-callable';
end
$$;
