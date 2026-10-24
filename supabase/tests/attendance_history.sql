-- ============================================================================
-- attendance_history.sql — the attendance audit trail
-- ============================================================================
-- requires-table: public.attendance_audit
--
-- Covers migration 20261020112000. One transaction, ROLLED BACK.
--
-- Asserts:
--   A  a manual correction writes exactly one entry with the right before/after,
--      actor, event, student and reason
--   B  a repeated save that changes nothing writes nothing
--   C  a real change records the previous and new value, and a plain
--      override_attendance (no reason) does not inherit the previous reason
--   D  clearing a mark (an absent mark deletes the row) is recorded as
--      "no record", not as a stored "absent"
--   E  a bulk action is one understandable set of entries with source = bulk
--   F  a student's own QR check-in is recorded with source = check_in
--   G  excuse explanations and staff notes are never copied into the audit
--   H  a failed operation creates no entry
--   I  students cannot read history; a section leader sees only their section;
--      a director sees the program; nobody reads another program
--   J  clients cannot insert, update or delete audit rows
--   K  every filter narrows correctly
--
-- On success: ATTENDANCE HISTORY PASSED
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure('public.list_attendance_history(uuid, uuid, uuid, timestamptz, timestamptz, text, text, uuid, integer)') is null then
    raise exception 'FAIL: AH-0 list_attendance_history() missing — apply 20261020112000 first';
  end if;
  if to_regprocedure('public.mark_attendance_bulk(uuid, uuid[], text, text)') is null then
    raise exception 'FAIL: AH-0 mark_attendance_bulk() missing';
  end if;
end
$$;

create or replace function public.ah_assert(condition boolean, label text)
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
  ('52000000-0000-4000-8000-0000000000a1', 'ah-a', 'AH Program A', true),
  ('52000000-0000-4000-8000-0000000000b1', 'ah-b', 'AH Program B', true);

insert into public.sections (id, ensemble_id, name, sort_order) values
  ('52000000-0000-4000-8000-0000000000c1', '52000000-0000-4000-8000-0000000000a1', 'AH Violin', 1),
  ('52000000-0000-4000-8000-0000000000c2', '52000000-0000-4000-8000-0000000000a1', 'AH Trumpet', 2);

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('52000000-0000-4000-8000-000000000001', 'ah-dir',   'AH Director', 'AH Director'),
  ('52000000-0000-4000-8000-000000000002', 'ah-sec',   'AH Secretary', 'AH Secretary'),
  ('52000000-0000-4000-8000-000000000003', 'ah-lead',  'AH Leader', 'AH Leader'),
  ('52000000-0000-4000-8000-000000000004', 'ah-stu1',  'AH Student One', ''),
  ('52000000-0000-4000-8000-000000000005', 'ah-stu2',  'AH Student Two', ''),
  ('52000000-0000-4000-8000-000000000006', 'ah-dir-b', 'AH Director B', 'AH Director B');

insert into public.memberships (user_id, ensemble_id, section_id, roles, active) values
  ('52000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-0000000000a1', null, '{director}', true),
  ('52000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-0000000000a1', null, '{secretary}', true),
  ('52000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-0000000000a1', '52000000-0000-4000-8000-0000000000c1', '{section_leader}', true),
  ('52000000-0000-4000-8000-000000000004', '52000000-0000-4000-8000-0000000000a1', '52000000-0000-4000-8000-0000000000c1', '{student}', true),
  ('52000000-0000-4000-8000-000000000005', '52000000-0000-4000-8000-0000000000a1', '52000000-0000-4000-8000-0000000000c2', '{student}', true),
  ('52000000-0000-4000-8000-000000000006', '52000000-0000-4000-8000-0000000000b1', null, '{director}', true);

insert into public.events
  (id, ensemble_id, name, type, event_type, date, end_date, checkin_mode, attendance_requirement, late_minutes, archived)
values
  ('52000000-0000-4000-8000-000000000101', '52000000-0000-4000-8000-0000000000a1',
   'AH Past Rehearsal', 'Rehearsal', 'rehearsal', now() - interval '2 days', null, 'toggle', 'required', 10, false),
  -- Live right now, so a QR session can be opened and a student can scan:
  -- check-in opens as soon as the event exists and closes 24 hours after the start.
  ('52000000-0000-4000-8000-000000000102', '52000000-0000-4000-8000-0000000000a1',
   'AH Live Rehearsal', 'Rehearsal', 'rehearsal', now() - interval '3 minutes', null, 'qr', 'required', 10, false);

-- ---------------------------------------------------------------------------
-- A. One manual correction, one entry
-- ---------------------------------------------------------------------------
do $$
declare
  v      jsonb;
  v_row  record;
  v_n    int;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;

  v := public.override_attendance_with_reason(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000004',
    'present', '', '', 'Paper roll said present');
  perform public.ah_assert(v->>'ok' = 'true', 'A the correction saved');
  reset role;

  select count(*) into v_n from public.attendance_audit;
  perform public.ah_assert(v_n = 1, 'A exactly one audit entry exists');

  select * into v_row from public.attendance_audit order by id desc limit 1;
  perform public.ah_assert(v_row.action = 'marked', 'A a new record is action = marked');
  perform public.ah_assert(v_row.old_status is null and v_row.new_status = 'present',
    'A previous value is null and the new value is present');
  perform public.ah_assert(v_row.actor_id = '52000000-0000-4000-8000-000000000001',
    'A the actor is the signed-in director');
  perform public.ah_assert(v_row.student_id = '52000000-0000-4000-8000-000000000004',
    'A the student is recorded');
  perform public.ah_assert(v_row.event_id = '52000000-0000-4000-8000-000000000101',
    'A the event is recorded');
  perform public.ah_assert(v_row.ensemble_id = '52000000-0000-4000-8000-0000000000a1',
    'A the program is derived from the event');
  perform public.ah_assert(v_row.source = 'manual', 'A a staff correction is source = manual');
  perform public.ah_assert(v_row.reason = 'Paper roll said present', 'A the optional reason is kept');
end
$$;

-- ---------------------------------------------------------------------------
-- B. A no-op save is not history
-- ---------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_after  int;
  v        jsonb;
begin
  select count(*) into v_before from public.attendance_audit;

  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.override_attendance_with_reason(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000004',
    'present', '', '', 'saved again');
  perform public.ah_assert(v->>'ok' = 'true', 'B the repeat save succeeds');
  reset role;

  select count(*) into v_after from public.attendance_audit;
  perform public.ah_assert(v_after = v_before, 'B saving the same value twice adds no entry');
end
$$;

-- ---------------------------------------------------------------------------
-- C. A real change carries both sides
-- ---------------------------------------------------------------------------
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.override_attendance_with_reason(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000004',
    'late', '', '', 'arrived after the downbeat');
  reset role;

  select * into v_row from public.attendance_audit order by id desc limit 1;
  perform public.ah_assert(v_row.action = 'changed', 'C a correction is action = changed');
  perform public.ah_assert(v_row.old_status = 'present' and v_row.new_status = 'late',
    'C the previous and new values are both correct');
  perform public.ah_assert(v_row.new_late = true, 'C the late flag is captured');

  -- A plain override (no reason) must not inherit the previous entry's reason.
  perform set_config('request.jwt.claims', '{"sub":"ah-sec","role":"authenticated"}', true);
  set role authenticated;
  perform public.override_attendance(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000004',
    'present', '', '');
  reset role;

  select * into v_row from public.attendance_audit order by id desc limit 1;
  perform public.ah_assert(v_row.old_status = 'late' and v_row.new_status = 'present',
    'C the second correction also carries both sides');
  perform public.ah_assert(v_row.actor_id = '52000000-0000-4000-8000-000000000002',
    'C a different actor is recorded as themselves');
  perform public.ah_assert(v_row.reason = '', 'C no stale reason is carried over');
end
$$;

-- ---------------------------------------------------------------------------
-- D. Clearing a mark is "no record", never a fabricated "absent"
-- ---------------------------------------------------------------------------
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.override_attendance(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000004',
    'absent', '', '');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  perform public.ah_assert(
    not exists (
      select 1 from public.attendance_records
       where event_id = '52000000-0000-4000-8000-000000000101'
         and student_id = '52000000-0000-4000-8000-000000000004'
    ),
    'D an absent mark removed the record'
  );

  select * into v_row from public.attendance_audit order by id desc limit 1;
  perform public.ah_assert(v_row.action = 'cleared', 'D the deletion is action = cleared');
  perform public.ah_assert(v_row.old_status = 'present' and v_row.new_status is null,
    'D the old value is kept and the new value is null (no record)');
end
$$;

-- ---------------------------------------------------------------------------
-- E. Bulk marking: understandable, attributed to the actor, one reason
-- ---------------------------------------------------------------------------
do $$
declare
  v        jsonb;
  v_n      int;
  v_bulk   int;
  v_reason int;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.mark_attendance_bulk(
    '52000000-0000-4000-8000-000000000101',
    array['52000000-0000-4000-8000-000000000004'::uuid,
          '52000000-0000-4000-8000-000000000005'::uuid],
    'present',
    'Everyone was at the door');
  perform public.ah_assert(v->>'ok' = 'true', 'E the bulk mark succeeded');
  perform public.ah_assert((v->>'updated')::int = 2, 'E both students were marked');
  reset role;

  select count(*) into v_n
    from public.attendance_audit
   where source = 'bulk';
  perform public.ah_assert(v_n = 2, 'E the bulk action produced one entry per student');

  select count(*) into v_bulk
    from public.attendance_audit
   where source = 'bulk'
     and reason = 'Everyone was at the door'
     and actor_id = '52000000-0000-4000-8000-000000000001';
  perform public.ah_assert(v_bulk = 2, 'E both entries carry the shared reason and the actor');

  select count(*) into v_reason
    from public.attendance_audit
   where source = 'bulk' and action = 'marked';
  perform public.ah_assert(v_reason = 2,
    'E both students had no live mark before the bulk action, so both are new marks');

  -- Bulk still respects section scoping: a section leader may only touch their
  -- own section, and the refusal is reflected in the answer (not silently).
  perform set_config('request.jwt.claims', '{"sub":"ah-lead","role":"authenticated"}', true);
  set role authenticated;
  v := public.mark_attendance_bulk(
    '52000000-0000-4000-8000-000000000101',
    array['52000000-0000-4000-8000-000000000004'::uuid,
          '52000000-0000-4000-8000-000000000005'::uuid],
    'late');
  perform public.ah_assert(v->>'ok' = 'false', 'E a section leader cannot bulk-mark another section');
  perform public.ah_assert((v->>'updated')::int = 1
    and (v->>'failed')::int = 1,
    'E the leader''s own section succeeded and the other student was refused');
  reset role;

  -- Restore both to a known state (superuser; clients cannot write attendance).
  update public.attendance_records
     set status = 'present', attended = true, is_late = false
   where event_id = '52000000-0000-4000-8000-000000000101'
     and student_id in ('52000000-0000-4000-8000-000000000004',
                        '52000000-0000-4000-8000-000000000005');

  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- F. A student's own check-in is attributed to them
-- ---------------------------------------------------------------------------
do $$
declare
  v        jsonb;
  v_row    record;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.start_checkin_session('52000000-0000-4000-8000-000000000102');
  perform public.ah_assert(v->>'ok' = 'true', 'F a check-in session opened');
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"ah-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.record_attendance(v->>'token');
  perform public.ah_assert(v->>'ok' = 'true', 'F the student checked in');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  select * into v_row from public.attendance_audit order by id desc limit 1;
  perform public.ah_assert(v_row.student_id = '52000000-0000-4000-8000-000000000004',
    'F the check-in entry belongs to the student');
  perform public.ah_assert(v_row.actor_id = '52000000-0000-4000-8000-000000000004',
    'F the actor is the student who scanned');
  perform public.ah_assert(v_row.source = 'check_in', 'F the source is check_in');
end
$$;

-- ---------------------------------------------------------------------------
-- G. Excuse reasons and staff notes are never copied
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.override_attendance(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000005',
    'excused',
    'Medical appointment — a private detail',
    'A staff note that must stay in attendance_staff_notes');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  select count(*) into v_n
    from public.attendance_audit
   where reason ilike '%medical%'
      or reason ilike '%private%'
      or reason ilike '%staff note%';
  perform public.ah_assert(v_n = 0,
    'G no excuse reason or staff note text reaches the audit trail');
end
$$;

-- ---------------------------------------------------------------------------
-- H. A refused operation writes nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v_before int;
  v_after  int;
  v        jsonb;
begin
  select count(*) into v_before from public.attendance_audit;

  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.override_attendance(
    '52000000-0000-4000-8000-000000000101',
    '52000000-0000-4000-8000-000000000004',
    'not-a-status', '', '');
  perform public.ah_assert(v->>'ok' = 'false', 'H an invalid status is refused');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);

  select count(*) into v_after from public.attendance_audit;
  perform public.ah_assert(v_after = v_before, 'H the refused call produced no entry');
end
$$;

-- ---------------------------------------------------------------------------
-- I. Who may read it
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  -- A student: no capability, no history — not even their own row.
  perform set_config('request.jwt.claims', '{"sub":"ah-stu1","role":"authenticated"}', true);
  set role authenticated;
  v := public.list_attendance_history('52000000-0000-4000-8000-0000000000a1');
  perform public.ah_assert(v->>'ok' = 'false', 'I a student cannot read attendance history');
  reset role;

  -- A section leader: section-scoped readers see only their own section.
  perform set_config('request.jwt.claims', '{"sub":"ah-lead","role":"authenticated"}', true);
  set role authenticated;
  v := public.list_attendance_history('52000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, null, 200);
  perform public.ah_assert(v->>'ok' = 'true', 'I a section leader may read their section''s history');
  perform public.ah_assert(
    (select count(*) from jsonb_array_elements(v->'entries') e
      where e->>'student_id' <> '52000000-0000-4000-8000-000000000004') = 0,
    'I the section leader sees only the student in their section'
  );
  reset role;

  -- A director: the whole program.
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  v := public.list_attendance_history('52000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, null, 200);
  perform public.ah_assert(v->>'ok' = 'true', 'I a director reads the program history');
  perform public.ah_assert(
    (select count(distinct e->>'student_id') from jsonb_array_elements(v->'entries') e) = 2,
    'I the director sees both students'
  );
  perform public.ah_assert(
    (select count(*) from jsonb_array_elements(v->'entries') e
      where e->>'student_name' in ('AH Student One', 'AH Student Two')) > 0,
    'I entries carry the student''s name'
  );
  perform public.ah_assert(
    (select count(*) from jsonb_array_elements(v->'entries') e
      where e->>'actor_name' = 'AH Director') > 0,
    'I entries carry the actor''s name'
  );
  reset role;

  -- Another program's director: nothing.
  perform set_config('request.jwt.claims', '{"sub":"ah-dir-b","role":"authenticated"}', true);
  set role authenticated;
  perform public.ah_assert(
    (public.list_attendance_history('52000000-0000-4000-8000-0000000000a1')->>'ok') = 'false',
    'I another program''s director cannot read this program''s history'
  );
  reset role;

  -- And this program's director cannot read the other program's.
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;
  perform public.ah_assert(
    (public.list_attendance_history('52000000-0000-4000-8000-0000000000b1')->>'ok') = 'false',
    'I the programme director cannot read another program''s history'
  );
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- J. Clients cannot fabricate, edit or delete history
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;

  begin
    insert into public.attendance_audit
      (event_id, ensemble_id, student_id, action, new_status, source)
    values ('52000000-0000-4000-8000-000000000101',
            '52000000-0000-4000-8000-0000000000a1',
            '52000000-0000-4000-8000-000000000004',
            'marked', 'present', 'manual');
    raise exception 'FAIL: J a director inserted an audit row directly';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.attendance_audit set reason = 'rewritten';
    raise exception 'FAIL: J a director edited an audit row';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.attendance_audit;
    raise exception 'FAIL: J a director deleted audit rows';
  exception when insufficient_privilege then null;
  end;

  begin
    perform count(*) from public.attendance_audit;
    raise exception 'FAIL: J a director read the audit table directly';
  exception when insufficient_privilege then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- ---------------------------------------------------------------------------
-- K. Filters
-- ---------------------------------------------------------------------------
do $$
declare
  v_all    jsonb;
  v_event  jsonb;
  v_stu    jsonb;
  v_old    jsonb;
  v_none   jsonb;
  v_actor  jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"ah-dir","role":"authenticated"}', true);
  set role authenticated;

  v_all := public.list_attendance_history(
    '52000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, null, 200);

  v_event := public.list_attendance_history(
    '52000000-0000-4000-8000-0000000000a1',
    '52000000-0000-4000-8000-000000000102', null, null, null, null, null, null, 200);
  perform public.ah_assert(
    (select count(*) from jsonb_array_elements(v_event->'entries') e
      where e->>'event_id' <> '52000000-0000-4000-8000-000000000102') = 0
    and jsonb_array_length(v_event->'entries') = 1,
    'K the event filter narrows to that event'
  );

  v_stu := public.list_attendance_history(
    '52000000-0000-4000-8000-0000000000a1', null,
    '52000000-0000-4000-8000-000000000005', null, null, null, null, null, 200);
  perform public.ah_assert(
    (select count(*) from jsonb_array_elements(v_stu->'entries') e
      where e->>'student_id' <> '52000000-0000-4000-8000-000000000005') = 0
    and jsonb_array_length(v_stu->'entries') >= 1,
    'K the student filter narrows to that student'
  );

  v_old := public.list_attendance_history(
    '52000000-0000-4000-8000-0000000000a1', null, null, null, null, 'present', null, null, 200);
  perform public.ah_assert(
    (select count(*) from jsonb_array_elements(v_old->'entries') e
      where e->>'old_status' is distinct from 'present') = 0
    and jsonb_array_length(v_old->'entries') >= 1,
    'K the previous-status filter works'
  );

  v_none := public.list_attendance_history(
    '52000000-0000-4000-8000-0000000000a1', null, null, null, null, null, 'none', null, 200);
  perform public.ah_assert(
    jsonb_array_length(v_none->'entries') = 1
    and (v_none->'entries'->0->>'action') = 'cleared',
    'K new_status = none finds the cleared mark'
  );

  v_actor := public.list_attendance_history(
    '52000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null,
    '52000000-0000-4000-8000-000000000004', 200);
  perform public.ah_assert(
    jsonb_array_length(v_actor->'entries') = 1
    and (v_actor->'entries'->0->>'source') = 'check_in',
    'K the actor filter finds only that person''s actions'
  );

  -- An invalid status is a refusal, not a silently ignored filter.
  perform public.ah_assert(
    (public.list_attendance_history(
      '52000000-0000-4000-8000-0000000000a1', null, null, null, null, 'bogus', null, null, 10
    )->>'ok') = 'false',
    'K an invalid status filter is refused'
  );

  -- The limit is clamped rather than trusted.
  perform public.ah_assert(
    (public.list_attendance_history(
      '52000000-0000-4000-8000-0000000000a1', null, null, null, null, null, null, null, 0
    )->>'limit')::int = 1,
    'K a zero limit is clamped to one'
  );

  perform public.ah_assert(jsonb_array_length(v_all->'entries') >= 6,
    'K the unfiltered list contains the whole story');

  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

rollback;

select 'ATTENDANCE HISTORY PASSED' as verification_result;
