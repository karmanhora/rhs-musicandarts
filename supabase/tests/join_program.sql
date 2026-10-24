-- ============================================================================
-- join_program.sql — Phase 3 gate: the in-app join flow
-- ============================================================================
-- requires-table: public.ensembles
-- requires-table: public.memberships
--
-- Two throwaway programs (`test-join-a`, `test-join-b`) and one with no code at
-- all (`test-join-open`), then a person who walks in cold and joins program by
-- program:
--
--   JP-1   anon cannot call it at all (42501), and a token-less caller is refused
--   JP-2   a wrong code creates NOTHING — no profile, no membership
--   JP-3   a correct code creates the profile and the membership, as a student
--   JP-4   the same person joins a SECOND program: one profile, two memberships
--   JP-5   joining a program they are already in is a no-op, not an error
--   JP-6   the supplied name is trimmed and capped at 80 characters
--   JP-7   a deactivated person cannot join anything
--   JP-8   somebody a director removed cannot let themselves back in with the code
--   JP-9   list_active_programs() exposes names and never a code
--   JP-10  the per-IP lockout still bites in this path
--   JP-11  the code alone names the program — no slug, no picker
--   JP-12  an unknown code creates nothing and says so
--   JP-13  anon cannot call the code-only RPC
--   JP-14  the lockout covers unknown codes too
--
-- Runs in one transaction and ROLLS BACK. Personas are authenticated exactly the
-- way PostgREST sees a Supabase Auth token. On success it prints: JOIN PROGRAM PASSED
--
-- A note on reading the aftermath: a persona can only see rows for a program they
-- belong to, so "nothing was created" and "that membership is still inactive"
-- are asked AFTER `reset role`, as the owner. Asked from inside the persona's
-- RLS those questions answer themselves — an empty result would look like proof.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Assertion helper (created inside the transaction — rolled back with it)
-- ---------------------------------------------------------------------------
create or replace function public.t_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end;
$$;

grant execute on function public.t_assert(boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Fixtures
-- ---------------------------------------------------------------------------
insert into public.ensembles (id, slug, name, short_name, theme_color) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'test-join-a',    'TST Join A',    'JoinA', '#333333'),
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'test-join-b',    'TST Join B',    'JoinB', '#444444'),
  ('cccccccc-0000-4000-8000-0000000000c1', 'test-join-open', 'TST Join Open', 'Open',  '#555555');

insert into public.ensemble_settings (ensemble_id, join_code) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'JOINA9'),
  ('bbbbbbbb-0000-4000-8000-0000000000c1', 'JOINB9');

-- The third program deliberately has no settings row at all — an empty code
-- means "no code required" (016's rule), which this suite pins down below.

-- ---------------------------------------------------------------------------
-- 2. JP-1 — anon, and a signed-in person with no account id
-- ---------------------------------------------------------------------------
do $$
declare
  v_state text;
begin
  set role anon;
  begin
    perform public.join_program('test-join-a', 'JOINA9');
    v_state := 'CALLED';
  exception
    when others then
      v_state := sqlstate;
  end;
  reset role;

  if v_state <> '42501' then
    raise exception 'FAIL: JP-1 anon could call join_program (sqlstate %)', v_state;
  end if;
end $$;

do $$
declare
  v jsonb;
begin
  -- Signed in to nothing at all: no `sub` claim.
  perform set_config('request.jwt.claims', '{}', true);
  set role authenticated;

  v := public.join_program('test-join-a', 'JOINA9');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-1b a caller with no account id was allowed to join');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  perform public.t_assert(
    not exists (select 1 from public.memberships
                 where ensemble_id = 'aaaaaaaa-0000-4000-8000-0000000000c1'),
    'JP-1c a token-less call created a membership');
end $$;

-- ---------------------------------------------------------------------------
-- 3. JP-2 — a wrong code creates nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-newbie","role":"authenticated"}', true);
  set role authenticated;

  v := public.join_program('test-join-a', 'WRONG99', 'Robin Wrong', 'jp-ip-wrong');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-2 a wrong join code was accepted');
  perform public.t_assert(coalesce(v ->> 'message', '') <> '',
    'JP-2b the refusal came with no message to show the person');

  -- The right code, but for the OTHER program, must not open this one.
  v := public.join_program('test-join-a', 'JOINB9', 'Robin Wrong', 'jp-ip-wrong');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-2e another program''s join code was accepted');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  -- …and nothing at all was created for them (read as the owner: this person has--    no profile yet, so through their own RLS they would see nothing anyway).
  perform public.t_assert(
    not exists (select 1 from public.profiles where auth_user_id = 'join-newbie'),
    'JP-2c a wrong code created a profile');
  perform public.t_assert(
    not exists (select 1 from public.memberships
                 where ensemble_id = 'aaaaaaaa-0000-4000-8000-0000000000c1'),
    'JP-2d a wrong code created a membership');
end $$;

-- ---------------------------------------------------------------------------
-- 4. JP-3 — the first program
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-newbie","role":"authenticated"}', true);
  set role authenticated;

  v := public.join_program('test-join-a', 'JOINA9', 'Robin Newbie', 'jp-ip-1');
  perform public.t_assert(v ->> 'ok' = 'true',
    'JP-3 the right join code was refused: ' || coalesce(v ->> 'message', '?'));
  perform public.t_assert(v ->> 'existing' = 'false',
    'JP-3b a first join reported itself as an existing membership');
  perform public.t_assert((v ->> 'program_name') = 'TST Join A',
    'JP-3c the call did not name the program it joined');

  perform public.t_assert(
    (select count(*) from public.profiles where auth_user_id = 'join-newbie') = 1,
    'JP-3d the profile was not created exactly once');
  perform public.t_assert(
    (select full_name from public.profiles where auth_user_id = 'join-newbie') = 'Robin Newbie',
    'JP-3e the supplied name was not stored');
  perform public.t_assert(
    (select count(*) from public.memberships m
       join public.profiles p on p.id = m.user_id
      where p.auth_user_id = 'join-newbie'
        and m.ensemble_id = 'aaaaaaaa-0000-4000-8000-0000000000c1'
        and m.active
        and m.roles = '{student}'::public.app_role[]) = 1,
    'JP-3f the membership was not created as an active student');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 5. JP-4 / JP-5 — a second program, then the same one twice
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-newbie","role":"authenticated"}', true);
  set role authenticated;

  -- JP-4 — band today, choir tomorrow: still one person.
  v := public.join_program('test-join-b', 'JOINB9', 'Ignored Name', 'jp-ip-2');
  perform public.t_assert(v ->> 'ok' = 'true',
    'JP-4 joining a second program failed: ' || coalesce(v ->> 'message', '?'));
  perform public.t_assert(v ->> 'existing' = 'false',
    'JP-4b the second program reported itself as already joined');
  perform public.t_assert(
    (select count(*) from public.profiles where auth_user_id = 'join-newbie') = 1,
    'JP-4c joining a second program duplicated the person');
  perform public.t_assert(
    (select count(*) from public.memberships m
       join public.profiles p on p.id = m.user_id
      where p.auth_user_id = 'join-newbie') = 2,
    'JP-4d a member of two programs does not have two memberships');
  -- The name they already had is not overwritten by a later call.
  perform public.t_assert(
    (select full_name from public.profiles where auth_user_id = 'join-newbie') = 'Robin Newbie',
    'JP-4e joining a second program overwrote their name');

  -- JP-5 — tapping join twice is harmless, not an error.
  v := public.join_program('test-join-a', 'JOINA9', 'Robin Newbie', 'jp-ip-1');
  perform public.t_assert(v ->> 'ok' = 'true',
    'JP-5 re-joining reported a failure: ' || coalesce(v ->> 'message', '?'));
  perform public.t_assert(v ->> 'existing' = 'true',
    'JP-5b re-joining did not report the existing membership');
  perform public.t_assert(
    (select count(*) from public.memberships m
       join public.profiles p on p.id = m.user_id
      where p.auth_user_id = 'join-newbie'
        and m.ensemble_id = 'aaaaaaaa-0000-4000-8000-0000000000c1') = 1,
    'JP-5c re-joining created a second membership row');

  -- JP-6 — the name is trimmed and capped.
  v := public.join_program('test-join-open', '', repeat('x', 200), 'jp-ip-3');
  perform public.t_assert(v ->> 'ok' = 'true',
    'JP-6 a program with no code refused a join: ' || coalesce(v ->> 'message', '?'));
  perform public.t_assert(
    (select length(full_name) from public.profiles where auth_user_id = 'join-newbie') <= 80,
    'JP-6b a 200-character name was stored uncapped');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 6. JP-7 — a deactivated person is refused
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  update public.profiles set deactivated = true where auth_user_id = 'join-newbie';

  perform set_config('request.jwt.claims', '{"sub":"join-newbie","role":"authenticated"}', true);
  set role authenticated;

  v := public.join_program('test-join-b', 'JOINB9', 'Robin Newbie', 'jp-ip-4');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-7 a deactivated account was allowed to join a program');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);
update public.profiles set deactivated = false where auth_user_id = 'join-newbie';

-- ---------------------------------------------------------------------------
-- 7. JP-8 — the roster is the director's decision
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  update public.memberships m
     set active = false
    from public.profiles p
   where p.id = m.user_id
     and p.auth_user_id = 'join-newbie'
     and m.ensemble_id = 'bbbbbbbb-0000-4000-8000-0000000000c1';

  perform set_config('request.jwt.claims', '{"sub":"join-newbie","role":"authenticated"}', true);
  set role authenticated;

  v := public.join_program('test-join-b', 'JOINB9', 'Robin Newbie', 'jp-ip-2');

  -- Removal must not be undone by re-entering a code someone else can share.
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-8 re-entering the code let a removed member back onto the roster');
  perform public.t_assert(coalesce(v ->> 'message', '') <> '',
    'JP-8b the refusal came with no message to show the person');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  -- Asked as the owner. Through their own RLS this row is invisible *because*
  -- the removal worked, so a persona-side check would pass on an empty result.
  perform public.t_assert(
    (select count(*) from public.memberships m
       join public.profiles p on p.id = m.user_id
      where p.auth_user_id = 'join-newbie'
        and m.ensemble_id = 'bbbbbbbb-0000-4000-8000-0000000000c1'
        and m.active = false) = 1,
    'JP-8c the membership was reactivated anyway');
  perform public.t_assert(
    (select count(*) from public.memberships m
       join public.profiles p on p.id = m.user_id
      where p.auth_user_id = 'join-newbie'
        and m.ensemble_id = 'bbbbbbbb-0000-4000-8000-0000000000c1') = 1,
    'JP-8d the refusal still created a duplicate membership');
end $$;

-- ---------------------------------------------------------------------------
-- 8. JP-9 — the join screen's menu never leaks a code
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_row jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-newbie","role":"authenticated"}', true);
  set role authenticated;

  v := public.list_active_programs();
  perform public.t_assert(jsonb_typeof(v) = 'array',
    'JP-9 list_active_programs did not answer with a list');
  perform public.t_assert(
    (select count(*) from jsonb_array_elements(v) x
      where x ->> 'slug' = 'test-join-a') = 1,
    'JP-9b the list omitted a program');

  -- Every row carries what the screen needs, and no code key at all.
  perform public.t_assert(
    not exists (
      select 1 from jsonb_array_elements(v) x
       where not (x ? 'slug' and x ? 'name' and x ? 'has_join_code')
    ),
    'JP-9c a row is missing slug/name/has_join_code');
  perform public.t_assert(
    not exists (
      select 1 from jsonb_array_elements(v) x
       where exists (select 1 from jsonb_object_keys(x) k where k like '%code%' and k <> 'has_join_code')
    ),
    'JP-9d the response carried a code-bearing key');

  -- And nothing in the payload is a live code value.
  perform public.t_assert(
    position('JOINA9' in v::text) = 0 and position('JOINB9' in v::text) = 0,
    'JP-9e a join code leaked into the program list');

  select x into v_row from jsonb_array_elements(v) x where x ->> 'slug' = 'test-join-a';
  perform public.t_assert(v_row ->> 'has_join_code' = 'true',
    'JP-9f a program that does have a code was reported as open');

  select x into v_row from jsonb_array_elements(v) x where x ->> 'slug' = 'test-join-open';
  perform public.t_assert(v_row ->> 'has_join_code' = 'false',
    'JP-9g a program with no code was reported as needing one');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 9. JP-10 — the lockout still bites through this path
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  i integer;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-brute","role":"authenticated"}', true);
  set role authenticated;

  -- Five wrong guesses from one address…
  for i in 1..5 loop
    v := public.join_program('test-join-a', 'NOPE' || i, 'Brute Force', 'jp-ip-brute');
  end loop;

  -- …and now even the CORRECT code from that address is refused.
  v := public.join_program('test-join-a', 'JOINA9', 'Brute Force', 'jp-ip-brute');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-10 the join-code lockout did not apply to join_program');
  perform public.t_assert(
    coalesce(v ->> 'message', '') ilike '%too many%',
    'JP-10b the lockout refusal did not say what happened: ' || coalesce(v ->> 'message', '?')
  );
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  perform public.t_assert(
    not exists (select 1 from public.profiles where auth_user_id = 'join-brute'),
    'JP-10c a throttled caller still got a profile');
end $$;

-- ---------------------------------------------------------------------------
-- 11. JP-11 — the code alone finds the program
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-code-only","role":"authenticated"}', true);
  set role authenticated;

  -- Padded and lower-case: the person only has the code to go on.
  v := public.join_program_by_code('  joinb9  ', 'Case Only', 'jp-ip-code-1');
  perform public.t_assert(v ->> 'ok' = 'true',
    'JP-11 a code-only join was refused: ' || coalesce(v ->> 'message', '?'));
  perform public.t_assert(v ->> 'program_name' = 'TST Join B',
    'JP-11b the code joined the wrong program');
  perform public.t_assert(v ->> 'existing' = 'false',
    'JP-11c a first code-only join reported an existing membership');
  perform public.t_assert(
    (select count(*) from public.profiles where auth_user_id = 'join-code-only') = 1,
    'JP-11d the profile was not created exactly once');
  perform public.t_assert(
    (select count(*) from public.memberships m
       join public.profiles p on p.id = m.user_id
      where p.auth_user_id = 'join-code-only'
        and m.ensemble_id = 'bbbbbbbb-0000-4000-8000-0000000000c1'
        and m.active) = 1,
    'JP-11e the code did not put them on that program''s roster');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 12. JP-12 — an unknown code creates nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-code-none","role":"authenticated"}', true);
  set role authenticated;

  v := public.join_program_by_code('ZZZZ9999', 'Nobody Here', 'jp-ip-code-2');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-12 an unknown code was accepted');
  perform public.t_assert(coalesce(v ->> 'message', '') <> '',
    'JP-12b the refusal came with no message to show the person');
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  perform public.t_assert(
    not exists (select 1 from public.profiles where auth_user_id = 'join-code-none'),
    'JP-12c an unknown code created a profile');
end $$;

-- ---------------------------------------------------------------------------
-- 13. JP-13 — anon cannot call the code-only RPC
-- ---------------------------------------------------------------------------
do $$
declare
  v_state text;
begin
  set role anon;
  begin
    perform public.join_program_by_code('JOINA9');
    v_state := 'CALLED';
  exception
    when others then
      v_state := sqlstate;
  end;
  reset role;

  if v_state <> '42501' then
    raise exception 'FAIL: JP-13 anon could call join_program_by_code (sqlstate %)', v_state;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 14. JP-14 — guessing codes stays throttled
-- ---------------------------------------------------------------------------
do $$
declare
  v jsonb;
  i integer;
begin
  perform set_config('request.jwt.claims', '{"sub":"join-code-brute","role":"authenticated"}', true);
  set role authenticated;

  for i in 1..5 loop
    v := public.join_program_by_code('NOPE' || i, 'Brute Code', 'jp-ip-code-brute');
  end loop;

  -- The right code, from an address that has just guessed five times.
  v := public.join_program_by_code('JOINA9', 'Brute Code', 'jp-ip-code-brute');
  perform public.t_assert(v ->> 'ok' = 'false',
    'JP-14 the code-only lockout did not apply');
  perform public.t_assert(
    coalesce(v ->> 'message', '') ilike '%too many%',
    'JP-14b the lockout refusal did not say what happened: ' || coalesce(v ->> 'message', '?')
  );
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);

do $$
begin
  perform public.t_assert(
    not exists (select 1 from public.profiles where auth_user_id = 'join-code-brute'),
    'JP-14c a throttled caller still got a profile');
end $$;

-- ---------------------------------------------------------------------------
-- 15. Teardown
-- ---------------------------------------------------------------------------
rollback;

select 'JOIN PROGRAM PASSED' as verification_result;
