# Security & Incident-Response Plan (DRAFT)

> **DRAFT.** Describes controls that exist in the code plus procedures that must
> be carried out by a person. Items marked **[do]** are not yet done.

## 1. Controls in place (verified in code)
- **Access control:** Row-Level Security on every public table; all writes via
  SECURITY DEFINER RPCs; helpers centralize the rules
  ([`015`](../../supabase/migrations/015_ensemble_policies.sql)).
- **Identity:** Supabase Auth with email confirmation; `auth.uid()`-based
  mapping ([`021`](../../supabase/migrations/021_supabase_auth.sql)).
- **Least privilege:** `anon` cannot execute any public function; only anon
  (publishable) key reaches the browser
  ([`016`](../../supabase/migrations/016_ensemble_rpcs.sql) verification).
- **Program isolation:** enforced and tested
  ([`ensemble_isolation.sql`](../../supabase/tests/ensemble_isolation.sql)).
- **Abuse limits:** check-in and join-code rate limits; program-creation guard.
- **Secrets:** service-role keys only inside edge functions; nothing privileged
  in the browser bundle.
- **No trackers:** no analytics, no third-party scripts.

## 2. Controls that depend on provider settings (must be confirmed)
- [ ] Supabase Auth password policy / minimum length, and MFA for staff.
- [ ] Redirect URLs restricted to the app origins (configured in
      [`config.toml`](../../supabase/config.toml) — confirm in the dashboard).
- [ ] Custom SMTP configured: Resend's relay from `rhsattendance.org`, with the
      domain verified (SPF/DKIM) and a separate API key for the digest.
- [ ] Vercel/Supabase/GitHub/SMTP accounts all have MFA and least-privilege.
- [ ] Supabase project region chosen and documented.

## 3. Operational procedures **[do]**
- **Backups:** enable a Supabase plan with backups, or run a documented periodic
  export. Free tier has none.
- **Access review:** review who holds service-role / management access quarterly.
- **Secret rotation:** rotate the management token and service-role keys now that
  the migration is complete; delete the retired Clerk secret.
- **Dependency updates:** review `npm audit` / Dependabot regularly.

## 4. Incident-response steps
1. **Detect & contain** — e.g. rotate the exposed key, disable the affected
   function, take the app offline if needed (Vercel can roll back / redeploy).
2. **Assess** — what data, whose, how many Washington residents, was the key to
   encrypted data exposed?
3. **Notify the school immediately** so the district can meet RCW 19.255:
   affected residents within **30 days**; **Attorney General** within 30 days if
   **>500** WA residents are affected.
4. **Document** — time, scope, cause, remediation.
5. **Fix the cause**, add a test, and review controls.

**Contacts:** Developer [NAME/EMAIL] · District IT [NAME/EMAIL] · District privacy
[NAME/EMAIL]. *(Fill in before launch.)*

## 5. Known technical follow-ups
- ~~CORS allowlist on edge functions~~ — **deployed 2026-10-11 and verified
  live** (allowed origins echoed; a foreign origin is refused).
- ~~Purge stale invitations (migration 028)~~ — **applied**; still needs a
  scheduled caller. Purge attempt logs too.
- Consider constraining free-text excuse reasons (possible health data).
- Consider disabling external avatar URLs (they can leak a viewer's IP to an
  arbitrary host when avatar images load).
