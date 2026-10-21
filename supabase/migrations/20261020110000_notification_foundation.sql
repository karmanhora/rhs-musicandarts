-- ============================================================================
-- RHS Music Platform — notification foundation
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Why this runs before the four feature migrations: absence requests and event
-- changes both write in-app notifications, and both need the two things added
-- here — the new `type` values in the check constraint, and an idempotency key
-- that makes "one notification per recipient per underlying event" enforceable
-- by the database instead of by every caller remembering to look first.
--
-- What this does NOT do:
--   * no new table — `notifications` already exists (base schema, RLS in 015)
--   * no new scheduled job, and no in-app copy of the 48-hour email reminder
--   * no change to email delivery ledgers (`event_*_deliveries`). The in-app
--     `read` flag and an email's `sent` state are deliberately separate facts.
--
-- Rollback: `dedupe_key` is additive and nullable; the type constraint can be
-- restored to `('new_event','checkin_open')` only after deleting the newer rows.
-- Dropping the column is safe once no writer names it, because the fan-out
-- triggers live in later migrations and are dropped first.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The idempotency key
-- ---------------------------------------------------------------------------
alter table public.notifications add column if not exists dedupe_key text;

comment on column public.notifications.dedupe_key is
  'Idempotency key for one recipient, e.g. absence:request:<uuid> or event:<uuid>:changed:<hash>. NULL for one-offs; a repeated insert with the same (user_id, dedupe_key) is ignored.';

-- A full unique index, not a partial one: Postgres treats NULLs as distinct, so
-- every legacy/one-off row without a key is still allowed, and `on conflict
-- (user_id, dedupe_key)` can infer this index without a WHERE clause.
create unique index if not exists notifications_user_dedupe_key
  on public.notifications (user_id, dedupe_key);

-- The bell reads newest-first per person; the existing table had no index for
-- that beyond the primary key.
create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. The type vocabulary
-- ---------------------------------------------------------------------------
-- Every value below has a real writer (this migration set):
--   new_event        016 trigger (remains)
--   checkin_open     016 trigger (remains)
--   absence_request  absence_requests insert trigger (absence migration)
--   absence_decision absence_requests decision trigger (absence migration)
--   event_changed    events update trigger (notification-centre migration)
--   event_cancelled  events archive trigger (notification-centre migration)
--   workflow_failed  make-up email delivery failure trigger (centre migration)
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check check (
    type = any (array[
      'new_event',
      'checkin_open',
      'absence_request',
      'absence_decision',
      'event_changed',
      'event_cancelled',
      'workflow_failed'
    ]::text[])
  );

-- ---------------------------------------------------------------------------
-- 3. The one write the client still makes for itself
-- ---------------------------------------------------------------------------
-- Marking read is a self-service action on the caller's own rows. RLS
-- (`notifications_update_own`, 015) already limits it to those rows; wrapping it
-- in a definer function gives the app an honest count and keeps the table's
-- direct write surface as narrow as it was after the 2026-10-16 hardening
-- migration (`insert`/`delete` remain revoked).
create or replace function public.mark_all_notifications_read()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := public.current_profile_id();
  v_updated integer;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to read your notifications.');
  end if;

  update public.notifications
     set read = true
   where user_id = v_me
     and read = false;

  get diagnostics v_updated = row_count;

  return jsonb_build_object('ok', true, 'updated', v_updated);
end
$$;

comment on function public.mark_all_notifications_read() is
  'Marks every one of the caller''s own unread notifications read. Never touches another person''s rows.';

revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_all_notifications_read() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'notifications'
       and column_name = 'dedupe_key'
  ) then
    raise exception 'FAIL: notifications.dedupe_key was not created';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'notifications_user_dedupe_key'
  ) then
    raise exception 'FAIL: notifications_user_dedupe_key index is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'notifications_type_check'
       and pg_get_constraintdef(oid) like '%absence_request%'
  ) then
    raise exception 'FAIL: notifications_type_check does not allow the absence types';
  end if;

  if has_function_privilege('anon', 'public.mark_all_notifications_read()', 'EXECUTE') then
    raise exception 'FAIL: anon can mark notifications read';
  end if;

  raise notice 'notification foundation OK: dedupe key, type vocabulary, mark-all-read';
end
$$;
