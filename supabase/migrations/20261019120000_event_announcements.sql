-- ============================================================================
-- RHS Music Platform — migration 20261019120000
-- New-event announcement emails
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- A newly added event is announced to the program's students by email, once per
-- (event, student), shortly after it is saved. The database decides who may be
-- mailed and keeps the idempotency record; the `event-announcements` Edge
-- Function renders and sends through Resend's API, the same transport as the
-- digest and the 48-hour reminder. Nothing here sends mail on its own, so
-- applying this migration changes no email behavior until the function is
-- deployed and scheduled.
--
--   * Only `event_source = 'manual'` events are announced. Calendar-sync
--     imports are suppressed from the in-app bell for the same reason (a first
--     import can add dozens of events at once); the digest and the 48-hour
--     reminder still cover those events.
--   * `event_announcement_settings.enabled_since` is the cutover point: events
--     that already existed when this migration was applied are never announced.
--     That is what keeps the first run from mailing the whole calendar.
--   * Eligibility mirrors the reminder: active program and membership, not
--     deactivated, a confirmed address, and the existing
--     `memberships.email_upcoming_events` preference. Directors and secretaries
--     are staff accounts, not recipients; section leaders are students.
--   * A timed event that has already started is skipped, and an all-day event is
--     still announced while its day is in progress. A run that is days late
--     cannot announce an event that is over.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cutover settings
-- ---------------------------------------------------------------------------
create table if not exists public.event_announcement_settings (
  id            boolean primary key default true,
  -- Events created before this instant are never announced. Set once, when the
  -- feature is applied; re-running this migration must not move it.
  enabled_since timestamptz not null default now(),
  constraint event_announcement_settings_singleton check (id)
);

comment on table public.event_announcement_settings is
  'One row. enabled_since is the cutover for new-event email announcements: an event created before it is never announced, so deploying the feature does not mail the existing calendar. Service-role only.';

insert into public.event_announcement_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.event_announcement_settings enable row level security;

drop policy if exists event_announcement_settings_no_client_access
  on public.event_announcement_settings;
create policy event_announcement_settings_no_client_access
  on public.event_announcement_settings
  for all to authenticated using (false) with check (false);

revoke all on table public.event_announcement_settings from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Delivery record
-- ---------------------------------------------------------------------------
create table if not exists public.event_announcement_deliveries (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  status          text not null default 'sending'
                    check (status in ('sending', 'sent', 'failed')),
  attempts        integer not null default 1 check (attempts > 0),
  resend_email_id text,
  error           text,
  claimed_at      timestamptz not null default now(),
  sent_at         timestamptz,
  -- One announcement per event per student. The key is the anti-duplicate
  -- guard: it is claimed before the send, so overlapping runs cannot both mail.
  constraint event_announcement_deliveries_once_per_student
    unique (event_id, user_id)
);

comment on table public.event_announcement_deliveries is
  'One row per (event, student) the new-event announcement was claimed for. The unique key is the anti-duplicate guard; a failure keeps the row and its attempt count so it can be retried. Service-role only.';

create index if not exists event_announcement_deliveries_due_idx
  on public.event_announcement_deliveries (status, claimed_at);

alter table public.event_announcement_deliveries enable row level security;

drop policy if exists event_announcement_deliveries_no_client_access
  on public.event_announcement_deliveries;
create policy event_announcement_deliveries_no_client_access
  on public.event_announcement_deliveries
  for all to authenticated using (false) with check (false);

revoke all on table public.event_announcement_deliveries from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Who is owed an announcement, and about what
-- ---------------------------------------------------------------------------
create or replace function public.due_event_announcements(
  p_now   timestamptz default now(),
  p_limit integer     default 500
)
returns table (
  event_id     uuid,
  user_id      uuid,
  auth_user_id uuid,
  email        text,
  recipient    text,
  ensemble_id  uuid,
  program_name text,
  event_name   text,
  event_start  timestamptz,
  event_end    timestamptz,
  all_day      boolean,
  location     text,
  event_type   text
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
    join public.event_announcement_settings s on s.id
   where not ev.archived
     and e.active
     and m.active
     and not p.deactivated
     and u.email is not null
     and u.email <> ''
     and u.email_confirmed_at is not null
     -- The existing "Upcoming events by email" switch is the app's one event
     -- email preference. An announcement is an event email, so it follows it.
     and m.email_upcoming_events
     -- Student recipients only: director and secretary are staff accounts.
     and not ('director' = any (m.roles))
     and not ('secretary' = any (m.roles))
     -- The creator already knows; the in-app bell makes the same exclusion.
     and m.user_id is distinct from ev.created_by
     -- Manual events only. Calendar imports are covered by the digest and the
     -- 48-hour reminder, and a first import can add dozens at once.
     and ev.event_source = 'manual'
     -- The cutover, plus a short lookback so a weekend outage does not leave
     -- stale announcements queued forever.
     and ev.created_at >= s.enabled_since
     and ev.created_at >= p_now - interval '7 days'
     -- Still to come. An all-day event is announced while its day (or its
     -- saved end date) is still in progress; a timed event is not announced
     -- after it has started.
     and (
       ev.date > p_now
       or (ev.all_day and coalesce(ev.end_date, ev.date + interval '1 day') > p_now)
     )
     and not exists (
       select 1
         from public.event_announcement_deliveries d
        where d.event_id = ev.id
          and d.user_id = m.user_id
          and (
            d.status = 'sent'
            or (d.status = 'sending' and d.claimed_at > now() - interval '15 minutes')
            or d.attempts >= 3
          )
     )
   order by ev.date, u.email
   limit greatest(coalesce(p_limit, 500), 1);
$$;

comment on function public.due_event_announcements(timestamptz, integer) is
  'Every (event, student) owed a new-event announcement at p_now: manually created, after the cutover, still to come, in an active program, and an active subscribed student with a confirmed address and no announcement already claimed. Returns email addresses, so it is service-role only.';

revoke all on function public.due_event_announcements(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.due_event_announcements(timestamptz, integer) to service_role;

-- Claim before sending. Re-reads the event, program, membership and address so
-- an opt-out, removal, archive or reschedule that lands between the queue read
-- and the send cannot slip through. Returns the claim id, or null when it is no
-- longer eligible, already sent, in flight, or out of attempts.
create or replace function public.claim_event_announcement(
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
  v_ok boolean;
  v_id uuid;
begin
  select exists (
    select 1
      from public.events ev
      join public.ensembles e  on e.id = ev.ensemble_id
      join public.memberships m on m.ensemble_id = ev.ensemble_id
      join public.profiles p   on p.id = m.user_id
      join auth.users u        on u.id::text = p.auth_user_id
      join public.event_announcement_settings s on s.id
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
       and m.user_id is distinct from ev.created_by
       and ev.event_source = 'manual'
       and ev.created_at >= s.enabled_since
       and ev.created_at >= p_now - interval '7 days'
       and (
         ev.date > p_now
         or (ev.all_day and coalesce(ev.end_date, ev.date + interval '1 day') > p_now)
       )
  ) into v_ok;

  if not v_ok then
    return null;
  end if;

  insert into public.event_announcement_deliveries
    (event_id, user_id, status, attempts)
  values
    (p_event, p_user, 'sending', 1)
  on conflict (event_id, user_id) do update
    set status     = 'sending',
        attempts   = public.event_announcement_deliveries.attempts + 1,
        error      = null,
        claimed_at = now()
    where public.event_announcement_deliveries.attempts < 3
      and (
        -- A recorded failure is retryable.
        public.event_announcement_deliveries.status = 'failed'
        -- A claim left behind by a crashed run is reclaimable after 15 minutes;
        -- before that it is treated as in flight.
        or (
          public.event_announcement_deliveries.status = 'sending'
          and public.event_announcement_deliveries.claimed_at < now() - interval '15 minutes'
        )
      )
  returning id into v_id;

  return v_id;
end
$$;

comment on function public.claim_event_announcement(uuid, uuid, timestamptz) is
  'Atomically claims one new-event announcement for (event, student). Returns null when it is no longer eligible, already sent, being sent, or out of attempts. Re-checks every eligibility rule. Service-role only.';

revoke all on function public.claim_event_announcement(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_event_announcement(uuid, uuid, timestamptz) to service_role;

create or replace function public.complete_event_announcement(
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
  update public.event_announcement_deliveries
     set status          = case when coalesce(p_ok, false) then 'sent' else 'failed' end,
         resend_email_id = case when coalesce(p_ok, false) then left(p_resend_email_id, 200) else null end,
         error           = case when coalesce(p_ok, false) then null else left(coalesce(p_error, 'unknown error'), 500) end,
         sent_at         = case when coalesce(p_ok, false) then now() else sent_at end
   where id = p_id;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$$;

comment on function public.complete_event_announcement(uuid, boolean, text, text) is
  'Records the result of one claimed new-event announcement. A failure keeps the row (and its attempt count), so it is auditable and can be retried up to three times. Service-role only.';

revoke all on function public.complete_event_announcement(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.complete_event_announcement(uuid, boolean, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.due_event_announcements(timestamptz, integer)') is null then
    raise exception 'FAIL: due_event_announcements() was not created';
  end if;
  if to_regprocedure('public.claim_event_announcement(uuid, uuid, timestamptz)') is null then
    raise exception 'FAIL: claim_event_announcement() was not created';
  end if;
  if to_regprocedure('public.complete_event_announcement(uuid, boolean, text, text)') is null then
    raise exception 'FAIL: complete_event_announcement() was not created';
  end if;

  if not exists (select 1 from public.event_announcement_settings where id) then
    raise exception 'FAIL: the announcement cutover row is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.event_announcement_deliveries'::regclass
       and conname = 'event_announcement_deliveries_once_per_student'
  ) then
    raise exception 'FAIL: the one-announcement-per-student key is missing';
  end if;

  -- The tables carry addresses and delivery history: no client may read them.
  if has_table_privilege('authenticated', 'public.event_announcement_deliveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.event_announcement_deliveries', 'INSERT')
     or has_table_privilege('authenticated', 'public.event_announcement_settings', 'SELECT')
     or has_table_privilege('anon', 'public.event_announcement_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.event_announcement_settings', 'SELECT') then
    raise exception 'FAIL: a client role holds a privilege on an announcement table';
  end if;

  -- Address-bearing / bookkeeping functions are service-role only.
  if has_function_privilege('authenticated', 'public.due_event_announcements(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.due_event_announcements(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_event_announcement(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.complete_event_announcement(uuid, boolean, text, text)', 'EXECUTE') then
    raise exception 'FAIL: a client role can execute an announcement function';
  end if;

  if not has_function_privilege('service_role', 'public.due_event_announcements(timestamptz, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_event_announcement(uuid, uuid, timestamptz)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.complete_event_announcement(uuid, boolean, text, text)', 'EXECUTE') then
    raise exception 'FAIL: service_role cannot execute an announcement function';
  end if;
end
$$;
