# Data Inventory & Data-Flow Diagram

**Draft for review.** Every row is drawn from the code in this repository; where a
field is not implemented yet it is marked *(planned)*. Confirm before sharing with
the district.

## 1. Data collected

| Data element | Where it lives | Source | Purpose | Required? |
|---|---|---|---|---|
| Student/staff **email** | Supabase `auth.users.email` | sign-up / invite | sign-in, confirmation | Yes |
| Supabase **auth user id** | `profiles.auth_user_id` | Supabase Auth | link account to person | Yes |
| **Full / display name** | `profiles.full_name`, `.display_name` | sign-up, invite, join | roster display | Yes || **Avatar picture** | `profiles.avatar_path` — object in the private `avatars` bucket (`profiles.avatar_url` is the legacy external URL, no longer written) | user | display (signed URL, 1 hour) | Yes, on account deletion (row + object). See [RETENTION_AND_DELETION](RETENTION_AND_DELETION.md) | | **Program membership** | `memberships` | join/create | program access | Yes |
| **Role** | `memberships.roles` | director assignment | permissions | Yes |
| **Section** | `memberships.section_id` → `sections` | director / self | grouping | No |
| **Attendance status** | `attendance_records.status/attended/checked_in_at/is_late` | check-in / staff | the core record | Yes |
| **Excused reason** | `attendance_records.excuse_reason` | staff free text | explanation | No |
| **Staff note** | `attendance_staff_notes.staff_note` | staff free text | internal note | No |
| **Invited name + email** | `program_invites.student_name/email` | staff invite | onboarding | Yes (until accepted) |
| **Signup audience** (student/teacher) | `signup_account_types` | sign-up | program-creation gate | Yes |
| **Events & calendar feed** | `events`, `calendar_sources.ics_url` | staff / Google ICS | scheduling | Yes |
| **Personal calendar items** | `personal_events` | user | personal calendar | No |
| **Notifications** | `notifications` | triggers | in-app alerts | Yes |
| **Rate-limit records** | `checkin_attempts`, `join_code_attempts` (IP) | check-in/join | abuse prevention | Yes |
| **QR token / entry code** | `checkin_sessions` | staff | check-in | Yes (5 min) |

**Not collected:** payment data, precise geolocation, biometrics, photos, phone
numbers, advertising identifiers, third-party analytics identifiers.

## 2. Where it goes (flow)

```
Student/staff browser (Vercel-hosted React SPA)
   │  HTTPS (TLS) — Supabase anon key + user JWT
   ▼
Supabase Edge / PostgREST  ──►  Supabase Postgres (RLS + SECURITY DEFINER RPCs)
   │                                   │
   │  invite email                     └── backups (provider, plan-dependent)
   ▼
Supabase Auth ──► Resend (SMTP relay) ──► student/staff inbox
   │
   └── event digest ──► Resend (API) ──► student/staff inbox

Staff browser ──► Supabase Edge Function ──► Google Calendar (public ICS URL, read-only)
                         │
                         └──► Postgres (`calendar_sources.ics_url` + imported `events`)
User browser  ──► calendar.google.com (an "add to calendar" link) [opt-in, per event]
```

- **No data is sent to analytics, advertising, or social networks.**
- The **Google OAuth** flow, if used, gives Supabase Auth the user's basic
  profile/email only (no Calendar API scopes).
- Staff import a **public Google Calendar iCal URL**. A staff-authorized Edge
  Function reads that public feed and stores the URL and parsed events for the
  program; it does not access a user's private calendar or Google account.
- A public calendar feed can be read by anyone who has its URL. Staff should
  only connect a calendar approved for public sharing.
- **Vercel** serves static files; runtime logs can contain request metadata, not
  student records (see [`THIRD_PARTY_PROVIDERS.md`](THIRD_PARTY_PROVIDERS.md)).

## 3. Who can access what (server-enforced)

| Role | Scope |
|---|---|
| Any signed-in person, not on a roster | sees only the join / start-a-program screens |
| Member (student) | their program's events; **their own** attendance; not others' |
| Section leader | their section's members' attendance for the event |
| Secretary | all attendance in that program; roster; events |
| Director | manage the program, roles, join code, analytics, archive |
| Program admin *(table, rarely used)* | cross-program administrative access |
| Maintainer (developer) | **service role** — full access, for support/migration; must be limited and logged |

Verified enforcement: [`015_ensemble_policies.sql`](../../supabase/migrations/015_ensemble_policies.sql),
[`021_supabase_auth.sql`](../../supabase/migrations/021_supabase_auth.sql);
cross-program isolation tested in
[`ensemble_isolation.sql`](../../supabase/tests/ensemble_isolation.sql).
