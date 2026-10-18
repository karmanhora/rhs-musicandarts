# RHS Music & Arts Attendance Tracker — Legal, Privacy & Security Readiness Audit

**Audience:** the developer/owner, and school or district reviewers.
**Date:** 2026-10-10
**Status of this document:** a *draft working assessment* by the developer. It is
**not** a legal opinion and it does **not** establish compliance. Nothing here
should be relied on as legal advice; items marked **[counsel]** need review by
the district's legal/privacy staff or a qualified attorney.

> **Plain-language summary:** the *engineering* is in unusually good shape — the
> database enforces access control itself, programs cannot see each other's data,
> and there are no trackers. The *legal and procedural* work is not done: there
> is no school agreement, no privacy policy, no signed authorization, and the
> app is not approved to hold real student data yet. The biggest risks are
> organizational (who is allowed to enter real records, and on what written
> basis), not technical.

---

## 1. Executive summary of current readiness

| Domain | State | Basis |
|---|---|---|
| Technical access control (RLS, least privilege, program isolation) | **Strong** | `supabase/migrations/015`, `021`; `supabase/tests/ensemble_isolation.sql` |
| Secret handling in the repo | **Strong** | no live keys in git history (verified); only `.env.example` tracked |
| Third-party tracking / data monetization | **Strong** | no analytics SDKs, no ad code, no CDN scripts (verified by search + build) |
| Encryption in transit/at rest | **Provider-dependent, unverified here** | Supabase/Vercel claims; not independently verified |
| Written authorization to process student data | **Absent** | no agreement exists in the repo |
| Privacy policy / notice to families | **Absent** | not present |
| Retention & deletion schedule | **Partial / implicit** | account deletion exists; no written schedule; stale invites retained |
| Backup & disaster recovery | **Weak** | free-tier Supabase has no included backups; no documented procedure |
| Incident response | **Absent** | no written plan |
| Role verification (are "teachers" really staff?) | **Weak** | sign-up audience is self-declared (`023`) |

**Bottom line:** this is a well-built prototype that is **not yet ready to hold
real LWSD student records**. Do not enter real names, emails, or attendance until
the school has authorized it in writing (see §7 and the checklist).

---

## 2. Highest-priority risks

Ranked by (likelihood × impact). "Required" = a legal or policy obligation in the
sources reviewed; "Best practice" = recommended, not legally mandated.

### R1 — No written basis for processing student data · **Critical**
Entering identifiable student records into a third-party app without the school's
authorization can violate FERPA and RCW 28A.605 regardless of good intent.
Under FERPA's school-official exception (34 CFR 99.31(a)(1)(i)(B)), the school
must outsource a function it would otherwise staff, retain **direct control**,
and list the party in its annual FERPA notice. RCW 28A.604 makes a covered
"school service provider" subject to statutory duties (no sale, no targeted ads,
no profiles, security program, deletion on request). **[counsel]**
**Fix:** obtain written district authorization before real data. See
[`SCHOOL_DATA_PROCESSING_AGREEMENT.md`](SCHOOL_DATA_PROCESSING_AGREEMENT.md).

### R2 — Unverified role self-declaration · **High**
`supabase/migrations/023` lets anyone who selects "teacher" at sign-up create
their own program and become its director (`create_program`). There is no check
that the person is actually LWSD staff. A stranger can create a program and
collect data from anyone they invite.
**Fix (product choice, [counsel]/[district]):** require a school-issued
authorization for director accounts, or restrict `create_program` to a
district-managed allowlist. At minimum, document this and do not present the
"teacher" label as verified.

### R3 — Account deletion retains a de-identified attendance history · **High**
`supabase/functions/delete-account` + `supabase/migrations/025` delete the
account, memberships, notifications, invites and personal events, **but keep
`attendance_records` rows** under a profile renamed "Deleted account" with
`auth_user_id = null`. This is a defensible retention choice, but it is **not**
full deletion, and the district may require genuine erasure. RCW 28A.604.040(2)
requires deletion "within a reasonable period" when the *institution* requests
it.
**Fix:** document the retention rule explicitly, name the person who decides,
and offer a true-delete path on district request. See
[`RETENTION_AND_DELETION.md`](RETENTION_AND_DELETION.md).

### R4 — Stale pending invitations are retained indefinitely · **Medium-High**
`supabase/migrations/027` stores a student's **name and email** in
`program_invites`. An invitation that is never accepted is never removed. That is
personal information with no retention limit.
**Fix:** purge stale pending invites after a defined window. Implemented in
`supabase/migrations/028_privacy_retention.sql` (this repo) — **not yet applied
to production.**

### R5 — No backups on the free tier · **Medium-High**
Supabase's Free tier does not include scheduled backups; the project is on that
tier unless changed. Losing the project loses the records.
**Fix:** enable a paid plan with backups **or** run a documented export routine
before real data is stored. See
[`SECURITY_AND_INCIDENT_RESPONSE.md`](SECURITY_AND_INCIDENT_RESPONSE.md).

### R6 — Live privileged secrets sit in a local `.env` file · **Medium**
`.env` contains a Supabase **management access token** and **service-role keys**
for old and new projects, plus a retired Clerk secret. The file is gitignored and
was **never committed** (verified against full history), so this is a *local
hygiene* issue, not a leak — but these keys can bypass all RLS if they escape.
**Fix:** rotate the management token and service-role keys now that the migration
is done; delete the retired Clerk secret; never paste `.env` into an agent,
chat, or issue. **[developer action — cannot be done from the repo]**

### R7 — CORS allows any origin on edge functions · **Low-Medium**
Both edge functions return `Access-Control-Allow-Origin: *`. Because callers
authenticate with a Bearer token (not cookies), this is not a classic CSRF hole,
but a wildcard is looser than needed. **Fix:** restrict to the app's origins
(implemented in this repo; see §6).

### R8 — Google Calendar ICS feed is a public URL · **Low**
The band's ICS URL is a public "basic.ics" Google Calendar feed. It is not a
secret (no private token), but whatever is on that calendar is world-readable.
**Fix:** confirm with the director that the calendar is intentionally public.

### R9 — Disease/health inference from excused-absence reasons · **Low, [counsel]**
`attendance_records.excuse_reason` can contain health information ("sick",
"medical"). Washington's My Health My Data Act (RCW 19.373) generally exempts
FERPA-governed education records, but a health-related reason is exactly the kind
of data that raises questions. **Fix:** constrain free-text excuse reasons to a
fixed set ("excused — school activity", etc.) if the district prefers.

---

## 3. Repository audit findings (evidence)

### 3.1 Architecture
- **Framework:** React 19 + Vite 8 + TypeScript + Tailwind v4, single-page app
  ([`package.json`](../../package.json), [`vite.config.ts`](../../vite.config.ts)).
- **Hosting:** Vercel; all routes rewrite to `index.html`
  ([`vercel.json`](../../vercel.json)) — static frontend, no server rendering.
- **Backend:** Supabase Postgres + Supabase Auth + 2 Edge Functions
  ([`src/lib/supabase.ts`](../../src/lib/supabase.ts),
  [`supabase/functions/`](../../supabase/functions)).
- **Client libraries:** `@supabase/supabase-js`, `react-router-dom`,
  `html5-qrcode`, `qrcode.react`, `lucide-react`, two self-hosted `@fontsource`
  fonts.

### 3.2 Authentication & identity
- Supabase Auth owns sign-in; email confirmation is **on**
  ([`supabase/config.toml`](../../supabase/config.toml)); Google OAuth enabled.
- Identity is `profiles.auth_user_id = auth.uid()`, resolved server-side by
  `current_profile_id()` from the JWT `sub` claim
  ([`supabase/migrations/021_supabase_auth.sql`](../../supabase/migrations/021_supabase_auth.sql)).
- Password reset + update flows exist with readable errors
  ([`src/hooks/useAuth.tsx`](../../src/hooks/useAuth.tsx)).
- **Verified:** signed-out callers resolve to `NULL` and every helper denies
  (fail-closed; asserted in migration 021's verification block).

### 3.3 Authorization & program isolation
- Every public table has RLS; the write path is SECURITY DEFINER RPCs.
- Access rules are centralized in helper functions
  ([`015_ensemble_policies.sql`](../../supabase/migrations/015_ensemble_policies.sql)):
  `is_member_of`, `has_role_in`, `can_manage_ensemble`, `can_read_attendance`,
  `can_read_staff_note`, `is_section_leader_for`, etc.
- Cross-program isolation is asserted by
  [`supabase/tests/ensemble_isolation.sql`](../../supabase/tests/ensemble_isolation.sql)
  (two programs, same-named sections, a student in both) and
  [`supabase/tests/security_verification_v2.sql`](../../supabase/tests/security_verification_v2.sql).
- **No client write path** exists for `memberships`, `ensembles`, `sections`,
  `calendar_sources` (revoked; [`015`](../../supabase/migrations/015_ensemble_policies.sql)).
- **Verified:** migration 016 asserts that `anon` can execute **no** public
  function.

### 3.4 Check-in / QR handling
- `start_checkin_session` mints a 24-byte random hex token and an 8-character
  human code, valid 5 minutes, and deletes any prior session for the event
  ([`016_ensemble_rpcs.sql`](../../supabase/migrations/016_ensemble_rpcs.sql)).
- `record_attendance` (token) / `record_attendance_by_code` enforce: session
  unexpired, event not ended, not before the −15-minute window, check-in mode is
  QR/both, caller is on the roster and not a director, a staff excuse is not
  overwritten, and first-check-in-wins. Rate-limited to 5 failures / 2 minutes.
- The token travels in the URL `/checkin?token=…`
  ([`src/screens/CheckInScreen.tsx`](../../src/screens/CheckInScreen.tsx)). It is
  short-lived and single-purpose; residual exposure is limited to that window.

### 3.5 Data collected, stored, and shown

| Table | Personal data | Who can read it |
|---|---|---|
| `profiles` | name, display name, avatar URL, `auth_user_id` (link to email), created_at | self, co-members, managers ([`015`](../../supabase/migrations/015_ensemble_policies.sql)) |
| `memberships` | user↔program, section, roles, active | members of that program |
| `attendance_records` | per-student status, timestamp, excused reason | self, program staff, that section's leader |
| `attendance_staff_notes` | free-text staff note | program staff only, never the student |
| `program_invites` | invited student's **name + email** | no client access (service role only) |
| `checkin_sessions` | token + entry code | issuer, program director |
| `personal_events`, `notifications` | owner's own calendar items / notifications | the owner only |
| `calendar_sources` | ICS URL | program staff |
| `signup_account_types` | auth id ↔ student/teacher | no client access |
| `signup_account_types`, `checkin_attempts`, `join_code_attempts`, `ensemble_settings`, `program_admins` | rate-limit/admin | no client access |

Full detail in [`DATA_INVENTORY_AND_FLOWS.md`](DATA_INVENTORY_AND_FLOWS.md).

### 3.6 Secrets, logs, analytics, storage
- **Secrets:** only `.env.example` is committed; `.env`/`.env.local` are
  gitignored. Full-history scan for `eyJ…` key material found matches only inside
  SVG base64 and `package-lock.json` integrity hashes — **no live keys were ever
  committed.**
- **Logs:** no application logging of PII; the only `console.*` in `src/` is a QR
  teardown error with no student data ([`QrScanner.tsx`](../../src/components/QrScanner.tsx)).
- **Analytics/trackers:** none. No Google Fonts CDN, no ad SDK, no Sentry/PostHog
  ([verified by search + `package.json`]).
- **Object storage:** the `avatars` bucket holds one picture per member who
  uploads one, at `<auth uid>/<uuid>.webp`, capped at 5 MB and images only. The
  bucket is **private** (migration 030): there is no anonymous URL, reads are
  granted per object to the same people who may see that member's profile row
  (`public.can_read_avatar`), writes are confined to the owner's own folder by
  path, and the app displays pictures through short-lived signed URLs. A replace
  deletes the object it superseded; account deletion clears the row.
- **Exports:** none — there is no CSV/export feature in the current app.

---

## 4. Applicable law (researched; link each conclusion to its trigger)

> This section states what the reviewed authorities say and the facts that decide
> whether each applies. **[counsel]** flags items that need a professional's
> judgment. Summaries are of official sources; see
> [`LEGAL_SOURCES.md`](LEGAL_SOURCES.md) for the citation list.

### FERPA — likely applies
- **Education record** = directly related to a student **and** maintained by the
  school or a party acting for it (34 CFR 99.3). Band/arts attendance entered for
  the school is directly about students and maintained for a school function →
  likely an education record. Extracurricular status is **not** an exemption.
- **School-official exception** (34 CFR 99.31(a)(1)(i)(B)) requires: an outsourced
  function the school would otherwise staff; the school's **direct control**; use
  limited to the disclosed purpose; and inclusion in the district's annual FERPA
  notice. FERPA does not *itself* mandate a written contract, but a contract is
  the practical way to establish control, and WA law effectively requires one.
  **[counsel]**
- **Re-disclosure** is limited (34 CFR 99.33): student data may not be used for
  unrelated purposes or handed to others.
- Being free, student-built, or independently hosted does **not** change these
  tests.

### Washington RCW Chapter 28A.604 — likely applies if used at staff direction
- "School service" = designed/marketed primarily for K-12 **and** used at a
  school employee's direction **and** collects student personal information.
  An attendance app used at a director's direction plausibly qualifies.
  **No free/nonprofit/individual exemption.** **[counsel]**
- Provider duties: use data only for authorized purposes; publish a clear policy
  and give notice of material changes; facilitate access/correction; maintain a
  comprehensive information-security program; **do not sell** student data, **do
  not use it for targeted advertising**, **do not build student profiles**;
  contractually bind subcontractors; delete on the institution's request within a
  reasonable period (RCW 28A.604.020–.040, .030).

### Washington RCW 28A.605 — attendance is an education record
A school generally may not release a student's education records (which
statutorily include attendance) without a valid FERPA/state basis. The question is
therefore also *whether the school may disclose attendance to this developer at
all.* **[counsel]**

### RCW 19.255 — breach notification
Notify affected WA residents within **30 days** of discovery; notify the Attorney
General within 30 days if **>500** WA residents are affected. A data *maintainer*
must notify the owner **immediately**. The agreement should assign incident
duties; the statute's duties cannot be assumed away.

### COPPA — **not** triggered for a high-school-only app
COPPA covers under-13s. A service limited to ages 14–18 and not directed to
children is generally outside COPPA. **This changes** if middle-school programs
join, or if the operator learns it is collecting under-13 data. School consent is
a narrow authorization for a school purpose, not blanket commercial consent.

### RCW 19.373 (My Health My Data) — generally **not** applicable
Ordinary attendance is not consumer *health* data, and the chapter exempts
FERPA-governed data. **Caution:** free-text *excuse reasons* could encode health
status. Prefer a fixed list. **[counsel]**

### LWSD policy — district-dependent
Publicly, LWSD references **Policy 2022 / Procedure 2022P** (Electronic Resources
& Internet Safety) and **Policy 3231 / 3231P** (Student Records), plus its FERPA
notice. The full current text and the district's vendor-approval process were
**not retrievable**, so they must be obtained directly. **[district]**

---

## 5. What is *required* vs *recommended* vs *district-dependent*

**Legally required (on the facts above):**
- A lawful basis for the school to disclose attendance to a third party, and the
  student-data contract/subcontractor terms that RCW 28A.604 expects.
- A published privacy notice and access/correction handling (RCW 28A.604.020).
- A reasonable information-security program (RCW 28A.604.040).
- Breach notification within 30 days / AG notice >500 (RCW 19.255).
- Deletion of student personal information when the institution requests it.

**Required by district policy / agreement (to confirm):** written vendor
approval, directory/records handling, acceptable-use terms, data-location and
retention expectations. **[district]**

**Recommended best practice (not a legal mandate):**
- CORS allowlist, stricter excuse-reason input, backup/DR routine, MFA on the
  Supabase/Vercel/GitHub/Resend accounts, least-privilege service keys,
  dependency review.

**Must be confirmed by district counsel:** whether the developer can be a
"school official"; whether the app is a "school service"; the correct FERPA
disclosure basis; who owns breach response; health-reason handling.

---

## 6. Remediation plan (prioritized)

**Now — before any real student data (do not skip):**
1. Get written school/district authorization; execute the draft agreement
   ([`SCHOOL_DATA_PROCESSING_AGREEMENT.md`](SCHOOL_DATA_PROCESSING_AGREEMENT.md)).
2. Publish the privacy policy ([`PRIVACY_POLICY.md`](PRIVACY_POLICY.md)) and, if
   the district wants one, the family notice
   ([`PARENT_STUDENT_NOTICE.md`](PARENT_STUDENT_NOTICE.md)).
3. Rotate the Supabase management token and service-role keys; delete the retired
   Clerk secret; remove dead Clerk vars from `.env.local`. **[developer]**
4. Enable MFA on Supabase, Vercel, GitHub, and the email/SMTP account.
5. Resolve the "unverified teacher" design (R2) with the district.

**Before the first real cohort:**
6. ~~Apply `supabase/migrations/028_privacy_retention.sql`~~ — **applied to
   production 2026-10-11.** Schedule the purge (Supabase Cron / scheduled
   function) so retention actually runs.
7. Set up backups (paid tier) or a documented export routine (R5).
8. Constrain excuse reasons (R9) if the district prefers.
9. Confirm the Google Calendar feed is intentionally public (R8).

**Ongoing:**
10. Review dependency updates; keep secrets out of the repo/chat.
11. Keep the retention schedule and provider list current.

### Technical changes made in this repo
- **Website legal pages (2026-10-11):** `/privacy` and `/terms` now render the
  privacy policy and terms of use **inside the app**, reachable signed out, with
  the drafts' placeholders and draft banner intact. Linked from the landing-page
  footer, the sign-up consent line, and a new Profile → Privacy section. See
  [`WEBSITE_LEGAL_CHANGES.md`](WEBSITE_LEGAL_CHANGES.md). This publishes drafts;
  it does **not** make them final or establish compliance.
- `supabase/migrations/028_privacy_retention.sql` — explicit deny policy on
  `program_invites`; a `purge_stale_program_invites()` retention function.
- `supabase/tests/program_invites_privacy.sql` — asserts invites are not
  client-readable and stale ones are purged.
- CORS origin allowlist in both edge functions (no more `*`).
- Removed dead Clerk variables from `.env.local`.
The migration and the privacy test were verified locally and then **applied to
production on 2026-10-11**, and both edge functions were deployed and re-verified
live (see §6.1).

#### 6.1 Verification performed / not performed
- **Performed and passing:**
  - `bash scripts/dev/verify_migrations_locally.sh` (throwaway local PostgreSQL
    in `.tools/pgsql`, no live project touched) — **all 22 migrations applied,
    including `028_privacy_retention.sql`, and 10/10 SQL suites passed**,
    including the new `program_invites_privacy.sql`.
  - **Applied to production** (`sjiswrvhrnrxkrfhfjrp`) on 2026-10-11: migration
    028 ran in a single transaction (dry-run first), then the privacy suite was
    run against the live DB (self-rolling-back) and **passed**; verified live
    that the deny policy exists, `authenticated` cannot SELECT the table or
    execute the purge, and the 2 existing invite rows are unchanged.
  - **Edge functions deployed** (delete-account v2, invite-student v3) and CORS
    verified live with real requests: production/preview/localhost origins are
    echoed; a foreign origin is refused. Unauthenticated POST returns 401.
  - `npm run build` succeeds after the changes.
  - Full git-history scan for `eyJ…` key material: only base64 in SVGs and
    `package-lock.json` integrity hashes — **no live keys ever committed.**
- **Not performed:** Deno was unavailable locally, so the edge functions were
  deployed without a local typecheck; **no browser end-to-end run** of the
  invite/delete flows against production was performed (that would send real
  email / delete a real account). No penetration test was performed.

---

## 7. Questions for LWSD's IT / privacy / legal team

1. What is the district's process and form for approving a staff/student-built
   tool that handles student information? Who signs?
2. May the district treat this app under FERPA's school-official exception, and
   would the district list the developer in its annual FERPA notice? **[counsel]**
3. Does the district consider this app a "school service" under RCW 28A.604? What
   contract terms does the district require of providers?
4. What data-location, retention, and deletion rules apply to student records
   held by a third-party app?
5. Which Google Workspace account and Calendar feed is approved for the program,
   and is that feed intentionally public?
6. Who must be notified in a suspected breach, and through what channel?
7. Must "teacher/director" accounts be provisioned only by LWSD staff, rather
   than self-declared?
8. Is collecting free-text excused-absence reasons acceptable, or should they be
   a fixed list?
9. For students under 13 (if any middle-school program is considered), what
   COPPA/consent handling does the district require?
10. Should the app avoid using student email for login (e.g., prefer a
    district-issued identity), and does the district require a specific one?

---

## 8. Final checklist

**Completed**
- [x] Server-enforced RLS on every public table; least-privilege grants.
- [x] Cross-program isolation implemented and covered by SQL tests.
- [x] No trackers, no ad code, no data monetization, no third-party scripts.
- [x] No live secrets in git history.
- [x] Account-deletion flow that removes identity and personal data.
- [x] QR tokens: short-lived, single-purpose, rate-limited.
- [x] Draft privacy policy, agreement, inventory, retention plan, incident plan,
      provider list, ownership statement, approval checklist, family notice.
- [x] Privacy Policy and Terms of Use reachable **in the app** as public routes
      (`/privacy`, `/terms`), wired to the footer, sign-up, and Profile. Still
      marked as drafts; placeholders unfilled. (`src/screens/LegalScreen.tsx`)

**Applied to production and verified (2026-10-11)**
- [x] `028_privacy_retention.sql` applied to `sjiswrvhrnrxkrfhfjrp` (dry-run first).
- [x] `program_invites_privacy.sql` **passes** against the live database.
- [x] Edge-function CORS allowlist deployed (delete-account v2, invite-student
      v3); allowed/refused origins verified live; unauthenticated POST → 401.
- [x] `.env` / `.env.local` Clerk cleanup.
- [ ] Schedule `purge_stale_program_invites()` (e.g. Supabase Cron) so the
      retention rule actually runs.

**Unverified / provider-dependent**
- [ ] Supabase & Vercel encryption, backups, subprocessors, region (provider docs;
      not independently audited).
- [ ] SMTP provider and deliverability (Resend; confirm DNS/SPF/DKIM and the
      DMARC posture for `rhsattendance.org`).
- [ ] Whether any data leaves the chosen region.

**District-dependent (blocking real data)**
- [ ] Written authorization and signed data-processing agreement.
- [ ] District approval form / vendor review.
- [ ] Decision on director-account verification and excuse reasons.
- [ ] Family notice, if the district requires one.
