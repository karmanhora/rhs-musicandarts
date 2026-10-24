-- ============================================================================
-- RHS Music Platform — Migration: join a program with the code alone
-- ============================================================================
-- Idempotent — create or replace / create index if not exists; safe to re-run.
--
-- WHY
--   The join screen made a person pick a program before typing the code, which
--   meant a wrong pick produced "that code isn't right" even when the code was
--   fine for a different program. The code already identifies its program, so
--   the picker is unnecessary: `join_program_by_code()` resolves the slug from
--   the code and then runs the existing `join_program()` unchanged.
--
-- WHAT THIS ADDS
--   1. A case-insensitive unique index on `ensemble_settings.join_code`, so a
--      code can never identify two programs. (Checked before writing: every
--      existing code is distinct and no program lacks one.)
--   2. `public.join_program_by_code(p_code, p_display_name, p_ip)`:
--        * signed-in callers only, exactly like `join_program()`;
--        * a code that matches no active program is charged to the same
--          per-address bucket as a wrong code for a known program, including
--          the five-failures-in-two-minutes lockout, so guessing stays
--          throttled;
--        * a matching code delegates to `public.join_program()`, which keeps
--          the profile creation, roster rules, second-program support and the
--          "a director removed you" refusal exactly as they are.
--
-- WHAT DOES NOT CHANGE
--   `join_program(p_slug, …)` keeps its signature and behaviour for any caller
--   that still resolves the program first; the code is still validated and
--   rate-limited on the server.
--
-- ROLLBACK
--   `drop function public.join_program_by_code(text, text, text);` and
--   `drop index public.ensemble_settings_join_code_unique;` in a new
--   timestamped migration. Dropping the index is safe: it is a constraint on
--   new data, not a rewrite.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. One code, one program
-- ---------------------------------------------------------------------------
create unique index if not exists ensemble_settings_join_code_unique
  on public.ensemble_settings (upper(btrim(join_code)))
  where join_code is not null
    and btrim(join_code) <> '';

-- ---------------------------------------------------------------------------
-- 2. Joining from the code alone
-- ---------------------------------------------------------------------------
create or replace function public.join_program_by_code(
  p_code         text,
  p_display_name text default null,
  p_ip           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth text := public.current_auth_id();
  v_ip   text := coalesce(nullif(btrim(coalesce(p_ip, '')), ''), public.client_ip());
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_slug text;
begin
  if v_auth is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if v_code = '' then
    return jsonb_build_object('ok', false, 'message', 'Type the join code your director gave you.');
  end if;

  select e.slug
    into v_slug
    from public.ensembles e
    join public.ensemble_settings s on s.ensemble_id = e.id
   where e.active
     and upper(btrim(s.join_code)) = v_code
   limit 1;

  if v_slug is null then
    -- Unknown code. Charge it to the same bucket `validate_join_code()` uses,
    -- or this path would be an unthrottled way to guess codes.
    if (select count(*) from public.join_code_attempts
         where ip = v_ip
           and success = false
           and created_at > now() - interval '2 minutes') >= 5 then
      insert into public.join_code_attempts (ip, success) values (v_ip, false);
      return jsonb_build_object(
        'ok', false,
        'message', 'Too many attempts — try again in a minute.'
      );
    end if;

    insert into public.join_code_attempts (ip, success) values (v_ip, false);
    return jsonb_build_object(
      'ok', false,
      'message', 'That join code isn''t right — ask your director for the current one.'
    );
  end if;

  -- The code proved the program, so the existing join runs unchanged: profile
  -- creation, the student membership, a second program, and the refusal to
  -- undo a director's removal all live there.
  return public.join_program(v_slug, v_code, p_display_name, v_ip);
end
$$;

comment on function public.join_program_by_code(text, text, text) is
  'Joins the program whose join code this is; the code names the program, so no slug is needed. Rate-limited.';

revoke all on function public.join_program_by_code(text, text, text) from public, anon;
grant execute on function public.join_program_by_code(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'ensemble_settings_join_code_unique'
  ) then
    raise exception 'FAIL: the join-code uniqueness index is missing';
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'join_program_by_code'
  ) then
    raise exception 'FAIL: join_program_by_code is missing';
  end if;

  if has_function_privilege('anon', 'public.join_program_by_code(text, text, text)', 'execute') then
    raise exception 'FAIL: anon can execute join_program_by_code';
  end if;

  if not has_function_privilege('authenticated', 'public.join_program_by_code(text, text, text)', 'execute') then
    raise exception 'FAIL: authenticated cannot execute join_program_by_code';
  end if;

  raise notice 'OK — join_program_by_code is live and codes are unique.';
end
$$;
