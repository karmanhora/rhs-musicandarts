-- ============================================================================
-- Feedback submissions — students and teachers tell the site owner what to fix
-- ----------------------------------------------------------------------------
-- Purpose
--   A private inbox for the website's owner. Any signed-in member may send one
--   message; nobody can read, change or delete a message except the owner.
--   Nothing is emailed by this migration, by design: the sender path only
--   writes a row, so an owner notification can be added later without changing
--   the table, the policies or the form.
--
-- What it creates
--   1. `public.feedback_submissions` — one row per message:
--        category         a fixed vocabulary, so filtering is honest
--        message          required, 10–4000 characters after trimming
--        affected_feature optional, at most 200 characters
--        contact_email    optional, at most 254 characters and shape-checked
--        submitted_by     the profile that sent it, when one is linked
--        status           'new' | 'reviewing' | 'resolved'
--        created_at / updated_at (the latter maintained by a trigger)
--   2. `public.is_feedback_owner()` — the owner predicate. It resolves the
--      caller through `current_profile_id()` and requires the *confirmed*
--      Supabase Auth address lebronyuh64@gmail.com. It never reads a value the
--      browser sent: the email comes from `auth.users`, which only the auth
--      service writes.
--   3. `public.submit_feedback(...)` — the only insert path. Validates every
--      field, refuses an exact repeat within ten minutes, and refuses a sixth
--      message in ten minutes. `submitted_by` is derived from the token, never
--      accepted from the client.
--   4. `public.set_feedback_status(...)` / `public.delete_feedback(...)` — the
--      owner's management paths. Both re-check `is_feedback_owner()`.
--   5. `public.feedback_owner_status()` — a boolean the interface may use to
--      decide what to render. It is not a boundary; the policies and the RPCs
--      above are.
--
-- Why a new table rather than an existing one
--   Nothing in this schema stores free-text feedback aimed at the site itself.
--   `notifications` is a per-person inbox written by workflows, `audit_logs`
--   records administrative actions, and `absence_requests` is scoped to an
--   event. Reusing any of them would either expose feedback through an existing
--   read path or overload a table with a different owner.
--
-- SECURITY
--   * RLS on. One SELECT policy, `is_feedback_owner()`. No INSERT/UPDATE/DELETE
--     grant to `authenticated` at all, so even a policy mistake could not let a
--     client write directly; both writes are SECURITY DEFINER RPCs.
--   * `anon` holds no privilege on the table and cannot execute any of these
--     functions.
--   * `submitted_by` is `current_profile_id()`, so a caller cannot attribute a
--     message to somebody else. Contact email is whatever the sender typed; it
--     is never copied from `auth.users` without the sender asking for it.
--
-- Ordering note
--   Apply this migration BEFORE deploying the frontend that calls the RPCs.
--
-- Rollback
--   drop function if exists public.delete_feedback(uuid);
--   drop function if exists public.set_feedback_status(uuid, text);
--   drop function if exists public.submit_feedback(text, text, text, text);
--   drop function if exists public.feedback_owner_status();
--   drop function if exists public.is_feedback_owner();
--   drop table if exists public.feedback_submissions;
--   Rolling back deletes every message, so export the table first.
--
-- Re-runnable: create-if-not-exists, create-or-replace, and drop-then-create for
-- the policy and trigger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.feedback_submissions (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  message text not null,
  affected_feature text,
  contact_email text,
  submitted_by uuid references public.profiles(id) on delete set null,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint feedback_submissions_category_known
    check (category in ('bug', 'feature', 'suggestion', 'broken', 'other')),
  constraint feedback_submissions_message_length
    check (char_length(btrim(message)) between 10 and 4000),
  constraint feedback_submissions_affected_length
    check (affected_feature is null or char_length(affected_feature) <= 200),
  constraint feedback_submissions_contact_length
    check (contact_email is null or char_length(contact_email) <= 254),
  constraint feedback_submissions_contact_shape
    check (
      contact_email is null
      or contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  constraint feedback_submissions_status_known
    check (status in ('new', 'reviewing', 'resolved'))
);

comment on table public.feedback_submissions is
  'Messages sent to the site owner through the feedback form. Members may insert through submit_feedback(); only the owner may read or manage them.';
comment on column public.feedback_submissions.submitted_by is
  'The profile that sent the message, resolved from the token. Null when the account had no profile row. Never client-supplied.';
comment on column public.feedback_submissions.contact_email is
  'Optional address the sender chose to share. Never copied from auth.users without their action.';
comment on column public.feedback_submissions.status is
  'The owner''s triage state: new, reviewing, resolved.';

create index if not exists feedback_submissions_created_idx
  on public.feedback_submissions (created_at desc);
create index if not exists feedback_submissions_status_created_idx
  on public.feedback_submissions (status, created_at desc);
create index if not exists feedback_submissions_category_idx
  on public.feedback_submissions (category);
-- Supports the per-sender duplicate and rate-limit checks in submit_feedback().
create index if not exists feedback_submissions_sender_created_idx
  on public.feedback_submissions (submitted_by, created_at desc);

-- `updated_at` is maintained here rather than trusted from the client; the
-- management RPCs also set it explicitly so a single UPDATE is one statement.
create or replace function public.feedback_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists feedback_submissions_touch on public.feedback_submissions;
create trigger feedback_submissions_touch
  before update on public.feedback_submissions
  for each row execute function public.feedback_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Who is the owner?
-- ---------------------------------------------------------------------------
-- The address is read from `auth.users`, the one table only Supabase Auth
-- writes, and must be confirmed. A registration that merely *claims* the address
-- is therefore not enough: the account has to have proven it by using the
-- confirmation link or a trusted OAuth provider. A `program_admins` row is not
-- consulted — program administrators are a different role and gain nothing here.
create or replace function public.is_feedback_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.users u
      join public.profiles p on p.auth_user_id = u.id::text
     where p.id = public.current_profile_id()
       and lower(u.email) = 'lebronyuh64@gmail.com'
       and u.email_confirmed_at is not null
  )
$$;

comment on function public.is_feedback_owner() is
  'True only for the confirmed Supabase Auth account lebronyuh64@gmail.com. Reads auth.users server-side; never trusts a client-supplied email.';

create or replace function public.feedback_owner_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'owner', public.is_feedback_owner(),
    'signed_in', public.current_profile_id() is not null
  )
$$;

comment on function public.feedback_owner_status() is
  'Rendering input only: whether the caller is the site owner. The table policy and the management RPCs re-check is_feedback_owner().';

-- ---------------------------------------------------------------------------
-- 3. Submit — the only insert path
-- ---------------------------------------------------------------------------
create or replace function public.submit_feedback(
  p_category text,
  p_message text,
  p_affected_feature text default null,
  p_contact_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := public.current_profile_id();
  v_category text := lower(btrim(coalesce(p_category, '')));
  v_message  text := btrim(coalesce(p_message, ''));
  v_affected text := nullif(btrim(coalesce(p_affected_feature, '')), '');
  v_email    text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  v_recent   int;
  v_id       uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to send feedback.');
  end if;

  if v_category not in ('bug', 'feature', 'suggestion', 'broken', 'other') then
    return jsonb_build_object('ok', false, 'message', 'Choose what kind of feedback this is.');
  end if;

  if char_length(v_message) = 0 then
    return jsonb_build_object('ok', false, 'message', 'Tell us what happened.');
  end if;
  if char_length(v_message) < 10 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Please add a little more detail — at least 10 characters.'
    );
  end if;
  if char_length(v_message) > 4000 then
    return jsonb_build_object(
      'ok', false,
      'message', 'That message is too long. Please keep it under 4,000 characters.'
    );
  end if;

  if v_affected is not null and char_length(v_affected) > 200 then
    return jsonb_build_object(
      'ok', false,
      'message', 'The affected page or feature is too long — keep it under 200 characters.'
    );
  end if;

  if v_email is not null then
    if char_length(v_email) > 254
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      return jsonb_build_object(
        'ok', false,
        'message', 'That doesn''t look like an email address. Leave it blank if you would rather not share one.'
      );
    end if;
  end if;

  -- A burst limit, not a captcha: enough for a genuine follow-up, low enough
  -- that a script cannot fill the owner's inbox in one sitting.
  select count(*) into v_recent
    from public.feedback_submissions
   where submitted_by = v_uid
     and created_at > now() - interval '10 minutes';
  if v_recent >= 5 then
    return jsonb_build_object(
      'ok', false,
      'message', 'You''ve sent several messages in the last few minutes. Please wait a little before sending another.'
    );
  end if;

  -- The same message twice is almost always a double-tap or a retried request,
  -- not a second report. Compared case-insensitively on the trimmed text.
  if exists (
    select 1
      from public.feedback_submissions
     where submitted_by = v_uid
       and lower(message) = lower(v_message)
       and created_at > now() - interval '10 minutes'
  ) then
    return jsonb_build_object(
      'ok', false,
      'message', 'You already sent this exact message a moment ago. We have it.'
    );
  end if;

  insert into public.feedback_submissions (
    category, message, affected_feature, contact_email, submitted_by
  )
  values (v_category, v_message, v_affected, v_email, v_uid)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'message', 'Thank you — your feedback was sent.'
  );
end
$$;

comment on function public.submit_feedback(text, text, text, text) is
  'Any signed-in member: validate, rate-limit and store one feedback message. Derives submitted_by from the token.';

-- ---------------------------------------------------------------------------
-- 4. Manage — owner only
-- ---------------------------------------------------------------------------
create or replace function public.set_feedback_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status  text := lower(btrim(coalesce(p_status, '')));
  v_updated int;
  v_label   text;
begin
  if not public.is_feedback_owner() then
    return jsonb_build_object('ok', false, 'message', 'Only the site owner can manage feedback.');
  end if;

  if v_status not in ('new', 'reviewing', 'resolved') then
    return jsonb_build_object('ok', false, 'message', 'That status does not exist.');
  end if;

  update public.feedback_submissions
     set status = v_status,
         updated_at = now()
   where id = p_id;
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return jsonb_build_object('ok', false, 'message', 'That feedback entry no longer exists.');
  end if;

  v_label := case v_status
    when 'reviewing' then 'reviewing'
    when 'resolved' then 'resolved'
    else 'new'
  end;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'message', format('Feedback marked as %s.', v_label)
  );
end
$$;

comment on function public.set_feedback_status(uuid, text) is
  'Owner only: move one submission between new, reviewing and resolved.';

create or replace function public.delete_feedback(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  if not public.is_feedback_owner() then
    return jsonb_build_object('ok', false, 'message', 'Only the site owner can delete feedback.');
  end if;

  delete from public.feedback_submissions where id = p_id;
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return jsonb_build_object('ok', false, 'message', 'That feedback entry no longer exists.');
  end if;

  return jsonb_build_object('ok', true, 'message', 'Feedback deleted.');
end
$$;

comment on function public.delete_feedback(uuid) is
  'Owner only: permanently remove one submission.';

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------
alter table public.feedback_submissions enable row level security;

-- Reads are owner-only. There is deliberately no INSERT/UPDATE/DELETE grant:
-- writes go through the SECURITY DEFINER functions above, so a caller can never
-- choose `submitted_by`, `status` or an existing row.
revoke all on table public.feedback_submissions from anon, authenticated;
grant select on table public.feedback_submissions to authenticated;

drop policy if exists feedback_submissions_owner_read on public.feedback_submissions;
create policy feedback_submissions_owner_read on public.feedback_submissions
  for select to authenticated
  using (public.is_feedback_owner());

revoke all on function public.is_feedback_owner() from public, anon;
revoke all on function public.feedback_owner_status() from public, anon;
revoke all on function public.submit_feedback(text, text, text, text) from public, anon;
revoke all on function public.set_feedback_status(uuid, text) from public, anon;
revoke all on function public.delete_feedback(uuid) from public, anon;
revoke all on function public.feedback_touch_updated_at() from public, anon, authenticated;

grant execute on function public.is_feedback_owner() to authenticated, service_role;
grant execute on function public.feedback_owner_status() to authenticated, service_role;
grant execute on function public.submit_feedback(text, text, text, text) to authenticated, service_role;
grant execute on function public.set_feedback_status(uuid, text) to authenticated, service_role;
grant execute on function public.delete_feedback(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner_fn boolean;
begin
  if to_regclass('public.feedback_submissions') is null then
    raise exception 'FAIL: public.feedback_submissions was not created';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.feedback_submissions'::regclass) then
    raise exception 'FAIL: row level security is not enabled on feedback_submissions';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'feedback_submissions'
       and policyname = 'feedback_submissions_owner_read'
       and cmd = 'SELECT'
  ) then
    raise exception 'FAIL: the owner-read policy is missing';
  end if;

  if has_table_privilege('anon', 'public.feedback_submissions', 'SELECT')
     or has_table_privilege('authenticated', 'public.feedback_submissions', 'INSERT')
     or has_table_privilege('authenticated', 'public.feedback_submissions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.feedback_submissions', 'DELETE') then
    raise exception 'FAIL: a client role holds a direct read/write grant it should not have';
  end if;

  if has_function_privilege('anon', 'public.submit_feedback(text, text, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_feedback_status(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.delete_feedback(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.feedback_owner_status()', 'EXECUTE') then
    raise exception 'FAIL: anon may execute a feedback function';
  end if;

  if not has_function_privilege('authenticated', 'public.submit_feedback(text, text, text, text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated cannot execute submit_feedback()';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'feedback_submissions_touch'
       and tgrelid = 'public.feedback_submissions'::regclass
  ) then
    raise exception 'FAIL: the updated_at trigger is missing';
  end if;

  -- The owner predicate must name the owner address and the confirmation check,
  -- so a future edit cannot quietly drop either.
  select exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'is_feedback_owner'
       and pg_get_functiondef(p.oid) like '%lebronyuh64@gmail.com%'
       and pg_get_functiondef(p.oid) like '%email_confirmed_at%'
  ) into v_owner_fn;

  if not v_owner_fn then
    raise exception 'FAIL: is_feedback_owner() does not resolve a confirmed owner address';
  end if;

  raise notice 'OK — feedback_submissions exists, owner-read only, writes through three owner/member RPCs.';
end
$$;
