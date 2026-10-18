# Security & production audit — October 2026

Scope: this repository (`main`), the hosted Supabase project `sjiswrvhrnrxkrfhfjrp`
("Redmond Performing Arts and Music Attendance Web-App"), read-only, and the
local verification harness. **The hardening migration was applied to production on
the owner's instruction (see Priority 3 below); `security_hardening_grants` is in
the hosted project's applied migrations, checked 2026-10-17.** Nothing in this
report is still waiting to be applied.

Read-only production checks used: `list_migrations`, `get_advisors` (security),
catalog queries against `pg_policies`, `pg_proc`, `pg_trigger`,
`information_schema` grants, and `storage.buckets`.

## Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | High | A signed-in user could UPDATE **any column** of their own `profiles` row, including `auth_user_id` (the login binding) and `id`. | Fixed; **applied to prod** (`security_hardening_grants`), verified |
| F2 | Medium (defence in depth) | Over-broad grants: `anon` held full table privileges; `authenticated` held `TRUNCATE`/`REFERENCES`/`TRIGGER` everywhere and INSERT/UPDATE/DELETE on tables that no client path writes. | Fixed; **applied to prod** (`security_hardening_grants`), verified |
| F3 | Low | `has_active_membership(uuid)` (SECURITY DEFINER) answers for any profile id to any signed-in user. | Open — needs a design decision (policy helper, see below) |
| F4 | Low | `get_join_code_status(slug)` returns one boolean for any program slug to signed-in users. | Accepted (tested API, boolean only) |
| F5 | Info | 63 SECURITY DEFINER functions are executable by `authenticated` (Supabase advisor `0029`). Reviewed the ones that read or change data: each checks the caller (`current_profile_id()`, `has_permission`, `can_manage_ensemble`, `has_role_in`, etc.). | Accepted by design; long-term, move helpers out of the exposed schema |
| F6 | Warn | Leaked-password protection is disabled in Supabase Auth. | Manual dashboard change |
| F7 | Warn | `pg_net` was installed in `public`. | Fixed in production 2026-10-16 (moved to `extensions`) |
| F8 | Info | RLS is enabled with **no** policies on `signup_account_types`, `teacher_invitations`, `teacher_invite_attempts`. Intentional deny-all; reached only through definer RPCs. | Accepted |
| F9 | Info | `profiles.clerk_id` was a legacy column (unique index, no code reads it). | Fixed in production 2026-10-16 (dropped after backup) |

### Checked and found sound

- **QR / check-in** (`record_attendance`, `record_checkin_for_session`): identity comes from `auth.uid()` only (`p_actor = current_profile_id()`), so a student cannot record attendance for another person. Membership is required; directors cannot check in; there is a per-event rate limit (5 failures / 2 min); the window is 15 min before start through end of event; the mode must be `qr`/`both`; tokens expire after 5 min; first scan wins; an excused record cannot be overwritten.
- **Attendance writes**: `attendance_records` has only a SELECT policy and no client write grant; all writes go through `override_attendance` / check-in, which check capability and section scope.
- **Role escalation**: `memberships` and `user_role_assignments` have no client write grant; `guard_membership_change`, `guard_user_role_assignment` and `guard_role_permissions_change` block self-role changes and delegating unheld capabilities. `assign_role` refuses self-assignment and system-admin grants.
- **Students creating programs**: `create_program` requires `has_teacher_access()`, which reads the verified redemption.
- **Teacher invitations**: codes stored as hashes, normalised, per-account and per-IP rate limited, atomic single-use redemption.
- **Join codes**: `get_join_code` is director-only; `join_program` is rate-limited via `validate_join_code`.
- **Invitations**: `invite-student` authenticates the caller, then runs `create_program_invite` as that caller, which requires director/secretary/section-leader of that program.
- **Storage (avatars)**: bucket is private, 5 MB limit, image MIME types only, owner folder = `auth.uid()`, reads gated by `can_read_avatar`.
- **Guest access**: the repo has no guest/anonymous product path. `anon` had no executable functions and no policy matches it; after F2 it has no table privileges at all.
- **Edge functions**: `delete-account`, `import-google-calendar`, `invite-student` require a valid bearer token; `event-digest` requires the `x-event-digest-secret` header or the platform service-role bearer.

## Priority 2 — fixes made (repo only)

**`supabase/migrations/20261016225631_security_hardening_grants.sql`** (timestamp-named on purpose: `20261013041215` is already applied remotely and a lower version would be rejected by `supabase db push` as out of order).

1. `profiles`: `UPDATE` revoked from `anon`/`authenticated`; re-granted only on `full_name, display_name, avatar_url, avatar_path, bio, must_change_password` — exactly what `updateMyProfile` writes. `deactivated` still changes only through `deactivate_member` (definer).
2. `anon`: all table and function privileges revoked (and default privileges).
3. `authenticated`: `TRUNCATE`, `REFERENCES`, `TRIGGER` revoked on all public tables (TRUNCATE bypasses RLS).
4. `authenticated`: `INSERT/UPDATE/DELETE` revoked on tables that no client path writes and no policy allows; `notifications` keeps UPDATE (read flag).
5. Verification `DO` block asserts the above.

Why this is safe: every trigger function in `public` is SECURITY DEFINER (checked); every RPC the client calls is definer; the client writes only `events`, `notifications` (read flag), `personal_events` and `profiles` (allowed columns).

**Tests**

- `supabase/tests/security_hardening_grants.sql` (new): SEC-H-1 self-rebind of `auth_user_id` refused; SEC-H-2 `id` rewrite refused; SEC-H-3 own bio still editable; SEC-H-4 direct attendance insert refused; SEC-H-5 no TRUNCATE on attendance; SEC-H-6 anon has no privileges. Rolls back its own fixtures.
- Two existing suites asserted the old wider behaviour and were updated so their denial checks accept the database's refusal (`insufficient_privilege`) while keeping the zero-row / flag-intact assertions: `security_verification_v2.sql` (B8, D1) and `capabilities_and_avatars.sql` (F3).
- Negative check: with the old grant restored locally, SEC-H-1 fails with `FAIL: SEC-H-1 student rebound their own auth_user_id`; with the hardened grant it passes.

## Priority 3 — migration & production verification

- **Deployed migrations** (`list_migrations`): 007–033 and 035 match local files by number. The pin migration is recorded remotely as version `20261013041215` with name `034_pin_function_search_path`; locally it is `20261013041215_pin_function_search_path.sql`. No file numbered 034 exists, locally or remotely. All local migrations up to 035 are applied.
- **Definition drift**: 95 repo-defined public functions were compared by hash against production after normalising CRLF. **Identical.** RLS policies (all of `public` and `storage`): **identical** hash. Trigger names match. Storage bucket `avatars`: private, 5 MB, image types.
- **Not compared**: column/index/constraint-level equality (only spot-checked via `profiles` indexes and the local migration verification blocks).
- **Local rebuild**: `scripts/dev/verify_migrations_locally.sh` rebuilt the schema from the dump plus all migrations including the new one: 30 migrations applied; 16 suites passed, 0 failed, 1 skipped (legacy-schema suite that runs against the pre-migration clone, by design).
- **Applied to production** as `security_hardening_grants` (remote version `20261016225631`). Post-apply checks: `auth_user_id`, `id`, `deactivated`, anon table access, attendance INSERT and TRUNCATE all false for `authenticated`/`anon`; `bio` and `events` INSERT still true; `notifications` UPDATE still true; RLS policy hash unchanged; no new security advisors (remaining items unchanged).

### Production deployment plan (requires your approval)

1. Take a backup or confirm point-in-time recovery is on for `sjiswrvhrnrxkrfhfjrp`.
2. `supabase db push --project-ref sjiswrvhrnrxkrfhfjrp --dry-run` — expect exactly one pending migration: `20261016225631_security_hardening_grants`.
3. Apply it (`supabase db push --project-ref sjiswrvhrnrxkrfhfjrp`), or paste the file into the SQL editor.
4. Post-check (read-only):
   - `select has_column_privilege('authenticated','public.profiles','auth_user_id','UPDATE');` → `false`
   - `select has_column_privilege('authenticated','public.profiles','bio','UPDATE');` → `true`
   - `select has_table_privilege('anon','public.events','SELECT');` → `false`
5. Smoke test in the app as a student: edit display name and bio (should save); attendance check-in still works; teacher/director roster and attendance screens still load.
6. Rollback if something unexpected breaks: re-grant the specific privilege that was removed, for example `grant update on table public.profiles to authenticated;`. Do not re-grant to `anon`.

## Priority 4 — credentials

- **Tracked files**: no secrets found in tracked files. `.env.example` has placeholders only; `.env`, `.env.local`, `.env.event-digest` are gitignored and were never tracked (`git log --all -- <paths>` is empty).
- **Git history**: a pattern scan of all commits (Supabase JWTs, `sb_secret_`, `sb_publishable_`, SendGrid key shape, `postgres://user:password@`) found nothing. This is a pattern scan, not a guarantee; a secret in an unusual format would not match.
- **Build output**: `dist/` (gitignored, local) contains one JWT with `role: anon` (public by design). No service-role key and no `sb_secret_` in the bundle.
- **Frontend env**: only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are read (`src/lib/supabase.ts`, `backend-config.ts`). No service-role key is referenced in `src/`.
- **Clerk**: no Clerk package in `package.json`, no SDK imports, no Clerk middleware or env. Remaining references are comments in `src/App.tsx`, `src/lib/supabase.ts`, `src/lib/queries.ts`, `src/lib/types.ts`, `src/screens/AuthScreen.tsx`, and historical docs. The one real leftover is the `profiles.clerk_id` column (unique index, read by nothing in the app). It was dropped in production on 2026-10-16 after a backup (all 9 rows were NULL; see `.tools/backups/clerk_id_backup_2026-10-16.md`).
- ~~**Config mismatch to confirm**~~ **Resolved 2026-10-18**: production is `https://rhsattendance.org`, and the live Site URL plus redirect URLs were aligned through the Management API. Do **not** use `supabase config push` to do this — it would reset 19 remote-only settings (Google sign-in, TOTP MFA, rate limits). See `docs/EMAIL_SETUP.md` §2.
- **Template paths to verify**: `confirmation`/`recovery`/etc. use `./supabase/templates/…`, while `password_changed_notification` uses `./templates/…`. Confirm the CLI resolves these relative to the expected root.

## Manual actions required (not performed)

1. ~~Approve and apply~~ **Done** — migration `20261016225631_security_hardening_grants` applied to production. The dry-run and backup steps above were not performed for this apply; take a point-in-time restore point before any further migration.
2. **Supabase Dashboard → Authentication → Providers → Email → Password security**: enable *Leaked password protection* (F6).
3. ~~Move `pg_net` out of `public`~~ (F7) Done 2026-10-16. `pg_net` is not relocatable, so it was dropped and recreated in `extensions`. No cron job was scheduled and no function called `net.http_*`, so nothing broke. Note: `cron.job` is empty, so the digest cron is not scheduled in production today and has not been exercised.
4. ~~Drop `profiles.clerk_id`~~ (F9) Done 2026-10-16 after backup. `prepare_account_deletion` was recreated without its `clerk_id` write, and the delete-account test was updated to match.
5. **Confirm production origin** (see Priority 4) and align Auth → URL Configuration (Site URL and Redirect URLs) with it.
6. **Rotate credentials if they were ever shared outside your machine.** Locally, `.env` holds a Supabase Management access token (its comment says to rotate after the migration), old and new service-role keys, database URLs whose password is still a placeholder, and the Resend auth key. `.env.event-digest` holds a separate Resend API key and `EVENT_DIGEST_SECRET`. Rotate the management token and both Resend keys at their providers if they appeared in chat or any shared document; rotating `EVENT_DIGEST_SECRET` requires updating the Supabase secret and the cron job together. I did not reproduce or rotate any value.
7. **Vercel**: confirm no `VITE_*` variable carries a service-role key, that no `VITE_CLERK_*` variables remain, and that `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` point at `sjiswrvhrnrxkrfhfjrp`. I cannot read Vercel settings from here.

## Open risks / not done

- **F3 `has_active_membership(uuid)`**: any signed-in user can ask whether any profile id has an active membership. The UUIDs are not trivially enumerable, but this is still an oracle. It is a policy helper that the suite (SEC-v2-B3) requires to stay executable, so it was not revoked. Tightening it to self-or-manager is a design change to be made deliberately.
- **Helper functions in `public`**: 63 SECURITY DEFINER functions are callable by signed-in users. Each reviewed sensitive one checks the caller. Moving helpers into a non-exposed schema would reduce the surface but changes every policy; not done.
- **Not run**: Playwright e2e (`npm run test:e2e`) was not run; the frontend is unchanged by this work. `npm run typecheck` and `npm run build` pass. There is no lint script in `package.json`.
- **Not verified**: full column/index/constraint equality of the hosted schema against the repo; the hosted Vercel environment; SMTP and email templates in the dashboard.
