-- ============================================================================
-- RHS Music Platform — Migration: per-person preferences
-- ============================================================================
-- Idempotent — create-if-not-exists and create-or-replace only; safe to re-run.
--
-- WHAT CHANGES
--   1. `public.profile_preferences` — one row per profile holding the choices
--      that belong to a person rather than to a program:
--        theme                'system' | 'light' | 'dark'
--        background           a built-in page treatment (see src/lib/personalization.ts):
--                             'paper' | 'mint' | 'ruled' | 'grid'
--        dashboard_modules    which dashboard blocks are shown, and in what order
--        onboarding_completed_at  when the guided setup was finished, if ever
--      A person with no row is "all defaults"; the app never has to write a row
--      just to read one.
--   2. `public.my_preferences()` — the caller's own preferences, with the
--      defaults filled in. Returns no row ever leaves the caller's own data.
--   3. `public.set_my_preferences(...)` — the only write path. Validates every
--      value against the same allow-lists the interface renders from, so an
--      unknown background or module is refused with a sentence instead of
--      stored and ignored.
--
-- WHAT DOES NOT CHANGE
--   * Program appearance (`ensemble_theme_tokens`) is still read-only to clients
--     and is not touched here. There is deliberately no program-wide default:
--     these are personal choices only.
--   * Nothing here grants a capability, a role or program access. The row is
--     scoped to the caller by `current_profile_id()` and by RLS.
--   * Dark mode keeps working with no row at all: `src/lib/personalization.ts`
--     treats a missing row as 'system' + 'paper'.
--
-- SECURITY
--   * RLS on, one policy: `user_id = public.current_profile_id()`. No client
--     INSERT/UPDATE/DELETE — both writes are SECURITY DEFINER RPCs that resolve
--     the profile from the token, so a client cannot name somebody else's row.
--   * Both functions pin `search_path`, as migration 034 requires.
--
-- ROLLBACK
--   drop function if exists public.set_my_preferences(text, text, text[], boolean);
--   drop function if exists public.my_preferences();
--   drop table if exists public.profile_preferences;
--   The frontend degrades to its defaults if the table is absent, but apply the
--   rollback only together with a frontend that no longer calls the RPCs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.profile_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  theme text not null default 'system',
  background text not null default 'paper',
  -- Kept in sync with DASHBOARD_MODULES in src/lib/personalization.ts. Hiding a
  -- block is legitimate; the dashboard's focal "next event" panel is not in this
  -- list at all, so it can never be hidden.
  dashboard_modules text[] not null default array[
    'coming_up', 'my_attendance', 'my_programs', 'program_facts', 'quick_links'
  ]::text[],
  onboarding_completed_at timestamptz,
  updated_at timestamptz not null default now(),

  constraint profile_preferences_theme_known
    check (theme in ('system', 'light', 'dark')),
  constraint profile_preferences_modules_known
    check (
      dashboard_modules <@ array[
        'coming_up', 'my_attendance', 'my_programs', 'program_facts', 'quick_links'
      ]::text[]
    ),
  constraint profile_preferences_modules_length
    check (cardinality(dashboard_modules) <= 8),
  constraint profile_preferences_modules_no_nulls
    check (array_position(dashboard_modules, null) is null)
);

-- The background allow-list is an ALTER so a re-run upgrades a table created by
-- an earlier copy of this migration, and so adding a treatment stays a deliberate
-- one-line migration rather than something any value of the right shape can be.
alter table public.profile_preferences
  drop constraint if exists profile_preferences_background_shape;
alter table public.profile_preferences
  drop constraint if exists profile_preferences_background_known;
alter table public.profile_preferences
  add constraint profile_preferences_background_known
  check (background in ('paper', 'mint', 'ruled', 'grid'));

comment on table public.profile_preferences is
  'Personal choices: theme, page background, dashboard blocks and onboarding state. Owner-read only; writes go through set_my_preferences().';
comment on column public.profile_preferences.dashboard_modules is
  'Ordered list of visible dashboard block ids. The role decides which of them actually render; this only says whether and where.';
comment on column public.profile_preferences.onboarding_completed_at is
  'When the guided setup was finished. Null means it was never finished — the wizard offers it again; it never blocks the app.';

-- ---------------------------------------------------------------------------
-- 2. Reads
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
      'onboarding_completed_at', null
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'theme', v_row.theme,
    'background', v_row.background,
    'dashboard_modules', to_jsonb(v_row.dashboard_modules),
    'onboarding_completed_at', v_row.onboarding_completed_at
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Writes
-- ---------------------------------------------------------------------------
-- Every argument is optional: null means "leave that one alone", so the theme
-- control, the background picker and the dashboard editor each send one field.
create or replace function public.set_my_preferences(
  p_theme text default null,
  p_background text default null,
  p_dashboard_modules text[] default null,
  p_onboarding_completed boolean default null
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
    user_id, theme, background, dashboard_modules, onboarding_completed_at
  )
  values (
    v_uid,
    coalesce(p_theme, 'system'),
    coalesce(p_background, 'paper'),
    coalesce(v_modules, array[
      'coming_up', 'my_attendance', 'my_programs', 'program_facts', 'quick_links'
    ]::text[]),
    case when p_onboarding_completed is true then now() else null end
  )
  on conflict (user_id) do update set
    theme = coalesce(p_theme, p.theme),
    background = coalesce(p_background, p.background),
    dashboard_modules = coalesce(v_modules, p.dashboard_modules),
    -- Finishing twice keeps the first timestamp; clearing it is explicit.
    onboarding_completed_at = case
      when p_onboarding_completed is true then coalesce(p.onboarding_completed_at, now())
      when p_onboarding_completed is false then null
      else p.onboarding_completed_at
    end,
    updated_at = now();

  return public.my_preferences();
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Access
-- ---------------------------------------------------------------------------
alter table public.profile_preferences enable row level security;

revoke all on table public.profile_preferences from anon, authenticated;
grant select on table public.profile_preferences to authenticated;

drop policy if exists profile_preferences_read_self on public.profile_preferences;
create policy profile_preferences_read_self on public.profile_preferences
  for select to authenticated
  using (user_id = public.current_profile_id());

revoke all on function public.my_preferences() from public, anon;
revoke all on function public.set_my_preferences(text, text, text[], boolean) from public, anon;
grant execute on function public.my_preferences() to authenticated;
grant execute on function public.set_my_preferences(text, text, text[], boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_default text;
begin
  if to_regclass('public.profile_preferences') is null then
    raise exception 'FAIL: profile_preferences was not created';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'profile_preferences'
       and policyname = 'profile_preferences_read_self'
  ) then
    raise exception 'FAIL: the owner-read policy is missing';
  end if;

  if has_table_privilege('authenticated', 'public.profile_preferences', 'INSERT')
     or has_table_privilege('authenticated', 'public.profile_preferences', 'UPDATE')
     or has_table_privilege('authenticated', 'public.profile_preferences', 'DELETE') then
    raise exception 'FAIL: authenticated still holds a direct write grant';
  end if;

  if has_function_privilege('anon', 'public.my_preferences()', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_my_preferences(text, text, text[], boolean)', 'EXECUTE') then
    raise exception 'FAIL: anon may execute a preferences RPC';
  end if;

  -- The column default and the defaults the RPC answers with must agree, or a
  -- person's dashboard would change the moment they saved an unrelated field.
  -- Checked from the catalogue (the expression's text), because inserting a
  -- fixture profile here would outlive the migration.
  select pg_get_expr(d.adbin, d.adrelid) into v_default
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.profile_preferences'::regclass
     and a.attname = 'dashboard_modules';

  if v_default is null
     or position('coming_up' in v_default) = 0
     or position('my_attendance' in v_default) = 0
     or position('my_programs' in v_default) = 0
     or position('program_facts' in v_default) = 0
     or position('quick_links' in v_default) = 0 then
    raise exception 'FAIL: the dashboard_modules default does not hold the five shipped blocks';
  end if;

  raise notice 'OK — profile_preferences exists, owner-read only, both RPCs callable by a signed-in person.';
end
$$;
