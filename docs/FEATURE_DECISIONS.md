# Feature decisions

What this project has decided, removed, deferred, and left genuinely unsettled.
It exists because the repository's documents were written at different times and
several describe a product that no longer exists — a reader who starts in the
wrong file can rebuild something the owner already rejected.

**Verified against the working tree on 2026-10-24.** Every entry names its
evidence. This log records decisions; it does not outrank the code. If an entry
and the code disagree, the code is right and this entry needs a dated correction.

## How to use it

- **Decided** — settled and implemented. Do not reverse without the owner.
- **Removed / retired** — built once, deliberately taken out. Do not restore
  without the owner's explicit approval.
- **Deferred** — not built yet and **not rejected**. Needs the owner's go-ahead;
  do not treat absence as an invitation.
- **Unresolved** — the documents disagree or the fact cannot be established from
  the repository. Stop and ask; do not pick a side.

Add new entries with a date and evidence. Do not rewrite an old report to match a
new decision — append here instead.

---

## 1. Verified decisions

| Decision | Status | Evidence |
| --- | --- | --- |
| **Supabase Auth is the only identity provider.** Identity resolves through `public.current_profile_id()` → `profiles.auth_user_id`. | Decided, live | [AUTH_MIGRATION.md](AUTH_MIGRATION.md) ("done and live", checked 2026-10-17); [DEV.md §4](DEV.md); `package.json` has no Clerk dependency |
| **Clerk was removed, not paused.** No Clerk provider, webhook, proxy, rewrite, env vars, or `profiles.clerk_id`. | Removed 2026-10-09 | [PLATFORM_PLAN.md](PLATFORM_PLAN.md) status note and historical labels; `20261016230715_move_pg_net_drop_clerk_id.sql`; `021_supabase_auth.sql` |
| **No `auth.users` signup trigger.** The join code is collected in the app by `join_program()`; re-adding the trigger would create a second profile per account. | Removed (migration 018) | [018_retire_legacy.sql](../supabase/migrations/018_retire_legacy.sql); [DEV.md §4](DEV.md) |
| **Chat is retired.** Tables survive with a deny-all policy and no `ensemble_id`; no UI, no access helper, no notification trigger. | Removed (migration 018) | [018_retire_legacy.sql](../supabase/migrations/018_retire_legacy.sql); [FEATURE_GAP_REPORT.md](FEATURE_GAP_REPORT.md) ("chat was retired in 018") |
| **Removing a member is `remove_member()`**, scoped to one program: membership, custom role grants and that program's attendance are deleted; the profile and sign-in account stay. | Decided | [DEV.md §5, §7](DEV.md); `031_program_sections_and_removal.sql` |
| **There is no member-deactivation button.** `deactivate_member()` remains as a reversible pause but is unreachable from the UI. | Decided | [DEV.md §7](DEV.md); no `deactivate_member` call exists in `src/` |
| **An approved absence request marks the student excused on that event's roll.** `decide_absence_request()` writes an `excused` record for (event, student) when none exists, signed by the reviewer and attributed in `attendance_audit` with `source = 'absence_request'`; it never replaces a recorded present, late or excused mark, and a denial writes no attendance. | Decided 2026-10-24 by owner request, reversing the earlier "approval writes nothing" rule | [20261024225639_absence_approval_marks_excused.sql](../supabase/migrations/20261024225639_absence_approval_marks_excused.sql), its verification block, and [absence_requests.sql](../supabase/tests/absence_requests.sql) §G/§O; the superseded rule is still written in [FEATURE_IMPLEMENTATION_REPORT.md](FEATURE_IMPLEMENTATION_REPORT.md) Feature 1 and [FEATURE_GAP_REPORT.md](FEATURE_GAP_REPORT.md), which are dated reports and are left as written |
| **"Absent" and "not recorded" are the same stored state.** An absent mark deletes the row; exports say "Not recorded". Changing this would raise existing percentages. | Decided (documented limitation) | [FEATURE_IMPLEMENTATION_REPORT.md §7](FEATURE_IMPLEMENTATION_REPORT.md) |
| **Attendance history exists and excludes personal explanation.** `attendance_audit` is append-only, has no client write path, and never copies `excuse_reason` or staff notes. | Decided | [20261020112000_attendance_history.sql](../supabase/migrations/20261020112000_attendance_history.sql) |
| **Reports/exports carry no email address, auth id or excuse text**, and neutralise spreadsheet formulas. | Decided | [FEATURE_IMPLEMENTATION_REPORT.md](FEATURE_IMPLEMENTATION_REPORT.md) Feature 3; `src/lib/csv.ts` |
| **Required-only attendance rates.** Only `attendance_requirement = 'required'` past events feed the required rate; `excused` is removed from the denominator; optional events are shown separately and never subtracted. | Decided | [FEATURE_GAP_REPORT.md](FEATURE_GAP_REPORT.md); [FEATURE_IMPLEMENTATION_REPORT.md](FEATURE_IMPLEMENTATION_REPORT.md) Feature 4 |
| **Analytics access is director-level per program** (plus program admins), not program-wide. | Decided 2026-10-05 | [PLATFORM_PLAN.md §12](PLATFORM_PLAN.md); enforced by the capability layer in `029_roles_and_permissions.sql` |
| **Roster visibility is co-membership based**: members see only programs they belong to. | Decided 2026-10-05 | [PLATFORM_PLAN.md §12](PLATFORM_PLAN.md); RLS via `013`/`015` helpers |
| **In-app notifications are independent of email.** No email is marked sent because a notification exists; no per-user in-app notification preference yet. | Decided | [FEATURE_IMPLEMENTATION_REPORT.md](FEATURE_IMPLEMENTATION_REPORT.md) Feature 5 and §7 |
| **No generic notification builder** for workflows that do not exist. Types are added only where a real writer exists. | Decided | [FEATURE_GAP_REPORT.md](FEATURE_GAP_REPORT.md) non-goals |
| **No demo seed and no demo accounts.** Test fixtures run inside transactions that roll back. | Decided | [PLATFORM_PLAN.md §1](PLATFORM_PLAN.md); commit `fab4d01` removed obsolete demo-account references; `supabase/tests/*` |
| **The weekly digest is deliberately unscheduled** until the shared Resend quota is settled. | Decided (operational) | [DEV.md §7](DEV.md); `scripts/migrate/04_functions_config.md` |
| **No push/web-push notifications.** The in-app bell is the only channel beyond email. | Decided (deferred feature set) | [PLATFORM_PLAN.md §11](PLATFORM_PLAN.md) |
| **The school's logo artwork stays out.** An original placeholder mark ships and is expected to be replaced by an original design, not the school's. | Removed 2026-10-09 | [BRAND_ASSETS.md](BRAND_ASSETS.md); `public/logo.svg` header comment |

## 2. Platform direction: umbrella site, one program

**Current direction (verified in the repository — DEV.md, the shipped UI and
migration 020):** the site is the **Redmond High School Music and
Arts Program** — one umbrella containing each program's attendance tracker. The
interface says "program"; the database says `ensemble`. Only `band` ships today,
and the schema is multi-program-ready by design.

- [DEV.md §1](DEV.md) states the umbrella framing and that band is currently the
  only program, with nothing in the code assuming it is the only one.
- [PLATFORM_PLAN.md §11](PLATFORM_PLAN.md) records that the umbrella repositioning
  pulled the program switcher, the choose-a-program join landing and joining a
  second program forward — they ship (`usePrograms.tsx`, `ProgramSwitcher.tsx`,
  `JoinProgramScreen.tsx`, migration 020).
- The landing page already shows a "Coming soon: more music and arts programs"
  card (`src/screens/WelcomeScreen.tsx`).

**What is deferred, not rejected:** a second program's actual data, sections,
screens and copy; the program-admin UI; `/e/:slug` routing; per-program themes
beyond the token structure; cross-program analytics, calendar overlays and member
management; per-program email branding and PWA manifests. The governing sentence
is PLATFORM_PLAN §11: nothing until the owner says that work has started.

**What is historical:** the 2026-10-05 line "RHS Band is the only program" was an
owner scope correction written before the umbrella repositioning. It is
**superseded**, not a rejection of other programs. Do not cite it to refuse
multi-program work, and do not cite the "Coming soon" card as approval to create
a second program. Only the owner settles this.

## 3. Deferred, not rejected

These are absent on purpose. They need an explicit owner decision, not an
inference from a stale document or an empty table.

| Item | Note |
| --- | --- |
| Second program data/screens (Orchestra, Choir, Drama, Jazz) | No seed rows, no screens, no copy |
| Program-admin screens | `program_admins` exists in the DB; no UI until a program needs it |
| `/e/:slug` route mount | `/`, `/checkin`, `/roster`, … stay as they are; QR deep links in the wild must keep working |
| Per-program themes | Token structure exists; one theme ships |
| Cross-program analytics / calendar overlay / member management | Explicitly out of scope |
| Push notifications / web push | In-app bell + email only |
| Per-user in-app notification preferences | Email preferences exist; in-app has no opt-out |
| Server-side PDF reports | Printing opens a pop-up window |
| A `special` value for `attendance_requirement` | Documented extension point only |
| MFA, social/SSO providers beyond Google, self-service account deletion | Not built |

## 4. Conflicts and their current status

Recorded because an agent that reads only one side would act incorrectly. Each
entry says whether the conflict was resolved in the documents on 2026-10-24 or is
still open. None of these is settled by this file.

### 4.1 The Privacy Policy Contact section — removed, then apparently restored

- [docs/privacy/WEBSITE_LEGAL_CHANGES.md](privacy/WEBSITE_LEGAL_CHANGES.md) says
  §12 "Contact" **was removed on the owner's instruction on 2026-10-11**, must be
  added back later, and that a `TODO(add-back)` block sits in
  `PRIVACY.sections` in `src/screens/LegalScreen.tsx`.
- The working tree contradicts that: `LegalScreen.tsx` renders a Contact block for
  the privacy policy with the address `privacy@rhsattendance.org`, and the legal
  pages carry an effective date of **2026-10-18**.
- That address and the Contact block were introduced by commit **`8a3765d`
  ("Publish a complete privacy policy for Google OAuth verification",
  2026-10-18)** — after the changes doc was written.
- No `TODO(add-back)` marker exists anywhere in `src/`.
- [QA_REPORT.md §7](QA_REPORT.md) (2026-10-12) still describes `[CONTACT EMAIL]`
  as an unresolved placeholder; the shipped page now uses a real address, while
  [privacy/PRIVACY_POLICY.md](privacy/PRIVACY_POLICY.md) still has its own
  `## Contact` section.

**Needed:** the owner confirms which is canonical. Until then: do not add, remove
or reword the Contact section, and do not "fix" the placeholder by inventing an
address.

### 4.2 The five-feature report contradicts itself about deployment

- [FEATURE_IMPLEMENTATION_REPORT.md](FEATURE_IMPLEMENTATION_REPORT.md) opens with
  "**nothing has been applied to the production Supabase project or deployed to
  Vercel**".
- §6a and §6b of the same file record the six migrations applied on 2026-10-21
  and the frontend deployed to `rhsattendance.org` the same day, with verification
  detail.

**Resolved in the document (2026-10-24):** a dated status note now sits directly
under the stale sentence, pointing at §6a/§6b and the matching commits. The
sentence is left as written so the report's own history stays intact. Production
state is still not independently verified here — do **not** use the header as a
reason to apply those migrations again.

### 4.3 DEV.md's "Not done yet" is partly a stale backlog

Before 2026-10-24, [DEV.md §7](DEV.md) asked for migration 021 to be applied before
anyone signs in and listed 029/030 as applied-but-not-deployed. That description
was stale: [AUTH_MIGRATION.md](AUTH_MIGRATION.md) recorded 021 as done and live, and
[FEATURE_IMPLEMENTATION_REPORT.md §6a](FEATURE_IMPLEMENTATION_REPORT.md) recorded
local and remote migrations in step on 2026-10-21. Acting on §7 as it then read
would have meant re-running migrations against production.

**Addressed in DEV.md (2026-10-24):** §7 now opens with a status note, and the
stale entries state what is *recorded* versus what an operator must still verify.
Live state is still not verified from this document; check the project before
acting.

### 4.4 Migration counts disagree across documents

**Documented, not resolved (2026-10-24).** DEV.md no longer states a stale range
(it names the tree's 39 files). The gap report's "33 migrations" and the
implementation report's "39 applied" are snapshots of their own dates, left as
written. The tree holds **39** files in `supabase/migrations/` and **24** suites in
`supabase/tests/`. Any count in prose is unreliable — use the directory or
`supabase migration list --linked`.

### 4.5 PLATFORM_PLAN's Clerk sections (now labeled historical)

The decision itself was never unresolved — Supabase Auth is live — but the
document's status line, §12 decision 3 and all of §13 used to read as approved
architecture, and §8–§9 described `clerk_id` personas and a `03b_clerk_import.sh`
step.

**Resolved in the documents (2026-10-24):** PLATFORM_PLAN opens with the current
decision and labels those sections historical and non-executable;
[AUTH_MIGRATION.md](AUTH_MIGRATION.md) §3 is marked applied and §8 is marked
historical and prohibited without owner approval. The text is preserved, not
deleted.

## 5. Open questions that belong to the owner

From [QA_REPORT.md §7](QA_REPORT.md), still unanswered in the repository:

1. The district help contact — who or what address the policy, terms, browser
   support page and `index.html` fallbacks should point at (entangled with 4.1).
2. Whether to keep the two accepted 8px-gap exceptions (bottom tab bar, calendar
   day grid).
3. Whether the WebGPU note canvas must meet the same contrast bar as Canvas2D
   (needs a GPU readback harness).
4. A real-device pass for iOS safe areas, standalone PWA, input zoom, camera
   permission and forced-colors mode.
5. Firefox and WebKit have not been measured; the Chromium guard suite is the only
   browser evidence.

## 6. What this log is not

- It is not a roadmap. Deferred items are not commitments.
- It is not permission. Nothing here authorises a migration, a deploy, a data
  change or a new dependency.
- It is not complete. Absence of an entry is not evidence that something was
  approved — check the canonical docs and ask.
