-- ============================================================================
-- RHS Music Platform — attendance change history (audit trail)
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Feature 2 of the 2026-10 expansion. There was no attendance audit of any
-- kind: `audit_logs` (029) records role changes only, and a corrected mark
-- simply overwrote the previous value.
--
-- Design
--   * ONE append-only table, `attendance_audit`, written by an AFTER trigger on
--     `attendance_records`. A trigger covers every path — the staff RPC, a
--     student's QR check-in, the new bulk RPC, and any future server-side
--     writer — so a future code path cannot forget to log.
--   * No client SELECT and no client write grant. Reads go through one
--     capability-gated RPC, so nobody can read another program's history and
--     nobody can fabricate, edit or delete an entry (there is no UPDATE or
--     DELETE policy, and the table's grants are revoked from `authenticated`).
--   * The trigger runs in the same transaction as the change: a rolled-back
--     correction leaves no entry, and a committed one always has its entry.
--   * A repeated save that changes nothing is not history. The trigger compares
--     status, late flag and attended before writing, so tapping "Present" twice
--     does not produce two identical entries.
--   * NOT logged, deliberately: `excuse_reason` text, staff notes, absence
--     request reasons. The audit answers "what changed, by whom, when and from
--     which source" — it is not a second copy of a student's personal
--     explanation. `reason` here is a short staff-authored note about the
--     correction, capped at 500 characters.
--   * `old_status` / `new_status` are NULL to mean "no record". An absent mark
--     deletes the row (`override_attendance`, 029), so a cleared mark is
--     recorded as `new_status = null` and shown as "No record" — not as the
--     stored word "absent", which would be a claim the schema cannot make.
--
-- Rollback: drop the trigger, the function, the RPCs and the table. The table is
-- additive and no other object depends on it; deleting an event still cascades
-- its audit rows away, exactly like its attendance rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_audit (
  id                   bigint generated always as identity primary key,
  -- The record's id at the time. Deliberately NOT a foreign key: an absent mark
  -- deletes the record, and the history of that deletion has to outlive it.
  attendance_record_id uuid,
  event_id             uuid not null references public.events (id) on delete cascade,
  ensemble_id          uuid not null references public.ensembles (id) on delete cascade,
  student_id           uuid not null references public.profiles (id) on delete cascade,
  actor_id             uuid references public.profiles (id) on delete set null,
  action               text not null check (action in ('marked', 'changed', 'cleared')),
  old_status           text,
  new_status           text,
  old_late             boolean,
  new_late             boolean,
  source               text not null default 'manual'
                         check (source in ('manual', 'bulk', 'check_in', 'absence_request', 'system')),
  reason               text not null default '',
  created_at           timestamptz not null default now(),
  constraint attendance_audit_status_values check (
    (old_status is null or old_status in ('present', 'absent', 'excused', 'late'))
    and (new_status is null or new_status in ('present', 'absent', 'excused', 'late'))
  ),
  constraint attendance_audit_reason_len check (char_length(reason) <= 500)
);

comment on table public.attendance_audit is
  'Append-only history of attendance status changes. Written only by the trigger below; readable only through list_attendance_history(). No excuse-reason or staff-note text is copied here.';
comment on column public.attendance_audit.action is
  'marked = a record was created, changed = status/late/attended changed, cleared = the record was deleted (an absent mark).';
comment on column public.attendance_audit.source is
  'How the change happened: manual (staff correction), bulk (staff bulk action), check_in (student QR/code), absence_request (reserved), system.';

create index if not exists attendance_audit_ensemble_idx
  on public.attendance_audit (ensemble_id, created_at desc);
create index if not exists attendance_audit_student_idx
  on public.attendance_audit (student_id, created_at desc);
create index if not exists attendance_audit_event_idx
  on public.attendance_audit (event_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. The trigger
-- ---------------------------------------------------------------------------
create or replace function public.log_attendance_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record_id  uuid;
  v_event_id   uuid;
  v_student_id uuid;
  v_ensemble   uuid;
  v_actor      uuid := public.current_profile_id();
  v_source     text;
  v_reason     text;
  v_action     text;
  v_old_status text;
  v_new_status text;
  v_old_late   boolean;
  v_new_late   boolean;
  v_marked_by  uuid;
begin
  -- A save that changes nothing is not history. `checked_in_at` alone is not a
  -- status change; a second "Present" tap keeps to_existing timestamp.
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status
       and new.is_late is not distinct from old.is_late
       and new.attended is not distinct from old.attended then
      return new;
    end if;
  end if;

  if tg_op = 'DELETE' then
    v_record_id := old.id;
    v_event_id := old.event_id;
    v_student_id := old.student_id;
    v_marked_by := old.marked_by;
    v_old_status := old.status;
    v_new_status := null;
    v_old_late := old.is_late;
    v_new_late := null;
    v_action := 'cleared';
  else
    v_record_id := new.id;
    v_event_id := new.event_id;
    v_student_id := new.student_id;
    v_marked_by := new.marked_by;
    v_old_status := case when tg_op = 'INSERT' then null else old.status end;
    v_new_status := new.status;
    v_old_late := case when tg_op = 'INSERT' then null else old.is_late end;
    v_new_late := new.is_late;
    v_action := case when tg_op = 'INSERT' then 'marked' else 'changed' end;
  end if;

  select e.ensemble_id into v_ensemble from public.events e where e.id = v_event_id;

  -- The event was deleted and this row is part of the cascade. Its audit rows go
  -- with it (same cascade), so there is nothing meaningful to attribute.
  if v_ensemble is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Source: an explicit setting wins (the bulk RPC and future server-side
  -- writers set it); otherwise a row nobody signed as marked_by is the student's
  -- own check-in, and a signed row is a staff action.
  v_source := nullif(current_setting('app.attendance_source', true), '');
  if v_source is null or v_source not in ('manual', 'bulk', 'check_in', 'absence_request', 'system') then
    v_source := case when v_marked_by is null then 'check_in' else 'manual' end;
  end if;

  v_reason := left(btrim(coalesce(current_setting('app.attendance_reason', true), '')), 500);

  insert into public.attendance_audit (
    attendance_record_id, event_id, ensemble_id, student_id, actor_id,
    action, old_status, new_status, old_late, new_late, source, reason
  )
  values (
    v_record_id, v_event_id, v_ensemble, v_student_id, v_actor,
    v_action, v_old_status, v_new_status, v_old_late, v_new_late, v_source, v_reason
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

comment on function public.log_attendance_change() is
  'Appends one attendance_audit row per real status change. Skips no-op updates, and never copies excuse reasons or staff notes.';

drop trigger if exists attendance_records_audit on public.attendance_records;
create trigger attendance_records_audit
  after insert or update or delete on public.attendance_records
  for each row execute function public.log_attendance_change();

-- ---------------------------------------------------------------------------
-- 3. Lock the table down — no client read, no client write
-- ---------------------------------------------------------------------------
alter table public.attendance_audit enable row level security;

-- No policy at all for `authenticated`: the only read path is the RPC below,
-- which applies the capability and section rules itself. Supabase's default
-- privileges would otherwise hand the new table to every signed-in role.
revoke all on table public.attendance_audit from public, anon, authenticated;
grant select on table public.attendance_audit to service_role;

-- ---------------------------------------------------------------------------
-- 4. Why a change happened, and one bulk action instead of N
-- ---------------------------------------------------------------------------
-- Existing callers of `override_attendance` keep working untouched (same
-- signature, same behavior). This wrapper only supplies the short reason that
-- lands on the audit row.
create or replace function public.override_attendance_with_reason(
  p_event_id uuid,
  p_student_id uuid,
  p_status text DEFAULT 'present',
  p_excuse_reason text DEFAULT '',
  p_staff_note text DEFAULT '',
  p_reason text DEFAULT ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_prev   text := current_setting('app.attendance_reason', true);
begin
  perform set_config(
    'app.attendance_reason',
    left(btrim(coalesce(p_reason, '')), 500),
    true
  );

  v_result := public.override_attendance(
    p_event_id, p_student_id, p_status, p_excuse_reason, p_staff_note
  );

  -- The setting is transaction-scoped. Restore what was there before so a later
  -- call in the same transaction cannot inherit this reason by accident.
  perform set_config('app.attendance_reason', coalesce(v_prev, ''), true);
  return v_result;
end
$$;

comment on function public.override_attendance_with_reason(uuid, uuid, text, text, text, text) is
  'override_attendance() plus an optional short reason recorded on the audit entry. Every permission and section rule is inherited unchanged.';

-- One request for "mark the rest present", with each student still checked
-- against the caller's capabilities. Previously the roll sent one request per
-- student, so a bulk action was indistinguishable from N manual edits.
create or replace function public.mark_attendance_bulk(
  p_event_id uuid,
  p_student_ids uuid[],
  p_status text,
  p_reason text DEFAULT ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := public.current_profile_id();
  v_ensemble   uuid;
  v_id         uuid;
  v_result     jsonb;
  v_updated    integer := 0;
  v_failed     integer := 0;
  v_first      text;
  v_requested  integer;
  v_prev_source text := current_setting('app.attendance_source', true);
  v_prev_reason text := current_setting('app.attendance_reason', true);
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to mark attendance.');
  end if;

  select e.ensemble_id into v_ensemble from public.events e where e.id = p_event_id;
  if v_ensemble is null then
    return jsonb_build_object('ok', false, 'message', 'Unknown event.');
  end if;

  if not (
    public.has_permission(v_ensemble, 'attendance.mark_present')
    or public.has_permission(v_ensemble, 'attendance.mark_section')
  ) then
    return jsonb_build_object('ok', false, 'message', 'Only staff may mark attendance.');
  end if;

  v_requested := coalesce(array_length(p_student_ids, 1), 0);
  if v_requested = 0 then
    return jsonb_build_object('ok', false, 'message', 'Pick at least one student.');
  end if;
  if v_requested > 500 then
    return jsonb_build_object('ok', false, 'message', 'Mark at most 500 students at a time.');
  end if;

  perform set_config('app.attendance_source', 'bulk', true);
  perform set_config(
    'app.attendance_reason',
    left(btrim(coalesce(p_reason, '')), 500),
    true
  );

  foreach v_id in array p_student_ids loop
    -- Keep the staff note the row already has: an empty note means "leave it".
    v_result := public.override_attendance(p_event_id, v_id, p_status, '', '');
    if coalesce((v_result ->> 'ok')::boolean, false) then
      v_updated := v_updated + 1;
    else
      v_failed := v_failed + 1;
      v_first := coalesce(v_first, v_result ->> 'message');
    end if;
  end loop;

  -- Leave the transaction's settings as we found them, so a later call in the
  -- same transaction is not mislabelled as part of this bulk action.
  perform set_config('app.attendance_source', coalesce(v_prev_source, ''), true);
  perform set_config('app.attendance_reason', coalesce(v_prev_reason, ''), true);

  return jsonb_build_object(
    'ok', v_failed = 0,
    'updated', v_updated,
    'failed', v_failed,
    'message', case
      when v_failed = 0 then 'Attendance updated.'
      when v_updated = 0 then coalesce(v_first, 'Nothing could be saved.')
      else format('Marked %s — %s could not be saved (the first reason: %s).', v_updated, v_failed, coalesce(v_first, 'unknown'))
    end
  );
end
$$;

comment on function public.mark_attendance_bulk(uuid, uuid[], text, text) is
  'Marks many students in one action. Each student passes the same capability and section checks as a single correction, and every entry is recorded with source = bulk.';

-- ---------------------------------------------------------------------------
-- 5. The read path
-- ---------------------------------------------------------------------------
create or replace function public.list_attendance_history(
  p_ensemble uuid,
  p_event uuid DEFAULT null,
  p_student uuid DEFAULT null,
  p_from timestamptz DEFAULT null,
  p_to timestamptz DEFAULT null,
  p_old_status text DEFAULT null,
  p_new_status text DEFAULT null,
  p_actor uuid DEFAULT null,
  p_limit integer DEFAULT 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me      uuid := public.current_profile_id();
  v_wide    boolean;
  v_scoped  boolean;
  v_limit   integer;
  v_entries jsonb;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to read attendance history.');
  end if;

  v_wide   := public.has_permission(p_ensemble, 'attendance.view_program');
  v_scoped := public.has_permission(p_ensemble, 'attendance.view_section');

  if not (v_wide or v_scoped) then
    return jsonb_build_object('ok', false, 'message', 'You do not have access to this program''s attendance history.');
  end if;

  if p_old_status is not null and p_old_status not in ('present', 'late', 'excused', 'absent', 'none') then
    return jsonb_build_object('ok', false, 'message', 'Unknown previous status.');
  end if;
  if p_new_status is not null and p_new_status not in ('present', 'late', 'excused', 'absent', 'none') then
    return jsonb_build_object('ok', false, 'message', 'Unknown new status.');
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 100), 500));

  select coalesce(jsonb_agg(row_to_json(x) order by x.created_at desc, x.id desc), '[]'::jsonb)
    into v_entries
    from (
      select a.id,
             a.created_at,
             a.action,
             a.old_status,
             a.new_status,
             a.old_late,
             a.new_late,
             a.source,
             a.reason,
             a.attendance_record_id,
             a.event_id,
             e.name  as event_name,
             e.date  as event_date,
             a.student_id,
             coalesce(nullif(sp.display_name, ''), sp.full_name) as student_name,
             coalesce(sec.name, '') as section,
             a.actor_id,
             coalesce(nullif(ap.display_name, ''), ap.full_name) as actor_name
        from public.attendance_audit a
        join public.events e   on e.id = a.event_id and e.ensemble_id = p_ensemble
        join public.profiles sp on sp.id = a.student_id
        left join public.memberships m
               on m.user_id = a.student_id and m.ensemble_id = a.ensemble_id
        left join public.sections sec on sec.id = m.section_id
        left join public.profiles ap  on ap.id = a.actor_id
       where a.ensemble_id = p_ensemble
         and (p_event is null or a.event_id = p_event)
         and (p_student is null or a.student_id = p_student)
         and (p_from is null or a.created_at >= p_from)
         and (p_to is null or a.created_at < p_to)
         and (p_actor is null or a.actor_id = p_actor)
         and (
           p_old_status is null
           or (p_old_status = 'none' and a.old_status is null)
           or (p_old_status <> 'none' and a.old_status = p_old_status)
         )
         and (
           p_new_status is null
           or (p_new_status = 'none' and a.new_status is null)
           or (p_new_status <> 'none' and a.new_status = p_new_status)
         )
         and (
           v_wide
           or public.is_section_leader_for(v_me, m.section_id)
         )
       order by a.created_at desc, a.id desc
       limit v_limit
    ) x;

  return jsonb_build_object('ok', true, 'entries', v_entries, 'limit', v_limit);
end
$$;

comment on function public.list_attendance_history(uuid, uuid, uuid, timestamptz, timestamptz, text, text, uuid, integer) is
  'Recent attendance changes in one program. Program-wide readers see all; section-scoped readers see only their own section. Students have no path to another student''s history.';

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
-- Trigger functions are executable by PUBLIC by default; the 016-era rule is
-- that `anon` can execute nothing in `public`, and the security suite asserts it
-- for every function — including ones only a trigger should ever call.
revoke all on function public.log_attendance_change() from public, anon;

revoke all on function public.override_attendance_with_reason(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.override_attendance_with_reason(uuid, uuid, text, text, text, text) to authenticated, service_role;

revoke all on function public.mark_attendance_bulk(uuid, uuid[], text, text) from public, anon;
grant execute on function public.mark_attendance_bulk(uuid, uuid[], text, text) to authenticated, service_role;

revoke all on function public.list_attendance_history(uuid, uuid, uuid, timestamptz, timestamptz, text, text, uuid, integer) from public, anon;
grant execute on function public.list_attendance_history(uuid, uuid, uuid, timestamptz, timestamptz, text, text, uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.attendance_audit') is null then
    raise exception 'FAIL: attendance_audit was not created';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'attendance_records_audit'
       and tgrelid = 'public.attendance_records'::regclass
  ) then
    raise exception 'FAIL: attendance_records_audit trigger is missing';
  end if;

  if has_table_privilege('authenticated', 'public.attendance_audit', 'SELECT')
     or has_table_privilege('authenticated', 'public.attendance_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.attendance_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.attendance_audit', 'DELETE') then
    raise exception 'FAIL: authenticated still has privileges on attendance_audit';
  end if;

  if has_function_privilege('anon', 'public.list_attendance_history(uuid, uuid, uuid, timestamptz, timestamptz, text, text, uuid, integer)', 'EXECUTE') then
    raise exception 'FAIL: anon can read attendance history';
  end if;

  raise notice 'attendance history OK: append-only table, trigger, history + bulk RPCs';
end
$$;
