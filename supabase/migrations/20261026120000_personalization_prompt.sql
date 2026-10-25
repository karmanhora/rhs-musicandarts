-- ============================================================================
-- RHS Music Platform — Migration: the first-run appearance prompt
-- ============================================================================
-- Idempotent — add-column-if-not-exists, create-or-replace, and a guarded drop
-- of the previous RPC signature; safe to re-run.
--
-- WHAT CHANGES
--   1. `profile_preferences.personalization_prompt_seen_at` — when a person was
--      first offered the short appearance prompt (theme + background). Null
--      means it has never been shown to them; a timestamp means it has been
--      offered and answered, whether they saved a choice or skipped.
--   2. `my_preferences()` returns the field, in both the "no row yet" branch and
--      the stored-row branch.
--   3. `set_my_preferences(...)` gains `p_personalize_seen boolean`. True stamps
--      the moment (keeping the first one), false clears it, null leaves it.
--
-- WHY A SEPARATE FIELD
--   `onboarding_completed_at` is the *teacher's* guided setup (`/setup`) and
--   decides only whether that wizard is offered. A student answering a two-line
--   appearance prompt must not consume that state: if they were later made a
--   director, their program setup would already count as finished. Two
--   audiences, two timestamps.
--
-- WHAT DOES NOT CHANGE
--   * Nothing here grants a capability, a role or program access. The row is
--     still scoped to the caller by `current_profile_id()` and by RLS.
--   * There is still no program-wide default appearance: this flag is personal
--     and `ensemble_theme_tokens` stays read-only to clients.
--   * A person with no row still reads as "all defaults", and reading still
--     writes nothing.
--
-- NOTE ON THE SIGNATURE
--   Postgres cannot replace a function with a different argument list, and
--   leaving the four-argument version alongside a five-argument one would make
--   `set_my_preferences(p_theme => 'dark')` ambiguous ("function is not
--   unique"). The old signature is dropped first; the frontend that sends the
--   new argument ships after this migration.
--
-- ROLLBACK
--   drop function if exists public.set_my_preferences(text, text, text[], boolean, boolean);
--   create the four-argument version from 20261025120000 again, then:
--   alter table public.profile_preferences drop column if exists personalization_prompt_seen_at;
--   Apply the rollback only together with a frontend that no longer sends
--   `p_personalize_seen`; the column itself is safe to leave in place (the
--   previous frontend simply ignores the extra field).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The new state
-- ---------------------------------------------------------------------------
alter table public.profile_preferences
  add column if not exists personalization_prompt_seen_at timestamptz;

comment on column public.profile_preferences.personalization_prompt_seen_at is
  'When the short appearance prompt (theme + background) was offered and answered. Null means never shown. Separate from onboarding_completed_at, which is the teacher setup wizard.';

-- ---------------------------------------------------------------------------
-- 2. Read: the same function, one more field
-- ---------------------------------------------------------------------------
create or replace function public.my_preferences()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := public.current_profile_id();
  v_row public.profile_preferences%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to read your preferences.');
  end if;

  select * into v_row from public.profile_preferences where user_id = v_uid;

  if not found then
    -- No row is a normal state, not an error: the interface gets the defaults
    -- and never has to write one just to read one.
    return jsonb_build_object(
      'ok', true,
      'theme', 'system',
      'background', 'paper',
      'dashboard_modules', jsonb_build_array(
        'coming_up', 'my_attendance', 'my_programs', 'program_facts', 'quick_links'
      ),
      'onboarding_completed_at', null,
      'personalization_prompt_seen_at', null
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'theme', v_row.theme,
    'background', v_row.background,
    'dashboard_modules', to_jsonb(v_row.dashboard_modules),
    'onboarding_completed_at', v_row.onboarding_completed_at,
    'personalization_prompt_seen_at', v_row.personalization_prompt_seen_at
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Write: the same function with one more optional argument
-- ---------------------------------------------------------------------------
drop function if exists public.set_my_preferences(text, text, text[], boolean);

create or replace function public.set_my_preferences(
  p_theme text default null,
  p_background text default null,
  p_dashboard_modules text[] default null,
  p_onboarding_completed boolean default null,
  p_personalize_seen boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := public.current_profile_id();
  v_modules text[];
  v_module  text;
  v_clean   text[] := array[]::text[];
  v_seen    text[] := array[]::text[];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in to change your preferences.');
  end if;

  if p_theme is not null and p_theme not in ('system', 'light', 'dark') then
    return jsonb_build_object('ok', false, 'message', 'That appearance option does not exist.');
  end if;

  if p_background is not null
     and p_background not in ('paper', 'mint', 'ruled', 'grid') then
    return jsonb_build_object('ok', false, 'message', 'That background does not exist.');
  end if;

  if p_dashboard_modules is not null then
    if cardinality(p_dashboard_modules) > 8 then
      return jsonb_build_object('ok', false, 'message', 'That is too many dashboard blocks.');
    end if;

    -- Deduplicate while keeping the order the person chose; refuse anything the
    -- interface does not offer rather than storing a block nobody can render.
    foreach v_module in array p_dashboard_modules loop
      if v_module is null then
        return jsonb_build_object('ok', false, 'message', 'A dashboard block was missing its name.');
      end if;
      if v_module not in ('coming_up', 'my_attendance', 'my_programs', 'program_facts', 'quick_links') then
        return jsonb_build_object('ok', false, 'message', format('“%s” is not a dashboard block.', v_module));
      end if;
      if v_module = any(v_seen) then
        continue;
      end if;
      v_seen := array_append(v_seen, v_module);
      v_clean := array_append(v_clean, v_module);
    end loop;
    v_modules := v_clean;
  end if;

  insert into public.profile_preferences as p (
    user_id, theme, background, dashboard_modules, onboarding_completed_at,
    personalization_prompt_seen_at
  )
  values (
    v_uid,
    coalesce(p_theme, 'system'),
    coalesce(p_background, 'paper'),
    coalesce(v_modules, array[
      'coming_up', 'my_attendance', 'my_programs', 'program_facts', 'quick_links'
    ]::text[]),
    case when p_onboarding_completed is true then now() else null end,
    case when p_personalize_seen is true then now() else null end
  )
  on conflict (user_id) do update set
    theme = coalesce(p_theme, p.theme),
    background = coalesce(p_background, p.background),
    dashboard_modules = coalesce(v_modules, p.dashboard_modules),
    -- Finishing or dismissing twice keeps the first timestamp; clearing is
    -- explicit, and a save that says nothing about it leaves it alone.
    onboarding_completed_at = case
      when p_onboarding_completed is true then coalesce(p.onboarding_completed_at, now())
      when p_onboarding_completed is false then null
      else p.onboarding_completed_at
    end,
    personalization_prompt_seen_at = case
      when p_personalize_seen is true then coalesce(p.personalization_prompt_seen_at, now())
      when p_personalize_seen is false then null
      else p.personalization_prompt_seen_at
    end,
    updated_at = now();

  return public.my_preferences();
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Access
-- ---------------------------------------------------------------------------
revoke all on function public.set_my_preferences(text, text, text[], boolean, boolean)
  from public, anon;
grant execute on function public.set_my_preferences(text, text, text[], boolean, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_columns integer;
  v_definition text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profile_preferences'
       and column_name = 'personalization_prompt_seen_at'
  ) then
    raise exception 'FAIL: personalization_prompt_seen_at was not added';
  end if;

  -- One overload only: two would make a named call ambiguous.
  select count(*) into v_columns
    from pg_proc
   where proname = 'set_my_preferences'
     and pronamespace = 'public'::regnamespace;

  if v_columns <> 1 then
    raise exception 'FAIL: set_my_preferences has % overloads (expected 1)', v_columns;
  end if;

  if not exists (
    select 1 from pg_proc
     where proname = 'set_my_preferences'
       and pronamespace = 'public'::regnamespace
       and pronargs = 5
  ) then
    raise exception 'FAIL: set_my_preferences does not take p_personalize_seen';
  end if;

  -- Both read branches must answer with the field, or the interface would read
  -- "never asked" for somebody who has already answered.
  v_definition := pg_get_functiondef('public.my_preferences()'::regprocedure);
  if position('personalization_prompt_seen_at' in v_definition) = 0 then
    raise exception 'FAIL: my_preferences does not return the prompt flag';
  end if;

  if has_function_privilege(
       'anon',
       'public.set_my_preferences(text, text, text[], boolean, boolean)',
       'EXECUTE'
     ) then
    raise exception 'FAIL: anon may execute set_my_preferences';
  end if;

  raise notice 'OK — the appearance prompt flag exists and is readable and writable only by its owner.';
end
$$;
