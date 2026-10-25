# Teacher / director verification by invitation code

**Status:** code complete (migrations 035 and 20261027120000, plus the frontend
that uses them). This page does **not** record either migration as applied to the
live project — §4 is the apply step, and §5 is the one thing an operator must do
before handing the initial code out. Live state is something to verify, never to
infer from a document ([DEV.md §7](DEV.md)).

This is the operator guide for the teacher credential: what it is, why the
self-declared "I'm a teacher" checkbox is no longer one, exactly what an
administrator runs, and what is *not* claimed to be verified.

---

## 1. Why it exists

Until this change, the only thing between a new account and its own program was
the answer to "are you a student or a teacher?" on the sign-up screen
(migrations 023/024). That answer is honest but it is not a credential: anybody
willing to tick the teacher box got `create_program()`, and a school had no way
to issue — or withdraw — "you may teach here".

Now the credential is a **redeemed invitation**: a hashed, single-use, optionally
email-bound code that a signed-in account exchanges on the server for verified
teacher access.

Since 2026-10-27 a code can also carry a **roster place**: the administrator who
issues it names one program and one role, and redeeming it grants that membership
with that role in the same atomic step (§2a). That is the answer to "invite a
director or a teacher to join" — the invitee never has to be added by hand and
never picks their own role.

## 2. How it works

```
   sign up / sign in (Google or email)          ── the account exists, and is
                                                   unprivileged
                │
                ▼
   enter the invitation code        ──►  redeem_teacher_invitation(code)   [server]
   (/teacher, or from Account              │  normalize → SHA-256
    settings, or instead of the            │  rate-limit check
    start-a-program form)                  │  ONE atomic UPDATE, guarded by
                                           │    redeemed_at is null
                                           │    and revoked_at is null
                                           │    and (expires_at is null or > now())
                                           │    and (intended_email is null or = the
                                           │          caller's address in auth.users)
                                           ▼
                                        the invitation row is marked redeemed,
                                        with the account and the timestamp
                                           │
                    ┌──────────────────────┴──────────────────────┐
                    │                                             │
        the code names a program + role                 no program: plain code
                    │                                             │
                    ▼                                             ▼
   that membership is created (or an existing      create_program() ──► has_teacher_access()
   one kept) and the role is added — the               ──► a program, and a {director}
   account may still start its own program                membership on it
   afterwards, as any verified teacher may
```

Three tables/objects carry the whole feature (migrations
[`035_teacher_invitations.sql`](../supabase/migrations/035_teacher_invitations.sql)
and [`20261027120000_invitation_program_roles.sql`](../supabase/migrations/20261027120000_invitation_program_roles.sql)):

| Object | What it holds |
| --- | --- |
| `public.teacher_invitations` | one row per issued code: its **SHA-256 digest**, label, optional intended email, optional expiry, optional program + role, and — once used — who redeemed it, with which address, and when |
| `public.teacher_invite_attempts` | one row per *failed* attempt. Codes are never recorded here (or anywhere else) |
| `public.redeem_teacher_invitation(text)` | the only thing that can grant teacher access, and the only thing that can turn a code into a roster place |

**There is exactly one authority.** Access is `has_teacher_access()`, which reads
the redeemed invitation rows; nothing on the account is flipped into a flag that
could drift out of step with them. That is why the sign-up type is deliberately
*not* rewritten on redemption, and why revoking an invitation takes the access
back on the holder's next request rather than at their next sign-in.

**The code is never stored in a readable form.** The plaintext exists in the
migration's seed only as its digest; `configure_teacher_invitation()` hashes what
it is given and cannot read it back; no function returns a digest to a client.

### 2a. A code that also joins a roster (20261027120000)

`teacher_invitations.ensemble_id` and `.role_id` are optional and always set
together. With both set, the invitation is a **staff invitation for one program**:
redeeming it still grants the teacher credential, and in the same transaction it

- creates the profile if the account had none (named from the auth metadata or the
  address, so a roster row is never blank);
- creates an active membership if there is none;
- adds the role — a **system role** (`director`, `secretary`, `section_leader`,
  `student`) into `memberships.roles`, exactly as `assign_role()` would, or a
  **custom role** as a live `user_role_assignments` row attributed to the
  administrator who issued the code;
- writes a `teacher.invite_join` audit entry beside the `teacher.invite_redeem`
  one.

What the database refuses, before the code is spent:

| Case | Answer |
| --- | --- |
| The role is `system_admin` | `configure_teacher_invitation()` will not issue it, and redemption refuses a row that got in by hand |
| The role belongs to another program | Refused at issue time and again at redemption |
| The program or role was deleted or archived | Refused; ask the administrator for a new code |
| The person was **removed** from that program by a director | Refused, and the code is deliberately **not** spent — the roster is the director's decision |
| A second, *different* code for the same program on the same account | The per-program unique index refuses the write; the redemption reports it rather than granting twice |

**One guard exception, and only one.** `guard_membership_change` and
`guard_user_role_assignment` both refuse a person changing their own roles, which
is exactly what redeeming does. `redeem_teacher_invitation()` therefore sets a
transaction-local flag (`rhs.invitation_grant`) around those writes. No client can
set a GUC — PostgREST runs no `SET` for a caller and no RPC exposes `set_config` —
the membership guard permits an **addition** only (never a removal, never an
access flip), and the assignment guard still insists on a real, active, custom
role of that program.

### What a code does *not* do

It never touches a program the administrator did not name, and it cannot mint
`system_admin` — that stays a `program_admins` row granted by migration
(`20261025010444`). Outside the one program a staff invitation names, joining
somebody else's roster is still that director's decision and still needs their
join code. A plain code (no program) is unchanged from 035: a verified teacher
starts their *own* program and is its director.

## 3. What the browser cannot do

| Attack | Why it fails |
| --- | --- |
| Type a guessed code | `redeem_teacher_invitation()` compares digests **on the server**, and 5 failed attempts per account (20 per address) in 15 minutes are then refused |
| Edit a profile / send a role | Roles live on `memberships`, not `profiles`. The `guard_membership_change` trigger refuses the caller's own roles, and `create_program()` takes no program id and no role — it always creates a *new* program |
| Give yourself a role by redeeming | The code has to exist, be unredeemed, unexpired and (when bound) addressed to you — and the role is one an **administrator** chose. The guard's exception is enabled only inside `redeem_teacher_invitation()`, only for that single write, and only for adding a role (IR-3, IR-5) |
| Hand yourself `system_admin` with a code | `configure_teacher_invitation()` refuses to issue one, and redemption refuses a row somebody inserted by hand (IR-8) |
| Re-join a program a director removed you from | The paused membership is detected before the code is spent and the redemption is refused (IR-7) |
| Issue, list or cancel a code as a program director | All three RPCs answer only to `is_program_admin()`; a director gets a refusal (IR-2) |
| Read or write the credential tables | Both are `enable row level security` with **no policies**, and `authenticated` has no table privilege at all — a direct read or write is `42501`, not an empty result. Asserted by TI-5 |
| Flip the sign-up type to "teacher" | It is still only a declaration. `create_program()` asks `has_teacher_access()`, so a declared teacher with no redeemed invitation is refused (TI-9 in `signup_account_type`, CP-11 in `create_program`) |
| Redeem one code from two accounts at once | The redemption is **one** `UPDATE` whose predicate contains every condition, so the row lock decides the winner; a partial unique index additionally allows at most one live redemption per account. Proved by `scripts/dev/check_teacher_invite_race.sh` |
| Reuse a spent code | `redeemed_at is null` is part of that same predicate, and the code row records who took it |
| Use a code bound to somebody else | The address is read from `auth.users` for the caller — **not** from any claim the client sends (asserted by TI-9) |
| Keep access after it is withdrawn | `revoke_teacher_invitation()` sets `revoked_at`, which `has_teacher_access()` excludes. Nothing is cached, so it applies to the next request |
| Learn whether a code exists | An unknown code and a wrong one get one identical message. The more specific texts (expired / already used / different address) are only reachable by somebody who already knows the code |

## 4. Apply the migration

Two files, in this order: `supabase/migrations/035_teacher_invitations.sql`, then
`supabase/migrations/20261027120000_invitation_program_roles.sql`. Both are
idempotent and **additive**. 035 creates two tables and replaces two function
bodies; 20261027120000 adds two nullable columns and the per-program redemption
index, replaces `configure_teacher_invitation` (new argument list — the old
four-argument function is dropped, so a four-argument call cannot be ambiguous),
`redeem_teacher_invitation`, `list_teacher_invitations`, and the two role guards.
Neither rewrites attendance, rosters or roles.

Rehearse first, then apply **both** pending files in one transaction (the pattern
in [`DEV.md`](DEV.md) §5):

```bash
{
  cat supabase/migrations/035_teacher_invitations.sql
  cat supabase/migrations/20261027120000_invitation_program_roles.sql
} > /tmp/apply_invitations.sql
psql "$NEW_DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f /tmp/apply_invitations.sql
```

Or the pipeline, which rehearses everything first:

```bash
bash scripts/migrate/06_apply_migrations.sh --dry-run --with-tests   # rehearse
CONFIRM_TARGET=NEW bash scripts/migrate/06_apply_migrations.sh       # apply
```

Each file's own verification block fails the apply (`FAIL: …`) if the tables, the
seed, the `anon` denials, the `create_program()` gate or the invitation columns,
signature and guards are not actually in place. Apply the migration **before**
deploying the frontend that calls the six-argument configure RPC and reads
`/invitations`; the old frontend does not know those exist and keeps working
against the new schema.

**Order matters for the frontend:** the migration is safe to apply first — with
it applied and the old frontend deployed, every existing teacher *account* stops
being able to start a program until a code is redeemed. Apply the migration and
deploy the frontend together, and hand the initial code to whoever needs it in
the same window. (Every **existing director** is unaffected: 023's allowance for
them is kept, so nobody running a program today is locked out.)

## 5. The initial invitation — bind it before you hand it out

Migration 035 seeds the single code supplied by the project owner as an
invitation that can be redeemed **once**. It is seeded deliberately *unbound*
(no intended email) and *non-expiring*, because guessing which teacher it was
meant for would be worse than leaving it open for the few minutes it takes to set
up. Its plaintext appears nowhere in this repository — only its digest:

```
4dd7073f2f1f7f95fc13f33d1b5cfb5a296c5cb5f8bb422a0d64df88a9a7896d
```

That digest is `SHA-256(normalize_invitation_code(code))`, where the normalization
upper-cases the code and strips every character that is not a letter or digit — so
case, spaces and dashes do not matter to whoever types it.

### Bind it to the intended teacher's email (recommended)

Do this **before** giving anyone the code. It turns a code that anybody could
redeem into one that only the right account can.

```sql
-- Bind the seeded invitation to ONE address, and optionally give it an expiry.
-- Safe to re-run: it only touches an invitation that has not been redeemed.
update public.teacher_invitations
   set intended_email = lower('<TEACHER_EMAIL_PLACEHOLDER>'),
       label          = 'Teacher invitation — <TEACHER_NAME_PLACEHOLDER>',
       expires_at     = now() + interval '14 days'   -- or null for no expiry
 where id = (
   select id from public.teacher_invitations
    where code_hash = '4dd7073f2f1f7f95fc13f33d1b5cfb5a296c5cb5f8bb422a0d64df88a9a7896d'
      and redeemed_at is null
      and revoked_at is null
 );
```

The bound address is the one **on their Supabase Auth account** — the address they
sign in with, not a billing or directory address. If they sign in with Google,
that is their Google address. It is checked case-insensitively.

Prefer to do it from inside the app? A **system administrator** (somebody with a
row in `program_admins`) can call the same thing as an RPC, and gets a readable
error instead of a silent no-op:

```sql
select public.configure_teacher_invitation(
  '<THE_PLAINTEXT_CODE>',            -- hashed on arrival; never stored or returned
  'Teacher invitation — <TEACHER_NAME_PLACEHOLDER>',
  '<TEACHER_EMAIL_PLACEHOLDER>',
  now() + interval '14 days',
  null,                              -- program, or a program uuid for a staff code
  null                               -- role in that program (both or neither)
);
```

Neither call can read a code back. Keep your own copy of the plaintext.

From 2026-10-27 the app has a screen for this: **Account sheet → Invitation codes**
(`/invitations`), visible only to a system administrator. It generates the code,
takes the optional program and role, shows the plaintext exactly once, lists what
is ready, and keeps used codes with the name and address of the account that
redeemed them.

## 6. Day-to-day operation

All three RPCs require `public.is_program_admin()`, i.e. a `program_admins` row —
a *system* administrator, not a program director. Without one, use the SQL below
in the dashboard's SQL editor (the service role bypasses RLS).

```sql
-- Issue a NEW code for another teacher. Put any secret here that is at least 8
-- letters/digits; the columns store only the digest.
-- For a staff invitation, fill ensemble_id AND role_id; for a plain teacher code,
-- leave both null. A role is a uuid from public.roles (a custom role carries its
-- own ensemble_id; a system role is global).
insert into public.teacher_invitations
  (code_hash, label, intended_email, expires_at, ensemble_id, role_id)
values (
  public.invitation_code_hash('<NEW_CODE_PLACEHOLDER>'),
  '<LABEL_PLACEHOLDER>',
  lower('<TEACHER_EMAIL_PLACEHOLDER>'),
  now() + interval '14 days',
  '<PROGRAM_UUID_OR_NULL>',
  '<ROLE_UUID_OR_NULL>'
)
on conflict (code_hash) do nothing;

-- What is issued, where each one got to, and what it grants. Never shows a code
-- or a digest.
select i.id, i.label, i.intended_email, i.expires_at,
       e.name as program, r.name as role,
       i.redeemed_at, i.redeemed_email,
       coalesce(nullif(p.display_name, ''), p.full_name) as redeemed_by,
       i.revoked_at,
       case when i.revoked_at is not null   then 'revoked'
            when i.redeemed_at is not null  then 'redeemed'
            when i.expires_at <= now()      then 'expired'
            else 'available' end as status
  from public.teacher_invitations i
  left join public.ensembles e on e.id = i.ensemble_id
  left join public.roles r    on r.id = i.role_id
  left join public.profiles p on lower(p.auth_user_id) = lower(i.redeemed_by_auth)
 order by i.created_at;

-- Withdraw one. On a redeemed invitation this also removes that account's
-- teacher access, on its next request.
update public.teacher_invitations set revoked_at = now() where id = '<INVITATION_UUID>';

-- Who currently holds verified teacher access?
select i.redeemed_by_auth, i.redeemed_email, i.redeemed_at, i.label
  from public.teacher_invitations i
 where i.redeemed_at is not null and i.revoked_at is null
 order by i.redeemed_at desc;
```

From a client, the same three are `configure_teacher_invitation(code, label,
intended_email, expires_at, ensemble_id, role_id)`,
`list_teacher_invitations()` and `revoke_teacher_invitation(<uuid>)`; the app
wraps them in `src/lib/rpc.ts` (`configureTeacherInvitation`,
`listTeacherInvitations`, `revokeTeacherInvitation`).

## 7. Environment variables and secrets

**This feature adds no environment variable and no secret.** There is nothing to
put in `.env.local`, in Vercel, or in Supabase's function secrets, and no
`VITE_`-prefixed value is involved — that is deliberate: a code in the frontend
bundle would be a code given away.

| Where | Variable | Status |
| --- | --- | --- |
| `.env.local` / `.env.example` | `VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co` | unchanged |
| `.env.local` / `.env.example` | `VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY` | unchanged |
| Supabase project (server-only) | `SUPABASE_SERVICE_ROLE_KEY` | already in use by the existing functions; this feature never reads it |
| Anywhere in this repo | an invitation code | **never** — not in the app, not in a migration, not in a log |

There is no Edge Function to deploy: redemption is a PostgreSQL function, so the
database is the only thing that has to be reachable.

## 8. Testing

```bash
bash scripts/dev/verify_migrations_locally.sh        # every migration + every SQL suite
bash scripts/dev/check_teacher_invite_race.sh        # after the above: two sessions, one code
```

`supabase/tests/invitation_program_roles.sql` (IR-1…IR-11) covers the roster half:
issuing a program+role code and listing it; a director refused issue/list/revoke;
redemption creating the profile, the membership and the role and recording who
used the code; single use; a custom role granted beside an existing student
membership; a plain code still joining nobody; a removed member refused **without**
spending the code; `system_admin` neither issuable nor redeemable; an expired code;
and one live invitation per program, so a second program follows the first while a
spare registration code is a no-op.

`supabase/tests/teacher_invitations.sql` (TI-1…TI-10) covers all ten cases in the
change brief: a valid invitation grants the role; an invalid one grants nothing;
a redeemed code cannot be reused; a student cannot self-promote through their
profile, their membership or the credential tables; a teacher who signs in first
redeems later without a second account; the student join/check-in path still
works end to end; nobody unauthorized can create a program; email binding and
expiry are enforced; and failed attempts are recorded and then limited.

`check_teacher_invite_race.sh` is separate on purpose: a SQL suite runs inside one
transaction, so it cannot produce the thing that matters — two sessions racing for
one code. That script runs two real `psql` clients against the local database and
requires exactly one winner, one refusal, one redeemed row, and teacher access for
the winner only. (Verified to be a *real* race: with a deliberately naive
read-then-write probe both sessions won, and with the shipped atomic `UPDATE` only
one does.)

The screen has its own browser test, `e2e/invitations.spec.ts` (chromium): it
serves a system administrator, asserts a ready code and a used code with its
redeemer's name and address, issues a new code and proves the plaintext is shown
once and is gone after the sheet closes, and cancels a code out of the ready list.
Run it with `npx playwright test e2e/invitations.spec.ts --project=chromium`.

## 9. Limits, and what is not claimed

- **No step here has been run against the live Supabase project.** Everything
  above is verified against a throwaway local PostgreSQL holding the same schema
  and data the migration pipeline restores. Applying 035 and 20261027120000 is
  still an operator action (§4); verify live state rather than inferring it from
  this page.
- **A code is only as secret as the channel you send it through.** Email is not a
  secure channel; a code that has been forwarded is a code that can be redeemed.
  Where that matters, bind it to an address (§5) so only that account can use it,
  and revoke it afterwards if it was shared.
- **Rate limiting is per account and per best-effort address**, not global. It
  stops a script working through a list of guesses against one account; it is not
  a defence against a distributed attack on a *weak* code. That is the real reason
  `configure_teacher_invitation()` requires at least 8 characters — prefer long,
  generated codes to memorable ones.
- **A redeemed invitation is not a licence check.** Export control, DBS/background
  checks and the like are the school's process, not this table's. The app records
  *who redeemed which invitation and when*, which is what an audit needs.
- **Revocation is immediate but not retroactive.** It removes the teacher
  credential; it does not remove the person from a program they already direct
  (that is the roster's `director` role, and `remove_member()`/`revoke_role()`
  are the tools for it). The same applies to a redeemed **staff** invitation:
  cancelling the code withdraws teacher access but leaves the membership and role
  it created, because the roster is the program's business, not the code's.
- **A staff invitation is an administrator's grant, not a second roster editor.**
  It cannot remove, pause or move anybody, it prints no changes over an existing
  role, and it never revives a membership a director paused (IR-7). Everything
  after the redemption is ordinary roster work: Roles & permissions for a role,
  the roster for a section or a removal.
- **One live redemption per account per program.** The unique index counts a
  program separately from a plain registration code, so a teacher can be invited
  to a second program later without a second account (IR-10) — but the same code
  cannot be redeemed twice, and two live codes for one program on one account are
  refused by the index.
