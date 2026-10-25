-- ============================================================================
-- teacher_invitations.sql — the invitation code is the only way in (035)
-- ============================================================================
-- requires-table: public.teacher_invitations
--
-- Covers the teacher/director credential added by migration 035: a hashed,
-- single-use, optionally email-bound invitation that a signed-in account
-- redeems on the server to become a verified teacher, and which
-- `create_program()` now requires instead of the sign-up checkbox.
--
--   TI-1   a valid invitation grants teacher access, and the account can then
--          start a program and become its director
--   TI-2   an invalid code grants nothing at all — no access, no flag, no row
--   TI-3   a redeemed code cannot be reused, by anybody
--   TI-4   redemption is atomic: one code, one row, no double-win (the two-live
--          -sessions race itself is scripts/dev/check_teacher_invite_race.sh)
--   TI-5   a student cannot promote themselves — not through their profile, not
--          through memberships, and not by writing the credential tables
--   TI-6   a teacher who signs in first redeems later, without a second account
--   TI-7   the student path is untouched: join with a code, check in, attend
--   TI-8   nobody unauthorized can create a program
--   TI-9   email binding and expiry are enforced when they are configured
--   TI-10  failed attempts are recorded and then rate-limited
--
-- Runs in one transaction and ROLLS BACK. Personas authenticate the way
-- PostgREST sees a Supabase Auth token (migration 021); accounts that need an
-- email address get a real `auth.users` row, because the address is read from
-- Supabase Auth — never from anything the client sends.
--
-- On success it prints: TEACHER INVITATIONS PASSED
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Assertion helper (created inside the transaction — rolled back with it)
-- ---------------------------------------------------------------------------
create or replace function public.ti_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end;
$$;
grant execute on function public.ti_assert(boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 0b. Prerequisites — fail fast, and name the migration that is missing
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.redeem_teacher_invitation(text)') is null then
    raise exception 'FAIL: TI-0 redeem_teacher_invitation() missing — apply migration 035 first';
  end if;
  if to_regprocedure('public.has_teacher_access()') is null then
    raise exception 'FAIL: TI-0 has_teacher_access() missing — apply migration 035 first';
  end if;
  if to_regprocedure('public.record_attendance_by_code(text)') is null then
    raise exception 'FAIL: TI-0 the check-in RPCs are missing — apply migration 016 first';
  end if;
  if not exists (select 1 from public.ensembles where slug = 'band') then
    raise exception 'FAIL: TI-0 the band program is missing — apply migration 014 first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Fixtures (as the owner, rolled back at the end)
-- ---------------------------------------------------------------------------
-- Real `auth.users` rows: the address that decides an email-bound redemption is
-- read from Supabase Auth, so a suite that wants to exercise binding has to hold
-- addresses there. Some JWT claims below deliberately carry a *different*
-- address, to prove the client's claim is ignored.
--
--   0001  the invited teacher        TI-VALID-CODE
--   0002  somebody else              (also the "wrong address" persona)
--   0003  a student on the band
--   0004  a teacher who signs in before they have a code
--   0005  the brute-force persona
--   0006  the address TI-BOUND-CODE was issued to
--   0007  a fresh account for the expiry case
--   0008  a fresh account for the revoked case
insert into auth.users (id, aud, role, email, created_at, updated_at, raw_user_meta_data) values
  ('035f0000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'invited-teacher@example.invalid', now(), now(), '{}'::jsonb),
  ('035f0000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'someone-else@example.invalid', now(), now(), '{}'::jsonb),
  -- An *established* account (older than 024's one-hour window), which is what a
  -- real student is by the time anybody asks them to be a teacher.
  ('035f0000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'student@example.invalid', now() - interval '2 hours', now(), '{}'::jsonb),
  ('035f0000-0000-4000-8000-000000000004', 'authenticated', 'authenticated',
   'late-teacher@example.invalid', now(), now(), '{}'::jsonb),
  ('035f0000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
   'brute-force@example.invalid', now(), now(), '{}'::jsonb),
  ('035f0000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
   'bound-teacher@example.invalid', now(), now(), '{}'::jsonb),
  ('035f0000-0000-4000-8000-000000000007', 'authenticated', 'authenticated',
   'expiry@example.invalid', now(), now(), '{}'::jsonb),
  ('035f0000-0000-4000-8000-000000000008', 'authenticated', 'authenticated',
   'revoked@example.invalid', now(), now(), '{}'::jsonb)
on conflict (id) do nothing;

-- A student who is genuinely on a roster (TI-5 and TI-7).
insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('035f0000-0000-4000-8000-0000000000c3', '035f0000-0000-4000-8000-000000000003',
   'TI Student', 'TI Student')
on conflict (id) do nothing;

insert into public.memberships (user_id, ensemble_id, roles, active)
select '035f0000-0000-4000-8000-0000000000c3'::uuid, b.id, '{student}'::public.app_role[], true
  from public.ensembles b where b.slug = 'band'
on conflict (user_id, ensemble_id) do nothing;

-- Invitations. Only digests live here, exactly as in production — a suite is the
-- one place a plaintext code has to be written down, because it has to type one.
insert into public.teacher_invitations (id, code_hash, label, intended_email, expires_at, revoked_at) values
  ('035f0000-0000-4000-8000-0000000000e1', public.invitation_code_hash('TI-VALID-CODE'),   'valid',   null, null, null),
  ('035f0000-0000-4000-8000-0000000000e2', public.invitation_code_hash('TI-BOUND-CODE'),   'bound',   'bound-teacher@example.invalid', null, null),
  ('035f0000-0000-4000-8000-0000000000e3', public.invitation_code_hash('TI-EXPIRED-CODE'), 'expired', null, now() - interval '1 hour', null),
  ('035f0000-0000-4000-8000-0000000000e4', public.invitation_code_hash('TI-REVOKED-CODE'), 'revoked', null, null, now() - interval '1 minute'),
  ('035f0000-0000-4000-8000-0000000000e5', public.invitation_code_hash('TI-RACE-CODE'),    'race',    null, null, null),
  ('035f0000-0000-4000-8000-0000000000e6', public.invitation_code_hash('TI-LATE-CODE'),    'late',    null, null, null),
  -- Reserved for TI-10: it must survive a throttled attempt untouched.
  ('035f0000-0000-4000-8000-0000000000e7', public.invitation_code_hash('TI-FRESH-CODE'),   'fresh',   null, null, null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. TI-1 — a valid invitation grants the role, and only then
-- ---------------------------------------------------------------------------
do $$
declare
  v_r      jsonb;
  v_status jsonb;
  v_prog   uuid;
  v_prof   uuid;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000001","role":"authenticated"}',
    true
  );

  -- Before: an ordinary account, with no teacher access.
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-1 a brand-new account already had teacher access');

  set role authenticated;
  v_status := public.teacher_access_status();
  reset role;
  perform public.ti_assert(v_status ->> 'ok' = 'true' and v_status ->> 'verified' = 'false',
    'TI-1b the status screen did not report an unverified account: ' || coalesce(v_status::text, '?'));

  -- Redeem. Case and punctuation are cosmetic: this is a lowercase, spaced code.
  set role authenticated;
  v_r := public.redeem_teacher_invitation('  ti valid-code  ');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-1c a valid invitation was refused: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(v_r ->> 'verified' = 'true',
    'TI-1d a successful redemption did not report verification');
  perform public.ti_assert(public.has_teacher_access(),
    'TI-1e redeeming did not grant teacher access');

  -- The grant is recorded on the invitation, once, by the right account.
  perform public.ti_assert(
    (select count(*) from public.teacher_invitations
      where id = '035f0000-0000-4000-8000-0000000000e1'
        and lower(redeemed_by_auth) = '035f0000-0000-4000-8000-000000000001'
        and redeemed_at is not null) = 1,
    'TI-1f the redeemed invitation is not marked redeemed by the right account');

  -- The credential is the redeemed row, and nothing else: the declared sign-up
  -- type is deliberately left alone, so there is no second flag to drift out of
  -- step with it. This account declared nothing and still declared nothing.
  perform public.ti_assert(
    not exists (select 1 from public.signup_account_types
                 where auth_user_id = '035f0000-0000-4000-8000-000000000001'),
    'TI-1g redeeming wrote a declared account type as well as the credential');

  -- The point of the whole exercise: it can now start a program, as its director.
  set role authenticated;
  v_r := public.create_program('TI Verified Ensemble', 'TIV', 'TI Teacher', null, array['Flute']);
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-1h a verified teacher could not start a program: ' || coalesce(v_r ->> 'message', '?'));
  v_prog := (v_r ->> 'program_id')::uuid;
  select id into v_prof from public.profiles
   where auth_user_id = '035f0000-0000-4000-8000-000000000001';

  perform public.ti_assert(
    (select count(*) from public.memberships
      where user_id = v_prof and ensemble_id = v_prog and active
        and roles = '{director}'::public.app_role[]) = 1,
    'TI-1i the verified teacher is not the director of the program they made');
  perform public.ti_assert(
    (select count(*) from public.sections
      where ensemble_id = v_prog and name = 'Flute') = 1,
    'TI-1j the program was created without the instrument it was given');

  -- …and the audit trail says how they got there.
  perform public.ti_assert(
    exists (select 1 from public.audit_logs where action = 'teacher.invite_redeem'),
    'TI-1k redeeming an invitation was not audited');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 3. TI-2 — an invalid code grants nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v_r jsonb;
  v_ens_before int;
  v_ens_after int;
begin
  select count(*) into v_ens_before from public.ensembles;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000002","role":"authenticated"}',
    true
  );

  set role authenticated;
  v_r := public.redeem_teacher_invitation('NOT-A-REAL-CODE');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-2 an invalid code was accepted');
  perform public.ti_assert(coalesce(v_r ->> 'message', '') <> '',
    'TI-2b the refusal came with no message to show the person');
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-2c an invalid code granted teacher access');
  perform public.ti_assert(
    not exists (select 1 from public.signup_account_types
                 where auth_user_id = '035f0000-0000-4000-8000-000000000002'),
    'TI-2d an invalid code wrote an account type');
  perform public.ti_assert(
    not exists (select 1 from public.profiles
                 where auth_user_id = '035f0000-0000-4000-8000-000000000002'),
    'TI-2e an invalid code created a profile');

  set role authenticated;
  v_r := public.create_program('TI Invalid Code Program', null, 'TI Nobody');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-2f an unverified account started a program');

  select count(*) into v_ens_after from public.ensembles;
  perform public.ti_assert(v_ens_after = v_ens_before,
    'TI-2g a refused program creation still created a program');

  -- A blank code is not a special case that slips through.
  set role authenticated;
  v_r := public.redeem_teacher_invitation('   ');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-2h a blank code was accepted');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 4. TI-3 — a redeemed code cannot be reused
-- ---------------------------------------------------------------------------
do $$
declare
  v_r jsonb;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000002","role":"authenticated"}',
    true
  );

  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-VALID-CODE');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-3 a redeemed code was reused by a second account');
  perform public.ti_assert(coalesce(v_r ->> 'message', '') ilike '%already been used%',
    'TI-3b the reuse refusal did not say the code was used: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-3c the second account inherited access from the first');

  -- Still exactly one redemption, still the first account's.
  perform public.ti_assert(
    (select count(*) from public.teacher_invitations
      where id = '035f0000-0000-4000-8000-0000000000e1'
        and lower(redeemed_by_auth) = '035f0000-0000-4000-8000-000000000001') = 1,
    'TI-3d the redemption moved to a different account');

  -- The original holder is unaffected by somebody else's failed attempt.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000001","role":"authenticated"}',
    true
  );
  perform public.ti_assert(public.has_teacher_access(),
    'TI-3e a failed reuse attempt cost the real holder their access');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 5. TI-4 — the redemption is a single atomic statement
-- ---------------------------------------------------------------------------
-- The two-live-sessions race cannot be run inside one transaction, so it lives
-- in scripts/dev/check_teacher_invite_race.sh (two real connections, one code).
-- What this block pins down is the shape that makes that race safe: the guard is
-- inside the UPDATE's own predicate, and the database itself refuses a second
-- live redemption for one account.
do $$
declare
  v_def  text;
  v_pred text;
begin
  v_def := pg_get_functiondef('public.redeem_teacher_invitation(text)'::regprocedure);

  perform public.ti_assert(position('update public.teacher_invitations' in v_def) > 0,
    'TI-4 the redemption is not a single UPDATE');
  perform public.ti_assert(position('redeemed_at is null' in v_def) > 0,
    'TI-4b the redemption does not guard on redeemed_at being null');
  perform public.ti_assert(position('for update' in lower(v_def)) = 0,
    'TI-4c the redemption selects a row first instead of letting the UPDATE decide');
  perform public.ti_assert(position('revoked_at is null' in v_def) > 0,
    'TI-4d the redemption does not exclude revoked invitations');
  perform public.ti_assert(position('expires_at' in v_def) > 0,
    'TI-4e the redemption does not enforce expiry');
  perform public.ti_assert(position('intended_email' in v_def) > 0,
    'TI-4f the redemption does not enforce the email binding');
  perform public.ti_assert(position('unique_violation' in v_def) > 0,
    'TI-4g the redemption has no backstop for a racing second redemption');

  -- The database's own backstop: at most one *live* redemption per account (and
  -- per program, since 20261027120000), so even if the function's guard were
  -- bypassed, two accounts cannot both hold access from one code and one account
  -- cannot stack two.
  v_pred := pg_get_indexdef(to_regclass('public.teacher_invitations_one_live_redemption'));

  perform public.ti_assert(v_pred is not null,
    'TI-4h the one-live-redemption index is missing');
  perform public.ti_assert(v_pred ilike 'create unique index%',
    'TI-4i the one-live-redemption index is not unique: ' || coalesce(v_pred, '?'));
  perform public.ti_assert(v_pred ilike '%lower(redeemed_by_auth)%',
    'TI-4j the one-live-redemption index is not scoped to the account: ' || coalesce(v_pred, '?'));
  perform public.ti_assert(v_pred ilike '%coalesce(ensemble_id%',
    'TI-4j2 the one-live-redemption index does not count a program separately: ' || coalesce(v_pred, '?'));
  perform public.ti_assert(v_pred ilike '%revoked_at IS NULL%',
    'TI-4k the one-live-redemption index does not exempt revoked rows: ' || coalesce(v_pred, '?'));

  -- And the code itself is unique, so the same code cannot be issued twice into
  -- two rows with two different fates.
  v_pred := pg_get_indexdef(to_regclass('public.teacher_invitations_code_hash_key'));
  perform public.ti_assert(v_pred ilike 'create unique index%' and v_pred ilike '%code_hash%',
    'TI-4l the invitation code is not uniquely indexed: ' || coalesce(v_pred, '?'));
end $$;

-- ---------------------------------------------------------------------------
-- 6. TI-5 — a student cannot promote themselves
-- ---------------------------------------------------------------------------
do $$
declare
  v_student text := '035f0000-0000-4000-8000-000000000003';
  v_profile uuid := '035f0000-0000-4000-8000-0000000000c3';
  v_band    uuid;
  v_r       jsonb;
  v_state   text;
  v_seen    int;
begin
  select id into v_band from public.ensembles where slug = 'band';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_student, 'role', 'authenticated')::text,
    true
  );

  -- (a) Their own profile. There is no role column to edit, and the one column
  --     that is not self-service stays refused. Asserted on the *outcome*, so a
  --     policy that filters the row out counts as a refusal too.
  set role authenticated;
  update public.profiles set display_name = 'TI Student Renamed' where id = v_profile;
  begin
    update public.profiles set deactivated = true where id = v_profile;
  exception
    when others then null;  -- refused by the guard trigger; the outcome below decides
  end;
  reset role;

  perform public.ti_assert(
    (select deactivated from public.profiles where id = v_profile) = false,
    'TI-5 a student deactivated their own account through the profile table');

  -- (b) Their membership: no way to grant themselves a staff role. The guard
  --     trigger refuses it by raising, so the attempt is caught and the *state*
  --     is what gets asserted — a refusal and a filtered-out write both count.
  set role authenticated;
  begin
    update public.memberships set roles = '{director}'::public.app_role[]
     where user_id = v_profile and ensemble_id = v_band;
    v_state := 'WROTE';
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform public.ti_assert(v_state <> 'WROTE',
    'TI-5b-0 a student rewrote their own membership row (sqlstate ' || v_state || ')');

  perform public.ti_assert(
    (select roles from public.memberships
      where user_id = v_profile and ensemble_id = v_band) = '{student}'::public.app_role[],
    'TI-5b a student made themselves a director by editing memberships');

  -- (c) And they cannot buy a program either.
  set role authenticated;
  v_r := public.create_program('TI Student Program', null, 'TI Student');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-5c a student account started a program');

  -- (d) The credential tables. A client may not read them, let alone write a
  --     redeemed row for itself — this is a privilege denial, so 42501 exactly.
  set role authenticated;
  begin
    select count(*) into v_seen from public.teacher_invitations;
    v_state := 'READ';
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform public.ti_assert(v_state = '42501',
    'TI-5d a student could read the invitation table (sqlstate ' || v_state || ')');

  set role authenticated;
  begin
    insert into public.teacher_invitations (code_hash, redeemed_by_auth, redeemed_at)
    values ('ti-self-granted', v_student, now());
    v_state := 'WROTE';
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform public.ti_assert(v_state = '42501',
    'TI-5e a student inserted an invitation row directly (sqlstate ' || v_state || ')');

  set role authenticated;
  begin
    update public.teacher_invitations
       set redeemed_by_auth = v_student, redeemed_at = now()
     where id = '035f0000-0000-4000-8000-0000000000e6';
    v_state := 'WROTE';
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform public.ti_assert(v_state = '42501',
    'TI-5f a student marked an invitation redeemed for themselves (sqlstate ' || v_state || ')');
  perform public.ti_assert(
    not exists (select 1 from public.teacher_invitations
                 where code_hash = 'ti-self-granted'
                    or lower(redeemed_by_auth) = lower(v_student)),
    'TI-5g a denied write still landed an invitation row');

  -- (e) The client-facing setter still refuses too.
  set role authenticated;
  begin
    perform public.set_signup_account_type('teacher');
    v_state := 'WROTE';
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform public.ti_assert(v_state <> 'WROTE',
    'TI-5h an established student account reclassified itself as a teacher');

  -- Nothing moved: still a student, still no teacher access, still no staff role.
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-5i the student ended up with teacher access');
  perform public.ti_assert(
    not public.has_permission(v_band, 'program.manage_settings'),
    'TI-5j the student gained program.manage_settings');
  perform public.ti_assert(
    not public.has_permission(v_band, 'attendance.mark_present'),
    'TI-5k the student gained staff attendance rights');
  perform public.ti_assert(
    (select account_type from public.signup_account_types
      where auth_user_id = v_student) is null,
    'TI-5l the student ended up with a recorded account type');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 7. TI-6 — a teacher who signs in first redeems their code later
-- ---------------------------------------------------------------------------
-- The flow the brief asks for: sign in (or join as a student), do not have the
-- code yet, then enter it afterwards — on the same account, with no duplicate.
do $$
declare
  v_teacher text := '035f0000-0000-4000-8000-000000000004';
  v_profile uuid := '035f0000-0000-4000-8000-0000000000c4';
  v_r       jsonb;
  v_profiles int;
  v_prog    uuid;
  v_band    uuid;
begin
  select id into v_band from public.ensembles where slug = 'band';

  -- Their account already exists and already has a profile: they signed in
  -- before they had the invitation.
  insert into public.profiles (id, auth_user_id, full_name, display_name)
  values (v_profile, v_teacher, 'TI Late Teacher', 'TI Late Teacher')
  on conflict (id) do nothing;

  insert into public.memberships (user_id, ensemble_id, roles, active)
  values (v_profile, v_band, '{student}'::public.app_role[], true)
  on conflict (user_id, ensemble_id) do nothing;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text,
    true
  );

  set role authenticated;
  v_r := public.create_program('TI Too Early', null, 'TI Late Teacher');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-6 a signed-in-but-unverified teacher started a program early');
  perform public.ti_assert(coalesce(v_r ->> 'message', '') ilike '%invitation code%',
    'TI-6b the refusal did not point at the invitation code: ' || coalesce(v_r ->> 'message', '?'));

  -- They type a couple of wrong codes, then the right one: a mistake must not
  -- poison the account, and the success must reuse the *same* person.
  set role authenticated;
  perform public.redeem_teacher_invitation('TI-WRONG-CODE');
  perform public.redeem_teacher_invitation('TI-ALSO-WRONG');
  v_r := public.redeem_teacher_invitation('TI-LATE-CODE');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-6c redeeming later was refused after earlier mistakes: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(public.has_teacher_access(),
    'TI-6d redeeming later did not grant teacher access');

  -- No duplicate account: one profile, and the membership they already had is
  -- untouched — the code grants a *new* program, never a promotion inside
  -- somebody else's.
  select count(*) into v_profiles from public.profiles where auth_user_id = v_teacher;
  perform public.ti_assert(v_profiles = 1,
    'TI-6e redeeming later created a second profile (' || v_profiles || ')');
  perform public.ti_assert(
    (select count(*) from public.memberships where user_id = v_profile) = 1,
    'TI-6f redeeming later changed their existing memberships');
  perform public.ti_assert(
    (select roles from public.memberships where user_id = v_profile and ensemble_id = v_band)
      = '{student}'::public.app_role[],
    'TI-6g redeeming an invitation promoted them inside an existing program');
  perform public.ti_assert(
    not exists (select 1 from public.signup_account_types where auth_user_id = v_teacher),
    'TI-6h the late redemption wrote a declared account type as well as the credential');

  -- The audit entry names the person, because by now they had a profile.
  perform public.ti_assert(
    exists (select 1 from public.audit_logs
             where action = 'teacher.invite_redeem' and target_user_id = v_profile),
    'TI-6i the late redemption was not audited against the right person');

  -- And now the door opens.
  set role authenticated;
  v_r := public.create_program('TI Late Ensemble', null, null);
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-6j the verified teacher still could not start a program: ' || coalesce(v_r ->> 'message', '?'));
  v_prog := (v_r ->> 'program_id')::uuid;

  perform public.ti_assert(
    (select count(*) from public.memberships
      where user_id = v_profile and ensemble_id = v_prog
        and roles = '{director}'::public.app_role[]) = 1,
    'TI-6k the late-verified teacher is not the director of their new program');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 8. TI-7 — the student path still works, end to end
-- ---------------------------------------------------------------------------
-- Join with a join code, be checked in with a live code, and read your own
-- attendance. Nothing in 035 may have disturbed any of this.
do $$
declare
  v_prog    uuid;
  v_slug    text;
  v_code    text;
  v_event   uuid := '035f0000-0000-4000-8000-0000000000f7';
  v_r       jsonb;
  v_entry   text;
begin
  -- The program TI-1's verified teacher created: it has a join code of its own,
  -- so the student flow runs in a program this suite fully controls rather than
  -- depending on the restored band's history.
  select e.id, e.slug, coalesce(s.join_code, '')
    into v_prog, v_slug, v_code
    from public.ensembles e
    left join public.ensemble_settings s on s.ensemble_id = e.id
   where e.slug = 'ti-verified-ensemble';

  perform public.ti_assert(v_prog is not null and coalesce(v_code, '') <> '',
    'TI-7 the verified teacher''s program has no join code, so the student path cannot be exercised');

  -- A brand-new student joins with the code, exactly as before.
  perform set_config('request.jwt.claims', '{"sub":"ti-new-student","role":"authenticated"}', true);
  set role authenticated;
  v_r := public.join_program(v_slug, v_code, 'TI New Student', 'ti-ip-new');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-7b a student could not join with a valid join code: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(
    (select roles from public.memberships m
      join public.profiles p on p.id = m.user_id
     where p.auth_user_id = 'ti-new-student' and m.ensemble_id = v_prog)
      = '{student}'::public.app_role[],
    'TI-7c joining did not produce a plain student membership');

  -- A rehearsal that is running now, so check-in is open.
  insert into public.events (id, ensemble_id, name, type, event_type, date, checkin_mode, attendance_requirement)
  values (v_event, v_prog, 'TI Rehearsal', 'rehearsal', 'rehearsal',
          now() - interval '10 minutes', 'qr', 'required')
  on conflict (id) do nothing;

  -- The director opens a live check-in and hands over the code on screen.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000001","role":"authenticated"}',
    true
  );
  set role authenticated;
  v_r := public.start_checkin_session(v_event);
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-7d a director could not open a check-in session: ' || coalesce(v_r ->> 'message', '?'));
  v_entry := v_r ->> 'entry_code';

  -- The student checks in with it.
  perform set_config('request.jwt.claims', '{"sub":"ti-new-student","role":"authenticated"}', true);
  set role authenticated;
  v_r := public.record_attendance_by_code(v_entry);
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-7e a student could not check in: ' || coalesce(v_r ->> 'message', '?'));

  -- …and the mark is on the record, with the student's own percentage readable.
  perform public.ti_assert(
    exists (
      select 1 from public.attendance_records ar
      join public.profiles p on p.id = ar.student_id
     where ar.event_id = v_event
       and p.auth_user_id = 'ti-new-student'
       and ar.status = 'present'
    ),
    'TI-7f the check-in did not record a present mark');

  perform set_config('request.jwt.claims', '{"sub":"ti-new-student","role":"authenticated"}', true);
  set role authenticated;
  v_r := public.my_attendance_pct(v_prog);
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'true'
      and coalesce((v_r ->> 'percentage')::numeric, -1) between 0 and 100,
    'TI-7g the student''s own attendance percentage is unreadable: ' || coalesce(v_r::text, '?'));

  -- A student still cannot create a program, even after all of that.
  perform set_config('request.jwt.claims', '{"sub":"ti-new-student","role":"authenticated"}', true);
  set role authenticated;
  v_r := public.create_program('TI Student Must Not', null, null);
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-7h a student account created a program after joining');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 9. TI-8 — nobody unauthorized can create a program
-- ---------------------------------------------------------------------------
do $$
declare
  v_call   text;
  v_redeem text;
  v_status text;
  v_r      jsonb;
  v_before int;
begin
  select count(*) into v_before from public.ensembles;

  -- anon: not even callable, and nothing to learn from the endpoint.
  set role anon;
  begin
    perform public.create_program('TI Anon', null, null);
    v_call := 'CALLED';
  exception
    when others then v_call := sqlstate;
  end;
  begin
    perform public.redeem_teacher_invitation('TI-RACE-CODE');
    v_redeem := 'CALLED';
  exception
    when others then v_redeem := sqlstate;
  end;
  begin
    perform public.teacher_access_status();
    v_status := 'CALLED';
  exception
    when others then v_status := sqlstate;
  end;
  reset role;

  perform public.ti_assert(v_call = '42501',
    'TI-8 anon could call create_program (sqlstate ' || v_call || ')');
  perform public.ti_assert(v_redeem = '42501',
    'TI-8b anon could redeem an invitation (sqlstate ' || v_redeem || ')');
  perform public.ti_assert(v_status = '42501',
    'TI-8c anon could read teacher_access_status() (sqlstate ' || v_status || ')');

  -- Signed out entirely: refused, and nothing created.
  perform set_config('request.jwt.claims', '{}', true);
  set role authenticated;
  v_r := public.create_program('TI Signed Out', null, null);
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-8d a signed-out caller created a program');
  perform public.ti_assert(public.redeem_teacher_invitation('TI-RACE-CODE') ->> 'ok' = 'false',
    'TI-8e a signed-out caller redeemed an invitation');
  perform public.ti_assert(public.has_teacher_access() = false,
    'TI-8f a signed-out caller has teacher access');

  -- A revoked invitation grants nothing, even though it was issued and has not
  -- expired.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000008","role":"authenticated"}',
    true
  );
  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-REVOKED-CODE');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false' and not public.has_teacher_access(),
    'TI-8g a revoked invitation granted access');
  perform public.ti_assert(coalesce(v_r ->> 'message', '') ilike '%cancelled%',
    'TI-8h the revocation refusal did not say it was cancelled: ' || coalesce(v_r ->> 'message', '?'));

  set role authenticated;
  v_r := public.create_program('TI Revoked Program', null, null);
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-8i a revoked invitation still allowed a program to be created');

  perform public.ti_assert((select count(*) from public.ensembles) = v_before,
    'TI-8j a refused caller still created a program');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 10. TI-9 — email binding and expiry are enforced
-- ---------------------------------------------------------------------------
do $$
declare
  v_r jsonb;
begin
  -- The address bound to the invitation belongs to a different account than the
  -- one trying — and the caller *claims* the bound address in its token, which
  -- must change nothing: the address is read from Supabase Auth.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000002","role":"authenticated","email":"bound-teacher@example.invalid"}',
    true
  );
  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-BOUND-CODE');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-9 an email-bound invitation was redeemed by the wrong account');
  perform public.ti_assert(coalesce(v_r ->> 'message', '') ilike '%different email%',
    'TI-9b the binding refusal did not explain the mismatch: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-9c the wrong account gained access from a bound invitation');
  perform public.ti_assert(
    (select redeemed_at is null from public.teacher_invitations
      where id = '035f0000-0000-4000-8000-0000000000e2'),
    'TI-9d a refused binding still consumed the invitation');

  -- The account that actually holds the bound address can redeem it — and it
  -- works even though *its* token claims some other address.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000006","role":"authenticated","email":"whatever-i-claim@example.invalid"}',
    true
  );
  set role authenticated;
  v_r := public.redeem_teacher_invitation('ti bound code');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-9e the account holding the bound address could not redeem: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(
    (select lower(redeemed_email) from public.teacher_invitations
      where id = '035f0000-0000-4000-8000-0000000000e2') = 'bound-teacher@example.invalid',
    'TI-9f the redemption did not record the address it was redeemed with');

  -- Expiry, on a fresh account so the earlier refusals cannot be the reason.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000007","role":"authenticated"}',
    true
  );
  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-EXPIRED-CODE');
  reset role;

  perform public.ti_assert(v_r ->> 'ok' = 'false',
    'TI-9g an expired invitation was redeemed');
  perform public.ti_assert(coalesce(v_r ->> 'message', '') ilike '%expired%',
    'TI-9h the expiry refusal did not say it expired: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-9i an expired invitation granted access');
  perform public.ti_assert(
    (select redeemed_at is null from public.teacher_invitations
      where id = '035f0000-0000-4000-8000-0000000000e3'),
    'TI-9j a refused expiry still marked the invitation used');

  -- An unbound, unexpired invitation for the *same* account still works, so the
  -- refusals above really were about binding and expiry.
  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-RACE-CODE');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-9k a plain invitation was refused for an unrelated reason: ' || coalesce(v_r ->> 'message', '?'));
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 11. TI-10 — failed attempts are limited
-- ---------------------------------------------------------------------------
do $$
declare
  v_brute constant text := '035f0000-0000-4000-8000-000000000005';
  v_r     jsonb;
  i       int;
  v_count int;
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_brute, 'role', 'authenticated')::text,
    true
  );

  -- Five wrong guesses: each is refused, each is recorded.
  set role authenticated;
  for i in 1..5 loop
    v_r := public.redeem_teacher_invitation('TI-GUESS-' || i);
    perform public.ti_assert(v_r ->> 'ok' = 'false',
      'TI-10 guess ' || i || ' was accepted');
  end loop;
  reset role;

  select count(*) into v_count from public.teacher_invite_attempts
   where lower(auth_user_id) = lower(v_brute);
  perform public.ti_assert(v_count = 5,
    'TI-10b expected five recorded failures, found ' || v_count);

  -- The sixth attempt is refused *before* it looks at the code — so even a
  -- correct one cannot be used while the account is throttled.
  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-GUESS-6');
  reset role;
  perform public.ti_assert(v_r ->> 'rate_limited' = 'true',
    'TI-10c a sixth attempt was not rate-limited: ' || coalesce(v_r::text, '?'));

  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-FRESH-CODE');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'false' and v_r ->> 'rate_limited' = 'true',
    'TI-10d a throttled account redeemed a valid code');
  perform public.ti_assert(not public.has_teacher_access(),
    'TI-10e a throttled account gained access');
  perform public.ti_assert(
    (select redeemed_at is null from public.teacher_invitations
      where id = '035f0000-0000-4000-8000-0000000000e7'),
    'TI-10f a throttled attempt consumed the invitation anyway');

  -- The rate limit protects the *account*: the invitation is untouched, so the
  -- person it was issued to can still use it. Nobody else has to wait.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"035f0000-0000-4000-8000-000000000008","role":"authenticated"}',
    true
  );
  set role authenticated;
  v_r := public.redeem_teacher_invitation('TI-FRESH-CODE');
  reset role;
  perform public.ti_assert(v_r ->> 'ok' = 'true',
    'TI-10g the invitation was unusable after somebody else was throttled: '
      || coalesce(v_r ->> 'message', '?'));

  -- A failure is recorded without the code that was tried.
  perform public.ti_assert(
    not exists (
      select 1 from public.teacher_invite_attempts a
       where coalesce(a.auth_user_id, '') || coalesce(a.ip, '') ilike '%GUESS%'
    ),
    'TI-10h an attempt row contains the code that was tried');
  perform public.ti_assert(
    not exists (
      select 1 from public.teacher_invite_attempts a
       where coalesce(a.auth_user_id, '') || coalesce(a.ip, '') like '%TI-%'
    ),
    'TI-10i an attempt row contains invitation material');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 12. Teardown
-- ---------------------------------------------------------------------------
rollback;

select 'TEACHER INVITATIONS PASSED' as verification_result;
