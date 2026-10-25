-- ============================================================================
-- RHS Music Platform — per-person preferences
-- ============================================================================
-- requires-table: public.profile_preferences
--
-- Covers migration 20261025120000: the table, the two RPCs, and the fact that a
-- person's appearance and dashboard choices are their own.
--
-- Scenarios:
--   A  no row reads as the shipped defaults, and reading creates no row
--   B  theme, background and dashboard order round-trip
--   C  refusals: an unknown theme, background or block is not stored, a null
--      block is refused, and the table's own constraints hold the same line
--   D  one person cannot read another's row, and a write only touches the caller
--   E  no client may write the table directly
--   F  finishing setup stamps once, and clearing it is explicit
--
-- Every fixture is fictional and the whole suite runs in ONE transaction that is
-- ROLLED BACK — it never touches real records.
--
-- Prints PROFILE PREFERENCES PASSED on success.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.profile_preferences') is null then
    raise exception 'FAIL: PREF-0 profile_preferences missing — apply 20261025120000 first';
  end if;
end
$$;

create or replace function public.pref_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: two people, neither with a preferences row.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'pref-auth-a', 'Pref Person A', 'Pref A'),
  ('eeeeeeee-0000-4000-8000-000000000002', 'pref-auth-b', 'Pref Person B', 'Pref B')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- A. Defaults with no row
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"pref-auth-a","role":"authenticated"}', true);
  set role authenticated;

  v := public.my_preferences();
  perform public.pref_assert(v->>'ok' = 'true', 'A1 my_preferences answers for a signed-in person');
  perform public.pref_assert(v->>'theme' = 'system', 'A2 the default theme follows the device');
  perform public.pref_assert(v->>'background' = 'paper', 'A3 the default background is paper');
  perform public.pref_assert(
    jsonb_array_length(v->'dashboard_modules') = 5,
    'A4 the default dashboard shows all five blocks');
  perform public.pref_assert(
    v->'dashboard_modules'->>0 = 'coming_up'
    and v->'dashboard_modules'->>4 = 'quick_links',
    'A5 the default order is the shipped layout');
  perform public.pref_assert(
    v->>'onboarding_completed_at' is null,
    'A6 setup has not been finished yet');

  reset role;

  perform public.pref_assert(
    (select count(*) from public.profile_preferences where user_id = 'eeeeeeee-0000-4000-8000-000000000001') = 0,
    'A7 reading preferences does not write a row');
end
$$;

-- ---------------------------------------------------------------------------
-- B. Round trip
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_row public.profile_preferences%rowtype;
begin
  perform set_config('request.jwt.claims', '{"sub":"pref-auth-a","role":"authenticated"}', true);
  set role authenticated;

  v := public.set_my_preferences(p_theme => 'dark');
  perform public.pref_assert(v->>'ok' = 'true', 'B1 a theme may be saved');
  perform public.pref_assert(v->>'theme' = 'dark', 'B2 the saved theme comes back');

  -- Leaving an argument null must not reset the others.
  v := public.set_my_preferences(p_background => 'ruled');
  perform public.pref_assert(v->>'theme' = 'dark', 'B3 an unrelated save keeps the theme');
  perform public.pref_assert(v->>'background' = 'ruled', 'B4 the background was saved');

  -- Deliberately out of order, and with one duplicate.
  v := public.set_my_preferences(
    p_dashboard_modules => array['my_attendance', 'coming_up', 'my_attendance', 'my_programs']
  );
  perform public.pref_assert(v->>'ok' = 'true', 'B5 a dashboard order may be saved');
  perform public.pref_assert(
    v->'dashboard_modules' = '["my_attendance","coming_up","my_programs"]'::jsonb,
    'B6 the chosen order is kept and the duplicate is dropped');

  reset role;

  select * into v_row
    from public.profile_preferences
   where user_id = 'eeeeeeee-0000-4000-8000-000000000001';
  perform public.pref_assert(v_row.theme = 'dark', 'B7 the table holds the theme');
  perform public.pref_assert(v_row.background = 'ruled', 'B8 the table holds the background');
  perform public.pref_assert(
    v_row.dashboard_modules = array['my_attendance', 'coming_up', 'my_programs'],
    'B9 the table holds the order');
end
$$;

-- ---------------------------------------------------------------------------
-- C. Refusals
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"pref-auth-a","role":"authenticated"}', true);
  set role authenticated;

  v := public.set_my_preferences(p_theme => 'neon');
  perform public.pref_assert(v->>'ok' = 'false', 'C1 an unknown theme is refused');
  perform public.pref_assert(
    position('does not exist' in v->>'message') > 0,
    'C2 the theme refusal explains itself');

  v := public.set_my_preferences(p_background => 'nebula');
  perform public.pref_assert(v->>'ok' = 'false', 'C3 an unknown background is refused');

  v := public.set_my_preferences(p_dashboard_modules => array['coming_up', 'weather']);
  perform public.pref_assert(v->>'ok' = 'false', 'C4 an unknown dashboard block is refused');
  perform public.pref_assert(
    position('weather' in v->>'message') > 0,
    'C5 the block refusal names the block');

  v := public.set_my_preferences(p_dashboard_modules => array['coming_up', null]);
  perform public.pref_assert(v->>'ok' = 'false', 'C6 a null block is refused');

  v := public.set_my_preferences(
    p_dashboard_modules => array['coming_up','my_attendance','my_programs','program_facts','quick_links','coming_up','my_attendance','my_programs','quick_links']
  );
  perform public.pref_assert(v->>'ok' = 'false', 'C7 more than eight entries is refused');

  -- A refusal must not have changed anything.
  v := public.my_preferences();
  perform public.pref_assert(v->>'theme' = 'dark', 'C8 a refusal leaves the saved theme alone');
  perform public.pref_assert(v->>'background' = 'ruled', 'C9 a refusal leaves the saved background alone');

  reset role;

  -- The table's own constraints hold the line even if an RPC were bypassed.
  begin
    insert into public.profile_preferences (user_id, background)
    values ('eeeeeeee-0000-4000-8000-000000000002', 'neon');
    raise exception 'FAIL: C10 the table accepted an unknown background';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.profile_preferences (user_id, dashboard_modules)
    values ('eeeeeeee-0000-4000-8000-000000000002', array['coming_up', 'weather']);
    raise exception 'FAIL: C11 the table accepted an unknown block';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.profile_preferences (user_id, theme)
    values ('eeeeeeee-0000-4000-8000-000000000002', 'neon');
    raise exception 'FAIL: C12 the table accepted an unknown theme';
  exception
    when check_violation then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- D. Isolation
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"pref-auth-b","role":"authenticated"}', true);
  set role authenticated;

  perform public.pref_assert(
    (select count(*) from public.profile_preferences) = 0,
    'D1 one person cannot read another person''s preferences');

  v := public.my_preferences();
  perform public.pref_assert(v->>'theme' = 'system', 'D2 the other person still reads their own defaults');

  v := public.set_my_preferences(p_theme => 'light');
  perform public.pref_assert(v->>'ok' = 'true', 'D3 the other person may save their own theme');

  reset role;

  perform public.pref_assert(
    (select theme from public.profile_preferences where user_id = 'eeeeeeee-0000-4000-8000-000000000001') = 'dark',
    'D4 the first person''s row was not touched');
  perform public.pref_assert(
    (select theme from public.profile_preferences where user_id = 'eeeeeeee-0000-4000-8000-000000000002') = 'light',
    'D5 the writer''s own row was written');
end
$$;

-- ---------------------------------------------------------------------------
-- E. No direct writes
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', '{"sub":"pref-auth-a","role":"authenticated"}', true);
  set role authenticated;

  begin
    insert into public.profile_preferences (user_id) values ('eeeeeeee-0000-4000-8000-000000000001');
    raise exception 'FAIL: E1 a client inserted a preferences row directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.profile_preferences set theme = 'light';
    raise exception 'FAIL: E2 a client updated preferences directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.profile_preferences;
    raise exception 'FAIL: E3 a client deleted preferences directly';
  exception
    when insufficient_privilege then null;
  end;

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- F. Onboarding state
-- ---------------------------------------------------------------------------
do $$
declare
  v        jsonb;
  v_first  timestamptz;
begin
  perform set_config('request.jwt.claims', '{"sub":"pref-auth-a","role":"authenticated"}', true);
  set role authenticated;

  v := public.set_my_preferences(p_onboarding_completed => true);
  perform public.pref_assert(v->>'ok' = 'true', 'F1 setup can be marked finished');
  perform public.pref_assert(v->>'onboarding_completed_at' is not null, 'F2 a timestamp is recorded');
  v_first := (v->>'onboarding_completed_at')::timestamptz;

  v := public.set_my_preferences(p_onboarding_completed => true);
  perform public.pref_assert(
    (v->>'onboarding_completed_at')::timestamptz = v_first,
    'F3 finishing twice keeps the first timestamp');

  -- An unrelated save must not clear it.
  v := public.set_my_preferences(p_background => 'grid');
  perform public.pref_assert(v->>'onboarding_completed_at' is not null, 'F4 another save keeps it');

  v := public.set_my_preferences(p_onboarding_completed => false);
  perform public.pref_assert(v->>'onboarding_completed_at' is null, 'F5 clearing it is explicit');

  reset role;
end
$$;

rollback;

select 'PROFILE PREFERENCES PASSED' as verification_result;
