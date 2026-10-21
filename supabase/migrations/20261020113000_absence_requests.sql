-- ============================================================================
-- RHS Music Platform — absence requests and approval
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Feature 1 of the 2026-10 expansion. Today an "excused" absence is only ever a
-- staff decision written straight onto an attendance record; a student has no
-- way to ask in advance. This adds the asking half, with its own review queue.
--
-- Deliberate boundaries
--   * An approved request does NOT create, change or delete an attendance
--     record. Approval means "you may miss this"; it says nothing about whether
--     the event happened or how it was marked. `override_attendance` (029) stays
--     the only writer of attendance, so the excused/unexcused rules are
--     unchanged and an approval can never inflate a percentage before the event.
--   * The reason is a student's own words. It is readable by the student and by
--     reviewers (`absence.review`), and by nobody else — the RLS policy says so,
--     and no other function returns it.
--   * Duplicate protection is a partial unique index, not a UI check: one
--     non-withdrawn request per (event, student). Withdrawing re-opens the
--     event for that student; so does a reviewer deliberately allowing a
--     resubmission after a decision.
--   * Status values are exactly Pending / Approved / Denied / Withdrawn.
--
-- New capabilities (029 catalogue)
--   absence.request_self  every system role, scope self, delegable
--   absence.review        director by default, scope program, delegable — so a
--                         director can deliberately give a secretary or a
--                         section leader the review queue through a custom role.
--                         Section leaders and secretaries hold nothing extra
--                         until that happens, as the brief requires.
--
-- Rollback: drop the two triggers, the functions, the policies, the table and
-- the two seeded capabilities. Nothing else references the table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Capabilities
-- ---------------------------------------------------------------------------
insert into public.permissions (code, category, label, description, scope, delegable, sort_order)
values
  ('absence.request_self', 'absence', 'Request an absence',
   'Ask a director to excuse you from an upcoming event.', 'self', true, 60),
  ('absence.review', 'absence', 'Review absence requests',
   'See, approve, deny and follow up on students'' absence requests for this program.', 'program', true, 61)
on conflict (code) do update set
  category    = excluded.category,
  label       = excluded.label,
  description = excluded.description,
  scope       = excluded.scope,
  delegable   = excluded.delegable,
  sort_order  = excluded.sort_order;

-- Every system role may ask for itself. Only the director reviews by default.
insert into public.role_permissions (role_id, permission)
select r.id, 'absence.request_self'
  from public.roles r
 where r.is_system
   and r.key in ('student', 'section_leader', 'secretary', 'director')
on conflict (role_id, permission) do nothing;

insert into public.role_permissions (role_id, permission)
select r.id, 'absence.review'
  from public.roles r
 where r.is_system
   and r.key = 'director'
on conflict (role_id, permission) do nothing;

-- ---------------------------------------------------------------------------
-- 2. "Does THIS person hold this capability?" — for fan-out, not for callers
-- ---------------------------------------------------------------------------
-- `has_permission()` answers for the session's own user, which is right for
-- authorization but useless when a trigger must find every reviewer in a
-- program. Same rules, explicit user. Internal: no client role may execute it.
create or replace function public.user_has_permission(
  p_user uuid,
  p_ensemble uuid,
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

comment on function public.user_has_permission(uuid, uuid, text) is
  'The same union has_permission() computes, for an explicit person. Used by notification fan-out; not callable by clients.';

revoke all on function public.user_has_permission(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The table
-- ---------------------------------------------------------------------------
create table if not exists public.absence_requests (
  id                   uuid primary key default gen_random_uuid(),
  ensemble_id          uuid not null references public.ensembles (id) on delete cascade,
  event_id             uuid not null references public.events (id) on delete cascade,
  student_id           uuid not null references public.profiles (id) on delete cascade,
  reason               text not null default '',
  status               text not null default 'pending'
                         check (status in ('pending', 'approved', 'denied', 'withdrawn')),
  decision_note        text not null default '',
  decided_by           uuid references public.profiles (id) on delete set null,
  decided_at           timestamptz,
  -- Set by a reviewer to let the student ask again after a decision. The unique
  -- index below ignores such a row, which is the whole mechanism.
  resubmission_allowed boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint absence_requests_reason_len check (char_length(reason) between 1 and 1000),
  constraint absence_requests_note_len   check (char_length(decision_note) <= 1000)
);

comment on table public.absence_requests is
  'A student''s advance request to miss one event. Approval never writes attendance. Readable by the student and by holders of absence.review; written only through the RPCs below.';
comment on column public.absence_requests.decision_note is
  'Optional response from the reviewer, shown to the student.';

create unique index if not exists absence_requests_one_active
  on public.absence_requests (event_id, student_id)
  where status in ('pending', 'approved', 'denied') and resubmission_allowed = false;

create index if not exists absence_requests_ensemble_idx
  on public.absence_requests (ensemble_id, status, created_at desc);
create index if not exists absence_requests_student_idx
  on public.absence_requests (student_id, created_at desc);
create index if not exists absence_requests_decision_idx
  on public.absence_requests (ensemble_id, created_at desc)
  where status in ('approved', 'denied', 'withdrawn');

-- ---------------------------------------------------------------------------
-- 4. Shape guard — the program is derived, never trusted
-- ---------------------------------------------------------------------------
create or replace function public.guard_absence_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ensemble uuid;
  v_date     timestamptz;
  v_archived boolean;
  v_required text;
begin
  select e.ensemble_id, e.date, e.archived, e.attendance_requirement
    into v_ensemble, v_date, v_archived, v_required
    from public.events e
   where e.id = new.event_id;

  if v_ensemble is null then
    raise exception 'That event no longer exists.';
  end if;

  -- The request always belongs to the event's program, whatever was supplied.
  new.ensemble_id := v_ensemble;
  new.reason := btrim(coalesce(new.reason, ''));
  new.decision_note := btrim(coalesce(new.decision_note, ''));

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'A request always starts pending.';
    end if;
    if new.decided_by is not null or new.decided_at is not null then
      raise exception 'A new request cannot carry a decision.';
    end if;
    if not exists (
      select 1 from public.memberships m
       where m.user_id = new.student_id
         and m.ensemble_id = v_ensemble
         and m.active
    ) then
      raise exception 'That student is not on this roster.';
    end if;
    if v_archived then
      raise exception 'That event has been archived.';
    end if;
    if v_date <= now() then
      raise exception 'That event has already started.';
    end if;
    if v_required = 'none' then
      raise exception 'That event does not take attendance.';
    end if;
    return new;
  end if;

  if new.event_id <> old.event_id
     or new.student_id <> old.student_id
     or new.ensemble_id <> old.ensemble_id then
    raise exception 'A request cannot be moved to another student or event.';
  end if;

  if new.status <> old.status then
    if old.status <> 'pending' then
      raise exception 'Only a pending request can change status.';
    end if;
    if new.status not in ('approved', 'denied', 'withdrawn') then
      raise exception 'Unknown request status.';
    end if;
  end if;

  if old.status = 'withdrawn' and new.status <> 'withdrawn' then
    raise exception 'A withdrawn request cannot be reopened.';
  end if;

  if new.status in ('approved', 'denied')
     and (new.decided_by is null or new.decided_at is null) then
    raise exception 'A decision needs a reviewer and a time.';
  end if;

  if new.status = 'pending'
     and (new.decided_by is not null or new.decided_at is not null) then
    raise exception 'A pending request carries no decision.';
  end if;

  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists absence_requests_guard on public.absence_requests;
create trigger absence_requests_guard
  before insert or update on public.absence_requests
  for each row execute function public.guard_absence_request();

-- ---------------------------------------------------------------------------
-- 5. RLS — read your own, or review the program's; writes are RPC-only
-- ---------------------------------------------------------------------------
alter table public.absence_requests enable row level security;

drop policy if exists absence_requests_read_scoped on public.absence_requests;
create policy absence_requests_read_scoped on public.absence_requests
  for select to authenticated
  using (
    student_id = public.current_profile_id()
    or public.has_permission(ensemble_id, 'absence.review')
  );

-- No INSERT/UPDATE/DELETE policy and no grant: the only writers are the definer
-- RPCs below. Supabase's default privileges would hand the new table to every
-- signed-in role, so remove them explicitly.
revoke all on table public.absence_requests from public, anon, authenticated;
grant select on table public.absence_requests to authenticated;
grant select on table public.absence_requests to service_role;

-- ---------------------------------------------------------------------------
-- 6. Student RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_absence_request(
  p_event_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := public.current_profile_id();
  v_ensemble uuid;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_id      uuid;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to request an absence.');
  end if;

  select e.ensemble_id into v_ensemble from public.events e where e.id = p_event_id;
  if v_ensemble is null then
    return jsonb_build_object('ok', false, 'message', 'That event no longer exists.');
  end if;

  if not public.has_permission(v_ensemble, 'absence.request_self') then
    return jsonb_build_object('ok', false, 'message', 'You cannot request an absence in this program.');
  end if;

  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_me and m.ensemble_id = v_ensemble and m.active
  ) then
    return jsonb_build_object('ok', false, 'message', 'You are not on this roster.');
  end if;

  if exists (
    select 1 from public.memberships m
     where m.user_id = v_me
       and m.ensemble_id = v_ensemble
       and 'director' = any (m.roles)
  ) then
    return jsonb_build_object('ok', false, 'message', 'Directors don''t request absences.');
  end if;

  if char_length(v_reason) < 1 then
    return jsonb_build_object('ok', false, 'message', 'Say briefly why you will be away.');
  end if;
  if char_length(v_reason) > 1000 then
    return jsonb_build_object('ok', false, 'message', 'Keep the reason under 1,000 characters.');
  end if;

  begin
    insert into public.absence_requests (ensemble_id, event_id, student_id, reason)
    values (v_ensemble, p_event_id, v_me, v_reason)
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object(
        'ok', false,
        'message', 'You already have a request for this event. Withdraw it first if you need to change it.'
      );
    when others then
      return jsonb_build_object('ok', false, 'message', sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'message', 'Absence request sent.', 'request_id', v_id);
end
$$;

comment on function public.create_absence_request(uuid, text) is
  'A student asks to miss one future event. The program id is derived from the event; the caller is derived from the session; nothing else is trusted.';

create or replace function public.withdraw_absence_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := public.current_profile_id();
  v_row  public.absence_requests%rowtype;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to withdraw a request.');
  end if;

  select * into v_row from public.absence_requests where id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That request no longer exists.');
  end if;
  if v_row.student_id <> v_me then
    return jsonb_build_object('ok', false, 'message', 'That request is not yours.');
  end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('ok', false, 'message', 'Only a pending request can be withdrawn.');
  end if;

  update public.absence_requests
     set status = 'withdrawn'
   where id = p_request_id;

  return jsonb_build_object('ok', true, 'message', 'Request withdrawn.');
end
$$;

comment on function public.withdraw_absence_request(uuid) is
  'Withdraws one of the caller''s own pending requests. Nobody can withdraw somebody else''s.';

create or replace function public.list_my_absence_requests(
  p_ensemble uuid,
  p_limit integer DEFAULT 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me    uuid := public.current_profile_id();
  v_limit integer;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to see your requests.');
  end if;
  if not public.is_member_of(p_ensemble) then
    return jsonb_build_object('ok', false, 'message', 'You are not on this roster.');
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 25), 100));

  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc)
      from (
        select a.id,
               a.event_id,
               e.name as event_name,
               e.date as event_date,
               e.attendance_requirement,
               a.reason,
               a.status,
               a.decision_note,
               a.decided_at,
               coalesce(nullif(dp.display_name, ''), dp.full_name) as decided_by_name,
               a.resubmission_allowed,
               a.created_at,
               a.updated_at
          from public.absence_requests a
          join public.events e on e.id = a.event_id
          left join public.profiles dp on dp.id = a.decided_by
         where a.student_id = v_me
           and a.ensemble_id = p_ensemble
         order by a.created_at desc
         limit v_limit
      ) x
  ), '[]'::jsonb);
end
$$;

comment on function public.list_my_absence_requests(uuid, integer) is
  'The caller''s own absence requests in one program, newest first. Never returns anybody else''s.';

-- ---------------------------------------------------------------------------
-- 7. Reviewer RPCs
-- ---------------------------------------------------------------------------
create or replace function public.list_absence_requests(
  p_ensemble uuid,
  p_status text DEFAULT 'pending',
  p_event uuid DEFAULT null,
  p_section uuid DEFAULT null,
  p_student uuid DEFAULT null,
  p_limit integer DEFAULT 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me    uuid := public.current_profile_id();
  v_limit integer;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to review absence requests.');
  end if;
  if not public.has_permission(p_ensemble, 'absence.review') then
    return jsonb_build_object('ok', false, 'message', 'You are not authorized to review absence requests for this program.');
  end if;
  if p_status is not null and p_status <> 'all'
     and p_status not in ('pending', 'approved', 'denied', 'withdrawn') then
    return jsonb_build_object('ok', false, 'message', 'Unknown request status.');
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 200), 500));

  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc)
      from (
        select a.id,
               a.event_id,
               e.name as event_name,
               e.date as event_date,
               e.attendance_requirement,
               a.student_id,
               coalesce(nullif(sp.display_name, ''), sp.full_name) as student_name,
               m.section_id,
               coalesce(sec.name, '') as section,
               a.reason,
               a.status,
               a.decision_note,
               a.decided_at,
               coalesce(nullif(dp.display_name, ''), dp.full_name) as decided_by_name,
               a.resubmission_allowed,
               a.created_at,
               a.updated_at
          from public.absence_requests a
          join public.events e on e.id = a.event_id
          join public.profiles sp on sp.id = a.student_id
          left join public.memberships m
                 on m.user_id = a.student_id and m.ensemble_id = a.ensemble_id
          left join public.sections sec on sec.id = m.section_id
          left join public.profiles dp on dp.id = a.decided_by
         where a.ensemble_id = p_ensemble
           and (p_status is null or p_status = 'all' or a.status = p_status)
           and (p_event is null or a.event_id = p_event)
           and (p_section is null or m.section_id = p_section)
           and (p_student is null or a.student_id = p_student)
         order by a.created_at desc
         limit v_limit
      ) x
  ), '[]'::jsonb);
end
$$;

create or replace function public.decide_absence_request(
  p_request_id uuid,
  p_decision text,
  p_note text DEFAULT ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := public.current_profile_id();
  v_row  public.absence_requests%rowtype;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to review absence requests.');
  end if;
  if p_decision not in ('approved', 'denied') then
    return jsonb_build_object('ok', false, 'message', 'Choose approved or denied.');
  end if;

  select * into v_row from public.absence_requests where id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That request no longer exists.');
  end if;

  -- Authority comes from the request's program, never from the caller.
  if not public.has_permission(v_row.ensemble_id, 'absence.review') then
    return jsonb_build_object('ok', false, 'message', 'You are not authorized to review absence requests for this program.');
  end if;

  if v_row.student_id = v_me then
    return jsonb_build_object('ok', false, 'message', 'You cannot decide your own request.');
  end if;

  if v_row.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'message', case v_row.status
        when 'withdrawn' then 'That request was withdrawn.'
        when 'approved' then 'That request is already approved.'
        when 'denied' then 'That request is already denied.'
        else 'That request is not open for a decision.'
      end
    );
  end if;

  update public.absence_requests
     set status = p_decision,
         decision_note = v_note,
         decided_by = v_me,
         decided_at = now()
   where id = p_request_id
     and status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That request changed while you were deciding it. Reload and try again.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', case p_decision when 'approved' then 'Absence approved.' else 'Absence denied.' end
  );
end
$$;

comment on function public.decide_absence_request(uuid, text, text) is
  'Approves or denies one pending request. Approval writes no attendance record. The reviewer cannot decide their own request, and the decision is atomic against a concurrent withdrawal.';

create or replace function public.allow_absence_resubmission(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := public.current_profile_id();
  v_row public.absence_requests%rowtype;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to review absence requests.');
  end if;

  select * into v_row from public.absence_requests where id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That request no longer exists.');
  end if;
  if not public.has_permission(v_row.ensemble_id, 'absence.review') then
    return jsonb_build_object('ok', false, 'message', 'You are not authorized to review absence requests for this program.');
  end if;
  if v_row.status not in ('approved', 'denied') then
    return jsonb_build_object('ok', false, 'message', 'Only a decided request can be reopened for a new ask.');
  end if;

  update public.absence_requests
     set resubmission_allowed = true
   where id = p_request_id;

  return jsonb_build_object('ok', true, 'message', 'That student can submit a new request for this event.');
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Notifications — reviewers on submit, student on decision
-- ---------------------------------------------------------------------------
create or replace function public.notify_absence_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_name text;
  v_student    text;
begin
  select e.name into v_event_name from public.events e where e.id = new.event_id;
  select coalesce(nullif(p.display_name, ''), p.full_name)
    into v_student
    from public.profiles p where p.id = new.student_id;

  insert into public.notifications (user_id, type, title, body, payload, dedupe_key)
  select m.user_id,
         'absence_request',
         'Absence request to review',
         format('%s asked to miss %s.', coalesce(v_student, 'A student'), coalesce(v_event_name, 'an event')),
         jsonb_build_object(
           'event_id', new.event_id,
           'event_name', v_event_name,
           'request_id', new.id
         ),
         'absence:request:' || new.id::text
    from public.memberships m
   where m.ensemble_id = new.ensemble_id
     and m.active
     and m.user_id <> new.student_id
     and public.user_has_permission(m.user_id, new.ensemble_id, 'absence.review')
  on conflict (user_id, dedupe_key) do nothing;

  return new;
end
$$;

drop trigger if exists absence_requests_notify_reviewers on public.absence_requests;
create trigger absence_requests_notify_reviewers
  after insert on public.absence_requests
  for each row execute function public.notify_absence_request();

create or replace function public.notify_absence_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_name text;
begin
  if old.status <> 'pending' or new.status not in ('approved', 'denied') then
    return new;
  end if;

  select e.name into v_event_name from public.events e where e.id = new.event_id;

  insert into public.notifications (user_id, type, title, body, payload, dedupe_key)
  values (
    new.student_id,
    'absence_decision',
    case new.status when 'approved' then 'Absence approved' else 'Absence denied' end,
    format(
      '%s — %s%s',
      coalesce(v_event_name, 'Your event'),
      case new.status when 'approved' then 'your absence was approved.' else 'your absence request was denied.' end,
      case when new.decision_note <> '' then ' ' || new.decision_note else '' end
    ),
    jsonb_build_object(
      'event_id', new.event_id,
      'event_name', v_event_name,
      'request_id', new.id
    ),
    'absence:decision:' || new.id::text
  )
  on conflict (user_id, dedupe_key) do nothing;

  return new;
end
$$;

drop trigger if exists absence_requests_notify_decision on public.absence_requests;
create trigger absence_requests_notify_decision
  after update of status on public.absence_requests
  for each row execute function public.notify_absence_decision();

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
-- Trigger functions default to EXECUTE for PUBLIC; close that like every other
-- function in this schema (the security suite asserts anon can execute none).
revoke all on function public.guard_absence_request() from public, anon;
revoke all on function public.notify_absence_request() from public, anon;
revoke all on function public.notify_absence_decision() from public, anon;

revoke all on function public.create_absence_request(uuid, text) from public, anon;
grant execute on function public.create_absence_request(uuid, text) to authenticated, service_role;

revoke all on function public.withdraw_absence_request(uuid) from public, anon;
grant execute on function public.withdraw_absence_request(uuid) to authenticated, service_role;

revoke all on function public.list_my_absence_requests(uuid, integer) from public, anon;
grant execute on function public.list_my_absence_requests(uuid, integer) to authenticated, service_role;

revoke all on function public.list_absence_requests(uuid, text, uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.list_absence_requests(uuid, text, uuid, uuid, uuid, integer) to authenticated, service_role;

revoke all on function public.decide_absence_request(uuid, text, text) from public, anon;
grant execute on function public.decide_absence_request(uuid, text, text) to authenticated, service_role;

revoke all on function public.allow_absence_resubmission(uuid) from public, anon;
grant execute on function public.allow_absence_resubmission(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.absence_requests') is null then
    raise exception 'FAIL: absence_requests was not created';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'absence_requests_one_active'
  ) then
    raise exception 'FAIL: the one-active-request index is missing';
  end if;

  if (select count(*) from public.permissions
       where code in ('absence.request_self', 'absence.review')) <> 2 then
    raise exception 'FAIL: absence capabilities were not seeded';
  end if;

  if not exists (
    select 1 from public.role_permissions rp
      join public.roles r on r.id = rp.role_id
     where r.is_system and r.key = 'director' and rp.permission = 'absence.review'
  ) then
    raise exception 'FAIL: directors do not hold absence.review';
  end if;

  if exists (
    select 1 from public.role_permissions rp
      join public.roles r on r.id = rp.role_id
     where r.is_system and r.key in ('student', 'section_leader', 'secretary')
       and rp.permission = 'absence.review'
  ) then
    raise exception 'FAIL: absence.review was granted to a non-director system role by default';
  end if;

  if has_table_privilege('authenticated', 'public.absence_requests', 'INSERT')
     or has_table_privilege('authenticated', 'public.absence_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.absence_requests', 'DELETE') then
    raise exception 'FAIL: authenticated can write absence_requests directly';
  end if;

  if has_function_privilege('anon', 'public.create_absence_request(uuid, text)', 'EXECUTE') then
    raise exception 'FAIL: anon can create an absence request';
  end if;

  raise notice 'absence requests OK: capabilities, table, RPCs, notifications';
end
$$;
