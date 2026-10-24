-- ============================================================================
-- RHS Music Platform — Migration: check-in opens as soon as an event exists
-- ============================================================================
-- Idempotent — create or replace only; safe to re-run.
--
-- WHAT CHANGES
--   1. public.start_checkin_session(uuid) no longer refuses when the event is
--      more than 15 minutes away, so staff can open a code for any event that
--      has not ended yet, at any time of day.
--   2. public.record_checkin_for_session(uuid, uuid) no longer rejects scans
--      that arrive before that window, so a code opened early works.
--
-- WHAT DOES NOT CHANGE
--   * A session is still five minutes long, and an expired code is still
--     refused ("That code has expired").
--   * An event that has already ended still refuses both a new session and a
--     scan — check-in is not retroactive.
--   * The capability gate on opening a session, the QR/toggle/none mode gate,
--     the per-actor rate limit, the excused protection, first-check-in-wins and
--     the status ⟺ attended invariant are carried over verbatim.
--   * Lateness is still measured from the event start + `late_minutes`, so an
--     early check-in records "present", never "late".
--
-- ROLLBACK
--   Re-apply the two function definitions from 029_roles_and_permissions.sql
--   (start_checkin_session) and 016_ensemble_rpcs.sql
--   (record_checkin_for_session) in a new timestamped migration — do not edit
--   those applied files. That restores the 15-minute window and both original
--   messages.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Opening a session: capability-gated, any time before the event ends
-- ---------------------------------------------------------------------------
-- Body carried over from 029_roles_and_permissions.sql, with the early window
-- removed. The capability check is what decides who may open a code.
create or replace function public.start_checkin_session(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := public.current_profile_id();
  v_event   public.events%rowtype;
  v_token   text;
  v_entry   text;
  v_expires timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to generate a code.');
  end if;

  select * into v_event from public.events where id = p_event_id;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That event no longer exists.');
  end if;

  -- Capability-backed: director, secretary and section leader, plus any custom
  -- role deliberately granted attendance.manage_checkin_sessions.
  if not public.has_permission(v_event.ensemble_id, 'attendance.manage_checkin_sessions') then
    return jsonb_build_object('ok', false, 'message', 'Only directors, secretaries and section leaders can generate codes.');
  end if;

  if v_event.checkin_mode = 'toggle' then
    return jsonb_build_object('ok', false, 'message', 'This event uses toggle check-in — mark attendance with the buttons on the Check-In screen.');
  end if;
  if v_event.checkin_mode = 'none' then
    return jsonb_build_object('ok', false, 'message', 'This event doesn''t collect attendance.');
  end if;
  if now() > coalesce(v_event.end_date, v_event.date + interval '24 hours') then
    return jsonb_build_object('ok', false, 'message', 'That event has already ended — check-in is closed.');
  end if;

  delete from public.checkin_sessions where event_id = p_event_id;

  v_entry := (
    select string_agg(
      substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (random() * 32)::int + 1, 1), ''
    )
    from generate_series(1, 8)
  );

  insert into public.checkin_sessions (event_id, created_by, token, entry_code, expires_at)
  values (
    p_event_id,
    v_uid,
    encode(gen_random_bytes(24), 'hex'),
    v_entry,
    now() + interval '5 minutes'
  )
  returning token, entry_code, expires_at into v_token, v_entry, v_expires;

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'entry_code', v_entry,
    'expires_at', v_expires
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Recording a scan: the same session rules, without the early window
-- ---------------------------------------------------------------------------
-- Shared by the QR (token) and manual (code) paths. Body carried over from
-- 016_ensemble_rpcs.sql, with the not-open-yet refusal removed.
create or replace function public.record_checkin_for_session(p_session_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session   record;
  v_record    public.attendance_records%rowtype;
  v_event_id  uuid;
  v_attempt   uuid;
  v_is_late   boolean := false;
  v_status    text;
  v_late_mins int;
begin
  if p_actor is null then
    return jsonb_build_object('ok', false, 'message', 'You are not signed in.');
  end if;

  select cs.id, cs.event_id, cs.expires_at,
         ev.name as event_name, ev.date as event_date, ev.end_date as event_end,
         ev.late_minutes, ev.checkin_mode, ev.ensemble_id
    into v_session
    from public.checkin_sessions cs
    join public.events ev on ev.id = cs.event_id
   where cs.id = p_session_id
   limit 1;

  v_event_id := v_session.event_id;

  -- Directors run the band; they don't check in — evaluated in the event's
  -- program, so a director of one program can still check into another. Both
  -- of these come before the rate limiter, so a staff mis-tap never burns an
  -- attempt against a student's bucket.
  if v_session.id is not null then
    if public.has_role_in(v_session.ensemble_id, 'director') then
      return jsonb_build_object('ok', false, 'message', 'Directors don''t check in.');
    end if;
    if not public.is_member_of(v_session.ensemble_id) then
      return jsonb_build_object('ok', false, 'message', 'You are not on this roster.');
    end if;
  end if;

  -- Rate limit: more than 5 failed attempts for this event (or the unknown-code
  -- bucket) in the last 2 minutes → refuse.
  if (select count(*) from public.checkin_attempts
       where actor_id = p_actor
         and event_id is not distinct from v_event_id
         and success = false
         and created_at > now() - interval '2 minutes') >= 5 then
    insert into public.checkin_attempts (event_id, actor_id, success)
    values (v_event_id, p_actor, false);
    return jsonb_build_object('ok', false, 'message', 'Too many attempts — try again in a minute.');
  end if;

  insert into public.checkin_attempts (event_id, actor_id, success)
  values (v_event_id, p_actor, false)
  returning id into v_attempt;

  if v_session.id is null then
    return jsonb_build_object('ok', false, 'message', 'That code was not recognized.');
  end if;

  if v_session.expires_at <= now() then
    return jsonb_build_object('ok', false, 'message', 'That code has expired — ask for a fresh one.');
  end if;

  -- A QR token only works while the event still collects attendance via QR.
  -- This kills tokens whose event was switched to toggle/none even if the
  -- session row somehow survived the invalidation trigger.
  if v_session.checkin_mode not in ('qr', 'both') then
    return jsonb_build_object('ok', false, 'message', 'This event doesn''t use QR check-in.');
  end if;

  -- Attendance is only accepted while the event is happening. Once it's over,
  -- the code is dead even if it's still unexpired — no retroactive check-ins.
  if now() > coalesce(v_session.event_end, v_session.event_date + interval '24 hours') then
    return jsonb_build_object('ok', false, 'message', 'That event has already ended — attendance is closed.');
  end if;

  -- A staff-set excuse is final: don't let a scan overwrite it.
  if exists (
    select 1 from public.attendance_records ar
     where ar.event_id = v_session.event_id
       and ar.student_id = p_actor
       and ar.status = 'excused'
  ) then
    return jsonb_build_object('ok', false, 'message', 'You''ve been excused for this event — no check-in needed.');
  end if;

  v_late_mins := coalesce(v_session.late_minutes, 10);
  if v_session.event_date + (v_late_mins || ' minutes')::interval < now() then
    v_is_late := true;
    v_status := 'late';
  else
    v_status := 'present';
  end if;

  insert into public.attendance_records (
    event_id, student_id, attended, checked_in_at, status, is_late
  )
  values (
    v_session.event_id, p_actor, true, now(), v_status, v_is_late
  )
  on conflict (event_id, student_id)
  do update set
    -- First check-in wins: keep an existing present/late status, lateness flag
    -- and timestamp. Anything else (legacy 'absent' rows) is upgraded to this
    -- check-in's status so status and attended can never disagree.
    status = case
      when attendance_records.status in ('present', 'late') then attendance_records.status
      else excluded.status
    end,
    is_late = case
      when attendance_records.status in ('present', 'late') then attendance_records.is_late
      else excluded.is_late
    end,
    attended = true,
    checked_in_at = case
      when attendance_records.status in ('present', 'late')
        then coalesce(attendance_records.checked_in_at, now())
      else now()
    end
  returning * into v_record;

  update public.checkin_attempts set success = true where id = v_attempt;

  -- Defend the invariant even against a lost race with a concurrent excuse:
  -- the row must never be excused + attended = true.
  if v_record.status = 'excused' then
    return jsonb_build_object('ok', false, 'message', 'You''ve been excused for this event — no check-in needed.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', case when v_record.status = 'late' then 'Checked in (late)' else 'Checked in' end,
    'event_id', v_session.event_id,
    'event_name', v_session.event_name,
    'checked_in_at', v_record.checked_in_at,
    'is_late', v_record.status = 'late'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_start  text := pg_get_functiondef('public.start_checkin_session(uuid)'::regprocedure);
  v_record text := pg_get_functiondef('public.record_checkin_for_session(uuid, uuid)'::regprocedure);
begin
  if position('Check-in opens 15 minutes' in v_start) > 0
     or position('interval ''15 minutes''' in v_start) > 0 then
    raise exception 'FAIL: start_checkin_session still carries the early window';
  end if;

  if position('Check-in has not opened yet' in v_record) > 0
     or position('event_date - interval ''15 minutes''' in v_record) > 0 then
    raise exception 'FAIL: record_checkin_for_session still rejects early scans';
  end if;

  -- The ended-event gate must survive the rewrite.
  if position('already ended' in v_start) = 0
     or position('already ended' in v_record) = 0 then
    raise exception 'FAIL: the ended-event gate went missing';
  end if;

  if position('has_permission' in v_start) = 0 then
    raise exception 'FAIL: the capability gate went missing from start_checkin_session';
  end if;

  raise notice 'OK — check-in opens as soon as an event exists (ended events still closed).';
end
$$;
