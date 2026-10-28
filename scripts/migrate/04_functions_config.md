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
  - [x] `CALENDAR_SYNC_SECRET` (long random value for scheduled sync calls)
        — set 2026-10-27 for `sync-google-calendars`; see §2
- [x] **Done 2026-10-20** — after applying migration 036, deploy the two event-email functions:
      `supabase functions deploy event-reminders --project-ref <NEW_PROJECT_REF> --no-verify-jwt --use-api`
      and
      `supabase functions deploy send-makeup-emails --project-ref <NEW_PROJECT_REF> --use-api`.
      `event-reminders` is server-to-server only (no CORS); it refuses every call
      without the `x-event-reminder-secret` header. `send-makeup-emails` is
      browser-invoked, keeps `verify_jwt = true`, and re-checks the caller's
      staff capability in the database.
- [x] **Done 2026-10-20** — add `EVENT_REMINDER_SECRET` to the function secrets (long random value;
      the reminder cron job sends it as `x-event-reminder-secret`). The two new
      functions reuse the existing `RESEND_API_KEY`, `RESEND_FROM` and
      `PUBLIC_APP_URL`; `REMINDER_FROM_NAME` / `MAKEUP_FROM_NAME` are optional
      and default to `RHS Music & Arts`.
- [x] **Done 2026-10-20** — after applying migration
      `20261019120000_event_announcements.sql`, deploy the new-event announcement
      sender:
      `supabase functions deploy event-announcements --project-ref <NEW_PROJECT_REF> --no-verify-jwt --use-api`.
      Server-to-server only (no CORS): it refuses every call without the
      `x-event-announcement-secret` header or the exact service-role bearer.
      `[functions.event-announcements] verify_jwt = false` in `supabase/config.toml`.
- [x] **Done 2026-10-20** — add `EVENT_ANNOUNCEMENT_SECRET` to the function secrets (long random value;
      the announcement cron job in §2 sends it as `x-event-announcement-secret`).
      The function reuses `RESEND_API_KEY`, `RESEND_FROM` and `PUBLIC_APP_URL`;
      `ANNOUNCEMENT_FROM_NAME` is optional and defaults to `RHS Music & Arts`.
- [x] **Done 2026-10-24** — after applying migration
      `20261024223123_absence_request_emails.sql`, deploy the absence-review
      sender:
      `supabase functions deploy absence-request-emails --project-ref <NEW_PROJECT_REF> --no-verify-jwt --use-api`.
      Server-to-server only (no CORS): it refuses every call without the
      `x-absence-request-email-secret` header or the exact service-role bearer.
      `[functions.absence-request-emails] verify_jwt = false` in
      `supabase/config.toml`.
- [x] **Done 2026-10-24** — add `ABSENCE_REQUEST_EMAIL_SECRET` to the function
      secrets (long random value; the absence-email cron job in §2 sends it as
      `x-absence-request-email-secret`). The function reuses `RESEND_API_KEY`,
      `RESEND_FROM` and `PUBLIC_APP_URL`; `ABSENCE_FROM_NAME` is optional and
      defaults to `RHS Music & Arts`.
- [ ] Note: `sync_google_calendar` currently runs with `verify_jwt = false` and
      accepts any signed-in user. Tightening to staff-only is **Phase 3 work**
      (docs/PLATFORM_PLAN.md §6 #4) — known and accepted for the clone window.
      **Superseded 2026-10-27:** that function is not in this tree. The scheduled
      pull is `sync-google-calendars` (below); the staff-facing path is
      `import-google-calendar`, which authenticates the caller and checks
      `attendance.manage_events`.
- [x] **Done 2026-10-27** — deployed the repeating calendar sync, so an event
      added, edited or deleted in Google reaches the app without anyone pressing
      Import:
      `supabase functions deploy sync-google-calendars --project-ref <NEW_PROJECT_REF> --no-verify-jwt --use-api`.
      Server-to-server only (no CORS): it refuses every call without the
      `x-calendar-sync-secret` header or the exact service-role bearer.
      `[functions.sync-google-calendars] verify_jwt = false` in `supabase/config.toml`.
      No migration: it reads `calendar_sources` and writes through the existing
      `sync_google_calendar_events` RPC.
- [x] **Done 2026-10-27** — `CALENDAR_SYNC_SECRET` (64 hex characters) set as a
      function secret and stored in Vault; the sync cron job sends it as
      `x-calendar-sync-secret`. It sends no mail, so it needs no Resend settings.
- [ ] **Added 2026-10-27** — re-deploy `import-google-calendar` once too. Its
      ICS fetch/parse code moved to
      `supabase/functions/_shared/google-calendar.ts` (shared with the sync), and
      it gains a bounded retry for Google's `429`/`503`, the throttle that made
      imports fail on the first attempt:
      `supabase functions deploy import-google-calendar --project-ref <NEW_PROJECT_REF> --use-api`.

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
- [ ] ~~Recreate each job, e.g. the calendar sync (secret header set)~~ — that
      snippet called `functions/v1/sync_google_calendar`, which this tree no longer
      contains. Use **Repeating calendar sync** below instead.
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

### Event reminders (migration 036)

- [x] **Done 2026-10-20** — store the reminder secret in **Vault** (never in
      `cron.job` plain text):

      ```sql
      select vault.create_secret('<EVENT_REMINDER_SECRET>', 'event_reminder_secret',
        'x-event-reminder-secret header for the event-reminders cron job');
      ```

- [x] **Done 2026-10-20** (`event-reminders`, job 1; `cron.job` was empty before
      it) — schedule it **every 15 minutes**. The sender computes “48 hours
      before” from `events.date`, so a 15-minute cadence is the maximum lateness
      (and a reminder is skipped entirely if the job runs so late that under 12
      hours remain):

      ```sql
      select cron.schedule('event-reminders', '*/15 * * * *', $$
        select net.http_post(
          url := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/event-reminders',
          headers := jsonb_build_object(
            'x-event-reminder-secret',
            (select decrypted_secret from vault.decrypted_secrets
              where name = 'event_reminder_secret'),
            'Content-Type', 'application/json'),
          body := '{}'::jsonb);
      $$);
      ```

- [x] **Done 2026-10-20** — before scheduling, run it once by hand with `{"dry_run": true}` and read
      the JSON. Nothing is sent; it names every due student, subject and event:

      ```bash
      curl -sS -X POST "https://<NEW_PROJECT_REF>.supabase.co/functions/v1/event-reminders" \
        -H "Content-Type: application/json" \
        -H "x-event-reminder-secret: <EVENT_REMINDER_SECRET>" \
        -d '{"dry_run": true}'
      ```

      Then confirm one real run and that
      `select count(*) from public.event_reminder_deliveries` rises. A second
      run for the same schedule must send nothing.

### New-event announcements (migration 20261019120000)

- [x] **Done 2026-10-20** — store the announcement secret in **Vault** (never in
      `cron.job` plain text):

      ```sql
      select vault.create_secret('<EVENT_ANNOUNCEMENT_SECRET>', 'event_announcement_secret',
        'x-event-announcement-secret header for the event-announcements cron job');
      ```

- [x] **Done 2026-10-20** (`event-announcements`, job 2) — schedule it **every 5
      minutes**, so a newly added event is announced within
      a few minutes of Save. The queue only holds events that are still to come
      and after the cutover, so an old calendar is never mailed:

      ```sql
      select cron.schedule('event-announcements', '*/5 * * * *', $$
        select net.http_post(
          url := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/event-announcements',
          headers := jsonb_build_object(
            'x-event-announcement-secret',
            (select decrypted_secret from vault.decrypted_secrets
              where name = 'event_announcement_secret'),
            'Content-Type', 'application/json'),
          body := '{}'::jsonb);
      $$);
      ```

- [x] **Done 2026-10-20** — before scheduling, run it once by hand with
      `{"dry_run": true}` and read the
      JSON. Nothing is sent; it names every due student, event and subject:

      ```bash
      curl -sS -X POST "https://<NEW_PROJECT_REF>.supabase.co/functions/v1/event-announcements" \
        -H "Content-Type: application/json" \
        -H "x-event-announcement-secret: <EVENT_ANNOUNCEMENT_SECRET>" \
        -d '{"dry_run": true}'
      ```

- [ ] Still to verify with real data: add one event in the app (not a synthetic
      row) and confirm exactly one row per student in
      `public.event_announcement_deliveries` with `status = 'sent'`. A second run
      must send nothing. Not done on 2026-10-20 to avoid mailing the roster as a
      test.

### Repeating calendar sync (added 2026-10-27)

- [x] **Done 2026-10-27** — sync secret stored in **Vault** (never in `cron.job`
      plain text):

      ```sql
      select vault.create_secret('<CALENDAR_SYNC_SECRET>', 'calendar_sync_secret',
        'x-calendar-sync-secret header for the google-calendar-sync cron job');
      ```

- [x] **Done 2026-10-27** (job 4) — scheduled **every 15 minutes**, so a Google
      Calendar change shows up in
      the app within a quarter of an hour. The cadence is deliberately modest:
      Google throttles the anonymous `basic.ics` endpoint per IP and the Edge
      runtime's egress is shared, which is exactly the `429` this project already
      hit. The function retries a throttled or unavailable feed twice with backoff
      before reporting it.

      ```sql
      select cron.schedule('google-calendar-sync', '*/15 * * * *', $$
        select net.http_post(
          url := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/sync-google-calendars',
          headers := jsonb_build_object(
            'x-calendar-sync-secret',
            (select decrypted_secret from vault.decrypted_secrets
              where name = 'calendar_sync_secret'),
            'Content-Type', 'application/json'),
          body := '{}'::jsonb,
          -- 5s is pg_net's default: it cuts the run off mid-fetch and records a
          -- NULL response while cron.job_run_details still says "succeeded".
          timeout_milliseconds := 120000);
      $$);
      ```

- [x] **Done 2026-10-27** — ran the hand check with `{"dry_run": true}`. It
      fetches and parses every connected feed and writes nothing:

      ```bash
      curl -sS -X POST "https://<NEW_PROJECT_REF>.supabase.co/functions/v1/sync-google-calendars" \
        -H "Content-Type: application/json" \
        -H "x-calendar-sync-secret: <CALENDAR_SYNC_SECRET>" \
        -d '{"dry_run": true}'
      ```

      Each result names the program, the event count and, if the feed failed, why
      (a made-private calendar answers `404`; a throttled one `429`). A dry run
      answers `200` with `ok: false` when any feed is broken, so read `results`,
      not just the status.

      **Observed 2026-10-27:** the first calls from the deployed function answered
      `429` for both connected feeds while the same two addresses returned `200`
      from an ordinary connection — Google throttles this endpoint **by IP**, and
      the Edge runtime's egress is shared. A named `User-Agent` did not change it.
      What did clear it: stop retrying the `429` inside the run. A throttled
      address stays throttled for minutes, so three attempts per feed only spent
      more of the same budget; the function now makes one request per feed, stops
      the run at the first `429`, and lets the next quarter hour retry. The next
      run then reported `146` and `109` events updated with nothing archived.
      If every run fails for hours, the egress address is the cause, not the feed
      or the URL — do not “fix” the calendar settings.

- [ ] Then one real run, and confirm in the app: add an event in Google Calendar,
      wait for the next quarter hour, and check it appears on the Calendar screen
      under the right program. Deleting it in Google must archive it in the app on
      the following run (archive, never delete — attendance history keeps the row),
      and `select last_synced_at from public.calendar_sources` must advance.
      Nothing is mailed by this job: the sync RPC sets
      `app.suppress_event_notifications`.

      **Verified 2026-10-27 (data path):** a throwaway program drove the whole
      loop through `sync_google_calendar_events`. An event added to the feed was
      inserted with its type-derived attendance (`rehearsal` → required, QR); an
      edit kept the **same `events.id`** and updated name, date and location in
      place; a cancelled event was archived, not deleted, and its row was left
      intact; an empty feed archived nothing. The throwaway program and its rows
      were removed afterwards — 0 leftovers, and the band's 255 active synced
      events plus 8 archived were unchanged. Still unconfirmed: the same three
      steps typed into the Google Calendar UI itself, which needs access to the
      school's calendar.

### Absence-request review emails (migration 20261024223123)

- [x] **Done 2026-10-24** — store the absence-email secret in **Vault** (never in
      `cron.job` plain text):

      ```sql
      select vault.create_secret('<ABSENCE_REQUEST_EMAIL_SECRET>', 'absence_request_email_secret',
        'x-absence-request-email-secret header for the absence-request-emails cron job');
      ```

- [x] **Done 2026-10-24** (`absence-request-emails`, job 3) — schedule it **every
      5 minutes**, so a request reaches the reviewer within a few minutes of
      being submitted. The queue only holds requests that are
      still pending and after the cutover, so an existing backlog is never
      mailed:

      ```sql
      select cron.schedule('absence-request-emails', '*/5 * * * *', $$
        select net.http_post(
          url := 'https://<NEW_PROJECT_REF>.supabase.co/functions/v1/absence-request-emails',
          headers := jsonb_build_object(
            'x-absence-request-email-secret',
            (select decrypted_secret from vault.decrypted_secrets
              where name = 'absence_request_email_secret'),
            'Content-Type', 'application/json'),
          body := '{}'::jsonb);
      $$);
      ```

- [x] **Done 2026-10-24** — before scheduling, run it once by hand with
      `{"dry_run": true}` and read the JSON. Nothing is sent; it names every due
      reviewer, request and subject:

      ```bash
      curl -sS -X POST "https://<NEW_PROJECT_REF>.supabase.co/functions/v1/absence-request-emails" \
        -H "Content-Type: application/json" \
        -H "x-absence-request-email-secret: <ABSENCE_REQUEST_EMAIL_SECRET>" \
        -d '{"dry_run": true}'
      ```

- [ ] Still to verify with real data: submit one real absence request in the
      app and confirm exactly one row per reviewer in
      `public.absence_request_email_deliveries` with `status = 'sent'`. A second
      run must send nothing.

- [ ] **Vercel Cron is not used here.** The deployment in `vercel.json` is a
      static SPA rewrite: there is no `api/` directory, no build step on Vercel
      that could run a job, and the project already schedules its mail through
      Supabase Cron (`pg_cron` + `pg_net`). Adding a Vercel cron would create a
      second scheduler with no database clock and no shared idempotency key.
      The 15-minute job above is the production scheduler.

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
