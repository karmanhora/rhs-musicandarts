# RHS Music Platform — Phase 0 Audit & Platform Plan

**Status:** **Approved 2026-10-05** with one architectural change: **Clerk replaces Supabase Auth** for sign-in/sign-up (full design in §13). Q1/Q2 (§12) accepted as proposed.

> **Reversed 2026-10-09 — Supabase Auth is the identity provider again.**
> §13 was built, then removed: Clerk brought a third-party script, a proxy
> function, a webhook, an Edge Function and five environment variables to do what
> the database's own service already does. `supabase/migrations/021_supabase_auth.sql`
> repoints identity at Supabase Auth (`profiles.auth_user_id`, `current_auth_id()`)
> and [docs/AUTH_MIGRATION.md](AUTH_MIGRATION.md) is the record. §13 is kept below
> as the history of that decision; read every "Clerk" in it as "the identity
> provider", which is Supabase Auth again. It is still worth reading for the one
> part that did not change: identity resolves through a single helper
> (`current_profile_id()`), which is why the provider could be swapped without
> rewriting a policy, a trigger or an RPC.
**Scope correction (2026-10-05):** **RHS Band is the only program.** The schema stays *multi-program-ready* (that is what makes it "all in one platform"), but exactly one program — `band` — exists as data, ships in the UI, and is built for. Nothing named Orchestra/Choir/Drama is created, seeded or tested as a deliverable; §11 lists what stays deferred.
**Phase 2 status:** migrations 007–018 are **applied to NEW** (`sjiswrvhrnrxkrfhfjrp`) and re-runnable; the gate (`scripts/migrate/05_verify.sh`) exits 0 — 16/16 legacy tables match, RLS on every public table, and the three suites pass (`backfill_verification`, `ensemble_isolation`, `security_verification_v2`).
**Scope shipped now:** RHS **Band only** (`slug = 'band'`), multi-ensemble-*ready* architecture.
**Source audited:** `studiosmandalora/RHS-BAND` @ `main` (read-only clone in `reference/RHS-BAND/`).

---

## 1. What was audited

| Area | Files |
|---|---|
| Schema + all RPCs + RLS + triggers | `supabase/schema.sql` (2,260 lines — canonical, self-contained) |
| Migrations | `001_event_types_attendance_upgrades.sql`, `002_section_leader_permissions.sql`, `003_staff_only_attendance_notes.sql`, `004_bulk_roster_import.sql`, `005_security_and_attendance_hardening.sql`, `006_checkin_session_open_window.sql` |
| Security tests | `supabase/tests/security_verification.sql` (801 lines, 1 rolled-back transaction, ~60 assertions) |
| Seeds / utilities | No demo seed or demo-account fixtures are present in this repository. |
| Edge functions | `sync_google_calendar` (ICS fetch + parse + RPC), `send_signup_reminder` (SendGrid) |
| Storage / auth | `avatars` bucket + 4 `storage.objects` policies; `handle_new_user` trigger on `auth.users`; 6 email templates; `config.toml` |
| Frontend | `src/` — 9 screens, `AppShell`, `ui.tsx` kit, `constants/types/rpc/supabase/date/eventCache/calendarSync`, `useAuth/useDark`, PWA (`sw.js`, manifest), Vite/TS/Tailwind v4 config |

**Data model today:** `profiles` (identity + `instrument` + global `roles app_role[]`), `events`, `checkin_sessions`, `attendance_records`, `attendance_staff_notes`, `checkin_attempts`, `personal_events`, `notifications`, `attendance_reminders`, `app_settings` (`band_join_code`), `join_code_attempts`. All attendance writes flow through SECURITY DEFINER RPCs — a strong foundation we keep.

---

## 2. Inventory of single-ensemble assumptions

Every row here is addressed in Phase 2 (DB) or Phase 3 (UI). "SA" = security-relevant.

### 2.1 Tables & columns

| # | Location | Assumption | Target change |
|---|---|---|---|
| T1 | `profiles.instrument` | Section = person-level free text | Move to `memberships.section_id` → `sections`; drop column after backfill |
| T2 | `profiles.roles` | Roles are global (`user_has_role('director')` = director **everywhere**) | Move to `memberships.roles`; `profiles` keeps only person-level identity (name, avatar, `must_change_password`, `deactivated`) |
| T3 | `app_settings['band_join_code']` | One join code for the whole app | New per-ensemble RPC-only store (`ensemble_settings.join_code`); `app_settings` retired |
| T4 | `events` | No `ensemble_id` | `events.ensemble_id uuid NOT NULL` (nullable → backfill → NOT NULL) |
| T5 | `checkin_sessions`, `attendance_records`, `attendance_staff_notes`, `checkin_attempts`, `attendance_reminders` | Implicitly program-wide via events | Keep keys; ensemble derived through `events.ensemble_id` (no schema change needed — this is why "attendance keyed by event" is the right call) |
| T6 | `join_code_attempts` | One global brute-force bucket | Keep (IP-keyed throttle is fine globally); validation becomes ensemble-aware |
| T7 | `notifications` triggers | Fan-out inserts for **every** profile on every new event / check-in | Fan-out to members of the event's ensemble only |
| T8 | Google Calendar columns on `events` | Single calendar implied | New `calendar_sources` table (per ensemble); events keep `google_calendar_uid` (unique per source in v1) |

### 2.2 Functions / RPCs (SA = security-relevant)

| # | Function | Assumption | Target change |
|---|---|---|---|
| F1 SA | `user_roles()`, `user_has_role()`, `user_role()` | Global role lookup on `profiles.roles` | Replaced by `is_program_admin()`, `is_member_of(ensemble)`, `has_role_in(ensemble, role)`, `is_section_leader_for(user, section)` (SECURITY DEFINER, `set search_path`). Old ones dropped after all callers migrate. |
| F2 SA | `handle_new_user()` on `auth.users` | Validates `band_join_code` from `app_settings`; writes `profiles.instrument` | **Replaced by Clerk** (§13): `user.created` webhook → `clerk_user_created` Edge Function validates the join code and creates `profiles` + `memberships`. Trigger dropped. |
| F3 SA | `guard_role_change()` | Guards `profiles.roles` | Move guard to `memberships` (roles): only that ensemble's directors (or program admins) change roles; never another director's |
| F4 SA | `set_band_join_code`, `get_band_join_code`, `get_band_join_code_status`, `validate_band_join_code` | Keyed `'band_join_code'` | `p_ensemble` param (slug or id); same return shapes so the UI changes are trivial |
| F5 SA | `start_checkin_session(event)` | Global staff check | Derive ensemble from event; `has_role_in(ensemble, staff-role)`; **new:** section leaders may only open sessions for their section when the event is section-scoped (v1: ensemble-wide, matching today's behavior) |
| F6 SA | `record_attendance(token)`, `record_attendance_by_code(code)` | Global "directors don't check in"; any roster member may check in | Ensemble derived from session→event; require `is_member_of(ensemble)` and `not has_role_in(ensemble,'director')`; keep ALL existing rules (rate limit 5/2 min, QR window, mode check, excused protection, first-check-in-wins, status×attended invariant) |
| F7 SA | `override_attendance` (both signatures) | Global staff check; section scoping via `profiles.instrument` string match | `has_role_in(ensemble, staff)`; section scoping via `memberships.section_id` and `is_section_leader_for` |
| F8 SA | `invite_member_one` / `invite_member` / `invite_members_bulk` | Global roles; writes `profiles.instrument`; **creates `auth.users` directly** | `p_ensemble` param; creates `memberships`; section-leader scoping by `section_id`; account creation moves to `invite_member` Edge Function via Clerk Backend API (temp-password UX unchanged) — §13 |
| F9 SA | `reset_member_password`, `deactivate_member`, `reactivate_member`, `update_member_instrument` | Global director-only; "can't touch another director" | Director of **that member's ensemble** (or program admin); director-protection becomes per-ensemble; password reset + ban/unban move to Clerk Backend API calls (§13) |
| F10 SA | `get_student_attendance_pct`, `get_section_attendance_stats`, `get_event_attendance_summary`, `get_attendance_trend` | Global director-only; queries program-wide | `p_ensemble` param; all aggregates scoped to the ensemble; access = **see Q1 below** (default proposal: director of that ensemble or program admin — matches today's guarantees and the ported tests) |
| F11 | `sync_google_calendar_events(events, replace_all)` | Replaces/archives **all** Google events program-wide | `p_calendar_source` (or `p_ensemble`); upsert/archive scoped to that source; see §6 for the bug fixes folded in here |
| F12 | `get_roster_emails()` | Whole-program roster | `p_ensemble`; members of that ensemble |
| F13 | `client_ip()`, `invalidate_checkin_sessions_on_mode_change()` | No ensemble coupling | Unchanged |

### 2.3 RLS policies

| # | Policy | Assumption | Target change |
|---|---|---|---|
| P1 SA | `profiles_read_all_authed` (`using (true)`) | Any signed-in user reads the whole roster | Read self + co-members (any shared active membership) + program admins |
| P2 SA | `profiles_update_self_or_director` | Global director | Self always; role/section fields move to `memberships` policies (ensemble director / program admin) |
| P3 SA | `profiles_delete_director` | Global director; protects directors | Ensemble director (or program admin) may delete non-directors of their ensemble |
| P4 SA | `events_read_all_authed` (`using (true)`) | Every authed user sees **all** events | `is_member_of(events.ensemble_id) or is_program_admin()` |
| P5 SA | `events_insert_staff` / `events_update_staff` / `events_delete_director` | Global director/secretary | `has_role_in(events.ensemble_id, …)` (insert: `with check` on `ensemble_id`) |
| P6 SA | `checkin_sessions_read_owner_or_director` | Global director | Issuer, or `has_role_in(ensemble,'director')`; still no client writes |
| P7 SA | `attendance_read_self_staff` | Global roles + `instrument` string match | Self, `has_role_in(ensemble,'director'/'secretary')`, or `is_section_leader_for(auth.uid(), student's section)` |
| P8 SA | `attendance_staff_notes_read_staff` | Same as P7 | Same rewrite as P7; students (incl. the subject) still never read notes |
| P9 | `personal_events_own_all`, `notifications_read/update_own`, `storage` avatar policies | Person-scoped | Unchanged |
| P10 | `checkin_attempts`, `join_code_attempts`, `app_settings`, `attendance_reminders` | RLS on, RPC/service-role only | `ensemble_settings` inherits the same "no client policies" rule |

### 2.4 Frontend

| # | Location | Assumption | Target change |
|---|---|---|---|
| U1 | `lib/constants.ts` `INSTRUMENTS` | 7 hardcoded sections | Sections fetched from DB per ensemble (`sections` table) |
| U2 | `constants.ts` `EVENT_TYPES`, "Band Meeting", chip maps | Band vocabulary + one-off chip class strings | Generic event-type keys internally; band wording via a Band theme label map; chip colors become tokens (no raw Tailwind in maps) |
| U3 | `WelcomeScreen` | "Band join code", hardcoded instrument dropdown; Supabase Auth calls | Replaced by Clerk `<SignIn />` / `<SignUp />` themed to the design system (§13); the join code is collected **in the app**, on the join screen (§13.2, `src/screens/JoinProgramScreen.tsx`), not as a sign-up field — Clerk fires `user.created` once, so a second program could never be added there; copy carries the umbrella's name, not the band's |
| U4 | `AppShell` | Hardcoded logos/branding; `profile.roles` gating | Branding from theme tokens; roles from active membership |
| U5 | `CheckInScreen` | Section scoping via `profile.instrument`; QR deep link `/checkin?token=` | Membership/section based; **keep `/checkin?token=` exactly as-is** (QR codes in the wild) |
| U6 | `AttendanceScreen` | `INSTRUMENTS` filter chips; client-side % math (with a contradictory filter in `percentOf` — see §7) | Sections from DB; % comes from an RPC so student/analytics numbers can't drift |
| U7 | `RosterScreen` | `INSTRUMENTS` selects; CSV canonicalizes against `INSTRUMENTS`; "Band join code" card | Sections from DB (CSV warns on unknown section, imports anyway — unchanged behavior); join code RPCs gain `p_ensemble` |
| U8 | `ProfileScreen` | `INSTRUMENTS` select; "RHS Band Attendance Manager" footer | Sections from DB; theme label |
| U9 | `AnalyticsScreen` | Queries all `profiles`/`attendance_records`; roster = all profiles | All queries + RPCs scoped to active ensemble |
| U10 | `lib/calendarSync.ts` + edge fn | Single hardcoded ICS URL fallback | `calendar_sources` per ensemble; sync passes source id |
| U11 | `send_signup_reminder` | "RHS Band" from-name; program-wide recipients | Ensemble param; recipients = ensemble members not checked in |
| U12 | Email templates, `index.html`, `manifest`, `sw.js` cache name | "RHS Band" branding, `#2d5a1b` | Single theme now (the Band tokens own the colors); the site itself is named for the **Music and Arts Program** in `index.html` and the manifest, with the band's name in `ensembles` |
| U14 | **The word "ensemble" must appear nowhere in the UI.** The site is the *Redmond High School Music and Arts Program*, and each tracker inside it is a **program** ("program", "section", "roster"). "Band" is right only where the program on screen *is* the band — its own name, or the "Band Meeting" event type. "Ensemble" lives in DB/API identifiers only. |

---

## 3. Target schema (Phase 2 — migrations 007+ on NEW only)

Small idempotent migrations; any future `ALTER TYPE … ADD VALUE` gets its own migration file (enum `app_role` needs **no** new values for this design — `program_admin` is a table, not a role).

```sql
-- 007: ensembles + theme tokens
create table public.ensembles (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name        text not null,
  short_name  text not null default '',
  theme_color text not null default '#2d5a1b',
  logo_url    text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Token structure is shared; only VALUES differ per ensemble later.
create table public.ensemble_theme_tokens (
  ensemble_id uuid primary key references public.ensembles(id) on delete cascade,
  tokens      jsonb not null default '{}'::jsonb  -- semantic tokens, not raw CSS
);

-- 008: sections replace the INSTRUMENTS constant
create table public.sections (
  id          uuid primary key default gen_random_uuid(),
  ensemble_id uuid not null references public.ensembles(id) on delete cascade,
  name        text not null,
  sort_order  int  not null default 0,
  unique (ensemble_id, name)
);

-- 009: memberships (roles + section are per-ensemble now)
create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  ensemble_id uuid not null references public.ensembles(id) on delete cascade,
  section_id  uuid references public.sections(id) on delete set null,
  roles       public.app_role[] not null default '{student}',
  active      boolean not null default true,
  joined_at   timestamptz not null default now(),
  unique (user_id, ensemble_id)
);

-- Program-level admin (DB only for now — NO UI until Orchestra)
create table public.program_admins (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 010: events.ensemble_id (nullable first, NOT NULL after backfill)
alter table public.events add column if not exists ensemble_id uuid
  references public.ensembles(id) on delete restrict;

-- 011: per-ensemble settings (RPC-only store, like app_settings today)
create table public.ensemble_settings (
  ensemble_id uuid primary key references public.ensembles(id) on delete cascade,
  join_code   text not null default ''
);

-- 012: calendar sources for Google sync
create table public.calendar_sources (
  id            uuid primary key default gen_random_uuid(),
  ensemble_id   uuid not null references public.ensembles(id) on delete cascade,
  provider      text not null default 'google_ics',
  ics_url       text not null,
  name          text not null default '',
  active        boolean not null default true,
  last_synced_at timestamptz
);

-- 013: helper functions (SECURITY DEFINER, set search_path, stable)
--   current_profile_id()            -- identity: profiles.id via auth.jwt()->>'sub' (Clerk, §13)
--   is_program_admin()
--   is_member_of(p_ensemble uuid)
--   has_role_in(p_ensemble uuid, p_role public.app_role)
--   is_section_leader_for(p_user uuid, p_section uuid)
--
-- SHIPPED migration order (lexical filename order == apply order == dependency
-- order; the backfill had to move ahead of the rewrite that reads it):
--   007 ensembles + theme tokens      012 calendar sources
--   008 sections                      013 identity helpers
--   009 memberships + program admins  014 backfill band (section/membership/event links)
--   010 events.ensemble_id            015 policies + guards
--   011 ensemble_settings             016 RPCs
--                                     017 calendar sync + grant hygiene
--                                     018 retire legacy (roles/instrument/app_settings,
--                                         auth.users FK + signup trigger)
```

**`profiles` after migration:** `id` (uuid PK — every FK in the schema keeps working), `clerk_id text unique not null` (Clerk `user_…` id, §13), `full_name, display_name, avatar_url, must_change_password, deactivated, created_at` — pure person-level identity.

### Acceptance criterion — "add a program = data only"

> **Band-only scope (owner directive, 2026-10-05):** RHS **Band** is the only program. The block below records the *shape* a future program insert would take so the schema stays honest about it — no second program is created, seeded, shipped or UI-surfaced, and `public.ensembles` keeps exactly one row (`band`). The `new_ensemble_data_only` test suite was removed rather than maintained.

```sql
insert into public.ensembles (slug, name, short_name, theme_color) values ('orchestra','RHS Orchestra','Orchestra','#3b2d5a');
insert into public.ensemble_theme_tokens (ensemble_id, tokens) values ((select id from ensembles where slug='orchestra'), '{...}');
insert into public.sections (ensemble_id, name, sort_order)
  select id, s.name, s.ord from ensembles, (values ('Violin',1),('Viola',2),('Cello',3)) as s(name,ord) where slug='orchestra';
insert into public.ensemble_settings (ensemble_id, join_code) values ((select id from ensembles where slug='orchestra'), 'ORCH2027');
insert into public.calendar_sources (ensemble_id, ics_url) values ((select id from ensembles where slug='orchestra'), 'https://calendar.google.com/...'); -- optional
-- optional: a theme entry is just token values — no code, no migration
```

`tests/ensemble_isolation.sql` proves the isolation half of this claim with two throwaway programs (`test-alpha`/`test-beta`) inside a **rolled-back transaction** — nothing is inserted for real.

### Backfill (runs once, idempotent, in `016_backfill_band.sql`)

1. Insert ensemble `('band', 'RHS Band', 'RHS Band', '#2d5a1b')`.
2. Create `sections` for each distinct `profiles.instrument` (canonical order: Flute, Clarinet, Saxophone, Trumpet, Trombone, Baritone, Percussion; anything else — e.g. `''` and `'Conductor'` — gets a section or NULL section deterministically; empty instrument → NULL section, same "no section = no access" rule as today).
3. `memberships` from `profiles` (`roles` copied verbatim, `section_id` from instrument, `active = not deactivated`).
4. `events.ensemble_id = band` for every event (manual + Google-sourced).
5. Move `app_settings['band_join_code']` → `ensemble_settings.join_code` for band.
6. Insert a `calendar_sources` row for the known RHS Band ICS feed.
7. Verification block: **zero orphans** — every event has an ensemble, every attendance row's event does, every profile has ≥1 membership *or* is a program admin, join code preserved. Prints counts and raises on any violation.

All user IDs and attendance history are preserved — accounts, password hashes, and rows are copied verbatim in Phase 1 and only *linked* here.

---

## 4. URL strategy decision — **keep clean URLs**

**Decision: `/`, `/checkin`, `/roster`, … stay exactly as they are.** The active ensemble is resolved silently from the user's memberships (Phase 3 ships a resolver that picks the single `band` membership).

Why this beats `/e/band/...` now:

- **Nothing breaks at cutover.** Bookmarks, the installed PWA (`start_url: "/"`, `scope: "/"`), and — critically — **QR deep links in the wild (`/checkin?token=…`)** keep working. QR codes get projected on walls and photographed; we can never regenerate them.
- **The "ensemble" word never appears in the URL bar**, reinforcing the dedicated-RHS-Band feel.
- Adding `/e/:slug/…` later is genuinely trivial and non-breaking: the router already builds screens from one route tree; we mount that tree twice — once under `/` (ensemble from context) and once under `e/:slug/*` (explicit context override). One `<Route>` wrapper + the resolver accepting an override. Old links and QR codes keep hitting the `/` mount forever.

So: clean URLs shipped now; `/e/:slug` becomes a ~20-line addition when Orchestra arrives.

---

## 5. UX audit of the current screens

**Overall:** the app is genuinely functional and thoughtful in places (check-in state machine, CSV preview/validate, forced password change, soft-deactivate). But it reads as a competent school project, not a premium product: a 128px-tall header on a phone, stacked full-width buttons on every event card, `window.confirm()` dialogs, gray-box loaders, raw spinner states, and hand-rolled zinc-* dark mode. It is also desktop-shaped where its users are phone-shaped: the **home screen is a month calendar** instead of "what's next + check in."

**What's good (keep the logic, restyle the skin):**

- Check-in correctness: QR + manual code parity, clear failure messages ("That code has expired — ask for a fresh one."), first-check-in-wins, excused protection.
- Roster CSV import: template download, per-row validation with preview table, per-row results with temp passwords + copy-all. Best screen in the app.
- Soft-deactivate vs. hard remove; forced password change gate; temp-password handoff UX.
- Event form: sensible coupling of attendance requirement ⟺ check-in mode (mirrors the DB constraint).
- Security posture (RPC-only writes, rate limits, section-scoped notes) — unusually good for a high-school project.

**What's clunky (fix in Phase 3b):**

- **Home = month grid.** Students open the app for one reason: check in. Today that's tab → pick event chip → scan. Target: home shows today's/next event + one big **Check in** button (1 tap), attendance ring, upcoming list; the month grid becomes a secondary Calendar view.
- **AppShell header is 128px** (`h-32` logo `h-28`) — enormous on a 390px phone. Compact app-bar with avatar + bell.
- **Event cards stack 4–5 full-width buttons** (Add to Google Calendar / Edit / Delete / Archive / Remind). Overflow menu + role-appropriate primary action.
- **`window.confirm()`** for delete/archive/deactivate — replace with designed confirm sheets.
- **CheckInScreen is 1,145 lines serving 3 personas**; the director live view is projector-hostile (200px QR, `max-h-52` scrolling roster, tiny type). Split student/staff flows; director live view = full-screen mode with huge QR/code, countdown ring, live counter, missing-by-section.
- **Analytics math is subtly wrong/misleading**: `overallPct` counts only `status='present'` (late students drag the % as if absent), `AttendanceScreen.percentOf` has a contradictory filter (`(r.attended || excused) && status !== 'excused'`), and the CSV export computes a third variant. One source of truth via RPC.
- **Analytics are numbers-in-boxes**, no charts, no trends over time, no at-risk list, no export.
- **Roster with many students is painful**: no search, no section/status filter, no bulk actions; every card shows editing chrome at once.
- **Duplicate password-change UI** in three places (Profile, UpdatePassword, ForcePasswordChange).
- **Loading = spinners/gray boxes**; no skeletons, no toasts (inline `Alert`s), no micro-interactions, no haptics, no `prefers-reduced-motion`.
- **Accessibility gaps**: icon buttons ~36px (< 44px target), modal lacks focus trap/`aria-modal`, buttons lack visible focus rings, several color-only status cues, no keyboard-operable date picking patterns audited.
- **Performance**: no route-level code splitting (all screens statically imported in `App.tsx`; only html5-qrcode is chunked). Easy win in Phase 3b.

---

## 6. `sync_google_calendar` investigation (the "known issue")

Findings from reading the parser, the RPC and the sync history comments:

1. **Event-type bug (real, live-impacting).** `sync_google_calendar_events` inserts `type` (e.g. `'Concert'`) but never `event_type`, so every synced event lands on the column default `'rehearsal'`. The UI reads `event.event_type || event.type` → **every Google-synced event displays as "Rehearsal."** This is why `supabase/fix_event_types.sql` exists (a manual patch after the fact). Fix: sync writes both fields (or we collapse the redundant `type`/`event_type` pair into one canonical column + label map).
2. **Empty-feed blast radius.** If the ICS fetch succeeds but parsing returns 0 events (format change, transient Google weirdness), the "archive disappeared events" pass archives **every** synced event. Fix: refuse to archive when the fetched event count is 0 (or < 50% of the previous run) and return a warning.
3. **All synced events become `required` + `qr`** via column defaults — "NO SCHOOL", "Booster Meeting" and "Banquet" all count as required attendance events in analytics. Fix: derive `attendance_requirement`/`checkin_mode` from the inferred type (the frontend already has `defaultCheckinMode()` logic to port into the sync).
4. **Auth hole (minor).** `verify_jwt = false` and `isAllowed` accepts *any* signed-in user — any student can trigger a sync every 5 minutes. Fix: director/secretary of the target ensemble or the `CALENDAR_SYNC_SECRET`.
5. **Single hardcoded ICS URL** fallback — becomes a `calendar_sources` row (per ensemble) in Phase 2; the edge function reads the source config instead.
6. Cosmetic: `v_deleted_now` is reused for two different meanings in the RPC result; return object says `deleted: 0` while `p_replace_all` can delete rows. Clean up while we're in there.

The parser itself (line unfolding, TZID handling, `zonedTimeToUtcIso` double-pass offset) is sound and will be reused with tests.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Auth data restore** (`auth.users` incl. password hashes, `auth.identities`): GoTrue fails on NULL token columns (documented in the repo) and triggers fire during load | `SET session_replication_role = replica` during data load; post-load sanity query for NULL token columns; verify by signing in with a test account in a staging flow before cutover |
| **Storage avatars can't be copied with `psql`** — objects live in object storage, not in SQL | Copy via Storage API (list/download/upload) with service keys in `03_auth_storage.sh`; verify object count + bytes old vs new |
| **RLS recursion** when policies read `memberships` (policies on memberships referencing memberships) | All cross-table checks go through SECURITY DEFINER helpers (`has_role_in` etc.), exactly the pattern `user_roles()` uses today |
| **Enum-in-transaction** (`ALTER TYPE … ADD VALUE` unusable in same transaction) | We add **no** enum values in this design; if any appear later, one value per migration file (documented in the migration template) |
| **Empty-feed calendar sync archiving everything** at the worst moment | Fix #2 in §6 ships in Phase 2 before any re-sync against NEW |
| **Cutover surprises** (PWA cache, email links, Vercel env) | SW cache name bump forces clients to refresh; `run_all.sh` + `CUTOVER.md` rehearse the full pipeline against fresh data first; old deployment untouched → instant rollback |
| **Data drift between rehearsal and cutover** | The whole pipeline is idempotent and re-runnable against fresh dumps (Phase 4 `run_all.sh`); final run happens during the freeze window |
| **Temp passwords / PII in logs** | Scripts never echo credentials (env vars only, gitignored); dump files land in gitignored `scripts/migrate/out/` |
| **Tests leaking fixtures into NEW** | Every test suite runs in `BEGIN … ROLLBACK` (proven pattern from `security_verification.sql`), including the two throwaway cross-ensemble fixtures |
| **Narrowing `profiles_read_all_authed`** could break UI code that assumes it sees every profile | Phase 3b centralizes all queries through the ensemble context; smoke checklist includes roster/attendance/analytics for every persona |
| `supabase/.temp/` hygiene | Never copied (gitignored in this repo from day one — done); fix in old repo only with your approval |
| **Clerk password-hash import** — Clerk must accept Supabase's bcrypt `$2a$` hashes for "same passwords" to survive | Phase 1 gate: spike in a throwaway Clerk **development** instance — import 2 known accounts and sign in with their real passwords before any bulk import. Fallback if a variant mismatch appears: trickled reset-link migration (users set a password once) |
| **Clerk cutover kills all sessions** (new session manager) | Accepted: one re-sign-in at cutover with unchanged passwords. Called out in the freeze announcement |
| **Clerk dependency & limits** (availability, BAPI rate limits on user import, free-tier 50,000 MAU) | RHS scale is ~two orders of magnitude under limits; Clerk's open-source migration tool handles rate limiting; import is idempotent (by `external_id`) and re-runnable |
| **Supabase TPA misconfiguration** (wrong Clerk domain, missing `role` claim) locks everyone out at cutover | Configured and verified in Phase 3b against NEW before the freeze; `04_functions_config.md` has the checklist; smoke test with a real Clerk session |
| **Access token exposed in chat** (the `sbp_…` Management API token transited this conversation) | Stored only in gitignored `.env`; **rotate it in your Supabase account settings once Phase 1 is built** (or now — the plan only needs it at run time) |

---

## 8. Test plan (Phase 2 gate)

Port `tests/security_verification.sql` → `supabase/tests/security_verification_v2.sql` with ensemble-scoped personas (memberships in `band`), preserving every behavioral assertion (QR window, rate limits, excused protection, status×attended, mode ⟺ requirement, multi-role, NULL-section leader, grant hygiene). New suites:

1. **`tests/ensemble_isolation.sql`** — creates **two throwaway ensembles** (`test-alpha`, `test-beta`) with fake users inside one rolled-back transaction. Asserts: Alpha director can't read/write Beta's events/attendance/notes/analytics and vice versa; a student in both programs sees both rosters but no cross-notes; program admin sees both; section leader scoped to their section **within their program** (a leader of "Violin" in Alpha gets nothing in Beta even with the same section name); join codes and calendar-sync scoping are per program; notification fan-out stays inside the program.
2. ~~`tests/new_ensemble_data_only.sql`~~ — **removed (band-only scope).** It inserted a second program to prove "add a program = data only"; the owner redirected the work to the band only, so the suite was deleted instead of maintained. No architecture changed.

   **Update, October 2026:** the owner has since repositioned the product as the umbrella site above — *the Music and Arts Program, containing each music program's attendance tracker*. Band is still the only program that exists (one `ensembles` row), so nothing about the schema changed: the interface now speaks "program", the shell carries the umbrella and a program switcher, and `join_program()` (020) is what makes adding orchestra a data change rather than a code change.
3. **`tests/backfill_verification.sql`** — orphan checks, role/section preservation, join-code migration, event counts per ensemble.

All suites: rolled back, self-checking (`FAIL: <id>` on first violation), runnable via `psql -f` in `05_verify.sh`. Personas carry `clerk_id` values and authenticate by setting `request.jwt.claims.sub` to the `clerk_id` — the exact token shape Clerk session tokens present to PostgREST (§13).

---

## 9. Migration pipeline (Phase 1 deliverable)

`scripts/migrate/` — bash, idempotent, documented, dry-run by default:

- `01_dump.sh` — against `OLD_DB_URL`: `roles.sql` (idempotent SQL-guarded role DDL), `schema.sql` (`pg_dump --schema-only --no-owner`, **public schema only** — Supabase-owned auth/storage/realtime schemas are excluded to avoid restore collisions and version drift; their app-custom objects are recreated from `sql/reapply_auth_storage.sql`), `data.sql` (`pg_dump --data-only`, COPY: all public rows + `auth.users`/`auth.identities` + `storage.buckets`/`objects` — live session state like `auth.sessions`/`refresh_tokens` is deliberately not copied), plus migration history. Writes to gitignored `out/`. (Tooling note: the Supabase CLI's `db dump` shells out to Docker on Windows — unavailable here — so the pipeline calls `pg_dump` 18 directly, the same engine the CLI wraps; roles use SQL guards instead of `--role-only`.)
- `02_restore.sh` — `psql --single-transaction ON_ERROR_STOP=1` into `NEW_DB_URL`; `SET session_replication_role = replica` around data so `handle_new_user` and notification triggers don't fire.
- `03_auth_storage.sh` — (a) `supabase db diff --linked --schema auth,storage` old→new to capture custom triggers/policies and reapply (avatar policies; `handle_new_user` is superseded by Clerk — §13); (b) `auth.users`/`auth.identities` are dumped (input to the Clerk import) and verified; (c) avatar objects old→new via Storage API.
- `03b_clerk_import.sh` — (§13) transform the `auth.users` dump into Clerk `CreateUser` calls (`email`, `external_id` = user uuid, `password_hash` = `encrypted_password`, `password_hasher` = bcrypt) via Clerk's open-source migration tool; runs after the hash-acceptance spike; idempotent by `external_id`.
- `04_functions_config.md` — checklist: redeploy both edge functions, set secrets (`RESEND_*`, `GOOGLE_CALENDAR_ICS_URL`/`CALENDAR_SYNC_SECRET`, `PUBLIC_APP_URL`), recreate cron schedules, reconfigure auth (site URL, redirect URLs incl. `/update-password`, Resend SMTP, the 6 email templates from `supabase/templates/`).
- `05_verify.sh` — per-table row counts old vs new, `auth.users` count + spot-check password hashes non-empty, attendance spot-checks, RLS enabled on every public table (`pg_class.relrowsecurity`), then runs the test suites against NEW.

---

## 10. Work estimate

| Phase | Work | Estimate |
|---|---|---|
| 1 — Clone pipeline (`01`–`05`, `03b`) + first verified clone | Scripts, storage copy, Clerk hash spike + import, verification output | 2–3 days (auth/storage restore + Clerk import verification dominate) |
| 2 — Multi-ensemble schema (007–016) + tests | Helpers, policy/RPC rewrite, backfill, 3 new test suites + ported suite | 3–4 days |
| 3a — Two design directions + 4 HTML mockups each | Pure design, no app code | 1–2 days |
| 3b — Design system + 10 screens + realtime + calendar fixes | Tokens, `DESIGN_SYSTEM.md`, component library, ensemble context, all screens restyled/rebuilt, quality passes | 2–3 weeks (the largest chunk — quality bar is the point) |
| 4 — Cutover runbook + `run_all.sh` + rehearsal | Docs, orchestration, dry run against fresh data | 1 day (+ your freeze-window run) |

---

## 11. Deferred until the next program — Orchestra, Choir, Drama … (explicitly NOT built now)

- **Update, October 2026:** the umbrella repositioning pulled the program switcher, the choose-a-program join landing and joining a second program *forward* — they now ship (`src/hooks/usePrograms.tsx`, `ProgramSwitcher.tsx`, `JoinProgramScreen.tsx`, migration 020). What remains deferred is everything else below.
- Program-wide dashboard and multi-program onboarding flows beyond the join screen.
- Any UI for program admins (DB support exists; screens deferred).
- `/e/:slug` route mount (kept a trivial addition — §4).
- Per-ensemble themes beyond the token structure — **one** theme ships: Band (RHS green `#2d5a1b` / gold `#f5a623` heritage).
- Any Orchestra/Choir/Jazz data, seed rows, screens, or copy — nothing, until you say that work has started.
- Cross-ensemble analytics rollups, cross-ensemble calendar overlay, cross-ensemble member management.
- Per-ensemble email template branding and per-ensemble PWA manifests (single set now).
- Per-ensemble event-type catalogs (a generic catalog + Band labels now).
- Push notifications / web-push (in-app notification bell only, as today).
- Clerk extras: Organizations as a program model (our `ensembles` table stays the source of truth), MFA, social/SSO providers, custom-branded auth emails (needs Clerk Pro; v1 ships Clerk's default templates), account deletion self-service.

---

## 12. Decisions (resolved at approval, 2026-10-05)

1. **Analytics access:** director-only per ensemble (+ program admins). Kept — no weakening of current guarantees; tests port unchanged.
2. **Roster visibility:** members see co-members of their ensembles (names, avatars, section); sensitive fields stay RPC-gated. Students in one ensemble see only that roster.
3. **Auth:** Clerk replaces Supabase Auth (§13).

**One assumption, correct me if wrong:** "use Clerk for the sign in and sign up page" is implemented as *Clerk is the auth system* (users, passwords and sessions live in Clerk; Clerk session tokens authenticate against Supabase RLS) — not merely Clerk-styled forms over Supabase Auth, which Clerk components cannot do.

---

## 13. Clerk authentication integration (approved change — 2026-10-05)

> **Removed 2026-10-09** — see the note at the top and
> [docs/AUTH_MIGRATION.md](AUTH_MIGRATION.md). Kept as the record of the decision.

Clerk replaces Supabase Auth as the identity provider. Sign-in/sign-up UI = Clerk `<SignIn />` / `<SignUp />` components themed to the Band design system via Clerk's appearance API. Verified against official docs (supabase.com/docs/guides/auth/third-party/clerk · supabase.com/blog/clerk-tpa-pricing · clerk.com/docs/guides/development/migrating/overview):

- Supabase supports Clerk as an **official Third-Party Auth (TPA) provider** — the native integration (Clerk's "Connect with Supabase" page + Supabase Dashboard → Authentication → Third-Party Auth → Clerk; `[auth.third_party.clerk]` in `config.toml` for local). The old JWT-template method is deprecated (Apr 2025) and will **not** be used.
- supabase-js accepts the Clerk session token: `createClient(url, key, { accessToken: () => Clerk.session?.getToken() })`.
- Clerk session tokens carry a `role: "authenticated"` claim (set up by "Connect with Supabase") so PostgREST maps connections to the `authenticated` Postgres role — RLS works unchanged in shape.
- **TPA pricing has parity with Supabase Auth: 50,000 MAU free / 100,000 on Pro.** RHS scale is far below either.
- **Password-preserving migration is supported:** Clerk's Backend API `CreateUser` accepts `password_hash` + `password_hasher`; Supabase hashes are bcrypt (`crypt(pw, gen_salt('bf',10))` → `$2a$`), and Clerk transparently upgrades hashes to its own bcrypt after first login. → **same passwords survive cutover.** Clerk also ships an open-source migration tool (JSON/CSV → BAPI with rate limiting).
- Clerk's documented legacy-ID pattern: store our UUID as Clerk `external_id`.

### 13.1 Identity mapping (zero FK churn)

- `profiles.id uuid` stays the schema-wide PK — every FK (`attendance_records.student_id`, etc.) is untouched.
- New column `profiles.clerk_id text unique not null` — the Clerk `user_…` id. Populated by the import (`03b_clerk_import.sh`, all existing users), by the `user.created` webhook (new users), and by `join_program()` (020) when somebody's first program is joined in the app.
- **`auth.uid()` is removed from every policy, RPC and trigger**, replaced by a SECURITY DEFINER helper:

  ```sql
  create or replace function public.current_profile_id() returns uuid
  language sql stable security definer set search_path = public as $$
    select p.id from public.profiles p
    where p.clerk_id = (select auth.jwt() ->> 'sub')
  $$;
  ```

  Every helper and policy composes on this — no dependence on how TPA maps `sub` to `auth.uid()`, no uuid/text cast ambiguity, and test personas authenticate by setting `request.jwt.claims.sub` to a fixture `clerk_id` exactly as PostgREST sees real Clerk tokens.

### 13.2 Flow mapping

| Old (Supabase Auth) | New (Clerk) |
|---|---|
| `handle_new_user` trigger + join-code gate | **In-app join (primary, 020):** a signed-in person picks their program on `/join` and types its code; `join_program()` validates it with the same rate-limited logic, creates `profiles` (first time) and adds the `memberships` row. Wrong code = refused with a message, nothing created. **Pre-provisioning (secondary):** the `user.created` webhook (svix) → `clerk_user_created` Edge Function does the same for accounts that should exist before they open the app. A signed-in person on no roster sees the join screen instead of a dead end |
| `invite_member_one` inserts `auth.users` + temp password | `invite_member` Edge Function: Clerk BAPI `CreateUser` (`external_id`, password, skip password requirements) + insert `profiles` + `memberships`. Temp-password handoff UX unchanged |
| `reset_member_password` (`crypt` + clears `banned_until`) | Clerk BAPI password reset; returns a temp password to the director exactly as today |
| `deactivate_member` / `reactivate_member` (`banned_until = +100 years`) | Clerk BAPI `BanUser` / `UnbanUser` **plus** our `profiles.deactivated` flag — today's double-lock preserved |
| `supabase.auth.updateUser({ password })` (Profile / UpdatePassword / forced change) | Clerk `user.updatePassword` via `useUser()`; `must_change_password` stays our column and the `AppShell` gate is unchanged |
| 6 `supabase/templates/*.html` auth emails | Clerk's built-in auth emails in v1; custom-branded templates deferred (needs Clerk Pro) |
| `WelcomeScreen` Supabase auth calls | Clerk components themed to tokens; forgot-password flow is Clerk's |

### 13.3 Consequences & guards

- **Cutover ends all live sessions** (new session manager) — one re-sign-in with unchanged passwords. Stated in the freeze announcement.
- Supabase Auth itself stays present-but-unused in the NEW project (TPA sits alongside it) — nothing to tear down.
- **Phase 1 gate `03b`:** before bulk import, a spike in a throwaway Clerk *development* instance: import 2 accounts with real Supabase bcrypt hashes and sign in with their real passwords. Only then run the bulk import (idempotent by `external_id`, re-runnable in `run_all.sh`). Fallback if a bcrypt variant is rejected: trickle migration with one-time reset links (users set a password once) — slower cutover, flagged before it would be needed.
- Frontend additions: `@clerk/clerk-react`, `ClerkProvider`, `accessToken` wiring on the Supabase client, and route guards that map Clerk session state onto the existing `useAuth` shape so `AppShell` and screens change as little as possible.

---

*Next step: Phase 1 (scripts in `scripts/migrate/` incl. `03b_clerk_import.sh`, dry runs against env-provided URLs; every modifying command will state OLD vs NEW target and wait for your "go").*
