-- ============================================================================
-- RHS Music Platform — event-specific attendance requirements (analytics)
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Feature 4 of the 2026-10 expansion. The *model* already exists and is NOT
-- duplicated here: `events.attendance_requirement` ('required' | 'optional' |
-- 'none') arrived with 017, a CHECK ties `none` to `checkin_mode = 'none'`, and
-- `CalendarScreen` already edits it. What was missing was a way to *report* the
-- distinction without the director having to trust a single blended number.
--
-- Documented calculation rules (unchanged for the existing rate):
--
--   REQUIRED RATE — `attendance_pct_for(ensemble, student)` (016, untouched)
--     * past, non-archived events whose requirement is 'required';
--     * present and late are attended; absent or no record is a miss;
--     * an excused record removes that event from the student's denominator;
--     * directors are not measured.
--
--   OPTIONAL TURNOUT — reported here for the first time
--     * past, non-archived events whose requirement is 'optional';
--     * attended records / (optional events × active students), i.e. how many
--       of the possible attendances were actually taken up;
--     * informational only. It never adds to or subtracts from any required
--       percentage, and no ranking is derived from it.
--
--   EXCLUDED ('none')
--     * counted and named, never scored. `none` ⇔ `checkin_mode = 'none'`.
--
--   A MISSING ATTENDANCE ROW IS NOT A STORED 'absent' — the app deletes the row
--   for an absent mark, so the two are indistinguishable in storage. The
--   required rate therefore counts both as a miss (as it always has), but the
--   event summary below now reports `unrecorded` separately so nobody has to
--   infer "absent" from a missing row.
--
-- Re-classifying an event changes these calculations only. No attendance row is
-- written, rewritten or deleted by changing `attendance_requirement` — that is
-- asserted by `supabase/tests/event_requirements.sql`.
--
-- Rollback: this migration only adds one function and replaces two others with
-- the same signatures and a superset of their JSON keys. Drop
-- `get_event_requirement_stats(uuid)` and restore the 029 bodies of the other
-- two to roll back. No table, column, policy or grant is changed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Required vs optional vs excluded — one labelled answer
-- ---------------------------------------------------------------------------
create or replace function public.get_event_requirement_stats(p_ensemble uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_required_events  integer;
  v_optional_events  integer;
  v_excluded_events  integer;
  v_students         integer;
  v_measured         integer;
  v_required_avg     integer;
  v_optional_marks   integer;
  v_optional_attended integer;
  v_optional_turnout integer;
begin
  if not public.can_view_analytics(p_ensemble) then
    return jsonb_build_object('ok', false, 'message', 'Only directors can view analytics.');
  end if;

  select count(*) filter (where e.attendance_requirement = 'required'),
         count(*) filter (where e.attendance_requirement = 'optional'),
         count(*) filter (where e.attendance_requirement = 'none')
    into v_required_events, v_optional_events, v_excluded_events
    from public.events e
   where e.ensemble_id = p_ensemble
     and e.archived = false
     and e.date < now();

  -- The measured roster: active, not a director. (Directors don't have records.)
  select count(*) into v_students
    from public.memberships m
   where m.ensemble_id = p_ensemble
     and m.active
     and not ('director' = any(m.roles));

  -- The programme average only exists once there is at least one required event
  -- behind the roster. Until then it is null, not a misleading 0%. (Per-student
  -- maths is unchanged: `attendance_pct_for()` still returns 0 for a student
  -- with no required events, exactly as the analytics screen has always shown.)
  select count(*),
         round(avg(public.attendance_pct_for(p_ensemble, m.user_id)))
    into v_measured, v_required_avg
    from public.memberships m
   where m.ensemble_id = p_ensemble
     and m.active
     and not ('director' = any(m.roles))
     and exists (
       select 1
         from public.events e
        where e.ensemble_id = p_ensemble
          and e.archived = false
          and e.attendance_requirement = 'required'
          and e.date < now()
     );

  select count(*),
         count(*) filter (where ar.status in ('present', 'late'))
    into v_optional_marks, v_optional_attended
    from public.events e
    cross join lateral (
      select m.user_id
        from public.memberships m
       where m.ensemble_id = p_ensemble
         and m.active
         and not ('director' = any(m.roles))
    ) roster
    left join public.attendance_records ar
           on ar.event_id = e.id and ar.student_id = roster.user_id
   where e.ensemble_id = p_ensemble
     and e.archived = false
     and e.attendance_requirement = 'optional'
     and e.date < now();

  v_optional_turnout := case
    when coalesce(v_optional_marks, 0) = 0 then null
    else round(v_optional_attended::numeric / v_optional_marks * 100)
  end;

  return jsonb_build_object(
    'ok', true,
    'students', coalesce(v_students, 0),
    'measured_students', coalesce(v_measured, 0),
    'required_events', coalesce(v_required_events, 0),
    'required_average_pct', v_required_avg,
    'optional_events', coalesce(v_optional_events, 0),
    'optional_marks', coalesce(v_optional_marks, 0),
    'optional_attended', coalesce(v_optional_attended, 0),
    'optional_turnout_pct', v_optional_turnout,
    'excluded_events', coalesce(v_excluded_events, 0),
    'basis', 'Required: past, non-archived events marked Required. Present and late count as attended; an excused absence is left out of the total; a missing mark counts as a miss. Optional events are reported separately as turnout and never change the required rate. No-attendance events are excluded from both.'
  );
end
$$;

comment on function public.get_event_requirement_stats(uuid) is
  'Required-event attendance average plus optional-event turnout and the count of excluded events, with the calculation basis in words. Directors only.';

-- ---------------------------------------------------------------------------
-- 2. Event summary: say what the event was, and how many rows are missing
-- ---------------------------------------------------------------------------
create or replace function public.get_event_attendance_summary(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select case
        when not public.can_view_analytics(e.ensemble_id) then
          jsonb_build_object('ok', false, 'message', 'Only directors can view analytics.')
        else jsonb_build_object(
          'ok', true,
          'present', (select count(*) from public.attendance_records ar
                       where ar.event_id = e.id and ar.status = 'present'),
          'late',    (select count(*) from public.attendance_records ar
                       where ar.event_id = e.id and ar.status = 'late'),
          'excused', (select count(*) from public.attendance_records ar
                       where ar.event_id = e.id and ar.status = 'excused'),
          'absent',  (select count(*) from public.attendance_records ar
                       where ar.event_id = e.id and (ar.status = 'absent' or ar.status is null)),
          'total',   (select count(*) from public.memberships m
                       where m.ensemble_id = e.ensemble_id
                         and m.active
                         and not ('director' = any(m.roles))),
          -- The number that used to be inferable only by subtraction, and the
          -- one the report must not relabel as "absent".
          'unrecorded', (
            select count(*)
              from public.memberships m
             where m.ensemble_id = e.ensemble_id
               and m.active
               and not ('director' = any(m.roles))
               and not exists (
                 select 1 from public.attendance_records ar
                  where ar.event_id = e.id and ar.student_id = m.user_id
               )
          ),
          'attendance_requirement', e.attendance_requirement,
          'checkin_mode', e.checkin_mode
        )
      end
        from public.events e
       where e.id = p_event_id
    ),
    jsonb_build_object('ok', false, 'message', 'Unknown event.')
  )
$$;

comment on function public.get_event_attendance_summary(uuid) is
  'One event''s status counts plus its requirement, check-in mode and how many roster members have no record at all. Directors only.';

-- ---------------------------------------------------------------------------
-- 3. Trend rows: carry the requirement so the interface can label them
-- ---------------------------------------------------------------------------
-- Same signature and same required-only filter as 029; each row gains
-- `attendance_requirement` so the analytics table can say "Required" out loud
-- instead of relying on a paragraph in the UI.
create or replace function public.get_attendance_trend(p_ensemble uuid, p_limit integer DEFAULT 10)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.can_view_analytics(p_ensemble) then
      jsonb_build_object('ok', false, 'message', 'Only directors can view analytics.')
    else (
      with recent_events as (
        select e.id, e.name, e.type, e.date, e.event_type, e.attendance_requirement
          from public.events e
         where e.ensemble_id = p_ensemble
           and e.archived = false
           and e.attendance_requirement = 'required'
           and e.date < now()
         order by e.date desc
         limit greatest(coalesce(p_limit, 0), 0)
      ),
      event_stats as (
        select
          re.id, re.name, re.type, re.date, re.event_type, re.attendance_requirement,
          (select count(*) from public.memberships m
            where m.ensemble_id = p_ensemble
              and m.active
              and not ('director' = any(m.roles))) as roster_size,
          (select count(*) from public.attendance_records ar
            where ar.event_id = re.id and ar.attended = true) as present_count,
          (select count(*) from public.attendance_records ar
            where ar.event_id = re.id and ar.status = 'excused') as excused_count,
          (select count(*) from public.attendance_records ar
            where ar.event_id = re.id and ar.status = 'late') as late_count
        from recent_events re
      )
      select coalesce(jsonb_agg(row_to_json(es)), '[]'::jsonb) from event_stats es
    )
  end
$$;

-- ---------------------------------------------------------------------------
-- 4. A student's own trend: name the requirement too
-- ---------------------------------------------------------------------------
create or replace function public.my_attendance_trend(p_ensemble uuid, p_limit integer DEFAULT 8)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := public.current_profile_id();
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Not signed in.');
  end if;
  if not public.is_member_of(p_ensemble) then
    return jsonb_build_object('ok', false, 'message', 'You are not on this roster.');
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.date desc)
      from (
        select e.id,
               e.name,
               e.event_type,
               e.date,
               e.attendance_requirement,
               coalesce(ar.status::text, 'absent') as status,
               ar.attended,
               ar.checked_in_at
          from public.events e
          left join public.attendance_records ar
                 on ar.event_id = e.id and ar.student_id = v_me
         where e.ensemble_id = p_ensemble
           and e.archived = false
           and e.attendance_requirement = 'required'
           and e.date < now()
         order by e.date desc
         limit greatest(coalesce(p_limit, 0), 0)
      ) x
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants — unchanged surface, authenticated only
-- ---------------------------------------------------------------------------
revoke all on function public.get_event_requirement_stats(uuid) from public, anon;
grant execute on function public.get_event_requirement_stats(uuid) to authenticated, service_role;

revoke all on function public.get_event_attendance_summary(uuid) from public, anon;
grant execute on function public.get_event_attendance_summary(uuid) to authenticated, service_role;

revoke all on function public.get_attendance_trend(uuid, integer) from public, anon;
grant execute on function public.get_attendance_trend(uuid, integer) to authenticated, service_role;

revoke all on function public.my_attendance_trend(uuid, integer) from public, anon;
grant execute on function public.my_attendance_trend(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.get_event_requirement_stats(uuid)') is null then
    raise exception 'FAIL: get_event_requirement_stats() was not created';
  end if;

  if (public.get_event_requirement_stats(gen_random_uuid())->>'ok')::boolean then
    raise exception 'FAIL: requirement stats answered for an unknown program';
  end if;

  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'get_event_requirement_stats'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'FAIL: anon can execute get_event_requirement_stats';
  end if;

  raise notice 'event requirement analytics OK: required average, optional turnout, excluded count';
end
$$;
