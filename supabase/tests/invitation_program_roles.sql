-- ============================================================================
-- invitation_program_roles.sql — a code that also joins a roster
-- ============================================================================
-- requires-table: public.teacher_invitations
--
-- Covers 20261027120000, the extension of the 035 staff credential: a system
-- administrator can issue one single-use code that both verifies a teacher and
-- puts them on a named program's roster with a named role, and the list keeps
-- who redeemed each code.
--
--   IR-1   an administrator issues a program+role code; the list shows the
--          program, the role and the state, and never the code
--   IR-2   a program director cannot issue, read or revoke invitations
--   IR-3   redeeming it grants teacher access, creates the profile if there was
--          none, adds the membership with the role, and records who used it
--   IR-4   the code is spent by that: a second account is refused, and nothing
--          is granted twice
--   IR-5   a custom role is granted through user_role_assignments, beside the
--          student membership the person already had
--   IR-6   a plain teacher code (no program) still joins nobody
--   IR-7   a code never re-activates a membership a director removed, and is
--          not spent by the refusal
--   IR-8   system administrator access can be neither issued nor redeemed
--   IR-9   an expired program code grants nothing
--   IR-10  one account can hold a live invitation per program, so a second
--          program follows the first; a second *registration* code is a no-op
--
-- Runs in ONE transaction and ROLLS BACK. Personas authenticate the way
-- PostgREST sees a Supabase Auth token (migration 021); accounts whose code can
-- be email-bound hold a real `auth.users` row, because the address is read from
-- Supabase Auth and never from anything the client sends.
--
-- On success it prints: INVITATION PROGRAM ROLES PASSED
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Assertion helper
-- ---------------------------------------------------------------------------
create or replace function public.ir_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if condition is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
end;
$$;
grant execute on function public.ir_assert(boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 0b. Prerequisites — fail fast, and name what is missing
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.redeem_teacher_invitation(text)') is null then
    raise exception 'FAIL: IR-0 redeem_teacher_invitation() missing — apply 035 first';
  end if;
  if to_regprocedure('public.configure_teacher_invitation(text, text, text, timestamptz, uuid, uuid)') is null then
    raise exception 'FAIL: IR-0 configure_teacher_invitation() has no program/role arguments — apply 20261027120000';
  end if;
  if to_regclass('public.teacher_invitations_one_live_redemption') is null then
    raise exception 'FAIL: IR-0 the per-program live-redemption index is missing — apply 20261027120000';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'teacher_invitations'
                    and column_name = 'ensemble_id') then
    raise exception 'FAIL: IR-0 teacher_invitations.ensemble_id is missing — apply 20261027120000';
  end if;
  if not exists (select 1 from public.ensembles where slug = 'band') then
    raise exception 'FAIL: IR-0 the band program is missing — apply 014 first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Fixtures (as the owner, rolled back at the end)
-- ---------------------------------------------------------------------------
-- A second program, so the per-program index has something to distinguish.
insert into public.ensembles (id, slug, name, short_name, active)
values ('1a000000-0000-4000-8000-0000000000a2', 'ir-second', 'IR Second Program', 'IR Two', true)
on conflict (slug) do nothing;

-- Accounts that redeem: real auth rows, because email binding and the audit
-- trail both read the address from Supabase Auth.
--
--   ...0001  the administrator
--   ...0002  a band director (not a system administrator)
--   ...0003  a brand-new invitee with no profile at all
--   ...0004  an existing band student (custom-role invitation)
--   ...0005  a plain teacher-code invitee
--   ...0006  a student a director has removed
--   ...0007  somebody handed a forged system-admin code
insert into auth.users (id, aud, role, email, created_at, updated_at, raw_user_meta_data) values
  ('1a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'ir-admin@example.invalid', now(), now(), '{"full_name":"IR Administrator"}'::jsonb),
  ('1a000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'ir-director@example.invalid', now(), now(), '{"full_name":"IR Director"}'::jsonb),
  ('1a000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'invitee-one@example.invalid', now(), now(), '{"full_name":"IR Invitee One"}'::jsonb),
  ('1a000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated',
   'ir-student@example.invalid', now(), now(), '{"full_name":"IR Student"}'::jsonb),
  ('1a000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
   'ir-plain-teacher@example.invalid', now(), now(), '{"full_name":"IR Plain Teacher"}'::jsonb),
  ('1a000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
   'ir-removed@example.invalid', now(), now(), '{"full_name":"IR Removed"}'::jsonb),
  ('1a000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated',
   'ir-forger@example.invalid', now(), now(), '{"full_name":"IR Forger"}'::jsonb)
on conflict (id) do nothing;

insert into public.profiles (id, auth_user_id, full_name, display_name) values
  ('1a000000-0000-4000-8000-0000000000c1', '1a000000-0000-4000-8000-000000000001',
   'IR Administrator', 'IR Administrator'),
  ('1a000000-0000-4000-8000-0000000000c2', '1a000000-0000-4000-8000-000000000002',
   'IR Director', 'IR Director'),
  ('1a000000-0000-4000-8000-0000000000c4', '1a000000-0000-4000-8000-000000000004',
   'IR Student', 'IR Student'),
  ('1a000000-0000-4000-8000-0000000000c6', '1a000000-0000-4000-8000-000000000006',
   'IR Removed', 'IR Removed')
on conflict (id) do nothing;

insert into public.memberships (user_id, ensemble_id, roles, active)
select '1a000000-0000-4000-8000-0000000000c2'::uuid, e.id, '{director}'::public.app_role[], true
  from public.ensembles e where e.slug = 'band'
on conflict (user_id, ensemble_id) do nothing;

insert into public.memberships (user_id, ensemble_id, roles, active)
select '1a000000-0000-4000-8000-0000000000c4'::uuid, e.id, '{student}'::public.app_role[], true
  from public.ensembles e where e.slug = 'band'
on conflict (user_id, ensemble_id) do nothing;

-- A student a director removed: the membership exists, paused. An invitation
-- must not quietly undo that decision.
insert into public.memberships (user_id, ensemble_id, roles, active)
select '1a000000-0000-4000-8000-0000000000c6'::uuid, e.id, '{student}'::public.app_role[], false
  from public.ensembles e where e.slug = 'band'
on conflict (user_id, ensemble_id) do nothing;

-- The system administrator: a program_admins row and no roster membership.
insert into public.program_admins (user_id) values ('1a000000-0000-4000-8000-0000000000c1')
on conflict (user_id) do nothing;

-- A custom role in band that a director could delegate — one capability, so the
-- grant is checkable through has_permission().
insert into public.roles (id, key, ensemble_id, name, description, scope, is_system, active)
select '1a000000-0000-4000-8000-0000000000f1', null, e.id,
       'IR Roster Reader', 'Reads the roster and the program attendance.', 'program', false, true
  from public.ensembles e where e.slug = 'band'
on conflict (id) do nothing;

insert into public.role_permissions (role_id, permission)
values ('1a000000-0000-4000-8000-0000000000f1', 'attendance.view_program')
on conflict (role_id, permission) do nothing;

-- The three codes this suite issues through the RPC have no fixtures; the forged
-- system-admin code can only be created by hand, because the RPC refuses one.
insert into public.teacher_invitations (id, code_hash, label, ensemble_id, role_id, expires_at)
select '1a000000-0000-4000-8000-0000000000e9',
       public.invitation_code_hash('IR FORGED ADMIN CODE'),
       'forged system admin',
       e.id,
       (select r.id from public.roles r where r.key = 'system_admin'),
       now() + interval '7 days'
  from public.ensembles e where e.slug = 'band'
on conflict (id) do nothing;

-- Expired program invitation, inserted directly: configure() refuses a past date.
insert into public.teacher_invitations (id, code_hash, label, ensemble_id, role_id, expires_at)
select '1a000000-0000-4000-8000-0000000000ea',
       public.invitation_code_hash('IR EXPIRED STAFF CODE'),
       'expired staff code',
       e.id,
       (select r.id from public.roles r where r.key = 'secretary'),
       now() - interval '1 hour'
  from public.ensembles e where e.slug = 'band'
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. IR-1 — an administrator issues a program + role code, and sees it listed
-- ---------------------------------------------------------------------------
do $$
declare
  v_band     uuid;
  v_director uuid;
  v_r        jsonb;
  v_list     jsonb;
  v_entry    jsonb;
  v_row      public.teacher_invitations%rowtype;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_director from public.roles where key = 'director';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.configure_teacher_invitation(
    'IR DIRECTOR CODE',
    'IR new director',
    'invitee-one@example.invalid',
    now() + interval '14 days',
    v_band,
    v_director
  );
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-1 an administrator could not issue a program invitation: ' || coalesce(v_r ->> 'message', '?'));

  select * into v_row from public.teacher_invitations
   where code_hash = public.invitation_code_hash('IR DIRECTOR CODE');

  perform public.ir_assert(v_row.id is not null,
    'IR-1b the issued invitation was not written');
  perform public.ir_assert(v_row.ensemble_id = v_band and v_row.role_id = v_director,
    'IR-1c the invitation did not keep the program and role it was issued for');
  perform public.ir_assert(v_row.code_hash <> 'IR DIRECTOR CODE',
    'IR-1d the code was stored in plaintext');

  set role authenticated;
  v_list := public.list_teacher_invitations();
  reset role;

  perform public.ir_assert(v_list ->> 'ok' = 'true',
    'IR-1e the administrator could not list invitations: ' || coalesce(v_list ->> 'message', '?'));

  select entry into v_entry
    from jsonb_array_elements(v_list -> 'invitations') entry
   where entry ->> 'id' = v_row.id::text;

  perform public.ir_assert(v_entry ->> 'status' = 'available',
    'IR-1f a fresh invitation is not listed as available: ' || coalesce(v_entry::text, 'missing'));
  perform public.ir_assert(v_entry ->> 'program_name' = (select name from public.ensembles where id = v_band),
    'IR-1g the listing does not name the program: ' || coalesce(v_entry::text, 'missing'));
  perform public.ir_assert(v_entry ->> 'role_name' = 'Director',
    'IR-1h the listing does not name the role: ' || coalesce(v_entry::text, 'missing'));
  perform public.ir_assert(v_entry ? 'code' = false and v_entry ? 'code_hash' = false,
    'IR-1i the listing leaks code material');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 3. IR-2 — a program director is not a system administrator
-- ---------------------------------------------------------------------------
do $$
declare
  v_band uuid;
  v_role uuid;
  v_r    jsonb;
  v_victim uuid := '1a000000-0000-4000-8000-0000000000e9';
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_role from public.roles where key = 'director';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.configure_teacher_invitation('IR DIRECTOR COPY', 'nope', null, null, v_band, v_role);
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-2 a program director issued an invitation');

  set role authenticated;
  v_r := public.list_teacher_invitations();
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-2b a program director read the invitation list');

  set role authenticated;
  v_r := public.revoke_teacher_invitation(v_victim);
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-2c a program director cancelled an invitation');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 4. IR-3 — redeeming it verifies the account *and* joins the roster
-- ---------------------------------------------------------------------------
do $$
declare
  v_band     uuid;
  v_director uuid;
  v_profile  uuid;
  v_r        jsonb;
  v_list     jsonb;
  v_entry    jsonb;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_director from public.roles where key = 'director';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

  -- No profile yet: the invitation is what makes them a person on this roster.
  perform public.ir_assert(public.current_profile_id() is null,
    'IR-3 the invitee already had a profile');

  set role authenticated;
  v_r := public.redeem_teacher_invitation('  ir-director-code  ');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-3b a valid staff invitation was refused: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(v_r ->> 'verified' = 'true',
    'IR-3c redeeming did not verify the account');
  perform public.ir_assert(v_r ->> 'joined' = 'true',
    'IR-3d redeeming did not report the roster place');
  perform public.ir_assert(v_r ->> 'program_name' = (select name from public.ensembles where id = v_band)
                           and v_r ->> 'role_name' = 'Director',
    'IR-3e the answer does not name the program and role: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(public.has_teacher_access(),
    'IR-3f redeeming did not grant teacher access');

  select id into v_profile from public.profiles
   where auth_user_id = '1a000000-0000-4000-8000-000000000003';

  perform public.ir_assert(v_profile is not null,
    'IR-3g redeeming a roster invitation did not create the profile');
  perform public.ir_assert(
    (select count(*) from public.memberships
      where user_id = v_profile and ensemble_id = v_band and active
        and 'director'::public.app_role = any (roles)) = 1,
    'IR-3h the redeemer is not an active director of the program');
  perform public.ir_assert(
    (select redeemed_by_auth from public.teacher_invitations
      where code_hash = public.invitation_code_hash('IR DIRECTOR CODE'))
      = '1a000000-0000-4000-8000-000000000003',
    'IR-3i the invitation does not record who redeemed it');
  perform public.ir_assert(
    (select redeemed_email from public.teacher_invitations
      where code_hash = public.invitation_code_hash('IR DIRECTOR CODE'))
      = 'invitee-one@example.invalid',
    'IR-3j the invitation does not record the address that redeemed it');

  -- The administrator's list is where "who used that code" is answered.
  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  set role authenticated;
  v_list := public.list_teacher_invitations();
  reset role;

  select entry into v_entry
    from jsonb_array_elements(v_list -> 'invitations') entry
   where entry ->> 'label' = 'IR new director';

  perform public.ir_assert(v_entry ->> 'status' = 'redeemed',
    'IR-3k a used invitation is not listed as used: ' || coalesce(v_entry::text, 'missing'));
  perform public.ir_assert(v_entry ->> 'redeemed_by_name' = 'IR Invitee One',
    'IR-3l the listing does not name the person who used the code: ' || coalesce(v_entry::text, 'missing'));
  perform public.ir_assert(v_entry ->> 'redeemed_email' = 'invitee-one@example.invalid',
    'IR-3m the listing does not show the address that used the code');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 5. IR-4 — the code is spent: a second account gets nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v_band    uuid;
  v_r       jsonb;
  v_profile uuid;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_profile from public.profiles
   where auth_user_id = '1a000000-0000-4000-8000-000000000004';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000004","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR DIRECTOR CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-4 a spent code was redeemed a second time');
  perform public.ir_assert(v_r ->> 'message' ilike '%already been used%',
    'IR-4b a spent code did not say so: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(not public.has_teacher_access(),
    'IR-4c a second account gained teacher access from a spent code');
  perform public.ir_assert(
    (select roles from public.memberships where user_id = v_profile and ensemble_id = v_band)
      = '{student}'::public.app_role[],
    'IR-4d a second account had its roles changed by a spent code');
  perform public.ir_assert(
    (select count(*) from public.teacher_invitations
      where code_hash = public.invitation_code_hash('IR DIRECTOR CODE')
        and redeemed_at is not null) = 1,
    'IR-4e the spent code is marked redeemed more than once');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 6. IR-5 — a custom role joins beside the membership the person already had
-- ---------------------------------------------------------------------------
do $$
declare
  v_band    uuid;
  v_role    uuid;
  v_admin   uuid := '1a000000-0000-4000-8000-0000000000c1';
  v_profile uuid := '1a000000-0000-4000-8000-0000000000c4';
  v_r       jsonb;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_role from public.roles where id = '1a000000-0000-4000-8000-0000000000f1';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.configure_teacher_invitation(
    'IR CUSTOM ROLE CODE', 'IR roster reader', 'ir-student@example.invalid',
    now() + interval '7 days', v_band, v_role
  );
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-5 the administrator could not issue a custom-role invitation: ' || coalesce(v_r ->> 'message', '?'));

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000004","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR CUSTOM ROLE CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-5b a custom-role invitation was refused: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(v_r ->> 'role_name' = 'IR Roster Reader',
    'IR-5c the answer did not name the custom role');
  perform public.ir_assert(
    (select roles from public.memberships where user_id = v_profile and ensemble_id = v_band)
      = '{student}'::public.app_role[],
    'IR-5d a custom role rewrote the system roles array');
  perform public.ir_assert(
    (select count(*) from public.user_role_assignments
      where user_id = v_profile and ensemble_id = v_band and role_id = v_role
        and revoked_at is null and granted_by = v_admin) = 1,
    'IR-5e the custom role was not granted, or not attributed to the inviter');
  perform public.ir_assert(
    public.has_permission(v_band, 'attendance.view_program'),
    'IR-5f the custom role grants nothing it was given');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 7. IR-6 — a plain teacher code still joins nobody
-- ---------------------------------------------------------------------------
do $$
declare
  v_r       jsonb;
  v_profile uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.configure_teacher_invitation(
    'IR PLAIN TEACHER CODE', 'IR plain teacher', 'ir-plain-teacher@example.invalid',
    now() + interval '7 days', null, null
  );
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-6 the administrator could not issue a plain code: ' || coalesce(v_r ->> 'message', '?'));

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000005","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR PLAIN TEACHER CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'true' and v_r ->> 'verified' = 'true',
    'IR-6b a plain teacher code was refused: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(v_r ->> 'joined' = 'false',
    'IR-6c a plain teacher code reported a roster place');

  select id into v_profile from public.profiles
   where auth_user_id = '1a000000-0000-4000-8000-000000000005';
  perform public.ir_assert(v_profile is null,
    'IR-6d a plain teacher code created a profile and joined somebody');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 8. IR-7 — a director's removal is not undone, and the code survives
-- ---------------------------------------------------------------------------
do $$
declare
  v_band uuid;
  v_role uuid;
  v_r    jsonb;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_role from public.roles where key = 'director';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.configure_teacher_invitation(
    'IR REMOVED CODE', 'IR removed member', 'ir-removed@example.invalid',
    now() + interval '7 days', v_band, v_role
  );
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-7 the administrator could not issue the code: ' || coalesce(v_r ->> 'message', '?'));

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000006","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR REMOVED CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-7b a removed member rejoined with a code');
  perform public.ir_assert(v_r ->> 'message' ilike '%removed you%',
    'IR-7c the refusal does not explain the removal: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(
    (select not active from public.memberships
      where user_id = '1a000000-0000-4000-8000-0000000000c6' and ensemble_id = v_band),
    'IR-7d the paused membership was reactivated');
  perform public.ir_assert(
    (select redeemed_at is null from public.teacher_invitations
      where code_hash = public.invitation_code_hash('IR REMOVED CODE')),
    'IR-7e the refusal still spent the code');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 9. IR-8 — system administrator access is neither issuable nor redeemable
-- ---------------------------------------------------------------------------
do $$
declare
  v_band      uuid;
  v_sysadmin  uuid;
  v_r         jsonb;
begin
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_sysadmin from public.roles where key = 'system_admin';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.configure_teacher_invitation(
    'IR SYSTEM ADMIN CODE', 'nope', null, null, v_band, v_sysadmin
  );
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-8 the administrator could issue a system-admin invitation');

  -- Even a row that got into the table by hand cannot be redeemed.
  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000007","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR FORGED ADMIN CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-8b a forged system-admin code was redeemed');
  perform public.ir_assert(not public.has_teacher_access(),
    'IR-8c a forged system-admin code granted access');
  perform public.ir_assert(
    (select redeemed_at is null from public.teacher_invitations
      where id = '1a000000-0000-4000-8000-0000000000e9'),
    'IR-8d a refused forged code was marked used');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 10. IR-9 — an expired program code grants nothing
-- ---------------------------------------------------------------------------
do $$
declare
  v_band uuid;
  v_r    jsonb;
begin
  select id into v_band from public.ensembles where slug = 'band';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000004","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR EXPIRED STAFF CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'false',
    'IR-9 an expired staff code was redeemed');
  perform public.ir_assert(v_r ->> 'message' ilike '%expired%',
    'IR-9b an expired code did not say so: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(
    (select roles from public.memberships
      where user_id = '1a000000-0000-4000-8000-0000000000c4' and ensemble_id = v_band)
      = '{student}'::public.app_role[],
    'IR-9c an expired code changed a membership');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 11. IR-10 — one live invitation per program, and a second plain code is a no-op
-- ---------------------------------------------------------------------------
do $$
declare
  v_second  uuid;
  v_band    uuid;
  v_role    uuid;
  v_profile uuid;
  v_r       jsonb;
  v_plain   jsonb;
begin
  select id into v_second from public.ensembles where slug = 'ir-second';
  select id into v_band from public.ensembles where slug = 'band';
  select id into v_role from public.roles where key = 'secretary';
  -- The profile IR-3 created when this account first redeemed a code.
  select id into v_profile from public.profiles
   where auth_user_id = '1a000000-0000-4000-8000-000000000003';

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

  -- The same person who already redeemed a band invitation can be invited to a
  -- second program: the unique index counts each program separately.
  set role authenticated;
  v_r := public.configure_teacher_invitation(
    'IR SECOND PROGRAM CODE', 'IR second program', 'invitee-one@example.invalid',
    now() + interval '7 days', v_second, v_role
  );
  reset role;
  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-10 the administrator could not issue a second-program invitation: ' || coalesce(v_r ->> 'message', '?'));

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR SECOND PROGRAM CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'true',
    'IR-10b an already-verified teacher could not join a second program: ' || coalesce(v_r ->> 'message', '?'));
  perform public.ir_assert(v_r ->> 'program_name' = 'IR Second Program',
    'IR-10c the second program was not reported');
  perform public.ir_assert(
    (select count(*) from public.memberships m
      join public.ensembles e on e.id = m.ensemble_id
     where m.user_id = v_profile
       and e.slug = 'ir-second' and m.active
       and 'secretary'::public.app_role = any (m.roles)) = 1,
    'IR-10d the second program membership was not created with its role');

  -- A second *registration* code adds nothing: the account already has the
  -- credential, so it is answered without being spent.
  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  set role authenticated;
  v_plain := public.configure_teacher_invitation(
    'IR SPARE TEACHER CODE', 'IR spare', null, null, null, null
  );
  reset role;
  perform public.ir_assert(v_plain ->> 'ok' = 'true',
    'IR-10e the spare registration code could not be issued');

  perform set_config('request.jwt.claims',
    '{"sub":"1a000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
  set role authenticated;
  v_r := public.redeem_teacher_invitation('IR SPARE TEACHER CODE');
  reset role;

  perform public.ir_assert(v_r ->> 'ok' = 'true' and v_r ->> 'verified' = 'true',
    'IR-10f an already-verified account was refused a spare registration code');
  perform public.ir_assert(
    (select redeemed_at is null from public.teacher_invitations
      where code_hash = public.invitation_code_hash('IR SPARE TEACHER CODE')),
    'IR-10g a registration code given to an already-verified account was spent');
  perform public.ir_assert(
    (select count(*) from public.memberships
      where user_id = v_profile and ensemble_id = v_band) = 1,
    'IR-10h the spare registration code added a second band membership');
end $$;
select set_config('request.jwt.claims', '{}', true);

-- ---------------------------------------------------------------------------
-- 12. The catalog is unchanged to a client
-- ---------------------------------------------------------------------------
do $$
begin
  perform public.ir_assert(
    not has_table_privilege('authenticated', 'public.teacher_invitations', 'SELECT')
    and not has_table_privilege('authenticated', 'public.teacher_invitations', 'UPDATE'),
    'IR-11 authenticated can reach the invitation table directly');
end $$;

rollback;

\echo INVITATION PROGRAM ROLES PASSED
