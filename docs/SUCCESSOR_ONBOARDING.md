# Successor onboarding guide

**Audience:** a new maintainer with basic programming knowledge who has never
worked on this project.
**Last verified against the repository:** 2 November 2026.
**Read this with:** [`../AGENTS.md`](../AGENTS.md), [`DEV.md`](DEV.md), and
[`FEATURE_DECISIONS.md`](FEATURE_DECISIONS.md).

This guide explains how the application is built, how to run it, and what not to
break. It describes the architecture that is actually in the repository. Where a
provider setting cannot be seen from the repository, it says so instead of
guessing.

> **Ownership first.** Maintenance authorisation is not copyright ownership.
> Read [`OWNERSHIP_AND_SUCCESSION.md`](OWNERSHIP_AND_SUCCESSION.md) and sign the
> agreement before making production changes.

## 1. Quick facts

| Item | Value |
| --- | --- |
| Public site | https://rhsattendance.org |
| Repository | https://github.com/karmanhora/rhs-musicandarts (public) |
| Frontend | React 19, Vite, TypeScript, Tailwind CSS v4 |
| Router | React Router 7 (`BrowserRouter`) |
| Backend | Supabase project `sjiswrvhrnrxkrfhfjrp` — Postgres, Auth, Storage, Edge Functions |
| Hosting | Vercel project `rhs-musicandarts` |
| Sign-in | Supabase Auth: email/password and Google OAuth |
| Email | Resend: SMTP relay for Supabase Auth, API for app email |
| Runtime | Node 22 or newer (built on v22.23.2, npm 12) |
| Test browser | Playwright, Chromium via the installed Chrome channel |
| Copyright | Karman Hora — see [`../LICENSE`](../LICENSE) |

The site is the **Redmond High School Music and Arts Program**, an umbrella that
holds each program's attendance tracker. The database calls a program an
`ensemble`; the interface says **program**. One program (`band`) ships today; the
schema is multi-program-ready. Do not add a second program's data or screens
without the owner's approval.

## 2. Access you need

Ask the owner to invite you; never ask for a password, recovery code, or
service-role key.

| Service | What you need | How access should be granted |
| --- | --- | --- |
| GitHub | Push access to the repository | Collaborator invitation with the narrowest role |
| Vercel | Deployments and logs | Team/project member invitation |
| Supabase | Project membership | Organisation/project invitation with a developer role |
| Resend | Domain and API key visibility | Team member invitation |
| Domain registrar | DNS and renewal | Delegated DNS access or registrar invitation |
| Google Cloud | OAuth client for Google sign-in | Project member invitation |
| School contact | Escalation path | Introduced by the owner; record the contact privately |

Enable multi-factor authentication everywhere it is offered. Use a password
manager. The owner remains the account owner unless a separate written transfer
says otherwise.

## 3. Run the app locally

```bash
npm install
cp .env.example .env.local     # then fill in the two values
npm run dev                    # http://localhost:5173
```

`.env.local` is gitignored and is the only env file the web app reads. It needs:

| Variable | Where to get it | Sensitivity |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API | Public |
| `VITE_SUPABASE_ANON_KEY` | Same page, the anon/publishable key | Public by design; RLS is the boundary |

The anon key grants nothing by itself: every table is behind row-level security.
The **service-role key must never** get a `VITE_` prefix or reach the browser.
Other server-side values live in provider secrets and in gitignored files such as
`.env`, `.env.event-digest`, and `.env.absence-emails`; do not print them, copy
them into documentation, or commit them.

Vite reads env files once at startup. Restart `npm run dev` after editing. If a
variable is missing, the app shows a screen naming what is absent instead of a
blank page.

## 4. Verify a change

Run these before asking for review:

```bash
npm run typecheck       # tsc -b --noEmit
npm run build           # typecheck + production bundle
npm run check:headers   # vercel.json headers and CSP inline-script hashes
npm run test:qa         # Chromium guard suite (mocks Supabase; no live data)
```

The QA suite starts its own Vite server on port 5200 with dummy Supabase values
and intercepts every Supabase request. It does not touch production. The full
suite is long; a focused run is acceptable while iterating:

```bash
npx playwright test --project=chromium -g "public pages|privacy policy|licensing"
```

Database changes also require the local rehearsal, which uses a throwaway
database and reads no hosted credentials:

```bash
bash scripts/dev/verify_migrations_locally.sh
```

A passing build does not prove behaviour. Report exactly what you ran, and say
what failed or could not run.

## 5. Repository map

| Path | What lives there |
| --- | --- |
| `src/` | The React app. `App.tsx` and `SignedInApp.tsx` hold the route tables; `screens/` holds one file per route; `components/` holds the shell and UI kit; `hooks/` holds session, program, preference, and avatar state; `lib/` holds queries, RPC calls, types, permissions, and design catalogues |
| `supabase/migrations/` | The schema's source of truth: tables, policies, RPCs, grants, triggers, and verification blocks. One timestamped file per change |
| `supabase/functions/` | Edge Functions (Deno) for account deletion, invites, calendar import/sync, and email jobs |
| `supabase/tests/` | SQL suites that run inside transactions and roll back |
| `supabase/templates/` | Branded Supabase Auth email templates |
| `e2e/` | Playwright guard suite and Supabase mocks |
| `scripts/dev/` | Local migration rehearsal, security-header check, and email-sender harnesses |
| `scripts/migrate/` | The clone/migration pipeline; writes are gated on `CONFIRM_TARGET=NEW` |
| `docs/` | Design, security, auth, email, privacy, and decision records |
| `public/` | Original placeholder logo and generated icons |

## 6. Frontend architecture

### Route table

Public, reachable signed out:

| Path | Screen |
| --- | --- |
| `/` | `WelcomeScreen` |
| `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` | `AuthScreen` modes |
| `/privacy` | Privacy Policy (`LegalScreen`) |
| `/terms` | Terms of Use (`LegalScreen`) |
| `/license` | Copyright & Licensing (`LegalScreen`) |

Signed in, with no program membership yet:

| Path | Screen |
| --- | --- |
| `/join` (and unknown paths) | `JoinProgramScreen` — enter a director's join code |
| `/new-program` | `NewProgramScreen`, gated on program-creation permission |
| `/teacher` | `TeacherVerifyScreen`, for an invited teacher |

Signed in, with a membership, inside `AppShell`:

| Path | Screen | Gate |
| --- | --- | --- |
| `/` | Home dashboard | Member |
| `/calendar` | Calendar and events | Member |
| `/checkin` | QR check-in / live session | Member (staff may run a session) |
| `/me` | Own profile | Member |
| `/join` | Join another program | Member |
| `/teacher` | Teacher verification | Member |
| `/new-program` | Start a program | Program creator |
| `/attendance` | Event roll | Staff |
| `/roster` | Roster and invitations | Staff |
| `/analytics` | Attendance analytics | `attendance.view_analytics` |
| `/absences` | Absence requests/review | `absence.request_self` or `absence.review` |
| `/records` | Reports and attendance history | One of the attendance view/export capabilities |
| `/settings` | Account settings | Member |
| `/setup` | Guided setup | `program.manage_settings` |
| `/roles` | Roles and permissions | `roles.view` |
| `/invitations` | Staff invitation codes | `system.manage` |

`src/App.tsx` chooses between the landing page, the auth screens, and the app
from the Supabase Auth session. `src/SignedInApp.tsx` chooses between the
no-roster screens and the full shell. A route that is missing from one of those
trees will not be reachable in that auth state.

### Providers and state

```
AuthProvider (useAuth)
  ProgramsProvider (usePrograms)
    PreferencesProvider (usePreferences)
      AvatarUrlProvider (useAvatars)
        AppShell → screens
```

- `useAuth` restores the stored Supabase session on the first tick, subscribes to
  `onAuthStateChange`, and owns sign-in, sign-out, password reset, and the
  recovery state.
- `usePrograms` holds every program the person belongs to, the current program,
  their role, and the server-returned capabilities. It remembers the last program
  per person in `localStorage`.
- `usePreferences` holds the person's theme, page background, dashboard blocks,
  and setup state. These are per person, never program-wide.
- `useAvatars` turns private avatar paths into short-lived signed URLs.

### Data access rules

- **No component talks to Supabase directly.** Reads go through
  `src/lib/queries.ts`; writes and analytics go through `src/lib/rpc.ts`.
- **Never invent a table column or an RPC.** If the database lacks it, add a
  migration.
- **Never trust a client-supplied program id for authorisation.** The RPCs derive
  the caller and the program on the server.
- **Show failures.** An error is an `Alert` or a toast, never a silent catch or a
  zero standing in for an error.
- `src/lib/permissions.ts` is a mirror of the server's capability catalogue. It
  decides what to render, never what is allowed; `has_permission()` is the
  boundary.

### Design system

Colour, type, spacing, and component rules are in
[`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md). The short version:

- tokens only; no hardcoded hex outside `:root` / `.dark`;
- four type roles plus the rare poster voice;
- 44px minimum touch targets, `Sheet` on mobile, `ConfirmSheet` for destructive
  actions;
- light and dark themes must both work;
- motion only when it explains something, and reduced motion is honoured.

## 7. Backend architecture

### Supabase project

The hosted project is `sjiswrvhrnrxkrfhfjrp`. It provides Postgres, Auth,
private storage for avatars, Edge Functions, and scheduled jobs. The old project
and the old Vercel deployment are read-only forever; do not connect to them.

### Identity and permissions

- Supabase Auth is the only identity provider. There is no Clerk and no second
  provider.
- `public.current_profile_id()` maps `auth.uid()` to `profiles.auth_user_id`.
  Every RLS policy, guard trigger, and RPC composes on that helper.
- `public.has_permission(ensemble, code)` unions system roles, custom roles, and
  system-administrator status. `program_admins` is the one grant the interface
  cannot make.
- There is deliberately **no `auth.users` signup trigger**. Re-adding one creates
  a second profile for every new account.

### Database tables you will meet

`profiles`, `ensembles`, `memberships`, `sections`, `events`,
`attendance_records`, `attendance_audit`, `permissions`, `roles`,
`role_permissions`, `user_role_assignments`, `audit_logs`, `program_admins`,
`notifications`, `personal_events`, `calendar_sources`, `profile_preferences`,
`absence_requests`, `teacher_invitations`, and the check-in/join attempt and
email-delivery tables.

This is a starting map, not a schema. Read the migrations before writing SQL.
Never infer a column from prose.

### Migrations

1. Never edit an already-applied migration. Add a new timestamped file.
2. Make it idempotent, state its purpose and rollback in the header, and end with
   a verification block. Follow
   `supabase/migrations/20261020112000_attendance_history.sql`.
3. Rehearse locally:
   `bash scripts/dev/verify_migrations_locally.sh`.
4. Apply the migration **before** deploying a frontend that depends on it.
5. A hosted apply requires the owner's explicit approval. `scripts/migrate/*.sh`
   gate writes on `CONFIRM_TARGET=NEW`; the Supabase CLI does not. The absence of
   a guard is not permission.
6. SQL suites run inside transactions that roll back. Keep that property.

Do not run `supabase config push`. The repository's `supabase/config.toml` is a
record of intent, not a push source: the hosted project has remote-only settings
(Google sign-in, MFA, rate limits) that a push would overwrite. Change provider
settings in the dashboard or via the Management API, then update the record by
hand.

### Edge Functions

| Function | `verify_jwt` | Purpose |
| --- | --- | --- |
| `delete-account` | true | Deletes the caller's sign-in account and de-identifies the profile, retaining program attendance |
| `invite-student` | true | Staff invitation to a student through Supabase Auth |
| `import-google-calendar` | true | Manual import of a public iCal feed |
| `send-makeup-emails` | true | Staff email to students who missed a completed event |
| `sync-google-calendars` | false | Scheduled pull of connected public calendars; authorised by a shared secret |
| `event-digest` | false | Scheduled upcoming-events email; shared secret |
| `event-reminders` | false | Scheduled 48-hour event reminder; shared secret |
| `event-announcements` | false | Scheduled new-event email; shared secret |
| `absence-request-emails` | false | Scheduled email to reviewers when a student requests an absence; shared secret |

Deploying or redeploying a function requires owner approval. A function with
`verify_jwt = false` is not public: it must still check its shared secret. Never
remove that check.

### Attendance and QR check-in

- Check-in modes are `qr`, `toggle`, `both`, and `none`.
- A live QR session has a short-lived token and an eight-character entry code.
  The token expires after about five minutes. The check-in window runs from 15
  minutes before the event start through the event end.
- Attendance writes go through server RPCs (`record_checkin_for_session`,
  `record_attendance`, `override_attendance`). The client cannot insert
  attendance directly.
- Identity comes from `auth.uid()` only. A student cannot check in another
  person. Directors cannot check in as attendees.
- Attempts are rate-limited per event/IP. First scan wins. An excused record is
  not overwritten by a scan.
- An absent mark deletes the attendance row; "absent" and "not recorded" are the
  same stored state. Reports say "Not recorded". Do not change this without the
  owner; it would change every percentage.
- Do not change attendance logic, windows, or permissions as part of routine
  maintenance.

### Auth email, app email, and calendar sync

- Supabase Auth sends confirmation, recovery, invite, magic-link, email-change,
  reauthentication, and security-notification emails through **Resend's SMTP
  relay** from `noreply@rhsattendance.org`.
- The app sends its own email through **Resend's API** with a separate key:
  upcoming-events digest, 48-hour reminders, new-event announcements, absence
  request notices, and staff make-up emails.
- Auth mail and app mail share the Resend quota. The free tier is 100 messages a
  day / 3,000 a month. A large digest can consume the day's allowance and block
  sign-up confirmations. Do not schedule a large digest until the quota question
  is settled.
- The repository records the 48-hour reminder cron as live and the digest cron as
  deliberately unscheduled. Confirm `cron.job` in the dashboard before assuming
  what runs.
- Google Calendar is a one-way pull from a public iCal feed. Nothing is written
  back to Google. A removed Google event is archived in the app, never deleted,
  so attendance history survives.

## 8. Vercel and the domain

- Project: `rhs-musicandarts` (`projectId` in `.vercel/project.json`).
- Deploys from `main`. `vercel.json` sets security headers and the SPA rewrite
  to `/index.html`, so client-side routes resolve on a hard refresh.
- The only frontend environment variables should be `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`, pointing at `sjiswrvhrnrxkrfhfjrp`. Confirm in the
  dashboard; this repository cannot read Vercel's environment.
- A production deploy, an alias change, or a Vercel setting change requires the
  owner's explicit approval.
- The custom domain is `rhsattendance.org`. The registrar is **not recorded in
  this repository**; confirm it with the owner before changing DNS. Resend needs
  its SPF/DKIM records, and Vercel needs its domain records.
- Enable registrar lock, auto-renew, and multi-factor authentication. A transfer
  needs the owner's written approval and an authorisation code.

## 9. Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Blank page, config screen | Missing `VITE_SUPABASE_URL` or anon key | `.env.local`, restart Vite |
| Sign-in works but every screen is empty | RLS denies, or the profile is not linked | `profiles.auth_user_id`, `current_profile_id()`, the row's membership |
| "Error sending confirmation email" | Resend/SMTP transport | Supabase Auth logs; `451` billing, `535` credentials, `550` sender domain |
| Reset link opens the home page | Redirect URL missing | Supabase Auth → URL Configuration (`/reset-password`) |
| A route 404s on refresh in production | SPA rewrite missing | `vercel.json` rewrites |
| Build fails on types | A query or RPC shape changed | `npm run typecheck`; compare `src/lib/types.ts` with the migration |
| Page is unstyled or a control is huge | A token or Tailwind class was renamed | `src/index.css`, `DESIGN_SYSTEM.md` |
| CSP blocks a script | An inline script changed without updating its hash | `npm run check:headers`, `vercel.json` |
| `/license` shows the raw licence text in local development | The root `LICENSE` file shadows the `/license` route on a case-insensitive filesystem | The `licenseRoutePlugin` in `vite.config.ts` reserves the path for the SPA; production uses the Vercel rewrite |
| Migration rehearsal fails | A migration depends on hosted-only state | Read the first error; rehearse before applying; never edit an applied file |
| Invitation code refused | Code spent, expired, bound to another address, or the program/role is unusable | `TEACHER_VERIFICATION.md`, the invitation screen, the SQL suite |

## 10. Security practices

- Never commit `.env*`, keys, tokens, dumps, or student data. The repository's
  `.gitignore` already excludes them; do not weaken it.
- Service-role credentials belong only in Edge Function secrets and the server.
  Never in `src/`, `VITE_*`, logs, screenshots, or chat.
- Keep RLS enabled and least-privilege grants. A screen that "needs" a direct
  table write is a design error, not a reason to grant one.
- Keep the avatar bucket private and serve pictures through signed URLs.
- Use MFA on GitHub, Vercel, Supabase, Resend, the registrar, and Google.
- Review `npm audit` and Dependabot. As of 2 November 2026, `npm audit --omit=dev`
  reports two high advisories in `@modelcontextprotocol/server`, reached through
  `vgpu`. Do **not** run `npm audit fix --force`: npm proposes `vgpu@0.3.0`, a
  breaking change from the installed 0.6 line. Assess the advisory with the
  owner and test any upgrade.
- Follow the incident steps in
  [`privacy/SECURITY_AND_INCIDENT_RESPONSE.md`](privacy/SECURITY_AND_INCIDENT_RESPONSE.md).
- Rotate a credential after any suspected exposure, and record the rotation date
  — never the value.

## 11. Backups and restore

The free Supabase tier has no managed backups. Choose one:

1. Enable a Supabase plan with backups, or
2. Run a documented periodic `pg_dump` and store it encrypted outside the
   repository.

The migration pipeline's `scripts/migrate/01_dump.sh` is a clone step, not a
scheduled backup. Use the portable PostgreSQL client in `.tools/pgsql/bin` if the
machine has no `pg_dump`.

A backup is not real until a restore has been tested:

1. Dump the database to an encrypted file outside the repository.
2. Restore into a separate local or staging database, never over production.
3. Run the SQL suites against the restored copy.
4. Record the date, result, and any errors.
5. Keep at least one copy off the machine.

The database dump does not include avatar objects in the private `avatars`
bucket. Export that bucket separately if profile pictures must be preserved.

Never restore, reset, or seed the hosted project without the owner's explicit
approval.

## 12. First two weeks

- [ ] Read `AGENTS.md`, `DEV.md`, `FEATURE_DECISIONS.md`, and this guide.
- [ ] Sign the maintenance agreement before touching production.
- [ ] Run the app locally and sign in with a test account.
- [ ] Run typecheck, build, header check, and the focused Playwright suite.
- [ ] Rehearse the migrations locally.
- [ ] Read the schema for the tables you will touch.
- [ ] Make one small documentation or UI change on a branch, get review, and
      merge it.
- [ ] Watch a production deploy with the owner, then do one with approval.
- [ ] Take a backup and test a restore.
- [ ] Review provider access, MFA, and billing.
- [ ] Record the handover and the next review date.

## 13. Where to read more

- [`DEV.md`](DEV.md) — the developer contract and verification commands.
- [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) — visual and accessibility rules.
- [`AUTH_MIGRATION.md`](AUTH_MIGRATION.md) — why Supabase Auth is the only
  identity system.
- [`TEACHER_VERIFICATION.md`](TEACHER_VERIFICATION.md) — invitation codes and
  teacher access.
- [`EMAIL_SETUP.md`](EMAIL_SETUP.md) — SMTP, templates, digests, reminders, and
  make-up email.
- [`SECURITY_AUDIT_2026-10.md`](SECURITY_AUDIT_2026-10.md) — the last full
  security review.
- [`SECURITY_HEADERS.md`](SECURITY_HEADERS.md) — CSP and header rules.
- [`BROWSER_SUPPORT.md`](BROWSER_SUPPORT.md) — the support floor.
- [`privacy/`](privacy/) — privacy, retention, providers, school-use, and
  incident-response documents.
- [`FEATURE_DECISIONS.md`](FEATURE_DECISIONS.md) — decisions that need the
  owner before they are reversed.
