-- ============================================================================
-- RHS Music Platform — feedback now requires a contact address
-- ============================================================================
-- Idempotent — safe to re-run.
--
-- The owner needs a way to answer. The form asks for an address and refuses to
-- send without one, and this migration makes that a server rule rather than a
-- browser courtesy:
--   * submit_feedback() refuses a missing/blank address with a readable answer;
--   * a CHECK constraint refuses any new row without one, even if a future
--     caller forgets the function.
--
-- Existing rows keep their NULL address. The constraint is NOT VALID on
-- purpose: Postgres skips old rows, but enforces it for every new or updated
-- one, so the historical inbox stays readable without inventing addresses.
--
-- Rollback:
--   alter table public.feedback_submissions
--     drop constraint if exists feedback_submissions_contact_required;
--   -- then re-run the submit_feedback() definition from 20261108150000 to
--   -- return to the optional-address behaviour; existing rows are untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table-level rule for new rows
-- ---------------------------------------------------------------------------
alter table public.feedback_submissions
  drop constraint if exists feedback_submissions_contact_required;
alter table public.feedback_submissions
  add constraint feedback_submissions_contact_required
  check (contact_email is not null) not valid;

comment on column public.feedback_submissions.contact_email is
  'The address the sender supplies so the owner can reply. Required for new messages; historical rows may predate the rule. Never copied from auth.users without the sender''s action.';

-- ---------------------------------------------------------------------------
-- 2. The submit path — same function, one new required field
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

  -- The owner cannot answer an anonymous message, so the address is part of
  -- what makes a submission complete rather than an optional nicety.
  if v_email is null then
    return jsonb_build_object(
      'ok', false,
      'message', 'Add an email address so the owner can reply.'
    );
  end if;

  if char_length(v_email) > 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object(
      'ok', false,
      'message', 'That doesn''t look like an email address. Check it and try again.'
    );
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
  'Any signed-in member: validate (including a required contact address), rate-limit and store one feedback message. Derives submitted_by from the token.';

-- ---------------------------------------------------------------------------
-- 3. Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'feedback_submissions_contact_required'
       and conrelid = 'public.feedback_submissions'::regclass
  ) then
    raise exception 'FAIL: feedback_submissions_contact_required is missing';
  end if;

  if pg_get_constraintdef((
    select oid from pg_constraint
     where conname = 'feedback_submissions_contact_required'
       and conrelid = 'public.feedback_submissions'::regclass
  )) not like '%contact_email IS NOT NULL%' then
    raise exception 'FAIL: the constraint does not require contact_email';
  end if;

  if pg_get_functiondef('public.submit_feedback(text, text, text, text)'::regprocedure)
     not like '%v_email is null%' then
    raise exception 'FAIL: submit_feedback() no longer checks the contact address';
  end if;

  raise notice 'feedback contact address OK: required for new rows and in submit_feedback()';
end
$$;
