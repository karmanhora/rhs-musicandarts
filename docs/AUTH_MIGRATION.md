# Supabase Auth migration (Clerk retired)

**Status:** done and live. Migration 021 is in the hosted project's applied
migrations and the schema matches it (checked 2026-10-17 on
`sjiswrvhrnrxkrfhfjrp`: `profiles.auth_user_id` present, `clerk_id` dropped, and
every RPC the app calls resolving). The one manual step in §4 applies only if you
have real people with attendance history. §3 stays as the record of what was
applied and why.

This is the record of what changed, why the database did not have to be
restructured for it, exactly what an operator had to run, and how the change could
have been reversed (§8, historical and not an approved path).

---

## 1. What changed, and why nothing else did

Clerk was doing the one thing Supabase already does: identifying a user. It
brought a third-party script on every page load, two API round-trips before the
landing page could decide whether to render, a server-side proxy function on
Vercel, a Vercel rewrite, a signed webhook plus an Edge Function, five frontend
environment variables, and a build-time dependency — all so that Supabase could
be told who was asking.

Supabase Auth is the same service as the database, so the session the browser
holds *is* the credential PostgREST verifies. The app now has one identity
provider, one set of environment variables, no proxy, no webhook and no
third-party bundle.

The important part is what did **not** change:

- **No table was restructured.** `profiles.id` is still the schema-wide primary
  key every foreign key points at — attendance, memberships, notifications,
  personal events, `created_by` columns. Nothing about attendance history moved.
- **No RLS policy was rewritten.** Every policy in migration 015 — and every
  guard trigger and RPC in 013/016/017/019/020 — resolves the caller through one
  function, `public.current_profile_id()`. Migration 021 changes that function's
  body and nothing else, so all of them keep working unchanged.
- **No screen was redesigned.** The auth screen keeps its layout, copy and
  student/teacher switch; only the form underneath changed from Clerk's hosted
  components to fields bound to Supabase Auth.

## 2. The identity model

| Before (Clerk) | After (Supabase Auth) |
| --- | --- |
| `profiles.clerk_id` (`user_…`) | `profiles.auth_user_id` (= `auth.uid()`, unique) |
| `current_clerk_id()` — Clerk `sub` as text | `current_auth_id()` — Supabase Auth `sub` as text |
| `current_profile_id()` matched `clerk_id` | `current_profile_id()` matches `auth_user_id` |
| Clerk session token as the Supabase bearer token | the Supabase Auth session, used directly |
| `<ClerkProvider>`, `<SignedIn>` / `<SignedOut>`, `useAuth().getToken()` | `AuthProvider` + `useAuth()` (`src/hooks/useAuth.tsx`), routed on in `src/App.tsx` |
| `user.created` webhook → `clerk_user_created` Edge Function | nothing: `join_program()` creates the profile on the join screen |
| Clerk BAPI password reset / ban | Supabase Auth reset link; `deactivate_member` only (see §6) |

`profiles.auth_user_id` is `text`, not `uuid`, and hold `auth.uid()` as its string
form. That is deliberate: `auth.uid()` is *defined* as the JWT `sub` claim cast to
uuid, so reading the claim as text is the same value without a cast — which keeps
the unique index usable, keeps `profiles` independent of `auth.users` (an account
may be deleted while the person's attendance history stays), and lets the SQL test
suites carry fixture ids that are not uuids.

`profiles.clerk_id` was kept (nullable, read by nothing) until the 2026-10-16
hardening migration dropped it, after a backup — all nine rows were NULL, so no
account link was lost. `auth_user_id` is the only identity column now.

## 3. Apply the migration

> **Status: applied.** This section records how migration 021 was applied; it is not
> an instruction to repeat it. The migration is recorded as live and its schema was
> verified on 2026-10-17 (see the status at the top of this file). Do not re-run
> these commands against the hosted project without the owner's explicit approval.

One file: `supabase/migrations/021_supabase_auth.sql`. Idempotent, additive, and
self-verifying — it raises `FAIL: …` if the identity layer did not actually move
or if any identity helper is still reachable by `anon`.

```bash
# rehearse first: loads every migration + test into one transaction and rolls back
bash scripts/migrate/06_apply_migrations.sh --dry-run --with-tests

# then, against the NEW project (the gate refuses anything else)
CONFIRM_TARGET=NEW bash scripts/migrate/06_apply_migrations.sh
bash scripts/migrate/05_verify.sh          # counts, RLS everywhere, every SQL suite
```

Or straight through the Supabase CLI, if you prefer:

```bash
supabase db push --project-ref <NEW_PROJECT_REF>
```

What it does, in order: adds `profiles.auth_user_id` + unique index; backfills the
profiles it can match exactly (§4); adds `current_auth_id()`; repoints
`current_profile_id()`; **drops** `current_clerk_id()`; rewrites `join_program()`
and `register_signup()` onto the new column; re-grants; then verifies.

It does not touch a row of attendance, roster, event, section, theme or calendar
data, and it does not set `NOT NULL` on either identity column — an unlinked row
resolves to NULL, and every helper then denies.

### Settings to configure in the dashboard

Authentication → **Providers → Email**: enabled, and keep *Confirm email* on (this
project currently has it on, so a new account must click the link before it can
sign in — the sign-up screen says so).

Authentication → **URL Configuration**:

- **Site URL** — the production origin.
- **Redirect URLs** — that origin, plus `<origin>/reset-password` for the
  password-recovery link and `<origin>/checkin*` for Google OAuth sign-in from a
  QR check-in. Add the equivalent local URLs when testing. A redirect not on
  this list is rejected or rewritten to the Site URL.

Authentication → **Providers → Google**: enable Google, configure the Google
OAuth client ID and secret, and register the Supabase callback URL shown there
with that OAuth client. The app uses Supabase's Google provider and sends users
back to the site origin, or to the original QR check-in when one is in progress.

No JWT template, webhook secret, or proxy is needed. The six account emails and
the password-change security notification are branded in `supabase/templates/`.
Program email invitations use the `invite-student` Edge Function and add the
student after email confirmation — see [`EMAIL_SETUP.md`](EMAIL_SETUP.md) for
applying the templates, enabling security notifications, the SMTP ceiling that
will bite a whole class signing up at once, and how to test them honestly.

### Environment variables

| Where | Variable | Action |
| --- | --- | --- |
| Local `.env.local` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | unchanged |
| Local `.env.local` | `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PROXY_URL` | **delete** |
| Vercel | the two `VITE_SUPABASE_*` | unchanged |
| Vercel | `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PROXY_URL`, `CLERK_SECRET_KEY` | **delete** |

There is no new variable to add. The `/_clerk` rewrite and the proxy function it
pointed at are gone from the repo, so the next deployment will 404 that path
instead of proxying it.

### Deploy note

The frontend and migration 021 ship together: a browser holding a Supabase Auth
session still resolves to nothing until 021 is applied, and 021 alone does not
sign anyone in until the new frontend is deployed. Applying the migration first is
the safe order — it changes no data and leaves the old behaviour intact (the old
`current_profile_id()` resolved from `clerk_id`, which is NULL for everyone, so
nobody could sign in through Clerk either).

## 4. Existing users — the one manual step

**What the audit shows:** all three live profiles have `clerk_id = NULL` and
`auth_user_id IS NULL`. The Clerk user import (`03b`) was written but never run,
and the `user.created` webhook was never deployed — which matches the note in the
old `DEV.md`: nobody could sign in through Clerk, and nothing ever resolved a real
person to an account. So **no real account is currently linked to any attendance
history.** There is nothing to "migrate" in the sense of moving credentials.

Passwords cannot be transferred in either direction — Clerk is gone, and Supabase
Auth has never seen these people. Everyone signs in through the new flow once:

1. They open the site and choose **Create account** (or you invite them).
2. They confirm their email.
3. They join their program with the join code. `join_program()` creates their
   `profiles` row with `auth_user_id`, and they are on the roster.

That is the whole migration for a person with no history.

### If somebody already has a `profiles` row and history

Migration 021 links a profile automatically **only** when it can prove the match:
a surviving `auth.users` row with the same uuid as the profile (the pre-Clerk
schema mirrored `profiles.id = auth.users.id`, so that row is the same account).

Anyone else with history needs one statement, run by an administrator **before**
they sign up, or joining will create a second profile and orphan the old one.
Work out who needs it first — this lists the profiles that are unlinked:

```sql
-- Who is unlinked? (run as service role / in the SQL editor)
select p.id, p.full_name, p.display_name, p.created_at,
       (select count(*) from public.attendance_records a
         where a.student_id = p.id) as attendance_rows
  from public.profiles p
 where p.auth_user_id is null
 order by attendance_rows desc;
```

Then link the ones that matter. Find the account by the address they signed up
with, confirm with the person that it is their address, and record the link:

```sql
-- Link ONE existing person to ONE Supabase Auth account. Run for one person at a
-- time, after checking the email with them. Nothing else is modified.
with target_profile as (
  select id from public.profiles where id = '<PROFILE_UUID>'
), target_account as (
  select id from auth.users where lower(email) = lower('<THEIR_EMAIL>')
)
update public.profiles p
   set auth_user_id = a.id::text
  from target_profile t, target_account a
 where p.id = t.id
   and p.auth_user_id is null;
```

Both subsections are `where … is null` guarded, so a re-run cannot move a link
that is already in place. After linking, that person signs in normally and sees
their existing attendance; they never need to join with a code.

This is deliberately **not** automatic. Choosing which account owns a history is a
decision about real people, and a migration that guessed at it — for instance by
matching on an email address alone — could hand one student's attendance record to
another.

## 5. Sessions, and one deliberate trade-off

`src/lib/supabase.ts` keeps the session in `localStorage` (`persistSession`),
renews it (`autoRefreshToken`) and finishes email flows that come back as a URL
(`detectSessionInUrl`). A refresh keeps you signed in; signing out clears it and
the app returns to the landing page.

The email flow is left at the library default (implicit) rather than PKCE on
purpose. A PKCE link can only be completed in the browser that requested it, and a
student who asks for a reset on a laptop and opens the mail on their phone would
be locked out with a confusing "link expired". If you would rather have PKCE, set
`flowType: "pkce"` in `src/lib/supabase.ts`, and tell people to open the reset link
in the same browser they asked from.

## 6. What is different about accounts, and what to know

- **Password reset** is a Supabase Auth email link that lands on
  `/reset-password` (`AuthScreen mode="reset"`), takes over the screen until a new
  password is saved, and then returns to the app. A signed-in person can also
  change their password from **Profile → Settings → Password**.
- **A temporary password from the director** is no longer something the app can
  issue: `invite_member` / `reset_member_password` were retired in migration 016
  and their Clerk replacement is gone. `profiles.must_change_password` still
  exists and still shows the AppShell banner, and the Profile screen now clears it
  when the person sets their own password.
- **Removing someone from a roster** sets `memberships.active = false` and, when
  they are on no other roster, `profiles.deactivated = true`. `join_program()`
  refuses a deactivated person, so the code cannot put them back — but their
  *login* is not banned (Clerk's `BanUser` went with Clerk). If you need the
  account itself locked, that is Supabase Auth → Users → the user → **Ban user**.
- **Deleting an account** in Supabase Auth does not delete the profile or the
  attendance. That is intended: the roster and the percentages survive a student
  deleting their login, and a new account can be linked to the same profile later.

## 7. Related surfaces audited

Everything else that could have carried a Clerk assumption was checked, not
assumed:

- **RLS policies and guard triggers** — none name Clerk. All of them compose on
  `current_profile_id()`, which is why 021 is the only schema change. Grep the
  migrations for `clerk` and every hit is a comment.
- **Storage policies** — the `avatars` bucket's four policies (they live in
  `scripts/migrate/sql/reapply_auth_storage.sql`, not in the migration chain) key
  on `(storage.foldername(name))[1] = auth.uid()::text`. That is Supabase-native
  and correct as written: under Clerk it matched nothing, and now it works again
  provided the upload path's first folder segment is the auth user id. Nothing
  uploads yet, so it is dormant.
- **Database functions that read the JWT** — the calendar sync RPC
  (`sync_google_calendar_events`, 017) reads only the `role` claim, which both
  providers set to `authenticated`; `join_program` and `register_signup` are on
  the helper. No function reads a provider-specific claim.
- **Server-side endpoints** — the Clerk frontend proxy is deleted. The
  `sync_google_calendar` Edge Function's source is not in this repository (only
  its deployment steps and the RPC it calls are), so it was audited at its
  documented interface: `verify_jwt = false` with a shared `CALENDAR_SYNC_SECRET`
  and an `isAllowed` check that accepts any signed-in user. That last part is a
  pre-existing weakness recorded in PLATFORM_PLAN §T4 — **not** something this
  migration introduced, and not something it can fix from here. If you want it
  closed, the fix is to require a director or secretary of the target program (or
  the secret) and to redeploy the function.
- **The one thing that got weaker, deliberately:** banning. Clerk's `BanUser` was
  the second lock behind `deactivate_member`; Supabase Auth's equivalent is
  manual (Users → Ban user). See §6.

## 8. Rollback

> **Historical, and prohibited without the owner's explicit approval.** The steps
> below record how the 2026-10-09 migration could have been undone. They are not an
> approved path, none of them has been run, and they must not be executed.
> Supabase Auth is the current and only identity system ([DEV.md §4](DEV.md));
> restoring Clerk, `profiles.clerk_id`, the `/_clerk` rewrite or the Clerk
> environment variables needs the owner's explicit approval.

Migration 021 is additive, so nothing has to be undone for the database to be
consistent. The steps below describe a hypothetical return to Clerk:

1. Restore the previous helper body (this is the exact `013` definition, only the
   column it reads differs — re-run it as one statement):

   ```sql
   create or replace function public.current_profile_id()
   returns uuid language sql stable security definer set search_path = public
   as $$ select p.id from public.profiles p where p.clerk_id = (select auth.jwt() ->> 'sub') $$;
   ```

2. Redeploy a frontend build that still has Clerk (the commit before this
   migration), and restore the Clerk Vercel variables and the `/_clerk` rewrite.
   *(Historical step — not approved.)*
3. `profiles.clerk_id` no longer exists (dropped 2026-10-16, all rows NULL), so a
   rollback to Clerk would have to re-add the column and repopulate it first. Every
   `auth_user_id` stays where it is, so no data is lost either way.

## 9. Verification performed

See the report attached to the change for the raw output. In short:

- `npm run typecheck` and `npm run build` pass, and the built bundle contains no
  Clerk code — the network log from a real page load contains no request to any
  Clerk host.
- **The whole chain was executed** — `007` through `022` applied in order to a
  real PostgreSQL 18 holding the same base the pipeline restores (the dump's
  schema **and** its data, plus stand-ins for the platform objects a hosted
  project provides). Every migration applied, every migration's own verification
  block passed, and 021's assertions on identity resolution, the fail-closed
  cases, `anon` grants and `join_program`'s create/idempotent/refused paths all
  held. Reproduce it with `bash scripts/dev/verify_migrations_locally.sh`.
- **That run found a real defect in 021, now fixed.** 021 redefined
  `register_signup` with its first parameter renamed from `p_clerk_id` to
  `p_auth_user_id`, and `create or replace` refuses to rename an input parameter:
  applying 021 to the real project would have aborted the whole batch with
  `ERROR: cannot change name of input parameter "p_clerk_id"`. 021 now drops the
  old function first (grants are re-issued later in the same file, so nothing is
  lost). The earlier, stub-based check of 021 could not catch this — the conflict
  is only with a function the *restored* schema already defines, which a stub
  does not have. That is why the harness above exists and why it is the check to
  run before touching the live project.
- **Every applicable SQL suite passes** against that database: `create_program`
  (24 assertions over the new self-serve path), `join_program`,
  `ensemble_isolation`, `security_verification_v2` and `backfill_verification`.
  `security_verification.sql` (v1) is skipped, as the pipeline already skips it:
  it declares a legacy-schema precondition and asserts policy names that 015
  deliberately replaced, so it belongs to the pre-migration clone.
- **The auth screens were exercised in a browser against the live Supabase
  project:** `POST /auth/v1/token?grant_type=password` returned a real 400 mapped
  to the friendly message, and `POST /auth/v1/recover?redirect_to=…/reset-password`
  returned 200 into the "Check your email" state.
- **Session restore, routing and sign-out were verified with a synthetic
  session** (a hand-written, unsigned token in `localStorage`): the app restored
  it on reload and switched to the signed-in tree, attached it to its queries
  automatically — the server answered `401` to `profiles` and
  `list_active_programs`, and the app failed closed to the join screen — and
  **Sign out** cleared the stored session and returned to the landing page. That
  proves the wiring and the failure paths; it is deliberately *not* a claim that
  a real login works.
- The SQL suites were re-pointed at `auth_user_id`, so they still assert the same
  19-persona security matrix — and they now actually say so: they run, green, in
  the local harness described above (the earlier note in this file that they had
  not been executed against a database no longer applies).
- **The brand assets changed in the same window** and are unrelated to identity:
  the school's own logo artwork was removed on request and replaced with an
  original placeholder mark. See [`BRAND_ASSETS.md`](BRAND_ASSETS.md).

**Not verified, and not claimed:** no real person has signed in end to end,
because no real account exists yet and email confirmation is on — somebody has to
open the link in a real inbox. Account creation was not submitted either, since
that would write a user into the production project. Creating an account,
confirming the email, joining with a code, and clearing `must_change_password`
from the Profile screen therefore remain to be seen working once, by a human, on
the real deployment. The migration's own checks run when it is applied — that is
the point of §3's rehearsal.
