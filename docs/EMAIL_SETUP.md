# Auth email setup (the emails Supabase sends)

Sign-in is Supabase Auth (`docs/AUTH_MIGRATION.md`), so **Supabase sends every
account email in this app** — confirmation, password reset, invite, magic link,
email change, reauthentication, and enabled security notifications. Their
wording and layout live in `supabase/templates/`, wired up by
`supabase/config.toml`.

Supabase Auth triggers every account email and hands delivery to **Resend's
SMTP relay** (§3). The app also sends one email of its own — the upcoming-events
digest — through Resend's **API** (§6a). The server-side Edge Function that
requests student invitations never exposes its service-role key to the browser,
and changing a subject line or template does not require a frontend redeploy.

The program-staff invite flow is backed by migration
`supabase/migrations/027_program_email_invites.sql` and the
`invite-student` Edge Function. Apply the migration and deploy the function
before enabling the invitation form in a production frontend; see
`scripts/migrate/04_functions_config.md`.

---

## 1. Which email fires when

| Email | Fires when | Template | The action it carries |
| --- | --- | --- | --- |
| Confirmation | Someone signs up (`supabase.auth.signUp`), or asks for the link again from the sign-in screen | `confirmation.html` | `{{ .ConfirmationURL }}`, with `{{ .Token }}` as the typed fallback |
| Recovery | Someone taps **Forgot your password?** (`resetPasswordForEmail`) | `recovery.html` | `{{ .ConfirmationURL }}` → lands on `/reset-password`; `{{ .Token }}` fallback |
| Invite | Program staff invite a new student from the roster (`auth.admin.inviteUserByEmail`) | `invite.html` | `{{ .ConfirmationURL }}`; accepting and confirming the invite adds the student to that program |
| Magic link | A passwordless sign-in is requested (`signInWithOtp`) | `magic_link.html` | `{{ .ConfirmationURL }}`; `{{ .Token }}` fallback |
| Email change | The address on an account is changed | `email_change.html` | `{{ .ConfirmationURL }}`, naming `{{ .Email }}` and `{{ .NewEmail }}` |
| Reauthentication | A security-sensitive change asks the person to prove themselves again | `reauthentication.html` | `{{ .Token }}` only — a code, not a link |
| Password changed notification | A user's password changes | `password_changed_notification.html` | `{{ .Email }}` and `{{ .SiteURL }}`; enable the notification in Supabase Auth |
| Email address changed notification | The address on an account **actually changes** — not the request to confirm a new one | `email_changed_notification.html` | `{{ .OldEmail }}`, `{{ .Email }}` (the new address) and `{{ .SiteURL }}`; enable the notification in Supabase Auth |

Security notifications are separate from the authentication emails above and
must be enabled in the Supabase project before they are sent. Both the
password-changed and email-changed notifications are enabled in this
repository's `supabase/config.toml` and on the live project. The email-change
*confirmation request* is a different email (`email_change.html`); the
notification covered here is the one sent after the swap succeeds. Only the
variables in the table above are used; they are documented Supabase variables.

## 2. Applying them

Templates are not deployed by the frontend build — they are configuration.
**Do not run `supabase config push` on this project.** `supabase config diff` on
2026-10-18 found 19 settings that exist only remotely — Google sign-in, TOTP
MFA, the security-notification toggles and a 1000/hour email rate limit among
them. A push replaces the remote auth configuration with this file's defaults,
which would turn Google sign-in off and drop the email limit to 2/hour.
`supabase/config.toml` is a record of intent, not a push source.

**Dashboard.** Authentication → Emails → Templates: paste the subject from
`supabase/config.toml` and the contents of the matching file. For the security
notifications, open the project's Auth notification settings and enable both
**Password changed** and **Email address changed**, then set each subject and
paste its file:

- `supabase/templates/password_changed_notification.html`
- `supabase/templates/email_changed_notification.html`

Notification enablement is project-level; saving a template alone does not turn
it on. The same settings can be applied with the Management API
(`PATCH /v1/projects/<ref>/config/auth`), which changes only the fields sent —
that is how SMTP, the redirect URLs and both notifications were set on
2026-10-18. Keep this file in step by hand afterwards.

**Template drift, as of 2026-10-18.** The live project matches this repository
for **confirmation**, **password changed** and **email address changed**
(`confirmation.html`, `password_changed_notification.html`,
`email_changed_notification.html`), all applied through the Management API. The
remaining branded templates are **not** applied on purpose: `recovery.html` and
`magic_link.html` tell the reader to type the code, and the app has no code path
for those flows yet — applying them would promise something that does not work.
`email_change.html` (the request to confirm a new address) and the invite and
reauthentication templates still need their matching screens checked before they
are applied.

If preview and production are separate Supabase projects, apply this to **both**.
They are separate environments; an email template is not inherited.

## 3. SMTP: Resend, from rhsattendance.org

Auth mail goes through **Resend's SMTP relay**, from the domain
`rhsattendance.org` verified in Resend's dashboard. It is not Supabase's
built-in sender, and not Brevo or SendGrid. The settings:

| Setting | Value |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `587` (STARTTLS; `465` implicit TLS and `2465`/`2587` also work) |
| Username | `resend` — that literal string, not an address |
| Password | a Resend **API key** (Resend has one credential type) |
| Sender email | `noreply@rhsattendance.org` |
| Sender name | `RHS Music & Arts` |

`supabase/config.toml` carries the same block with
`pass = "env(RESEND_API_KEY)"`, so the key never enters git. The live project
was set through the Management API; use the dashboard or that API for future
changes, and do not `config push` (see §2).

Resend refuses any From address whose domain is not verified in its dashboard,
so verify `rhsattendance.org` there and add the DNS records it asks for (SPF,
DKIM, and the MX/return-path record). Those records are not what makes sending
work — they are what keeps the mail out of spam, which is the difference between
a confirmation a student finds and one they do not. Resend's free tier is 3,000
messages a month / 100 a day — enough for sign-ups, but the digest shares that
quota (§6a). Supabase still applies its own auth-email rate limit
(`GOTRUE_RATE_LIMIT_EMAIL_SENT`, 30 an hour by default), so a whole class
signing up at once can still wait.

### Reading a failure

What a student sees when the transport fails is the same sentence on the phone:
**Create account** answers `Error sending confirmation email`, and **Forgot your
password?** fails the same way, because both go through the same transport. The
app maps it to plain language in `src/hooks/useAuth.tsx` (before that it was
shown verbatim, which reads like the student's mistake), but the sentence cannot
tell you *why*. The auth log can, and it carries the transport's own answer
under `error`. History from this project, still useful for reading the codes:

```
# 2026-10-16 — SendGrid account out of credits (trial ended, no free plan since May 2025)
path: /signup    status: 500   error_code: unexpected_failure
error: 451 "Authentication failed: Maximum credits exceeded"

# 2026-10-17 — the same request after moving the relay to Brevo
path: /recover   status: 200   (no `error` field at all)

# 2026-10-17 19:32Z — custom SMTP off, built-in sender, accepted
mail_from: noreply@mail.app.supabase.io   mail_to: <owner address>   mail_type: recovery
```

`451` is a provider refusing on billing; `535` is credentials (with Resend, a
revoked or wrong API key); a `550` naming the sender means the From address is
not on the verified domain. None of those is a code bug, and all of them are one
identical sentence on the student's phone. Resend's dashboard → Emails shows
each send and the exact rejection, which is often quicker than the auth log.

The built-in sender and the Brevo/SendGrid relays above are history, not
fallbacks: GoTrue does not retry or reroute. Whichever transport is configured
either accepts the message or the request fails, which is why this repository
declares the transport it means to keep.

**The one route that needs no email:** *Continue with Google*. The school
addresses are Google Workspace accounts, the Google provider is enabled, and
OAuth accounts arrive already confirmed — a student can get in that way while a
transport problem is being sorted. That is a workaround, not the fix:
email/password sign-up and password reset stay broken for everyone until mail
actually leaves.

That matters more here than in most apps, because **a new account cannot sign in
until it confirms its address**. Even with a working transport, a class signing
up together can hit the per-hour limit, and the confirmations will not arrive.

If an invitation fails with "Error sending invite email," it is the
`invite-student` function's call to `auth.admin.inviteUserByEmail` — that goes
through this same auth transport, not the digest's API key. Check that
`noreply@rhsattendance.org` is on the verified domain and read the auth log
before retrying.

**No application code changes when SMTP is configured.** The templates, the
subjects, the redirect URLs and every call in `src/hooks/useAuth.tsx` stay
exactly as they are; only the transport changes. A failed send is a transport
problem until the auth log says otherwise — start there, not in `src/`.

**Two transports, one provider.** Auth mail uses Resend's SMTP relay (this
section). The upcoming-events digest calls Resend's **API** with its own key and
sender (§6a). They are independent calls: a digest failure does not stop
sign-ups, and the digest does not go through SMTP. Use a **separate Resend API
key** for the digest so either can be revoked without breaking the other — the
`RESEND_API_KEY` in `supabase/config.toml` is the auth relay's, while the
function secret of the same name belongs to the digest.

## 4. Redirect URLs

Authentication → URL Configuration:

- **Site URL** — the production origin.
- **Redirect URLs** — that origin, **`<origin>/reset-password`**, and
  `http://localhost:5173/**` for development.

A destination that is missing from that list is silently rewritten to the Site
URL, which opens the home page instead of the reset form and looks like the link
was broken. `docs/AUTH_MIGRATION.md` §3 has the same checklist next to the
migration that depends on it.

## 5. Testing it honestly

- **Locally:** `supabase start` runs a mail catcher alongside the local stack.
  Open the local mailbox (port 54324) and you can read every message the local
  project sends without touching a real inbox.
- **In production:** use a real address you control, and make it a school
  address — that is what a student will experience, and Resend will deliver to
  it. Sign up, open the confirmation, then run the password-reset flow end to
  end. Check it **arrives in the inbox** — not just in spam — and that Resend's
  dashboard → Emails lists the send. Also check the link opens
  `/reset-password`, not the home page (§4), and verify that a successful
  password change sends the password-changed notification.
- A confirmation that arrives but whose link does nothing is almost always a
  redirect-URL problem, not a template one. A missing subject line means the
  template was saved without its subject.
- **A confirmation link is single-use, and it and `{{ .Token }}` are the same
  one-time pass.** A mail-security scanner, a link preview, a second tap — or
  the person typing the code after opening the link — spends it; the next
  request lands on the Site URL with `#error=access_denied&error_code=otp_expired`,
  while the account is already confirmed and password sign-in works. The app
  catches that code, sends the person to `/sign-in`, and says so. Typing a spent
  code is treated as *that* — not as a wrong code: if a password is already in
  the form, the app signs the person in with it rather than showing an error.
  The code panel asks for the email address before calling the server, because
  `verifyOtp` without one answers with the raw sentence "Only an email address or
  phone number should be provided on verify". This project's `mailer_otp_length`
  is **8**, not the default 6, so the field accepts 4–10 digits — do not hardcode
  a length.

## 6. What this does not cover

The in-app notification bell — the `notifications` table and its SQL triggers —
stays in-app, but two of its triggers now also reach a mailbox: a new event
(§6d) and a student's absence request (§6e). Emailing the bell's remaining
trigger (a check-in opening) is still not built: a check-in is live for minutes,
so it belongs in the bell, not in a mailbox.

## 6a. App email: the upcoming-events digest

This app now sends one email of its own (migration 032 + the `event-digest` edge
function): at most one a day per person, listing the next week's events across
every program they belong to. It goes through Resend's **API**
(`api.resend.com/emails`), with its own key and sender — a *different*
transport from the auth relay in §3, even though both are Resend.

- **Who is owed one** — `public.due_event_digests()` returns the members who are
  active, subscribed, have a confirmed address, are not deactivated, and have at
  least one event in the window with no delivery logged for today. Nobody else:
  an opted-out member, an unconfirmed address and a quiet program all produce no
  row. It returns email addresses, so it is **service-role only** and no client
  can call it.
- **Not sending twice** — `public.record_event_digests()` logs the run against
  (member, program, day). A retried or overlapping job is therefore a no-op.
  A send that *fails* is deliberately not logged, so the next run offers that
  person again rather than dropping them silently.
- **Turning it off** — Account settings → Preferences → *Upcoming events by
  email*, one switch per program (`set_email_upcoming_events()`). A student in
  band and orchestra can quiet one without losing the other. The in-app bell is
  unaffected either way.
- **Seeing who it reaches** — Roster → *Upcoming-events email*, for staff of
  that program only: how many active members the email can reach, and the reason
  each of the rest is skipped (`digest_reachability()`, migration 033). It
  reports the *state* of an address — confirmed, unconfirmed, absent — and never
  the address itself. "Reachable" and "will get an email this week" are different
  questions, and the card says which one it is answering: a quiet week, an
  archived program and a program nobody can be reached in all read differently.
- **Secrets** — `EVENT_DIGEST_SECRET` (the cron job sends it as
  `x-event-digest-secret`; without it set the function refuses to run), plus
  `RESEND_API_KEY` and `RESEND_FROM`, and optionally `DIGEST_FROM_NAME` and
  `PUBLIC_APP_URL`. These are Resend **API** credentials for
  `api.resend.com`, *not* the SMTP username, key and sender above — and they
  should be a **different API key**, so the digest can be revoked without
  stopping sign-ups. All five are set on the live project as of **2026-10-18**
  (a sending-only `event-digest` key), and the Resend sender code is deployed.
  The local source for them is `.env.event-digest` (gitignored);
  `supabase secrets set --env-file .env.event-digest` re-applies the same values.
- **The schedule** — a Supabase Cron job, like the calendar sync. The exact
  statement is in `scripts/migrate/04_functions_config.md` §2. `pg_cron` and
  `pg_net` **are** enabled on the live project (checked 2026-10-17), but
  `cron.job` is empty — no digest run is scheduled. Create the job only after
  the secrets above exist, or it will fire and 401 against itself.
- **Quota, and why it can break sign-ups** — the free Resend account sends 100
  messages a day, and **auth mail and the digest share that quota**. The digest
  will mail up to `MAX_RECIPIENTS` (500) people in one run, so a roster past 100
  would spend the day's allowance before a student's confirmation leaves. With
  more than ~100 reachable members, move Resend to a paid tier before scheduling
  the digest; until then the weekly run is the thing that gets sent, not the
  sign-up.
- **Current state** — migration 032 is applied and the `event-digest`
  function is deployed with the Resend sender (`verify_jwt = false`, authorised
  by `x-event-digest-secret`). A dry run on 2026-10-18 returned `ok: true`; no
  member was due a digest in that window. Nothing can be mailed until the cron
  job below exists, and that is deliberate until the quota question is settled.
- **Testing it honestly** — call it with `{"dry_run": true}` and the
  `x-event-digest-secret` header: the JSON names every recipient, subject and
  event and sends nothing. A service-role bearer is not a substitute — the
  deployed function rejects one with `401`.
  `node scripts/dev/check_event_digest.mjs` checks the sender's logic locally
  with no network at all.

## 6b. App email: the 48-hour event reminder

Migration 036 + the `event-reminders` edge function add a second scheduled app
email: **exactly one reminder per student per event schedule, due 48 hours
before the event starts.** It uses the same Resend API transport as the digest
(§6a), not the auth SMTP relay.

- **Who is due** — `public.due_event_reminders(now)` returns active members of
the event's program who are active, subscribed (`email_upcoming_events`), not
deactivated, have a confirmed address, and hold a student role (not director or
secretary). The event must be active, not archived, in the future, **at most 48
hours away and at least 12 hours away**, and it must have existed before its own
48-hour mark. All of that is one SQL query, so the sender cannot drift from it.
- **48 hours is an instant.** Event times are `timestamptz`; the window is
`ev.date <= now() + interval '48 hours'` and `ev.date >= now() + interval '12
hours'`. A daylight-saving change neither moves the reminder nor changes the
instant. Rendering uses **America/Los_Angeles**, the school clock the digest
also uses. There is no per-event timezone column in this schema; adding one is a
separate product decision and is not needed for the send time.
- **Created late** — an event created *after* `date - 48 hours` is skipped, never
mailed immediately (the requirement's explicit rule). Rescheduling it further
out can make it eligible again, which is correct: its creation time is then
before the new 48-hour mark.
- **Rescheduled** — the delivery key is `(event_id, user_id, event_start)`, so a  new start time is a new schedule version: the old reminder is not repeated and
  the new time gets its own. The queue, the claim **and the sender** all read the
  latest `events.date`; the sender re-reads the event immediately before
  rendering and refuses if it was archived or has started, so a mail can never
  announce a superseded time.
- **Cancelled** — this app represents a cancelled event as `archived = true`.
Archived events and archived programs are excluded in the queue **and** in
`claim_event_reminder()`.
- **Late job / stale reminders** — a reminder is only sent while the event is
still at least 12 hours away. A run that is hours late cannot deliver a "in two
days" message on the event's doorstep, and nothing is sent after the event
starts.
- **No duplicates** — `claim_event_reminder()` inserts the unique delivery row
**before** the send, so two overlapping cron runs cannot both mail one student.
The row is completed with the Resend id (or the failure). A failed send is
recorded and retried on later runs, up to **3 attempts**; the Resend
`Idempotency-Key` is `event-reminder:<event>:<student>:<start>`, which also
covers an ambiguous network timeout.
- **Retries** — `complete_event_reminder()` records `sent` or `failed` with the
attempt count; `due_event_reminders()` re-offers a failed row until it has made
three attempts. Nothing else is retried automatically.
- **Secrets** — `EVENT_REMINDER_SECRET` (the cron header), plus the existing
`RESEND_API_KEY`, `RESEND_FROM`, optional `REMINDER_FROM_NAME` and
`PUBLIC_APP_URL`. The function refuses to run without its shared secret.
- **The schedule** — Supabase Cron, every 15 minutes, exactly like the digest.
The SQL is in `scripts/migrate/04_functions_config.md` §2. The job is **live**
(`event-reminders`, job 1, created 2026-10-20); `cron.job` was empty before it,
so this is the only scheduled mail job on the project.
- **Current state (2026-10-20)** — migration 036 is applied, both functions are
deployed (`event-reminders` without platform JWT verification, authorised by the
Vault-backed `x-event-reminder-secret`; `send-makeup-emails` with it), the
function secret `EVENT_REMINDER_SECRET` is set, and the Vault secret plus the
15-minute job exist. A dry run returned `ok: true` with nothing due, and the
job's own `net.http_post` path was exercised once: `200`, `due: 0`. **The
frontend is not deployed yet**, so the Attendance-screen composer is not live.
- **Testing it honestly** — run it with `{"dry_run": true}` and the
`x-event-reminder-secret` header: the JSON names every due student, event and
rendered subject, and sends nothing. `dry_run` also accepts a `now` override so
the 48-hour boundary can be exercised without waiting. A real run ignores
`now`. `node scripts/dev/check_event_reminders.mjs` checks the sender locally
with no network, including both daylight-saving renderings.

## 6c. App email: post-event make-up instructions

Migration 036 + the `send-makeup-emails` edge function let authorized program
staff mail the students marked **absent** for a completed event. This is the
only app mail a browser can trigger.

- **Where** — Attendance screen, below the roll, for staff with
`attendance.mark_present` (director, secretary, or a custom role holding it):
**Email Students Who Missed This Event**. The button is disabled until the
saved end time, with the message *Available after this event ends.* A client
timer re-enables it without a refresh; the timer is presentation only.
- **The server decides** — `send-makeup-emails` verifies the JWT
(`verify_jwt = true`), reads the caller's profile, and calls
`begin_makeup_email_campaign()`, which re-checks the staff capability, the
latest `end_date`, the archived event/program state, and **`now() >= end_date`**.
A missing end time, an end before the start, an archived event, or an archived
program is refused with a message. The function re-reads the event schedule
again during a long send, and renders `{event_date}` / `{event_time}` from that
latest saved schedule — not the snapshot taken when the composer opened. The
frontend clock cannot authorize anything.
- **Who receives it** — only students with a confirmed `attendance_records.status
= 'absent'` row for that event, an active membership in the event's program, a
confirmed address, and no deactivated flag. Present, late and excused are not
included (late is not treated as absent for make-up). Director/secretary staff
accounts are excluded. A student with **no attendance row** is not assumed
absent: the composer lists them separately for review, to be marked on the roll
if needed.
- **Composer** — editable subject, editable message body, separate make-up
instructions field, placeholder help, live preview, recipient list with
the count and per-student remove, unmarked-student review, a warning list for
unresolved placeholders or empty instructions, and a final confirmation before
sending. Attendance is never modified by opening, previewing or sending.
- **Placeholders** — `{student_name}`, `{event_name}`, `{event_date}`,
`{event_time}`, `{program_name}`, `{teacher_name}`, `{makeup_instructions}`.
Substitution happens server-side per recipient; the preview uses the same
tokens. Subject newlines are stripped, the body is HTML-escaped and rendered as
text with line breaks, and the lengths are capped (subject 200, instructions
4,000, body 8,000).
- **Not the digest preference** — `memberships.email_upcoming_events` controls
the *upcoming-events* digest, not a teacher's post-event make-up instructions.
The make-up email is a direct staff communication to the students the
attendance record says missed the event, so it is not gated by that opt-out.
- **One at a time** — every recipient gets a separate Resend call with one `to`,
so no student sees another's address. The response reports **accepted for
delivery** and **failed** separately. Resend accepting a message is not a
guarantee it reached an inbox.
- **No duplicate sends** — the browser sends a `client_operation_id`; the unique
`(created_by, client_operation_id)` key makes a double-click or a retried chunk
one campaign. `(campaign_id, user_id)` is unique. An `accepted` row is never
selected again, and `record_makeup_email_delivery()` refuses to overwrite it.
Retrying failures sends only those recipients (a new operation is a deliberate
follow-up). The Resend `Idempotency-Key` is stable for the campaign + student,
so two concurrent or ambiguous copies of the same send collapse to one, while a
new operation gets a new campaign id and therefore a fresh key.
- **Rate limit** — at most 10 new campaigns per teacher per 10 minutes, and 500
recipients per campaign. Bigger sends are refused with a message rather than
silently truncated.
- **Auditability without extra personal data** — `event_makeup_campaigns` stores
the event, teacher, subject/body the teacher wrote, the schedule snapshot and
time; `event_makeup_deliveries` stores recipient profile id, status, Resend id
and error. Neither stores a copy of the address, and both are deny-all to
clients. Only the service role reads them.
- **Testing it honestly** — `node scripts/dev/check_makeup_emails.mjs` exercises
the function with no network: bearer refusal, malformed input, refusal mapping,
per-recipient payloads, partial failure, archived-mid-send, and that no address
is returned to the caller. `supabase/tests/event_emails.sql` covers the
database rules.
- **Current state (2026-10-20)** — the function is deployed and refuses an
anonymous call (`401`); it is reachable only with a signed-in staff JWT. The
frontend that calls it ships with the next app deploy.

## 6d. App email: a new event was added

Migration `20261019120000_event_announcements.sql` + the `event-announcements`
edge function add the third scheduled app email: **one message per student per
event, sent shortly after someone adds the event to the calendar.** It uses the
digest's Resend API transport (§6a), not the auth SMTP relay. The email carries
the event name, type, date, **start time** (or “All day”), location and program —
the answer to “what is it and when am I supposed to be there” without opening
the app.

- **Who is due** — `public.due_event_announcements(now)` returns active members of
  the event's program who are active, subscribed (`email_upcoming_events`), not
  deactivated, have a confirmed address, and hold a student role (director and
  secretary are staff and are excluded; section leaders are students and are
  included). The event must be **manually created** (calendar-sync imports are
  covered by the digest and the 48-hour reminder instead), not archived, in an
  active program, after the cutover, still to come, and have no announcement
  already claimed. The event's creator is skipped — they just made it.
- **The cutover** — `event_announcement_settings.enabled_since` is written when
  the migration is applied. Events created before it are never announced, so
  deploying this does not mail the whole existing calendar. A seven-day lookback
  also keeps a long outage from mailing stale announcements.
- **Still to come** — a timed event is only announced before its start; an
  all-day event is announced while its day (or saved end date) is still running.
  A run that is days late cannot announce an event that is over. The sender
  re-reads the event after the claim and refuses if it was archived or has
  started, so the message always describes the latest saved schedule and
  location.
- **One setting, all event email** — this follows the same *Upcoming events by
  email* switch per program in Account settings (§6a), and the email's footer
  says so and links to it. The bell is separate.
- **No duplicates** — `claim_event_announcement()` inserts the unique
  `(event_id, user_id)` delivery row **before** the send, so overlapping runs
  cannot both mail one student. It re-checks the roster, the address and the
  event, so an opt-out, removal, archive or reschedule between the queue read
  and the send is respected. `complete_event_announcement()` records `sent` or
  `failed` with the attempt count; failures retry on later runs, up to **3
  attempts**. The Resend `Idempotency-Key` is
  `event-announcement:<event>:<student>`.
- **Secrets** — `EVENT_ANNOUNCEMENT_SECRET` (the cron header), plus the existing
  `RESEND_API_KEY`, `RESEND_FROM` and `PUBLIC_APP_URL`;
  `ANNOUNCEMENT_FROM_NAME` is optional and defaults to “RHS Music & Arts”. The
  function refuses every call without the shared secret or the service-role
  bearer.
- **The schedule** — Supabase Cron, every 5 minutes. The SQL is in
  `scripts/migrate/04_functions_config.md` §2.
- **Testing it honestly** — `node scripts/dev/check_event_announcements.mjs` runs
  the real function with no network: secret refusal, dry run, subject/text/HTML
  contents (including both sides of a daylight-saving change), the claim-before-
  send order, duplicate protection, a recorded failure and a missing key.
  `supabase/tests/event_announcements.sql` covers the database rules. A live dry
  run is `{"dry_run": true}` with the `x-event-announcement-secret` header: it
  names every due student and rendered subject and sends nothing. A real run
  ignores `now`.
- **Editing an event** — only a *new* event is announced. Editing an existing one
  sends no email; the digest and the 48-hour reminder pick up a changed time.
- **Current state (2026-10-20)** — migration `20261019120000` is applied (cutover
  `enabled_since` 2026-10-20 05:04 UTC, so nothing already on the calendar is
  queued), `event-announcements` is deployed without platform JWT verification,
  `EVENT_ANNOUNCEMENT_SECRET` is set, the Vault secret
  `event_announcement_secret` exists, and the `event-announcements` cron job
  (job 2, every 5 minutes) is active. A dry run returned `ok: true` with
  `recipients: 0`. No test event has been added to production, so the first real
  send will be the first event someone adds after this cutover.

## 6e. App email: a student asked to be excused

Migration `20261024223123_absence_request_emails.sql` + the
`absence-request-emails` edge function add the fifth app email: **one message
per request per reviewer, sent shortly after a student submits an absence
request.** It uses the same Resend API transport as the other app mail (§6a),
not the auth SMTP relay. The in-app bell already announced the request; this is
the same event reaching someone who may not have the app open.

- **Who is due** — `public.due_absence_request_emails(now)` returns active
  members of the request's program who are active, not deactivated, have a
  confirmed address, are not the student asking, and hold
  `absence.review` (`user_has_permission`, so program admins and any custom role
  a director deliberately granted the review queue are included). The request
  must still be **pending**, in an active program, on a non-archived event, and
  after the cutover.
- **The cutover** — `absence_email_settings.enabled_since` is written when the
  migration is applied. A request that already existed then is never mailed, so
  deploying this does not mail a backlog. A seven-day lookback also keeps a long
  outage from mailing a stale request.
- **Not the student's subscription switch** — `memberships.email_upcoming_events`
  governs the *upcoming-events* digest. A request waiting for a decision is
  operational mail to a reviewer, like the post-event make-up email, so that
  student preference does not gate it.
- **No duplicates** — `claim_absence_request_email()` inserts the unique
  `(request_id, user_id)` delivery row **before** the send, so overlapping runs
  cannot both mail one reviewer. It re-checks the request state, the roster, the
  address and the capability, so a decision, withdrawal, removal or missed
  confirmation between the queue read and the send is respected.
  `complete_absence_request_email()` records `sent` or `failed` with the attempt
  count; failures retry on later runs, up to **3 attempts**. The Resend
  `Idempotency-Key` is `absence-request:<request>:<reviewer>`.
- **Decisions are not emailed** — approving or denying sends no message. The
  student's bell already reports the outcome; adding a decision email is a
  separate change.
- **Secrets** — `ABSENCE_REQUEST_EMAIL_SECRET` (the cron header), plus the
  existing `RESEND_API_KEY`, `RESEND_FROM` and `PUBLIC_APP_URL`;
  `ABSENCE_FROM_NAME` is optional and defaults to “RHS Music & Arts”. The
  function refuses every call without the shared secret or the exact
  service-role bearer.
- **The schedule** — Supabase Cron, every 5 minutes. The SQL is in
  `scripts/migrate/04_functions_config.md` §2.
- **Testing it honestly** — `supabase/tests/absence_request_emails.sql` covers
  the database rules (who is due, the exclusions, the claim, retries, the
  attempt cap, a stale claim and the client-role grants), and
  `node scripts/dev/check_absence_request_emails.mjs` runs the real function
  with no network at all: secret refusal, dry run, the claim-before-send order,
  the rendered subject/text/HTML on both sides of a daylight-saving change,
  escaping, a request decided after the claim, and a recorded Resend failure.
  A live dry run is
  `{"dry_run": true}` with the `x-absence-request-email-secret` header: it names
  every due reviewer, request and rendered subject, and sends nothing. A real run
  ignores `now`.
- **Current state (2026-10-24)** — migration `20261024223123` is applied (cutover
  `enabled_since` 2026-10-24 22:31 UTC, so no existing request is queued),
  `absence-request-emails` is deployed without platform JWT verification,
  `ABSENCE_REQUEST_EMAIL_SECRET` is set as a function secret, the Vault secret
  `absence_request_email_secret` exists, and the `absence-request-emails` cron
  job (job 3, every 5 minutes) is active. A dry run returned `ok: true` with
  `recipients: 0`, and an unauthenticated call is refused with `401`. No request
  has been submitted since the cutover, so the first real send will be the first
  request a student submits.

## 7. Never

Put a key, token, SMTP password, sender credential or tracking pixel in a
template or in this document. Templates are content; credentials belong in
Authentication → Emails → SMTP Settings, where they are stored encrypted and are
never returned.
