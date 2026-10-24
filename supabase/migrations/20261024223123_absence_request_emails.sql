-- ============================================================================
-- RHS Music Platform — migration 20261024223123
-- Absence-request review emails
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Before this, a student asking to miss an event reached the reviewers only
-- through the in-app bell (`notify_absence_request`, 20261020113000). This adds
-- an email, one per (request, reviewer), sent shortly after the request is
-- submitted by the `absence-request-emails` Edge Function through Resend's API —
-- the same transport as the digest, the 48-hour reminder and the new-event
-- announcement. Nothing here sends mail on its own: applying this migration
-- changes no email behavior until the function is deployed and scheduled.
--
-- Deliberate boundaries
--   * Reviewers only. The queue is `memberships` joined to
--     `user_has_permission(…, 'absence.review')`, so it is exactly the people
--     the in-app notification already reaches: directors by default, plus any
--     custom role a director deliberately granted the review queue. Nobody
--     else learns a request exists.
--   * Not the student's own preference. `memberships.email_upcoming_events`
--     governs the *upcoming-events* digest. A request waiting for a decision is
--     operational mail to the reviewer, like the post-event make-up email, so
--     it is not gated by that switch.
--   * Decisions are not emailed. This migration covers a student asking; the
--     bell already tells the student the outcome, and adding a decision email is
--     a separate change.
--   * `absence_email_settings.enabled_since` is the cutover: a request that
--     already existed when the migration was applied is never mailed. Re-running
--     this migration must not move it.
--
-- Rollback: drop the two tables and the three functions. Nothing else
-- references them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cutover settings
-- ---------------------------------------------------------------------------
create table if not exists public.absence_email_settings (
  id            boolean primary key default true,
  -- Requests submitted before this instant are never emailed. Set once, when
  -- the feature is applied.
  enabled_since timestamptz not null default now(),
  constraint absence_email_settings_singleton check (id)
);

comment on table public.absence_email_settings is
  'One row. enabled_since is the cutover for absence-request review emails: a request that already existed before it is never mailed, so deploying the feature does not mail a backlog. Service-role only.';

insert into public.absence_email_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.absence_email_settings enable row level security;

drop policy if exists absence_email_settings_no_client_access
  on public.absence_email_settings;
create policy absence_email_settings_no_client_access
  on public.absence_email_settings
  for all to authenticated using (false) with check (false);

revoke all on table public.absence_email_settings from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Delivery record
-- ---------------------------------------------------------------------------
create table if not exists public.absence_request_email_deliveries (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.absence_requests (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  status          text not null default 'sending'
                    check (status in ('sending', 'sent', 'failed')),
  attempts        integer not null default 1 check (attempts > 0),
  resend_email_id text,
  error           text,
  claimed_at      timestamptz not null default now(),
  sent_at         timestamptz,
  -- One review email per request per reviewer. The key is the anti-duplicate
  -- guard: it is claimed before the send, so overlapping runs cannot both mail.
  constraint absence_request_email_deliveries_once_per_reviewer
    unique (request_id, user_id)
);

comment on table public.absence_request_email_deliveries is
  'One row per (absence request, reviewer) the review email was claimed for. The unique key is the anti-duplicate guard; a failure keeps the row and its attempt count so it can be retried. Service-role only.';

create index if not exists absence_request_email_deliveries_due_idx
  on public.absence_request_email_deliveries (status, claimed_at);

alter table public.absence_request_email_deliveries enable row level security;

drop policy if exists absence_request_email_deliveries_no_client_access
  on public.absence_request_email_deliveries;
create policy absence_request_email_deliveries_no_client_access
  on public.absence_request_email_deliveries
  for all to authenticated using (false) with check (false);

revoke all on table public.absence_request_email_deliveries from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Who is owed a review email, and about what
-- ---------------------------------------------------------------------------
create or replace function public.due_absence_request_emails(
  p_now   timestamptz default now(),
  p_limit integer     default 200
)
returns table (
  request_id   uuid,
  user_id      uuid,
  auth_user_id uuid,
  email        text,
  recipient    text,
  ensemble_id  uuid,
  program_name text,
  event_id     uuid,
  event_name   text,
  event_start  timestamptz,
  all_day      boolean,
  student_name text,
  reason       text,
  submitted_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id,
         m.user_id,
         u.id,
         u.email::text,
         coalesce(nullif(p.display_name, ''), nullif(p.full_name, ''), 'there')::text,
         a.ensemble_id,
         e.name::text,
         a.event_id,
         ev.name::text,
         ev.date,
         ev.all_day,
         coalesce(nullif(sp.display_name, ''), nullif(sp.full_name, ''), 'A student')::text,
         a.reason::text,
         a.created_at
    from public.absence_requests a
    join public.events ev      on ev.id = a.event_id
    join public.ensembles e    on e.id = a.ensemble_id
    join public.profiles sp    on sp.id = a.student_id
    join public.memberships m  on m.ensemble_id = a.ensemble_id
    join public.profiles p     on p.id = m.user_id
    join auth.users u          on u.id::text = p.auth_user_id
    join public.absence_email_settings s on s.id
   where a.status = 'pending'
     and not ev.archived
     and e.active
     and m.active
     and not p.deactivated
     and coalesce(u.email, '') <> ''
     and u.email_confirmed_at is not null
     -- The student asking is not a reviewer of their own request.
     and m.user_id <> a.student_id
     and public.user_has_permission(m.user_id, a.ensemble_id, 'absence.review')
     -- The cutover, plus a short lookback so a long outage does not leave a
     -- stale request queued forever.
     and a.created_at >= s.enabled_since
     and a.created_at >= p_now - interval '7 days'
     and not exists (
       select 1
         from public.absence_request_email_deliveries d
        where d.request_id = a.id
          and d.user_id = m.user_id
          and (
            d.status = 'sent'
            or (d.status = 'sending' and d.claimed_at > now() - interval '15 minutes')
            or d.attempts >= 3
          )
     )
   order by a.created_at, u.email
   limit greatest(coalesce(p_limit, 200), 1);
$$;

comment on function public.due_absence_request_emails(timestamptz, integer) is
  'Every (request, reviewer) owed an absence-review email at p_now: still pending, after the cutover, in an active program, and an active reviewer with a confirmed address who holds absence.review. Returns email addresses, so it is service-role only.';

revoke all on function public.due_absence_request_emails(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.due_absence_request_emails(timestamptz, integer) to service_role;

-- Claim before sending. Re-checks the request, program, membership, address and
-- capability so a decision, withdrawal, removal or opt-out that lands between
-- the queue read and the send cannot slip through. Returns the claim id, or null
-- when it is no longer eligible, already sent, in flight, or out of attempts.
create or replace function public.claim_absence_request_email(
  p_request uuid,
  p_user    uuid,
  p_now     timestamptz default now()
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
      from public.absence_requests a
      join public.events ev      on ev.id = a.event_id
      join public.ensembles e    on e.id = a.ensemble_id
      join public.memberships m  on m.ensemble_id = a.ensemble_id
      join public.profiles p     on p.id = m.user_id
      join auth.users u          on u.id::text = p.auth_user_id
      join public.absence_email_settings s on s.id
     where a.id = p_request
       and m.user_id = p_user
       and a.status = 'pending'
       and not ev.archived
       and e.active
       and m.active
       and not p.deactivated
       and coalesce(u.email, '') <> ''
       and u.email_confirmed_at is not null
       and m.user_id <> a.student_id
       and public.user_has_permission(m.user_id, a.ensemble_id, 'absence.review')
       and a.created_at >= s.enabled_since
       and a.created_at >= p_now - interval '7 days'
  ) into v_ok;

  if not v_ok then
    return null;
  end if;

  insert into public.absence_request_email_deliveries
    (request_id, user_id, status, attempts)
  values
    (p_request, p_user, 'sending', 1)
  on conflict (request_id, user_id) do update
    set status     = 'sending',
        attempts   = public.absence_request_email_deliveries.attempts + 1,
        error      = null,
        claimed_at = now()
    where public.absence_request_email_deliveries.attempts < 3
      and (
        -- A recorded failure is retryable.
        public.absence_request_email_deliveries.status = 'failed'
        -- A claim left behind by a crashed run is reclaimable after 15 minutes;
        -- before that it is treated as in flight.
        or (
          public.absence_request_email_deliveries.status = 'sending'
          and public.absence_request_email_deliveries.claimed_at < now() - interval '15 minutes'
        )
      )
  returning id into v_id;

  return v_id;
end
$$;

comment on function public.claim_absence_request_email(uuid, uuid, timestamptz) is
  'Atomically claims one absence-review email for (request, reviewer). Returns null when it is no longer eligible, already sent, being sent, or out of attempts. Re-checks every eligibility rule. Service-role only.';

revoke all on function public.claim_absence_request_email(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_absence_request_email(uuid, uuid, timestamptz) to service_role;

create or replace function public.complete_absence_request_email(
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
  update public.absence_request_email_deliveries
     set status          = case when coalesce(p_ok, false) then 'sent' else 'failed' end,
         resend_email_id = case when coalesce(p_ok, false) then left(p_resend_email_id, 200) else null end,
         error           = case when coalesce(p_ok, false) then null else left(coalesce(p_error, 'unknown error'), 500) end,
         sent_at         = case when coalesce(p_ok, false) then now() else sent_at end
   where id = p_id;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$$;

comment on function public.complete_absence_request_email(uuid, boolean, text, text) is
  'Records the result of one claimed absence-review email. A failure keeps the row (and its attempt count), so it is auditable and can be retried up to three times. Service-role only.';

revoke all on function public.complete_absence_request_email(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.complete_absence_request_email(uuid, boolean, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.due_absence_request_emails(timestamptz, integer)') is null then
    raise exception 'FAIL: due_absence_request_emails() was not created';
  end if;
  if to_regprocedure('public.claim_absence_request_email(uuid, uuid, timestamptz)') is null then
    raise exception 'FAIL: claim_absence_request_email() was not created';
  end if;
  if to_regprocedure('public.complete_absence_request_email(uuid, boolean, text, text)') is null then
    raise exception 'FAIL: complete_absence_request_email() was not created';
  end if;

  if not exists (select 1 from public.absence_email_settings where id) then
    raise exception 'FAIL: the absence-email cutover row is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.absence_request_email_deliveries'::regclass
       and conname = 'absence_request_email_deliveries_once_per_reviewer'
  ) then
    raise exception 'FAIL: the one-email-per-reviewer key is missing';
  end if;

  -- The tables carry addresses and delivery history: no client may read them.
  if has_table_privilege('authenticated', 'public.absence_request_email_deliveries', 'SELECT')
     or has_table_privilege('authenticated', 'public.absence_request_email_deliveries', 'INSERT')
     or has_table_privilege('authenticated', 'public.absence_email_settings', 'SELECT')
     or has_table_privilege('anon', 'public.absence_request_email_deliveries', 'SELECT')
     or has_table_privilege('anon', 'public.absence_email_settings', 'SELECT') then
    raise exception 'FAIL: a client role holds a privilege on an absence-email table';
  end if;

  -- Address-bearing / bookkeeping functions are service-role only.
  if has_function_privilege('authenticated', 'public.due_absence_request_emails(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.due_absence_request_emails(timestamptz, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_absence_request_email(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.claim_absence_request_email(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.complete_absence_request_email(uuid, boolean, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.complete_absence_request_email(uuid, boolean, text, text)', 'EXECUTE') then
    raise exception 'FAIL: a client role can execute an absence-email function';
  end if;

  if not has_function_privilege('service_role', 'public.due_absence_request_emails(timestamptz, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_absence_request_email(uuid, uuid, timestamptz)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.complete_absence_request_email(uuid, boolean, text, text)', 'EXECUTE') then
    raise exception 'FAIL: service_role cannot execute an absence-email function';
  end if;
end
$$;
