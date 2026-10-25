# AGENTS.md

Working agreement for AI agents (and humans) changing this repository. It records
decisions and gates, not tutorials. Detail lives in the canonical docs named
below — read them instead of trusting a summary here.

Verified against the working tree on **2026-10-24**. If this file misdescribes the
code, say so and correct this file — but never treat shipped code as evidence that
a documented owner decision changed: investigate the evidence and ask (see "When
instructions, docs and code disagree").

## What this is

A Vite + React 19 + TypeScript + Tailwind v4 single-page app on Supabase
(Postgres, Auth, Edge Functions), deployed on Vercel at `rhsattendance.org`.

The site is the **Redmond High School Music and Arts Program** — an umbrella
holding each music program's attendance tracker. The database calls a program an
`ensemble`; the interface never does. It says **program**, and "band" only where
the program on screen is the band. One program (`band`) ships today; the schema is
deliberately multi-program-ready.

## Read first

| Doc | Why |
| --- | --- |
| [docs/DEV.md](docs/DEV.md) | The developer contract: setup, auth model, DB workflow, frontend rules, verification |
| [docs/FEATURE_DECISIONS.md](docs/FEATURE_DECISIONS.md) | What is decided, removed, deferred — and what is still unresolved |
| [docs/AUTH_MIGRATION.md](docs/AUTH_MIGRATION.md) | Authoritative on identity |
| [docs/PLATFORM_PLAN.md](docs/PLATFORM_PLAN.md) | **Historical.** Read its reversal notes first; parts describe designs that were built and then removed |
| `supabase/migrations/` | The schema's actual source of truth, not the prose |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md), [docs/SECURITY_HEADERS.md](docs/SECURITY_HEADERS.md), [docs/BROWSER_SUPPORT.md](docs/BROWSER_SUPPORT.md), [docs/MOTION.md](docs/MOTION.md), [docs/EMAIL_SETUP.md](docs/EMAIL_SETUP.md), [docs/TEACHER_VERIFICATION.md](docs/TEACHER_VERIFICATION.md), [docs/privacy/](docs/privacy) | Surface-specific invariants |

## Identity: Supabase Auth is the only auth system

Never add Clerk or any second identity provider. No `@clerk/*` dependency, no
`ClerkProvider`, no `profiles.clerk_id`, no Clerk webhook, proxy or rewrite, no
`VITE_CLERK_*` variables.

Identity resolves through one helper, `public.current_profile_id()` →
`profiles.auth_user_id`; every RLS policy, guard trigger and RPC composes on it.
[docs/AUTH_MIGRATION.md](docs/AUTH_MIGRATION.md) records why Clerk was removed.
§13 of PLATFORM_PLAN is the history of that decision, not a build spec — and the
Clerk rollback steps in [AUTH_MIGRATION.md §8](docs/AUTH_MIGRATION.md) are
history too, not instructions.

## Do not restore without explicit owner approval

| Thing | Status | Evidence |
| --- | --- | --- |
| **Clerk / any second auth provider** | Removed 2026-10-09 | [AUTH_MIGRATION.md](docs/AUTH_MIGRATION.md), [DEV.md §4](docs/DEV.md) |
| **Chat** (`chat_channels`, `chat_messages`, any chat UI) | Retired in migration 018; empty tables keep a deny-all policy | [018_retire_legacy.sql](supabase/migrations/018_retire_legacy.sql), [015](supabase/migrations/015_ensemble_policies.sql) |
| **`auth.users` signup trigger** (`handle_new_user` / `on_auth_user_created`) | Removed in 018. Re-adding it creates a second profile for every new account | [DEV.md §4](docs/DEV.md), [018](supabase/migrations/018_retire_legacy.sql) |
| **A member-deactivation button** | `deactivate_member()` still exists but deliberately has no UI; removal is `remove_member()` | [DEV.md §7](docs/DEV.md) |
| **The school's logo artwork** | Removed on request 2026-10-09; an original placeholder ships in `public/logo.svg` | [BRAND_ASSETS.md](docs/BRAND_ASSETS.md) |
| **A second program's data, screens or copy** (Orchestra, Choir, Drama, …) | Deferred, **not rejected** — nothing is seeded until the owner says work has started | [PLATFORM_PLAN.md §11](docs/PLATFORM_PLAN.md) |
| **A program-admin console** | Deferred. One `program_admins` account now reaches every program's existing screens (owner request 2026-10-24); a dedicated cross-program console is still unbuilt | [FEATURE_DECISIONS.md §1](docs/FEATURE_DECISIONS.md), [20261025010444_system_administrator_grant.sql](supabase/migrations/20261025010444_system_administrator_grant.sql) |
| **Changes to legal copy**, including the Privacy Policy Contact section | Owner-controlled; the docs and the shipped page currently disagree (see FEATURE_DECISIONS) | [WEBSITE_LEGAL_CHANGES.md](docs/privacy/WEBSITE_LEGAL_CHANGES.md) |

Anything in that table is an owner decision, not a technical obstacle. If a task
appears to require one, stop and ask.

## Ask before any operation with production effect

Explicit approval is required before:

- applying migrations to the hosted/production project (including
  `supabase db push`), resetting or restoring a database, or seeding data;
- deploying or redeploying an Edge Function (`supabase functions deploy`);
- deploying to production (`vercel --prod`, a production alias, or Vercel
  environment/settings changes);
- deleting or rewriting existing remote data, rotating keys, or changing
  Supabase/Vercel configuration.

The hosted project is `sjiswrvhrnrxkrfhfjrp`. The **old** project and the old
Vercel deployment are read-only, forever ([DEV.md §5](docs/DEV.md)).

`scripts/migrate/*.sh` gate writes on `CONFIRM_TARGET=NEW`; the Supabase CLI does
**not**. The absence of that guard is not permission.

## Migrations

- **Never edit an already-applied migration.** Add a new timestamped file.
- Idempotent; the header states the purpose and its rollback; the file ends with
  its own verification block. Follow
  [20261020112000_attendance_history.sql](supabase/migrations/20261020112000_attendance_history.sql).
- Rehearse without credentials first:
  `bash scripts/dev/verify_migrations_locally.sh` (builds a throwaway local DB,
  touches no hosted project).
- Hosted dry run when approved:
  `bash scripts/migrate/06_apply_migrations.sh --dry-run --with-tests`.
- Apply the migration **before** deploying the frontend that depends on it.
- SQL suites run inside transactions that roll back; fixtures never persist.
  Keep that property.

## Code rules

- No component talks to `supabase` directly: reads through `src/lib/queries.ts`,
  writes and analytics through `src/lib/rpc.ts`.
- Never invent an RPC or a table column. If the database lacks it, add a
  migration.
- Say "program" in the interface; `ensemble` is a database word only.
- Confirmations use `ConfirmSheet`, never `window.confirm`.
- Mobile first: 44px minimum targets, `Sheet` over a desktop modal.
- Colour, type and layout come from [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md):
  no new card style, heading size or hardcoded hex outside `:root` / `.dark`.
- Show failures. No silent `catch`, no zero standing in for an error.
- Do not add a browser/CSS feature that [BROWSER_SUPPORT.md](docs/BROWSER_SUPPORT.md)
  records as unsupported without updating that table.

## Verify, then say what you ran

```bash
npm run typecheck
npm run build
npm run test:qa            # chromium guard suite
npm run check:headers      # vercel.json headers + CSP hashes
bash scripts/dev/verify_migrations_locally.sh
```

Report checks that failed or could not run as limitations. A passing build alone
does not prove behaviour.

## When instructions, docs and code disagree

This repository contains documents written at different times that describe
different states of the product, and the code carries changes whose intent was
never written down. Never invent a decision, silently pick a side, or rewrite an
existing doc to match an assumption.

1. Check [docs/FEATURE_DECISIONS.md](docs/FEATURE_DECISIONS.md) — the conflict may
   already be recorded.
2. Investigate the evidence: the documents that describe the decision, the
   migrations, the code, the tests, and the Git history (`git log`, `git blame`,
   `git show`) around each side. A recent commit often explains why prose and code
   diverged, and which of them moved.
3. Do **not** treat the current code as the owner's intended decision by default.
   Code can be stale, half-finished, or a placeholder nobody replaced; a shipped
   line is evidence of what happened, not proof of what was approved.
4. If the evidence still leaves the conflict unresolved, stop and ask the owner
   before changing anything.
5. Record the outcome as a dated entry with its evidence; do not retrofit old
   reports.
