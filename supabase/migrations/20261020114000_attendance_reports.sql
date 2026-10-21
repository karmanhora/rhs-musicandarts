-- ============================================================================
-- RHS Music Platform — exportable attendance reports
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Feature 3 of the 2026-10 expansion. Analytics was on-screen only; there was
-- no export of any kind. This adds ONE server-side row builder and leaves the
-- formatting (CSV, print) to the browser, because the security boundary belongs
-- in the database: the RPC decides which program, which rows and which fields a
-- caller may see, and every filter is applied here — never by hiding rows in
-- React.
--
-- The shape is deliberately report-shaped rather than table-shaped:
--   * exactly one row per (event, student) — the roster is joined once and
--     attendance once, so no join can duplicate a row;
--   * a student with no attendance record appears with status 'not_recorded',
--     NOT 'absent'. Those are different claims and the report must not merge
--     them, even though the required-attendance formula treats both as a miss;
--   * past events only, unless one event is named explicitly — a report of what
--     happened should not be padded with every future rehearsal;
--   * no email address, no auth id, no excuse reason, no staff note, no
--     `marked_by` profile. `student_ref` is a short slice of the person's uuid,
--     which is enough to disambiguate two students with the same name.
--
-- New capability (029 catalogue)
--   attendance.export_reports — director by default, delegable, so a director
--   can deliberately let a secretary pull a report. Anybody without it is
--   refused by name, including people who can otherwise read the whole
--   program's attendance.
--
-- Rollback: drop `attendance_report_rows(...)` and the role grant; the
-- capability row is inert once nothing checks it. No table is touched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Capability
-- ---------------------------------------------------------------------------
insert into public.permissions (code, category, label, description, scope, delegable, sort_order)
values (
  'attendance.export_reports',
  'analytics',
  'Export attendance reports',
  'Download this program''s attendance as a spreadsheet-ready report.',
  'program',
  true,
  55
)
on conflict (code) do update set
  category    = excluded.category,
  label       = excluded.label,
  description = excluded.description,
  scope       = excluded.scope,
  delegable   = excluded.delegable,
  sort_order  = excluded.sort_order;

insert into public.role_permissions (role_id, permission)
select r.id, 'attendance.export_reports'
  from public.roles r
 where r.is_system
   and r.key = 'director'
on conflict (role_id, permission) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The report
-- ---------------------------------------------------------------------------
create or replace function public.attendance_report_rows(
  p_ensemble uuid,
  p_event uuid DEFAULT null,
  p_from timestamptz DEFAULT null,
  p_to timestamptz DEFAULT null,
  p_student uuid DEFAULT null,
  p_section uuid DEFAULT null,
  p_status text DEFAULT null,
  p_requirement text DEFAULT null,
  p_limit integer DEFAULT 5000
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
  v_rows  jsonb;
  v_total integer;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to export attendance.');
  end if;

  -- Program comes from the request but authority comes from the caller's own
  -- capabilities in that program. There is no cross-program path here.
  if not public.has_permission(p_ensemble, 'attendance.export_reports') then
    return jsonb_build_object('ok', false, 'message', 'You are not authorized to export attendance for this program.');
  end if;

  if p_status is not null
     and p_status not in ('present', 'late', 'excused', 'absent', 'not_recorded') then
    return jsonb_build_object('ok', false, 'message', 'Unknown attendance status.');
  end if;

  if p_requirement is not null
     and p_requirement not in ('required', 'optional', 'none') then
    return jsonb_build_object('ok', false, 'message', 'Unknown event requirement.');
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 5000), 10000));

  with roster as (
    select m.user_id,
           coalesce(nullif(p.display_name, ''), p.full_name) as student_name,
           m.section_id,
           coalesce(s.name, '') as section,
           s.sort_order
      from public.memberships m
      join public.profiles p on p.id = m.user_id
      left join public.sections s on s.id = m.section_id
     where m.ensemble_id = p_ensemble
       and m.active
       -- Directors are not measured, exactly like every other attendance RPC.
       and not ('director' = any (m.roles))
  ),
  report as (
    select e.id                     as event_id,
           e.name                   as event_name,
           e.date                   as event_date,
           e.end_date               as event_end_date,
           e.all_day,
           e.event_type,
           e.attendance_requirement,
           r.user_id                as student_id,
           r.student_name,
           upper(substr(replace(r.user_id::text, '-', ''), 1, 8)) as student_ref,
           r.section_id,
           r.section,
           coalesce(ar.status, 'not_recorded') as status,
           ar.checked_in_at,
           coalesce(ar.is_late, false) as late,
           r.sort_order
      from public.events e
      join roster r on true
      left join public.attendance_records ar
             on ar.event_id = e.id and ar.student_id = r.user_id
     where e.ensemble_id = p_ensemble
       and e.archived = false
       -- A report is a record of what happened. Future events are excluded so
       -- hundreds of "not recorded" rows cannot look like an absence problem;
       -- naming one event explicitly overrides that (a schedule check).
       and (p_event is not null or e.date <= now())
       and (p_event is null or e.id = p_event)
       and (p_from is null or e.date >= p_from)
       and (p_to is null or e.date < p_to)
       and (p_student is null or r.user_id = p_student)
       and (p_section is null or r.section_id = p_section)
       and (p_requirement is null or e.attendance_requirement = p_requirement)
       and (p_status is null or coalesce(ar.status, 'not_recorded') = p_status)
  ),
  page as (
    select rep.*,
           count(*) over () as total_rows
      from report rep
     order by rep.event_date desc, rep.sort_order, rep.student_name
     limit v_limit
  )
  select coalesce(jsonb_agg(to_jsonb(page) - 'total_rows' order by page.event_date desc, page.sort_order, page.student_name), '[]'::jsonb),
         coalesce(max(page.total_rows), 0)
    into v_rows, v_total
    from page;

  return jsonb_build_object(
    'ok', true,
    'rows', v_rows,
    'total', v_total,
    'returned', jsonb_array_length(v_rows),
    'truncated', v_total > jsonb_array_length(v_rows),
    'limit', v_limit
  );
end
$$;

comment on function public.attendance_report_rows(uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, integer) is
  'Permission-checked attendance report rows for one program, one row per event and student, with "not_recorded" kept distinct from "absent". Filters are applied server-side.';

revoke all on function public.attendance_report_rows(uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, integer) from public, anon;
grant execute on function public.attendance_report_rows(uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.attendance_report_rows(uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, integer)') is null then
    raise exception 'FAIL: attendance_report_rows() was not created';
  end if;

  if not exists (
    select 1 from public.permissions where code = 'attendance.export_reports'
  ) then
    raise exception 'FAIL: attendance.export_reports was not seeded';
  end if;

  if not exists (
    select 1 from public.role_permissions rp
      join public.roles r on r.id = rp.role_id
     where r.is_system and r.key = 'director'
       and rp.permission = 'attendance.export_reports'
  ) then
    raise exception 'FAIL: directors do not hold attendance.export_reports';
  end if;

  if exists (
    select 1 from public.role_permissions rp
      join public.roles r on r.id = rp.role_id
     where r.is_system and r.key in ('student', 'section_leader', 'secretary')
       and rp.permission = 'attendance.export_reports'
  ) then
    raise exception 'FAIL: export was granted to a non-director system role by default';
  end if;

  if has_function_privilege('anon', 'public.attendance_report_rows(uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, integer)', 'EXECUTE') then
    raise exception 'FAIL: anon can export attendance';
  end if;

  raise notice 'attendance reports OK: capability, row builder, server-side filters';
end
$$;
