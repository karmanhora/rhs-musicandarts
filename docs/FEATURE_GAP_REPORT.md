# Feature-gap report — five extensions to RHS Music & Arts Attendance

Audited on 2026-10-20 against the working tree (`main`, after `1b5deca`),
`supabase/migrations/007`–`20261019120000`, `supabase/tests/`, `src/`, and the
local migration harness (`bash scripts/dev/verify_migrations_locally.sh`, which
rebuilt the base dump + all 33 migrations and passed all 18 runnable suites).

The database calls a program an `ensemble`; the interface says **program**. The
two words mean the same row here.

## What already exists

| Area | Already implemented | Where |
| --- | --- | --- |
| Tables | `profiles`, `ensembles`, `memberships`, `sections`, `events`, `attendance_records`, `attendance_staff_notes`, `checkin_sessions`, `notifications`, `audit_logs`, `roles`/`permissions`/`role_permissions`/`user_role_assignments` | migrations 007–036; the four core tables predate 007 and arrive in the restored base schema |
| Attendance model | Four statuses: `present`, `late`, `excused`, `absent`. An **absent mark deletes the row** (`override_attendance`), so "absent" and "no record" are the same state in storage; the app states this in the roll and analytics. `excused` is removed from the percentage denominator, so it is neutral rather than a miss. | `016`, `029`, `019`, `AttendanceScreen`, `AnalyticsScreen` |
| Manual corrections | `override_attendance(event, student, status, excuse_reason, staff_note)`, capability-gated, section-scoped for section leaders | `029` |
| Bulk marking | **UI-only loop** over `override_attendance`, one request per student | `AttendanceScreen.markAllRemaining` |
| Attendance history | **Nothing.** `audit_logs` records role/permission changes only. No attendance audit table, trigger or view exists. | — |
| Event types & requirements | `events.event_type` (free text + label catalogue), `events.attendance_requirement` (`required` / `optional` / `none`), with a constraint that `none` ⇔ `checkin_mode = 'none'`. Create/edit UI, event detail, home-screen next event and the roll all show it. Analytics/percentages count **only** `required` past events. | `017`, `029`, `019`, `CalendarScreen`, `HomeScreen` |
| Requirement analytics | Required-only average per student and per section. **No** required-vs-optional breakdown, no count of excluded events, no labelled statement of what a percentage includes. | `029` analytics RPCs |
| Reports / exports | **Nothing.** No CSV, no download, no printable report. Analytics is on-screen only. | — |
| Absence requests | **Nothing.** `attendance_records.excuse_reason` is a free-text note a staff member writes when marking someone excused; students cannot ask for one. | — |
| Notifications | `notifications` table (types `new_event`, `checkin_open` only), two fan-out triggers, RLS "read/update your own", a bell in `AppShell` that lists the newest 30 and marks them read on open. **No** unread badge, no mark-all-read, no per-item navigation, no error state, no decision/change/cancellation notifications, no dedupe key. | `015`, `016`, `AppShell` |
| Email | Resend via five Edge Functions: `event-digest` (weekly), `event-reminders` (48 h), `event-announcements` (new event), `send-makeup-emails`, `invite-student`. Delivery ledgers in `event_digest_deliveries`, `event_reminder_deliveries`, `event_announcement_deliveries`, `event_makeup_campaigns`/`deliveries`. Per-membership `email_upcoming_events` opt-out. Cron configured in `scripts/migrate/04_functions_config.md`. | `032`, `033`, `036`, `20261019120000` |
| Roles & capabilities | `has_permission(ensemble, code)`, `my_permissions()`, 22 capability codes, system roles student/section_leader/secretary/director, per-program custom roles, `audit_logs`, delegation limits, last-director protection. | `029` |
| UI kit | `PageHeader`, `Stage`/`Poster`, `List`/`Row`, `Metric`/`MetricStrip`, `Sheet`, `ConfirmSheet`, `Field`/`Input`/`Select`/`Textarea`/`Toggle`/`SegmentedControl`, `Badge`, `Alert`, `EmptyState`, `Skeleton`, toasts, `PAGE`/`type-*` scale, light+dark tokens | `src/components/ui.tsx`, `src/index.css`, `docs/DESIGN_SYSTEM.md` |
| Tests | 19 SQL suites run inside a rolled-back transaction against a locally rebuilt schema; Playwright QA guard and check-in specs; five Node harnesses for mail senders | `supabase/tests/`, `e2e/`, `scripts/dev/` |

## What is partial, and what this work changes

1. **Attendance history — missing.** Add an append-only `attendance_audit`
   table written by a trigger on `attendance_records`, so every path (manual
   correction, check-in, bulk mark, future RPC) is covered. No client write
   grant and no client SELECT: reads go through one capability-gated RPC.
   A bulk RPC replaces the UI loop so a bulk action is one understandable entry
   set (`source = 'bulk'`) instead of N indistinguishable manual edits.
   *Not logged*: excuse-reason text, staff notes, or any absence explanation.
2. **Event requirements — mostly exists.** Keep `attendance_requirement`
   exactly as it is; do not add a duplicate column. Add:
   - a required-vs-optional breakdown RPC with an explicit `basis` string;
   - `attendance_requirement` and `unrecorded` in the event summary;
   - `attendance_requirement` on each trend row;
   - UI labels in analytics ("Required only", "Optional — not counted",
     "No attendance — excluded") and a clearer event-form hint;
   - a documented extension point for a future `special` value in `docs/`.
   The documented rule stays: required past events only, excused excluded from
   the denominator, and no record counts as a miss **for the required rate** —
   while reports and event summaries never *label* a missing row "absent".
3. **Absence requests — missing.** One new table plus six narrowly scoped RPCs.
   Approval deliberately does **not** touch `attendance_records`; a reviewer can
   see approved requests on the roll when the event happens, and the ordinary
   excused rule applies then. Two new capabilities (`absence.request_self`,
   `absence.review`) mean section leaders and secretaries get review only if a
   director grants it, per the brief.
4. **Reports — missing.** One capability (`attendance.export_reports`), one
   server-side report RPC returning permission-checked, filtered rows, and a
   browser CSV writer that escapes RFC 4180 fields and neutralises spreadsheet
   formulas. No email addresses, no excuse reasons, no auth data.
5. **Notifications — partial.** Reuse the existing table, RLS and bell. Add a
   `dedupe_key` (unique per recipient), extend the type check, add fan-out for
   absence requests/decisions and event changes/cancellations, keep the
   in-app `read` flag separate from the email delivery ledgers, and rebuild the
   sheet with unread count, mark-all-read, navigation, and loading/empty/error
   states. The 48-hour email reminder is **not** duplicated in-app.

## Order adjustment (and why)

The requested order was requirements → history → absences → reports →
notifications. One dependency forces a small change: absence requests and event
changes must insert notification rows with an idempotency key, so the
notification **schema** (new type values + `dedupe_key`) has to exist before
those triggers. It is therefore the first migration; the notification **centre
UI and event-change fan-out** still come last, as requested. The remaining four
features land in the requested order.

## Deliberate non-goals

- No new scheduled job. The 48-hour reminder stays email-only; the weekly digest
  is untouched.
- No automatic attendance penalty, ranking, or "absence request approved ⇒
  excused record". Approval is a decision, not a mark.
- No generic notification builder for workflows that do not exist (chat was
  retired in 018). Types are added only where a real writer exists.
- No change to existing percentages: `attendance_pct_for()` is not modified.
