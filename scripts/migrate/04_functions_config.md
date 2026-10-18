# 04 — Functions & configuration checklist (manual steps)

Everything here configures the **NEW** project only. Nothing in this list is
automated (Supabase dashboard settings aren't fully scriptable); tick each box
and paste evidence into the run log. The OLD project and the old Vercel
deployment stay untouched.

---

## 1. Edge Functions (NEW)

- [ ] `supabase functions deploy sync_google_calendar --project-ref <NEW_PROJECT_REF>`
- [ ] `supabase functions deploy send_signup_reminder --project-ref <NEW_PROJECT_REF>`
- [ ] After applying migration 027, deploy
      `supabase functions deploy invite-student --project-ref <NEW_PROJECT_REF>`.
- [x] Re-deployed `event-digest` with the Resend sender and the new default
      app URL on 2026-10-18 (`--use-api --no-verify-jwt`).
- [x] After applying migration 032, deploy
      `supabase functions deploy event-digest --project-ref <NEW_PROJECT_REF>`.
      Server-to-server only (no CORS): it is called by the cron job in §2, not by
      the browser. **Deployed 2026-10-11** with `--no-verify-jwt --use-api`
      (`[functions.event-digest] verify_jwt = false` in `supabase/config.toml`):
      the cron call carries no `Authorization` header, so the platform check has
      to be off and the function authorises the call itself.
- [ ] Function secrets (`supabase secrets set … --project-ref <NEW_PROJECT_REF>`, values never logged):
  - [x] `RESEND_API_KEY` (a sending-only key, separate from the auth relay's)
        — set 2026-10-18
  - [x] `RESEND_FROM` = `noreply@rhsattendance.org` (on the verified domain)
        — set 2026-10-18
  - [x] `EVENT_DIGEST_SECRET` (long random value; the digest cron job sends it as
        the `x-event-digest-secret` header and the function refuses to run
        without it) — set 2026-10-18; also write it into Vault when scheduling
  - [x] `DIGEST_FROM_NAME` = `RHS Music & Arts` — set 2026-10-18
  - [x] `PUBLIC_APP_URL` = `https://rhsattendance.org` — set 2026-10-18
  - [ ] `GOOGLE_CALENDAR_ICS_URL` (the RHS Band public ICS feed)
  - [ ] `CALENDAR_SYNC_SECRET` (long random value for scheduled sync calls)
- [ ] Note: `sync_google_calendar` currently runs with `verify_jwt = false` and
      accepts any signed-in user. Tightening to staff-only is **Phase 3 work**
      (docs/PLATFORM_PLAN.md §6 #4) — known and accepted for the clone window.

## 2. Schedules (cron)

- [ ] On OLD (read-only), inspect existing jobs:
      `psql "$OLD_DB_URL" -c "select jobid, schedule, command from cron.job order by jobid"`
- [x] On NEW, enable `pg_cron` + `pg_net` (Dashboard → Database → Extensions, or
      the SQL below). Both were enabled on the live project on **2026-10-11**
      (`pg_cron` 1.6.4, `pg_net` 0.20.4). Before that `cron.job` was empty: there
      was no schedule on NEW at all, not even the calendar sync.

      ```sql
      create extension if not exists pg_cron with schema pg_catalog;
      grant usage on schema cron to postgres;
      grant all privileges on all tables in schema cron to postgres;
      create extension if not exists pg_net;
      ```
- [ ] Recreate each job, e.g. the calendar sync (secret header set):
      `select cron.schedule('google-calendar-sync', '*/5 * * * *', $$
         select net.http_post(url := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/sync_google_calendar',
           headers := jsonb_build_object('x-calendar-sync-secret', '<CALENDAR_SYNC_SECRET>', 'Content-Type', 'application/json'),
           body := '{}');
      $$);`
- [ ] Recreate any `send_signup_reminder` schedule if one existed on OLD (check `cron.job` output above).
- [x] **Event digest** — one email a day per member with something in the next
      week, at **5pm Pacific**: `0 0 * * *` UTC, which is 5pm PDT / 4pm PST. A
      fixed UTC time drifts an hour across daylight saving — `0 1 * * *` holds
      5pm through standard time instead. `pg_cron` + `pg_net` were enabled on the
      live project on 2026-10-11 (`cron.job` was empty: there was no schedule on
      NEW at all, not even the calendar sync).

      The job reads the shared secret from **Vault** rather than embedding it:
      `cron.job` stores its command as plain text, and Supabase's own guidance is
      not to put a key in there.

      ```sql
      select vault.create_secret('<EVENT_DIGEST_SECRET>', 'event_digest_secret',
        'x-event-digest-secret header for the event-digest cron job');

      select cron.schedule('event-digest', '0 0 * * *', $$
        select net.http_post(
          url := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/event-digest',
          headers := jsonb_build_object(
            'x-event-digest-secret',
            (select decrypted_secret from vault.decrypted_secrets
              where name = 'event_digest_secret'),
            'Content-Type', 'application/json'),
          body := '{"days": 7}'::jsonb);
      $$);
      ```

      Before scheduling it, run it once by hand with `{"days": 7, "dry_run":
      true}` and read the JSON — it reports every recipient, subject and event and
      sends nothing. Send it with the shared secret, not a service-role bearer:
      this project's legacy `service_role` JWT presentation
      (`Authorization: Bearer …`) is rejected with `401` by the deployed function
      (observed 2026-10-11), while the `x-event-digest-secret` header is the path
      the cron job uses:

      ```bash
      curl -sS -X POST "https://<NEW_PROJECT_REF>.supabase.co/functions/v1/event-digest" \
        -H "Content-Type: application/json" \
        -H "x-event-digest-secret: <EVENT_DIGEST_SECRET>" \
        -d '{"days": 7, "dry_run": true}'
      ```

      Then run it once for real (`{"days": 7}`) and confirm the
      emails arrive and `select count(*) from public.event_digest_deliveries`
      rises. Running it twice in a row must email nobody the second time: that is
      the once-per-day key doing its job.

## 3. Auth configuration — Supabase Auth

**Supabase Auth is the app's sign-in system** (migration 021): it owns accounts and
sessions, and the JWT it issues is what every RLS policy resolves identity from.
These settings are live configuration, not a legacy fallback. Section 4 is the
cutover checklist.

- [ ] Site URL: the new production URL (Vercel) + `http://localhost:5173` for dev.
- [ ] Redirect URLs: `<app>/reset-password` (the password-recovery landing — see
      the `redirectTo` in `src/hooks/useAuth.tsx`), plus `<app>/*`.
- [x] SMTP: Resend's relay — host `smtp.resend.com`, port `587`, user
      `resend`, password a Resend API key, sender
      `noreply@rhsattendance.org` (the domain verified in Resend). Set live on
      2026-10-18; `supabase config.toml` now mirrors it. Never commit the key
      (docs/EMAIL_SETUP.md §3).
- [ ] Authentication email templates: copy the 6 from `supabase/templates/` (confirmation,
      recovery, invite, magic_link, email_change, reauthentication) into
      Dashboard → Auth → Email Templates (subjects + HTML).
- [ ] Apply `supabase/migrations/027_program_email_invites.sql` before enabling
      the program-staff invite form in a deployment; run
      `supabase/tests/program_email_invites.sql` to verify its database behavior.
- [ ] Password-change security notification: enable it in Dashboard → Auth →
      Notifications and set its subject + HTML from `password_changed_notification.html`.
- [ ] Confirm email ON (as configured on OLD), and verify one test signup +
      one test password reset end to end.

## 4. Auth configuration — cutover checklist

Verify each step with a real sign-in against the NEW project.

- [ ] Authentication → Providers → **Email** enabled, **Confirm email ON** (as
      configured on OLD). The app's sign-up shows "check your email" when a
      confirmation is required, and sign-in refuses an unconfirmed account with a
      resend action.
- [ ] Authentication → URL Configuration → **Site URL**: the production Vercel
      origin, and `http://localhost:5173` for dev.
- [ ] Authentication → URL Configuration → **Redirect URLs**: the production
      origin, the dev origin, and `<origin>/reset-password` on both — a recovery
      link lands there (`redirectTo` in `src/hooks/useAuth.tsx`) and the app
      refuses to apply one without a session.
- [ ] **Ordinary signups do not create profiles or memberships via an
      `auth.users` trigger.** The join code is validated in the app by
      `join_program()` (migration 020) *after* the account exists. Migration 027
      adds a narrowly scoped email-confirmation trigger that enrolls only a
      student with a matching pending director invitation; it does not replace
      the ordinary join flow.
- [ ] Frontend env (Vercel + local `.env.local`): `VITE_SUPABASE_URL` and
      `VITE_SUPABASE_ANON_KEY` from the NEW project. There is no auth-provider
      variable any more.
- [ ] Verify end to end: sign in; a refresh keeps the session; sign out clears it;
      a wrong join code cannot get a profile; the forgot-password email arrives
      and lands on `/reset-password` with a working new-password form.

## 5. Vercel & PWA (old deployment untouched)

- [ ] New Vercel project for the new app (don't touch `rhs-band.vercel.app`).
- [ ] When the new frontend deploys (Phase 3b/4): bump the service-worker cache
      name so installed PWAs refresh cleanly at cutover.
- [ ] Smoke test the installed PWA on a phone after the env swap.

## 6. Rollback readiness

- [ ] OLD project + old Vercel deployment confirmed unchanged and healthy.
- [ ] `.env` in a safe place (gitignored — back it up to a password manager, not git).
- [ ] `scripts/migrate/out/` dumps retained until the post-cutover monitoring
      checklist completes (they contain password hashes — keep them private).
- [ ] Rotate the Supabase **personal access token** used for this migration
      (it transited chat) once the pipeline is finished.
