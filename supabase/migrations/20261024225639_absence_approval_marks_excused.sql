-- ============================================================================
-- RHS Music Platform — migration 20261024225639
-- An approved absence marks the student excused on that event's roll
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Until now an approved absence request was only a decision on the Absences
-- screen: the roll stayed empty, the student could be marked absent on the day,
-- and the approval had to be remembered by hand. This makes the decision reach
-- the roll it is about.
--
-- What changes
--   * `decide_absence_request()` is replaced with the same body plus one step:
--     an approval writes an `excused` attendance record for (event, student).
--     The reviewer who approved is the `marked_by`, and the audit trail records
--     it with `source = 'absence_request'` — a value the history migration
--     already reserved for exactly this.
--   * Nothing else moves. A denial still writes no attendance at all, the
--     decision is still saved the same way, and only a pending request can be
--     decided.
--
-- Deliberate boundaries
--   * A recorded roll always wins. The record is only created when the student
--     has no record for that event; an existing present, late or excused mark is
--     never overwritten. A teacher who already marked the student has seen what
--     actually happened, and an approval cannot silently undo that. The
--     approval itself is still saved, and the response says the roll was left
--     alone.
--   * `excuse_reason` is the neutral `Approved absence request`. The student's
--     own reason is readable by `absence.review` holders; the roll is readable
--     by anyone who can view attendance, which is a wider group. Copying the
--     words across would leak them.
--   * An excused mark is final for check-in: the existing check-in RPC already
--     refuses a scan for an excused event ("You've been excused — no check-in
--     needed"), so an approved student is not asked to sign in as well.
--   * Analytics already leave an excused event out of the required-attendance
--     denominator, so an approved absence cannot lower a student's percentage.
--
-- Rollback: restore the `decide_absence_request()` body from
-- 20261020113000 (status/note/decider only). No table, column or grant changes.
-- ============================================================================

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
  v_me     uuid := public.current_profile_id();
  v_row    public.absence_requests%rowtype;
  v_note   text := left(btrim(coalesce(p_note, '')), 1000);
  v_marked uuid;
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

  if p_decision = 'approved' then
    -- The audit trigger reads these two settings, so the history says the excuse
    -- came from an approved request rather than a staff tap. Transaction-local,
    -- so a later write in the same session cannot inherit them.
    perform set_config('app.attendance_source', 'absence_request', true);
    perform set_config('app.attendance_reason', 'Approved absence request', true);

    -- Never overwrite a recorded roll: present, late and an earlier excused mark
    -- all stand. A missing record is exactly the "no one has marked this yet"
    -- case the approval should fill in.
    insert into public.attendance_records (
      event_id, student_id, attended, checked_in_at, status, excuse_reason, is_late, marked_by
    )
    values (
      v_row.event_id, v_row.student_id, false, null, 'excused',
      'Approved absence request', false, v_me
    )
    on conflict (event_id, student_id) do nothing
    returning id into v_marked;

    perform set_config('app.attendance_source', '', true);
    perform set_config('app.attendance_reason', '', true);
  end if;

  return jsonb_build_object(
    'ok', true,
    'message', case
      when p_decision = 'denied' then 'Absence denied.'
      when v_marked is not null then 'Absence approved — the roll now shows them excused.'
      else 'Absence approved. Their attendance was already recorded for that event, so the roll is unchanged.'
    end,
    'roll', case
      when p_decision = 'denied' then 'unchanged'
      when v_marked is not null then 'excused'
      else 'kept'
    end
  );
end
$$;

comment on function public.decide_absence_request(uuid, text, text) is
  'Approves or denies one pending request. An approval creates an excused attendance record for the event when the student has none, and never overwrites a recorded mark. A denial writes no attendance. The reviewer cannot decide their own request, and the decision is atomic against a concurrent withdrawal.';

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  if to_regprocedure('public.decide_absence_request(uuid, text, text)') is null then
    raise exception 'FAIL: decide_absence_request() is missing';
  end if;

  v_def := pg_get_functiondef('public.decide_absence_request(uuid, text, text)'::regprocedure);

  if position('insert into public.attendance_records' in v_def) = 0 then
    raise exception 'FAIL: the approval no longer marks attendance';
  end if;
  if position('on conflict (event_id, student_id) do nothing' in v_def) = 0 then
    raise exception 'FAIL: an approval could overwrite a recorded mark';
  end if;
  if position('''absence_request''' in v_def) = 0 then
    raise exception 'FAIL: the audit source is not set to absence_request';
  end if;

  -- Still the same surface: no client gained a direct write, and anonymous
  -- callers still cannot decide anything.
  if has_function_privilege('anon', 'public.decide_absence_request(uuid, text, text)', 'EXECUTE') then
    raise exception 'FAIL: anon can decide an absence request';
  end if;
  if not has_function_privilege('authenticated', 'public.decide_absence_request(uuid, text, text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated lost access to decide_absence_request()';
  end if;
end
$$;
