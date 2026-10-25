-- ============================================================================
-- system_administrator_grant — one owner account administers every program
-- ----------------------------------------------------------------------------
-- Purpose
--   The owner asked (2026-10-24) for one account to administer every program —
--   the ones that exist and any made later — after discovering that a program
--   director deliberately cannot change a co-director's roles (029 §14:
--   "Directors cannot change another director's roles") and so could not undo a
--   temporary promotion.
--
--   This adds no capability, table or bypass. `program_admins` is the
--   system-administrator table 009 created, and `public.is_program_admin()` is
--   already the cross-program branch inside `has_permission()`, every RLS
--   policy and every role/roster RPC. A row here *is* the whole grant, which is
--   why it is a data migration rather than new SQL.
--
-- What it does
--   Inserts the `program_admins` row for the profile behind the Supabase Auth
--   account lebronyuh64@gmail.com. It is a deliberate no-op where that account
--   does not exist (a throwaway database built from the schema + public data
--   has no `auth.users` rows), so replaying it everywhere is safe — and a
--   restore of this project cannot silently strip the owner's access.
--
-- Rollback
--   delete from public.program_admins
--    where user_id = (
--      select p.id
--        from auth.users u
--        join public.profiles p on p.auth_user_id = u.id::text
--       where lower(u.email) = 'lebronyuh64@gmail.com'
--    );
--
-- Re-runnable: `on conflict (user_id) do nothing`.
-- ============================================================================

insert into public.program_admins (user_id)
select p.id
  from auth.users u
  join public.profiles p on p.auth_user_id = u.id::text
 where lower(u.email) = 'lebronyuh64@gmail.com'
on conflict (user_id) do nothing;

-- 009 described this table as "DB support only". It now has an account and a
-- client path (the app lets a system administrator open any program), so the
-- comment should say what the table actually is.
comment on table public.program_admins is
  'System administrators: one row grants cross-program authority through is_program_admin() — every capability in every program, existing or future. No client read or write; granted by migration only (009, then 20261025010444).';

comment on column public.program_admins.user_id is
  'public.profiles.id, not auth.users.id — identity resolves through current_profile_id().';

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_account  boolean;
  v_granted  int;
begin
  if to_regclass('public.program_admins') is null then
    raise exception 'FAIL: public.program_admins is missing';
  end if;

  select exists (
    select 1 from auth.users where lower(email) = 'lebronyuh64@gmail.com'
  ) into v_account;

  select count(*)
    into v_granted
    from public.program_admins pa
    join public.profiles p on p.id = pa.user_id
    join auth.users u on u.id::text = p.auth_user_id
   where lower(u.email) = 'lebronyuh64@gmail.com';

  -- Exactly the one grant when the account is present, and none when it is not:
  -- that is what makes the statement above both a grant and a no-op.
  if v_account and v_granted <> 1 then
    raise exception 'FAIL: expected 1 program_admins row for lebronyuh64@gmail.com, found %', v_granted;
  end if;
  if not v_account and v_granted <> 0 then
    raise exception 'FAIL: % program_admins rows for an account that does not exist here', v_granted;
  end if;

  raise notice 'system_administrator_grant: account present = %, grant rows = %', v_account, v_granted;
end
$$;
