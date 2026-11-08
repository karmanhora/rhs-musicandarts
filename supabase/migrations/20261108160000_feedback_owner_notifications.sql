-- ============================================================================
-- RHS Music Platform — feedback reaches the owner's notification bell
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- Members can send feedback from any program, but the owner should not have to
-- poll the inbox to notice it. Every row inserted into feedback_submissions
-- writes one unread in-app notification to the confirmed account
-- lebronyuh64@gmail.com. It is deliberately in-app only: no Resend call, no
-- Edge Function, and no address or message text leaves the database.
--
-- What this does NOT do:
--   * no email and no new delivery ledger — the bell and an email stay separate
--     facts, exactly as the notification foundation decided;
--   * no new table — notifications already exists (base schema, RLS in 015);
--   * no client write path. The trigger function is definer-only, and
--     authenticated keeps its SELECT-only surface on both tables.
--
-- Rollback:
--   drop trigger if exists feedback_submissions_notify_owner
--     on public.feedback_submissions;
--   drop function if exists public.notify_feedback_owner();
--   delete from public.notifications where type = 'feedback_received';
--   alter table public.notifications drop constraint if exists notifications_type_check;
--   alter table public.notifications
--     add constraint notifications_type_check check (
--       type = any (array[
--         'new_event','checkin_open','absence_request','absence_decision',
--         'event_changed','event_cancelled','workflow_failed'
--       ]::text[])
--     );
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The type vocabulary
-- ---------------------------------------------------------------------------
-- The constraint is rewritten, not appended, because Postgres has no ADD VALUE
-- for a text CHECK. Keep every value that already has a writer.
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
      'workflow_failed',
      'feedback_received'
    ]::text[])
  );

-- ---------------------------------------------------------------------------
-- 2. One notification per submission, to the owner only
-- ---------------------------------------------------------------------------
-- The recipient is resolved the same way is_feedback_owner() resolves it: a
-- profile linked to a confirmed auth.users row at the owner address. A client
-- never supplies a recipient, and a program_admins row is not consulted.
create or replace function public.notify_feedback_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  v_label := case new.category
    when 'bug' then 'Bug report'
    when 'feature' then 'Feature request'
    when 'suggestion' then 'General suggestion'
    when 'broken' then 'Something isn''t working'
    else 'Other feedback'
  end;

  insert into public.notifications (user_id, type, title, body, payload, dedupe_key)
  select p.id,
         'feedback_received',
         'New feedback received',
         format('%s — read it in the feedback inbox.', v_label),
         jsonb_build_object('feedback_id', new.id, 'category', new.category),
         'feedback:' || new.id::text
    from auth.users u
    join public.profiles p on p.auth_user_id = u.id::text
   where lower(u.email) = 'lebronyuh64@gmail.com'
     and u.email_confirmed_at is not null
  on conflict (user_id, dedupe_key) do nothing;

  return new;
end
$$;

comment on function public.notify_feedback_owner() is
  'Writes one unread in-app notification to the confirmed owner account for each feedback submission. Never emails, never notifies the sender.';

drop trigger if exists feedback_submissions_notify_owner on public.feedback_submissions;
create trigger feedback_submissions_notify_owner
  after insert on public.feedback_submissions
  for each row execute function public.notify_feedback_owner();

-- Trigger-only: nobody calls this from a browser.
revoke all on function public.notify_feedback_owner() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.notify_feedback_owner()') is null then
    raise exception 'FAIL: notify_feedback_owner() was not created';
  end if;

  if not exists (
    select 1
      from pg_trigger
     where tgname = 'feedback_submissions_notify_owner'
       and tgrelid = 'public.feedback_submissions'::regclass
       and not tgisinternal
  ) then
    raise exception 'FAIL: feedback_submissions_notify_owner trigger is missing';
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'notifications_type_check'
       and pg_get_constraintdef(oid) like '%feedback_received%'
  ) then
    raise exception 'FAIL: notifications_type_check does not allow feedback_received';
  end if;

  if has_function_privilege('authenticated', 'public.notify_feedback_owner()', 'EXECUTE')
     or has_function_privilege('anon', 'public.notify_feedback_owner()', 'EXECUTE') then
    raise exception 'FAIL: a client role can execute the feedback notifier';
  end if;

  raise notice 'feedback owner notifications OK: type, trigger, definer-only';
end
$$;
