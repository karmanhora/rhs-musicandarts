-- ============================================================================
-- RHS Music Platform — Invitations that also put somebody on a roster
-- ============================================================================
-- Idempotent — create or replace / add column if not exists; safe to re-run.
--
-- WHY
--   Migration 035 made a redeemed invitation the teacher credential: it proves
--   the account may teach here, and `create_program()` asks for it. But it could
--   only ever do that. A system administrator had no way to invite a director or
--   a teacher *into an existing program*: the invitee still had to be added to
--   the roster by somebody already in it, and then given a role by hand.
--
--   The owner asked (2026-10-25) for exactly that: one code, issued by the
--   administrator, that both verifies the person and places them on a program's
--   roster with a named role — and a record of who used it.
--
-- WHAT THIS ADDS
--   1. `teacher_invitations.ensemble_id` and `.role_id` — optional. A row with
--      neither is the 035 registration code, unchanged; a row with both is a
--      staff invitation for one program.
--   2. A unique index that allows one live redemption per (account, program)
--      instead of one per account, so the same teacher can be invited to a
--      second program without a second account. A registration code (no
--      program) keeps the old "one live redemption per account" rule.
--   3. `configure_teacher_invitation()` gains `p_ensemble_id` and `p_role_id`,
--      validates them, and refuses `system_admin`.
--   4. `redeem_teacher_invitation()` grants the program membership and the role
--      in the same atomic redemption, after checking the program and role are
--      still usable — a broken invitation is refused *without* being spent.
--   5. `list_teacher_invitations()` answers with the program, the role, and the
--      name and address of whoever redeemed each code.
--
-- WHAT DOES NOT CHANGE
--   Access is still `has_teacher_access()`, derived from redeemed rows; nothing
--   is cached and nothing is written on the account. Issuing remains gated on
--   `is_program_admin()` — a system administrator, never a program director.
--   A code is still hashed on arrival and cannot be read back. A director's
--   removal still stands: an invitation never re-activates a paused membership.
--
-- THE TWO GUARD EXCEPTIONS. `guard_membership_change` and
-- `guard_user_role_assignment` both refuse a self role change, and redeeming is a
-- person changing their own membership. The function sets a transaction-local
-- flag (`rhs.invitation_grant`) around those writes; no client can set a GUC
-- (PostgREST runs no SET for a caller and no RPC exposes `set_config`). The
-- membership guard allows the write only while adding a role — never while
-- removing one or flipping access — and the assignment guard still insists on a
-- real, active custom role of that program.
--
-- ROLLBACK
--   Restore the earlier bodies of `configure_teacher_invitation`,
--   `redeem_teacher_invitation` and `list_teacher_invitations` from
--   `035_teacher_invitations.sql`, and of `guard_membership_change` and
--   `guard_user_role_assignment` from `015_ensemble_policies.sql` and
--   `029_roles_and_permissions.sql`, then:
--     drop index if exists public.teacher_invitations_one_live_redemption;
--     create unique index teacher_invitations_one_per_account
--       on public.teacher_invitations (lower(redeemed_by_auth))
--       where redeemed_at is not null and revoked_at is null;
--     alter table public.teacher_invitations
--       drop column if exists role_id,
--       drop column if exists ensemble_id;
--   Dropping the columns is safe: they are optional attributes of new rows, not
--   a rewrite of the roster or of any redemption already recorded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A code may name a program and a role
-- ---------------------------------------------------------------------------
alter table public.teacher_invitations
  add column if not exists ensemble_id uuid references public.ensembles(id) on delete cascade,
  add column if not exists role_id     uuid references public.roles(id)     on delete cascade;

comment on column public.teacher_invitations.ensemble_id is
  'The program this code also puts the redeemer on. Null for a 035 registration code.';
comment on column public.teacher_invitations.role_id is
  'The role the redeemer is given on that program''s roster. Null for a 035 registration code.';

-- One live redemption per account *per program*. `coalesce` is what lets a
-- NULL program (a registration code) keep the old one-per-account rule while a
-- program invitation is counted separately.
drop index if exists public.teacher_invitations_one_per_account;
create unique index if not exists teacher_invitations_one_live_redemption
  on public.teacher_invitations (
    lower(redeemed_by_auth),
    coalesce(ensemble_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where redeemed_at is not null and revoked_at is null;

comment on index public.teacher_invitations_one_live_redemption is
  'At most one live redemption per account per program (a registration code is its own bucket), so a second code cannot stack and a program invitation can follow a registration one.';

-- ---------------------------------------------------------------------------
-- 2. The one guard exception: a redeemed invitation adding a role
-- ---------------------------------------------------------------------------
create or replace function public.guard_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_profile_id();
begin
  if new.roles      is not distinct from old.roles
     and new.section_id is not distinct from old.section_id
     and new.active   is not distinct from old.active then
    return new;
  end if;

  -- No `sub` claim: service role / migration context (edge functions, imports,
  -- backfills). Those paths are already trusted and RLS-checked.
  if v_actor is null then
    return new;
  end if;

  -- A redeemed staff invitation is the *administrator's* decision recorded on a
  -- single-use row, not a self-promotion: `redeem_teacher_invitation()` sets
  -- this transaction-local flag around the one UPDATE that adds the invited
  -- role, and nothing else ever sets it. It permits an addition only — never a
  -- removal, never an access flip.
  if current_setting('rhs.invitation_grant', true) = 'on'
     and new.active is not distinct from old.active
     and old.roles <@ new.roles then
    return new;
  end if;

  -- A person may change their own section (that is self-service), never their
  -- own roles or access. This branch must come FIRST: a student is not a
  -- director of their program, so checking `can_manage_ensemble` before it
  -- would refuse the one self-service change we do allow
  -- (`set_member_section` with p_member_id = the caller).
  if old.user_id = v_actor then
    if new.roles is distinct from old.roles or new.active is distinct from old.active then
      raise exception 'You cannot change your own roles or access.';
    end if;
    return new;
  end if;

  if not public.can_manage_ensemble(old.ensemble_id) then
    raise exception 'Only directors of this program can change roles, sections or membership status.';
  end if;

  if public.is_director_anywhere(old.user_id) and not public.is_program_admin() then
    raise exception 'Directors cannot change another director''s membership.';
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 2b. The same exception for a custom role's assignment row
-- ---------------------------------------------------------------------------
-- A custom role is granted through `user_role_assignments`, whose guard refuses
-- a self-assignment and then checks the *actor's* authority to delegate. On a
-- redemption the actor is the redeemer, and the authority is the administrator's
-- (recorded on the invitation), so the flag allows the row — while still
-- insisting it names a real, active custom role of that program.
create or replace function public.guard_user_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_profile_id();
  v_bad   text;
begin
  -- Service role / migration context (no `sub` claim): already trusted.
  if v_actor is null then
    return new;
  end if;

  if new.user_id = v_actor then
    if current_setting('rhs.invitation_grant', true) <> 'on' then
      raise exception 'You cannot assign a role to yourself.';
    end if;

    -- A single-use staff invitation, issued by a system administrator: the
    -- role is theirs to choose, so the redeemer need not hold it. What it may
    -- not be is a system role, an inactive role, or another program's role.
    if not exists (
      select 1 from public.roles r
       where r.id = new.role_id
         and r.active
         and r.is_system = false
         and r.ensemble_id = new.ensemble_id
    ) then
      raise exception 'That role is not available in this program.';
    end if;

    return new;
  end if;

  if not public.has_permission(new.ensemble_id, 'roles.assign') then
    raise exception 'You are not authorized to assign roles in this program.';
  end if;

  if not exists (
    select 1 from public.roles r
     where r.id = new.role_id
       and r.active
       and r.is_system = false
       and r.ensemble_id = new.ensemble_id
  ) then
    raise exception 'That role is not available in this program.';
  end if;

  -- Only delegable capabilities, and only ones the actor already holds.
  select string_agg(rp.permission, ', ')
    into v_bad
    from public.role_permissions rp
    join public.permissions p on p.code = rp.permission
   where rp.role_id = new.role_id
     and (not p.delegable or not public.has_permission(new.ensemble_id, rp.permission));

  if v_bad is not null then
    raise exception 'You cannot delegate these capabilities: %', v_bad;
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Issuing: the administrator names a program and a role, or neither
-- ---------------------------------------------------------------------------
-- The four-argument signature is replaced rather than overloaded: two functions
-- that differ only by defaulted arguments make a four-argument call ambiguous
-- for PostgREST. Nothing in the app called the old one (it had no screen), and
-- the SQL in docs/TEACHER_VERIFICATION.md §5 is updated with this migration.
drop function if exists public.configure_teacher_invitation(text, text, text, timestamptz);

create or replace function public.configure_teacher_invitation(
  p_code           text,
  p_label          text default '',
  p_intended_email text default null,
  p_expires_at     timestamptz default null,
  p_ensemble_id    uuid default null,
  p_role_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash       text := public.invitation_code_hash(p_code);
  v_actor      uuid := public.current_profile_id();
  v_email      text := nullif(lower(btrim(coalesce(p_intended_email, ''))), '');
  v_id         uuid;
  v_state      public.teacher_invitations%rowtype;
  v_ens_name   text;
  v_ens_active boolean;
  v_role       public.roles%rowtype;
begin
  if not public.is_program_admin() then
    return jsonb_build_object('ok', false, 'message', 'Only a system administrator can issue teacher invitations.');
  end if;

  if v_hash is null or length(public.normalize_invitation_code(p_code)) < 8 then
    return jsonb_build_object('ok', false, 'message', 'Give the invitation a code of at least 8 letters or digits.');
  end if;

  if v_email is not null and position('@' in v_email) < 2 then
    return jsonb_build_object('ok', false, 'message', 'That does not look like an email address.');
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    return jsonb_build_object('ok', false, 'message', 'That expiry date is in the past.');
  end if;

  -- Both or neither. A program with no role would silently make the person a
  -- student, and a role with no program has nothing to grant it on.
  if (p_ensemble_id is null) <> (p_role_id is null) then
    return jsonb_build_object(
      'ok', false,
      'message', 'Choose both a program and a role for this invitation, or neither for a plain teacher code.'
    );
  end if;

  if p_ensemble_id is not null then
    select e.name, e.active into v_ens_name, v_ens_active
      from public.ensembles e
     where e.id = p_ensemble_id;

    if v_ens_name is null or not v_ens_active then
      return jsonb_build_object('ok', false, 'message', 'That program is not taking members right now.');
    end if;

    select * into v_role from public.roles where id = p_role_id and active;
    if not found then
      return jsonb_build_object('ok', false, 'message', 'That role no longer exists.');
    end if;

    if v_role.key = 'system_admin' then
      return jsonb_build_object('ok', false, 'message', 'System administrator access cannot be given by an invitation.');
    end if;

    if not v_role.is_system and v_role.ensemble_id <> p_ensemble_id then
      return jsonb_build_object('ok', false, 'message', 'That role belongs to a different program.');
    end if;
  end if;

  select * into v_state from public.teacher_invitations where code_hash = v_hash;

  if v_state.id is null then
    insert into public.teacher_invitations
      (code_hash, label, intended_email, expires_at, ensemble_id, role_id, created_by)
    values
      (v_hash, left(btrim(coalesce(p_label, '')), 120), v_email, p_expires_at,
       p_ensemble_id, p_role_id, v_actor)
    returning id into v_id;

    perform public.log_audit('teacher.invite_create', p_ensemble_id, null::uuid, p_role_id,
      jsonb_build_object(
        'invitation_id', v_id,
        'label', p_label,
        'email_bound', v_email is not null,
        'program', v_ens_name,
        'role', v_role.name
      ));
  else
    if v_state.redeemed_at is not null then
      return jsonb_build_object('ok', false, 'message', 'That code has already been redeemed — issue a different one instead.');
    end if;
    if v_state.revoked_at is not null then
      return jsonb_build_object('ok', false, 'message', 'That code has been cancelled — issue a different one instead.');
    end if;

    -- Binding, re-binding and (re)scheduling are all just this update: a code
    -- that has not been used yet is still editable, which is what makes
    -- "bind the seeded code to the intended teacher" a one-liner. The program
    -- and role follow the same rule.
    update public.teacher_invitations
       set label          = left(btrim(coalesce(p_label, '')), 120),
           intended_email = v_email,
           expires_at     = p_expires_at,
           ensemble_id    = p_ensemble_id,
           role_id        = p_role_id
     where id = v_state.id
    returning id into v_id;

    perform public.log_audit('teacher.invite_update', p_ensemble_id, null::uuid, p_role_id,
      jsonb_build_object(
        'invitation_id', v_id,
        'label', p_label,
        'email_bound', v_email is not null,
        'program', v_ens_name,
        'role', v_role.name
      ));
  end if;

  return jsonb_build_object(
    'ok', true,
    'invitation_id', v_id,
    'message', 'Invitation saved. The code itself is never stored, so keep a copy — it cannot be read back.'
  );
end
$$;

comment on function public.configure_teacher_invitation(text, text, text, timestamptz, uuid, uuid) is
  'System administrator: create an invitation, or bind/re-label/reschedule one that has not been redeemed. Optionally names a program and role the redeemer is given. The code is hashed on arrival and never read back.';

revoke all on function public.configure_teacher_invitation(text, text, text, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.configure_teacher_invitation(text, text, text, timestamptz, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Redeeming: grant the credential, and the roster place, in one transaction
-- ---------------------------------------------------------------------------
create or replace function public.redeem_teacher_invitation(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth     text := public.current_auth_id();
  v_email    text;
  v_profile  uuid;
  v_ip       text;
  v_hash     text;
  v_id       uuid;
  v_inv      public.teacher_invitations%rowtype;
  v_fails    int;
  v_ip_fails int;
  v_already  boolean;
  v_ensemble uuid;
  v_role     uuid;
  v_ens_name text;
  v_ens_open boolean;
  v_role_row public.roles%rowtype;
  v_member   public.memberships%rowtype;
  v_name     text;
  -- Said once, used for every "no". It never distinguishes a wrong code from an
  -- unknown one, so a client cannot learn which invitations exist by asking.
  c_generic constant text := 'That invitation code isn''t valid. Check it and try again.';
begin
  if v_auth is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  v_email   := public.current_auth_email();
  v_profile := public.current_profile_id();

  -- Best effort: PostgREST exposes the request headers. Absent is fine — the
  -- per-account limit below is the one that cannot be evaded.
  begin
    v_ip := nullif(
      (current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for'),
      ''
    );
  exception
    when others then v_ip := null;
  end;
  v_ip := left(v_ip, 64);

  select exists (
    select 1 from public.teacher_invitations i
     where lower(i.redeemed_by_auth) = lower(v_auth)
       and i.redeemed_at is not null
       and i.revoked_at is null
  ) into v_already;

  -- --- rate limit ---------------------------------------------------------
  select count(*) into v_fails
    from public.teacher_invite_attempts a
   where lower(a.auth_user_id) = lower(v_auth)
     and a.attempted_at > now() - interval '15 minutes';

  if v_fails >= 5 then
    return jsonb_build_object(
      'ok', false,
      'message', 'Too many incorrect codes. Wait a few minutes before trying again.',
      'rate_limited', true
    );
  end if;

  if v_ip is not null then
    select count(*) into v_ip_fails
      from public.teacher_invite_attempts a
     where a.ip = v_ip
       and a.attempted_at > now() - interval '15 minutes';

    if v_ip_fails >= 20 then
      return jsonb_build_object(
        'ok', false,
        'message', 'Too many incorrect codes from here. Wait a few minutes before trying again.',
        'rate_limited', true
      );
    end if;
  end if;

  v_hash := public.invitation_code_hash(p_code);

  if v_hash is null then
    insert into public.teacher_invite_attempts (auth_user_id, ip) values (lower(v_auth), v_ip);
    return jsonb_build_object('ok', false, 'message', c_generic);
  end if;

  select * into v_inv from public.teacher_invitations where code_hash = v_hash;

  -- A code that would be refused anyway must not cost the person their
  -- invitation. Everything the loop below depends on is checked here, while the
  -- row is still unredeemed; the UPDATE further down re-checks all of it.
  if v_inv.id is not null
     and v_inv.redeemed_at is null
     and v_inv.revoked_at is null
     and (v_inv.expires_at is null or v_inv.expires_at > now())
     and (v_inv.intended_email is null
          or (v_email is not null and lower(v_inv.intended_email) = v_email))
     and v_inv.ensemble_id is not null then

    select e.name, e.active into v_ens_name, v_ens_open
      from public.ensembles e
     where e.id = v_inv.ensemble_id;

    if v_ens_name is null or not v_ens_open then
      return jsonb_build_object(
        'ok', false,
        'message', 'That program is no longer taking members. Ask the administrator for a new invitation.'
      );
    end if;

    if v_inv.role_id is null then
      return jsonb_build_object(
        'ok', false,
        'message', 'That invitation is missing its role. Ask the program administrator for a new one.'
      );
    end if;

    select * into v_role_row from public.roles where id = v_inv.role_id and active;
    if not found then
      return jsonb_build_object(
        'ok', false,
        'message', 'The role that invitation grants no longer exists. Ask the program administrator for a new one.'
      );
    end if;

    if v_role_row.key = 'system_admin' then
      return jsonb_build_object(
        'ok', false,
        'message', 'That invitation cannot be redeemed. Ask the program administrator for a new one.'
      );
    end if;

    if not v_role_row.is_system and v_role_row.ensemble_id <> v_inv.ensemble_id then
      return jsonb_build_object(
        'ok', false,
        'message', 'The role that invitation grants belongs to a different program. Ask the program administrator for a new one.'
      );
    end if;

    -- A director removed them. An invitation must not undo that: the roster is
    -- the director's decision, and `guard_membership_change` would refuse the
    -- reactivation anyway.
    if v_profile is not null then
      select * into v_member
        from public.memberships m
       where m.user_id = v_profile
         and m.ensemble_id = v_inv.ensemble_id;

      if v_member.id is not null and not v_member.active then
        return jsonb_build_object(
          'ok', false,
          'message', 'A director removed you from that program — ask the administrator for a new invitation once you are back on the roster.'
        );
      end if;
    end if;
  end if;

  -- Already verified, and this is a plain registration code: nothing to redeem,
  -- and no second code should stack. (A program invitation is different — the
  -- credential it also carries is already held, but the roster place is not.)
  if v_already
     and v_inv.id is not null
     and v_inv.ensemble_id is null
     and v_inv.redeemed_at is null
     and v_inv.revoked_at is null then
    return jsonb_build_object(
      'ok', true, 'verified', true,
      'message', 'This account already has teacher access.'
    );
  end if;

  -- --- the redemption: one atomic UPDATE is the whole concurrency story ---- 
  -- Every condition is in the WHERE clause, so the row lock decides the winner
  -- and the loser re-evaluates to "no rows" rather than double-redeeming.
  update public.teacher_invitations i
     set redeemed_by_auth    = lower(v_auth),
         redeemed_by_profile = v_profile,
         redeemed_email      = v_email,
         redeemed_at         = now()
   where i.code_hash = v_hash
     and i.redeemed_at is null
     and i.revoked_at is null
     and (i.expires_at is null or i.expires_at > now())
     and (
       i.intended_email is null
       or (v_email is not null and lower(i.intended_email) = v_email)
     )
  returning i.id, i.ensemble_id, i.role_id into v_id, v_ensemble, v_role;

  if v_id is null then
    insert into public.teacher_invite_attempts (auth_user_id, ip) values (lower(v_auth), v_ip);

    -- Why it failed. This is only *reachable* by somebody who already knew the
    -- code, so it gives them a usable answer without becoming an oracle for
    -- somebody guessing: an unknown code and a wrong-looking one get one text.
    select * into v_inv from public.teacher_invitations where code_hash = v_hash;

    if v_inv.id is null then
      return jsonb_build_object('ok', false, 'message', c_generic);
    elsif v_inv.revoked_at is not null then
      return jsonb_build_object(
        'ok', false,
        'message', 'That invitation has been cancelled. Ask your program administrator for a new one.'
      );
    elsif v_inv.redeemed_at is not null then
      return jsonb_build_object(
        'ok', false,
        'message', 'That invitation code has already been used. Each one works once.'
      );
    elsif v_inv.expires_at is not null and v_inv.expires_at <= now() then
      return jsonb_build_object(
        'ok', false,
        'message', 'That invitation code has expired. Ask your program administrator for a new one.'
      );
    else
      return jsonb_build_object(
        'ok', false,
        'message', 'That invitation was issued to a different email address. Sign in with that address, or ask for a new code.'
      );
    end if;
  end if;

  -- --- the roster place, when the invitation carries one -------------------
  if v_ensemble is not null then
    if v_role_row.id is null or v_ens_name is null then
      -- Unreachable: the pre-flight check above refuses code+program states the
      -- atomic UPDATE would accept, so a successful update always has both.
      raise exception 'That invitation is missing its program or role.';
    end if;

    -- A brand-new account has no profile yet. It gets one now, named from the
    -- address or the auth metadata, so the roster row is not a blank.
    if v_profile is null then
      select coalesce(
               nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name',
                                     u.raw_user_meta_data ->> 'name', '')), ''),
               nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
               ''
             )
        into v_name
        from auth.users u
       where u.id::text = v_auth;

      insert into public.profiles (id, auth_user_id, full_name, display_name)
      values (gen_random_uuid(), v_auth, coalesce(v_name, ''), coalesce(v_name, ''))
      on conflict (auth_user_id) do nothing
      returning id into v_profile;

      if v_profile is null then
        select p.id into v_profile
          from public.profiles p
         where p.auth_user_id = v_auth;
      end if;
    end if;

    select * into v_member
      from public.memberships m
     where m.user_id = v_profile
       and m.ensemble_id = v_ensemble;

    -- Both guard triggers refuse a self role change. These two writes are the
    -- administrator's decision, recorded on the single-use invitation row, so
    -- they are allowed while this function's own flag is set — and never
    -- otherwise, because no client can set a GUC and no RPC exposes set_config.
    perform set_config('rhs.invitation_grant', 'on', true);

    if v_member.id is null then
      -- One insert, with the final roles array: `guard_membership_change` is a
      -- BEFORE UPDATE trigger, so an added role must not be bolted on after.
      insert into public.memberships (user_id, ensemble_id, roles, active)
      values (
        v_profile,
        v_ensemble,
        case
          when v_role_row.is_system then array[v_role_row.key::public.app_role]
          else array['student'::public.app_role]
        end,
        true
      )
      returning * into v_member;
    elsif v_role_row.is_system and not (v_role_row.key::public.app_role = any (v_member.roles)) then
      update public.memberships
         set roles = v_member.roles || v_role_row.key::public.app_role
       where id = v_member.id;
    end if;

    if not v_role_row.is_system then
      insert into public.user_role_assignments (user_id, ensemble_id, role_id, granted_by)
      values (v_profile, v_ensemble, v_role, v_inv.created_by)
      on conflict (user_id, ensemble_id, role_id)
      do update set
        revoked_at = null,
        revoked_by = null,
        granted_by = excluded.granted_by,
        granted_at = now();
    end if;

    perform set_config('rhs.invitation_grant', 'off', true);

    perform public.log_audit('teacher.invite_join', v_ensemble, v_profile, v_role,
      jsonb_build_object(
        'invitation_id', v_id,
        'program', v_ens_name,
        'role', v_role_row.name,
        'system_role', v_role_row.is_system
      ));
  end if;

  -- Clear the failures this account accumulated, so one bad minute is not a lockout.
  delete from public.teacher_invite_attempts where lower(auth_user_id) = lower(v_auth);

  perform public.log_audit(
    'teacher.invite_redeem',
    v_ensemble,
    v_profile,
    v_role,
    jsonb_build_object('invitation_id', v_id)
  );

  return jsonb_build_object(
    'ok', true,
    'verified', true,
    'joined', v_ensemble is not null,
    'program_name', v_ens_name,
    'role_name', v_role_row.name,
    'message', case
      when v_ensemble is not null then format(
        'You''re verified, and on the %s roster as %s.', v_ens_name, v_role_row.name
      )
      else 'You''re verified — you can start a program of your own now.'
    end
  );
exception
  when unique_violation then
    -- A partial unique index fired: this account already holds a live
    -- redemption for that program (a race with its own second attempt, or a
    -- code issued twice).
    return jsonb_build_object(
      'ok', false,
      'message', 'This account has already used an invitation for that program.'
    );
end
$$;

comment on function public.redeem_teacher_invitation(text) is
  'Redeem a teacher invitation code. Atomic, single-use, optionally email-bound and expiring; rate-limited per account and address. Grants verified teacher access and, when the invitation names one, a program membership with its role.';

revoke all on function public.redeem_teacher_invitation(text) from public, anon;
grant execute on function public.redeem_teacher_invitation(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The administrator's list, now with the roster it grants and who used it
-- ---------------------------------------------------------------------------
create or replace function public.list_teacher_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_program_admin() then
    return jsonb_build_object('ok', false, 'message', 'Only a system administrator can read teacher invitations.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'invitations', coalesce(
      (
        select jsonb_agg(entry order by (entry ->> 'created_at') desc)
          from (
            select jsonb_build_object(
              'id', i.id,
              'label', i.label,
              'intended_email', i.intended_email,
              'expires_at', i.expires_at,
              'redeemed_at', i.redeemed_at,
              'redeemed_email', i.redeemed_email,
              -- The person, resolved from the account that redeemed it. The
              -- profile may not have existed at redemption time, so this is a
              -- join on the auth id rather than the stored profile pointer.
              'redeemed_by_name', coalesce(nullif(p.display_name, ''), nullif(p.full_name, '')),
              'redeemed_by_auth', i.redeemed_by_auth,
              'revoked_at', i.revoked_at,
              'created_at', i.created_at,
              'program_name', e.name,
              'program_id', i.ensemble_id,
              'role_name', r.name,
              'role_key', r.key,
              'role_is_system', r.is_system,
              'status', case
                when i.revoked_at is not null then 'revoked'
                when i.redeemed_at is not null then 'redeemed'
                when i.expires_at is not null and i.expires_at <= now() then 'expired'
                else 'available'
              end
            ) as entry
            from public.teacher_invitations i
            left join public.profiles p
              on lower(p.auth_user_id) = lower(i.redeemed_by_auth)
            left join public.ensembles e on e.id = i.ensemble_id
            left join public.roles r on r.id = i.role_id
          ) t
      ),
      '[]'::jsonb
    )
  );
end
$$;

comment on function public.list_teacher_invitations() is
  'System administrator: every staff invitation with its program, its role, its state, and who redeemed it. Returns no code and no digest.';

revoke all on function public.list_teacher_invitations() from public, anon;
grant execute on function public.list_teacher_invitations() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Verification — the shape the app and the suites rely on
-- ---------------------------------------------------------------------------
do $$
declare
  v_anon text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'teacher_invitations'
       and column_name = 'ensemble_id'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'teacher_invitations'
       and column_name = 'role_id'
  ) then
    raise exception 'FAIL: teacher_invitations is missing ensemble_id/role_id';
  end if;

  if to_regprocedure('public.configure_teacher_invitation(text, text, text, timestamptz)') is not null then
    raise exception 'FAIL: the four-argument configure_teacher_invitation() still exists — a four-argument call would be ambiguous';
  end if;

  if to_regprocedure('public.configure_teacher_invitation(text, text, text, timestamptz, uuid, uuid)') is null then
    raise exception 'FAIL: configure_teacher_invitation() was not replaced with the program/role signature';
  end if;

  if to_regclass('public.teacher_invitations_one_live_redemption') is null then
    raise exception 'FAIL: the per-program live-redemption index is missing';
  end if;

  if to_regclass('public.teacher_invitations_one_per_account') is not null then
    raise exception 'FAIL: the old one-redemption-per-account index is still present';
  end if;

  -- The guard must know the flag, and the redeem function must be the only place
  -- that raises it.
  if pg_get_functiondef('public.guard_membership_change()'::regprocedure)
       not like '%rhs.invitation_grant%' then
    raise exception 'FAIL: guard_membership_change() does not honour the invitation grant flag';
  end if;

  if pg_get_functiondef('public.guard_user_role_assignment()'::regprocedure)
       not like '%rhs.invitation_grant%' then
    raise exception 'FAIL: guard_user_role_assignment() does not honour the invitation grant flag';
  end if;

  if pg_get_functiondef('public.redeem_teacher_invitation(text)'::regprocedure)
       not like '%rhs.invitation_grant%' then
    raise exception 'FAIL: redeem_teacher_invitation() does not set the invitation grant flag';
  end if;

  if pg_get_functiondef('public.list_teacher_invitations()'::regprocedure)
       not like '%redeemed_by_name%' then
    raise exception 'FAIL: list_teacher_invitations() does not answer with who redeemed each code';
  end if;

  select string_agg(p.proname, ', ')
    into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('configure_teacher_invitation', 'list_teacher_invitations',
                       'revoke_teacher_invitation', 'redeem_teacher_invitation')
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_anon is not null then
    raise exception 'FAIL: anon can execute: %', v_anon;
  end if;

  raise notice 'OK — invitations can name a program and role, and redemption grants both.';
end
$$;
