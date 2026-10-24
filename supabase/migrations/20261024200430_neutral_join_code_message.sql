-- ============================================================================
-- RHS Music Platform — Migration: a join-code refusal that names no program
-- ============================================================================
-- Idempotent — create or replace only; safe to re-run.
--
-- WHY
--   `validate_join_code()` still answered a wrong code with "That band join
--   code isn't right", wording from when the site had one program. It now
--   surfaces for any program, which reads as if the person used the wrong
--   kind of code. The refusal stays identical in every other respect.
--
-- WHAT CHANGES
--   Only the refusal text: "That join code isn't right — ask your director for
--   the current one." The per-address bucket, the five-failures-in-two-minutes
--   lockout, the "That program isn't available" answer for an unknown or
--   inactive slug, the empty-code-means-open rule, and the success answer are
--   carried over verbatim.
--
-- ROLLBACK
--   Re-apply the definition from 016_ensemble_rpcs.sql in a new timestamped
--   migration. Do not edit 016 — it is already applied.
-- ============================================================================

create or replace function public.validate_join_code(p_slug text, p_code text, p_ip text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip       text := coalesce(nullif(trim(coalesce(p_ip, '')), ''), public.client_ip());
  v_required text;
  v_ok       boolean;
begin
  select coalesce(s.join_code, '')
    into v_required
    from public.ensembles e
    left join public.ensemble_settings s on s.ensemble_id = e.id
   where e.slug = p_slug
     and e.active;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'That program isn''t available.');
  end if;

  v_ok := v_required = '' or upper(coalesce(p_code, '')) = upper(v_required);

  -- Lockout: too many recent failures from this IP → refuse, even if the code
  -- happens to be right now, so the throttled caller can't trivially bypass.
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

  insert into public.join_code_attempts (ip, success) values (v_ip, v_ok);

  if v_ok then
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object(
    'ok', false,
    'message', 'That join code isn''t right — ask your director for the current one.'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.validate_join_code(text, text, text)'::regprocedure);
begin
  if position('band join code' in v_def) > 0 then
    raise exception 'FAIL: validate_join_code still names the band';
  end if;

  -- The body is stored with doubled quotes (`isn''t`), so match the stable part.
  if position('That join code isn' in v_def) = 0
     or position('ask your director for the current one' in v_def) = 0 then
    raise exception 'FAIL: the neutral refusal is missing';
  end if;

  -- The throttle and the open-program rule must survive the rewrite.
  if position('join_code_attempts' in v_def) = 0
     or position('Too many attempts' in v_def) = 0 then
    raise exception 'FAIL: the join-code lockout went missing';
  end if;

  if position('v_required = '''' or upper' in v_def) = 0 then
    raise exception 'FAIL: the no-code-means-open rule went missing';
  end if;

  raise notice 'OK — join-code refusals no longer name the band.';
end
$$;
