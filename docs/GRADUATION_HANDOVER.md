# Graduation handover checklist

**Owner:** Karman Hora
**Prepared:** 2 November 2026
**Use with:** [`OWNERSHIP_AND_SUCCESSION.md`](OWNERSHIP_AND_SUCCESSION.md),
[`SUCCESSOR_MAINTENANCE_AGREEMENT.md`](SUCCESSOR_MAINTENANCE_AGREEMENT.md), and
[`SUCCESSOR_ONBOARDING.md`](SUCCESSOR_ONBOARDING.md).

This is a working checklist, not a legal document. Complete it with the successor
before the owner's access is reduced. Store the completed copy privately; do not
put personal contact details, credentials, or student information in the public
repository.

## 0. Principles

- [ ] The owner retains copyright in the original work.
- [ ] The GitHub repository stays **public** as a portfolio.
- [ ] Maintenance authority is granted in writing; it is not a copyright
      transfer.
- [ ] No administrative access is granted until the agreement is signed.
- [ ] The school is told who maintains the app; no school endorsement or
      ownership is claimed.
- [ ] Existing user access and program permissions are not changed as part of the
      handover.

## 1. Select a successor

- [ ] Identify a primary successor and, if possible, a backup.
- [ ] Confirm they expect to remain reachable after the owner graduates.
- [ ] Confirm they understand the retained-ownership model.
- [ ] Confirm they are willing to follow the security and privacy rules.
- [ ] Check for conflicts: are they employed by the district, contracted
      elsewhere, or bound by an agreement that affects contributions?
- [ ] Record why they were chosen and who else was considered (privately).

## 2. Verify technical ability

Ask the candidate to demonstrate, without the owner doing it for them:

- [ ] Clone the repository and run the app locally with their own `.env.local`.
- [ ] Explain the difference between the anon key and the service-role key.
- [ ] Read one migration and explain what it changes and how it rolls back.
- [ ] Explain how RLS and `current_profile_id()` protect a student's records.
- [ ] Make a small change on a branch, run typecheck and build, and open a pull
      request.
- [ ] Run the focused Playwright suite and interpret a failure.
- [ ] Rehearse the migrations locally.
- [ ] Take a database dump and restore it into a separate database.
- [ ] Explain what they would do first after a suspected key leak.

A candidate who cannot do these with documentation and time is not ready for
production access. Offer a smaller role or more mentoring instead.

## 3. Agree on responsibilities

- [ ] Response expectation for outages and security reports.
- [ ] Release cadence and who approves features.
- [ ] Backup frequency and restore testing.
- [ ] Dependency and security review cadence.
- [ ] Who talks to the school, and about what.
- [ ] Who pays for Vercel, Supabase, Resend, and the domain.
- [ ] What happens during school holidays and exam periods.
- [ ] How the successor reports changes and incidents to the owner.
- [ ] How the arrangement is reviewed and ended.

Record the answers in Schedule A of the agreement.

## 4. Sign the maintenance authorisation

- [ ] Complete every blank in
      [`SUCCESSOR_MAINTENANCE_AGREEMENT.md`](SUCCESSOR_MAINTENANCE_AGREEMENT.md).
- [ ] Choose the contribution option; do not leave it blank.
- [ ] Have a parent or guardian review and sign while the owner is a minor.
- [ ] Have a lawyer review if the school, district, or a provider requires it.
- [ ] Sign and date every copy.
- [ ] Give the successor a copy and store the original privately.
- [ ] Record the effective date and the next review date.

## 5. Establish administrative access

Grant the narrowest role that works. Use invitations, not shared passwords.

- [ ] GitHub: collaborator or organisation member, not account owner.
- [ ] Vercel: team/project member, not the only owner.
- [ ] Supabase: organisation/project member with a developer role.
- [ ] Resend: team member; domain and key visibility only if needed.
- [ ] Domain registrar: delegated DNS access or a named contact.
- [ ] Google Cloud OAuth: project member, not the only owner.
- [ ] School contact: introduced and recorded.
- [ ] Confirm MFA on every account.
- [ ] Confirm the successor can sign in without the owner's device or inbox.

## 6. Review GitHub

Current position on 2 November 2026: public repository
`karmanhora/rhs-musicandarts`, default branch `main`, one collaborator (the
owner), no branch protection, no rulesets, Dependabot alerts disabled, no
`.github` workflows, and zero secret-scanning alerts.

- [ ] Keep the repository public.
- [ ] Add branch protection or a ruleset for `main`: require a pull request,
      require review, block force pushes, block deletion.
- [ ] Require status checks once a CI workflow exists.
- [ ] Enable Dependabot alerts and security updates.
- [ ] Enable secret scanning and push protection where the plan allows it.
- [ ] Keep Actions secrets empty unless a workflow needs one; never commit a
      secret to make a workflow pass.
- [ ] Review collaborators and their roles.
- [ ] Confirm no `.env` file, dump, key, or student data is tracked.
- [ ] Explain that a public repository can be viewed and forked under GitHub's
      platform terms; the licence reserves reuse rights but cannot remove those
      platform permissions.

## 7. Review Vercel

- [ ] Confirm the project owner and team.
- [ ] Add the successor as a member; keep the owner as an owner until the end.
- [ ] Confirm the production branch is `main`.
- [ ] Confirm the only `VITE_*` variables are `VITE_SUPABASE_URL` and
      `VITE_SUPABASE_ANON_KEY`.
- [ ] Confirm no service-role key is present in any Vercel variable.
- [ ] Confirm the custom domain and TLS certificate.
- [ ] Review deployment protection, logs, and spend limits.
- [ ] Record who can deploy to production.
- [ ] Do not change deployment settings without a written record.

## 8. Review Supabase

- [ ] Confirm the organisation and project `sjiswrvhrnrxkrfhfjrp`.
- [ ] Add the successor to the organisation with the least role that works.
- [ ] Confirm the database plan and backup position.
- [ ] Confirm Auth providers: email/password and Google.
- [ ] Confirm Site URL and redirect URLs include the production origin and
      `/reset-password`; remove stale origins.
- [ ] Confirm email templates and SMTP settings.
- [ ] Confirm Edge Functions and their secrets.
- [ ] Confirm the `avatars` bucket is private with size/type limits.
- [ ] Confirm RLS is enabled and policies match the repository.
- [ ] Confirm migration state with `supabase migration list --linked` (read-only).
- [ ] Review the security advisors and record accepted risks.
- [ ] Enable leaked-password protection if it is still off.
- [ ] Confirm scheduled jobs (`cron.job`) and who owns them.

## 9. Review domain administration

The registrar is **not recorded in this repository**. Confirm it with the owner.

- [ ] Record the registrar, account email, and renewal date privately.
- [ ] Enable registrar lock and auto-renew.
- [ ] Enable MFA on the registrar account.
- [ ] Confirm DNS records for Vercel.
- [ ] Confirm Resend SPF, DKIM, and return-path records.
- [ ] Confirm the registrant contact is one that will still be reachable after
      graduation.
- [ ] Add the successor as a technical or billing contact if the registrar
      supports it.
- [ ] Do not transfer the domain without the owner's written approval.

## 10. Review email-provider administration

- [ ] Confirm the Resend account owner and team.
- [ ] Confirm `rhsattendance.org` is verified.
- [ ] Confirm the auth SMTP key and the app API key are separate.
- [ ] Record which key belongs to which function (names only, never values).
- [ ] Confirm sending limits and billing.
- [ ] Confirm the auth email rate limit is appropriate for a class signing up at
      once.
- [ ] Confirm the digest quota decision: do not schedule a large run that would
      starve sign-up confirmations.
- [ ] Add the successor to the Resend team with the least role that works.

## 11. Billing and renewals

| Service | What is billed | Renewal / limit | Owner of the payment method | Handover action |
| --- | --- | --- | --- | --- |
| Vercel | Hosting | Confirm plan and usage | [record privately] | Add successor; decide who pays |
| Supabase | Database/Auth/Storage | Confirm plan and backups | [record privately] | Add successor; confirm backup tier |
| Resend | Email | Free tier 100/day, 3,000/month; paid tier if exceeded | [record privately] | Add successor; confirm quota |
| Domain | Annual registration | Confirm renewal date | [record privately] | Enable auto-renew; add contact |
| Google Cloud | OAuth client | Usually no charge | [record privately] | Add project member |

- [ ] Record every renewal date.
- [ ] Confirm at least two people can pay or be billed.
- [ ] Confirm a failed payment will not silently take the site or email down.
- [ ] Do not change billing without the owner's approval.

## 12. Back up the database

- [ ] Take a current logical backup.
- [ ] Store it encrypted outside the repository.
- [ ] Restore it into a separate database and run the SQL suites.
- [ ] Record the date, size, location, and result.
- [ ] Export avatar objects separately if they must be preserved.
- [ ] Confirm who holds the backup and how it is protected.
- [ ] Confirm the restore procedure is written down for the successor.
- [ ] Never restore over production without explicit approval.

## 13. Review security

- [ ] Re-read the security baseline in section 17.
- [ ] Confirm no secrets are tracked or in the current bundle.
- [ ] Confirm no `.env` file was ever committed.
- [ ] Confirm the service-role key is only in server-side secrets.
- [ ] Confirm MFA on every provider.
- [ ] Confirm branch protection, Dependabot, and secret scanning.
- [ ] Review the open dependency advisories and decide what to do.
- [ ] Review Supabase security advisors.
- [ ] Confirm the incident-response contact list is current.
- [ ] Confirm a credential-rotation plan exists.

## 14. Rotate credentials when appropriate

Rotate when access changes, a value was shared, a device was lost, or a provider
recommends it. Do not rotate blindly during a handover; coordinate the order so
the app does not go down.

- [ ] Supabase service-role key, if it was ever shared.
- [ ] Supabase management token, if it was ever shared.
- [ ] Resend SMTP key and app API keys.
- [ ] `EVENT_DIGEST_SECRET`, `EVENT_REMINDER_SECRET`,
      `EVENT_ANNOUNCEMENT_SECRET`, `ABSENCE_REQUEST_EMAIL_SECRET`, and
      `CALENDAR_SYNC_SECRET` if they were exposed.
- [ ] GitHub personal access tokens.
- [ ] Vercel tokens.
- [ ] Google OAuth client secret, if one exists and was exposed.
- [ ] Registrar and email account passwords.
- [ ] Remove the departing person's access after the new access works.
- [ ] Record rotation dates, never values.

If a secret was committed, removing the commit is not enough: rotate the secret
first, then decide with the owner whether history needs rewriting. Never rewrite
history or force-push without explicit approval.

## 15. Test production deployments

Do this with the owner present, then let the successor repeat it.

- [ ] `npm ci` on a clean checkout.
- [ ] `npm run typecheck`.
- [ ] `npm run build`.
- [ ] `npm run check:headers`.
- [ ] Focused Playwright suite for public and legal pages.
- [ ] Deploy a preview, not production.
- [ ] Check the preview: `/`, `/privacy`, `/terms`, `/license`, `/sign-in`.
- [ ] Check both themes and a 320–390px viewport.
- [ ] With approval, deploy to production.
- [ ] Smoke test: sign-in, dashboard, calendar, attendance roll, QR check-in,
      roster, reports, account settings, privacy, licence.
- [ ] Confirm the browser console has no errors and the API calls succeed.
- [ ] Confirm the custom domain serves the new deployment.
- [ ] Record the deployment id and the result.
- [ ] Confirm the rollback path: promote the previous deployment in Vercel.

## 16. Confirm independent operation

- [ ] The successor makes one real, low-risk change on a branch.
- [ ] Someone reviews it.
- [ ] It is merged and deployed with approval.
- [ ] The successor verifies it in production.
- [ ] The successor handles one support question from the school.
- [ ] The successor takes a backup and records it.
- [ ] The owner observes but does not take over.
- [ ] Any gaps are documented and fixed before access is reduced.

## 17. Security baseline (2 November 2026)

This is the review performed for this handover package. It is a point-in-time
record, not a guarantee.

### Current tree

- No tracked credential files. `git ls-files` shows only `.env.example`, which
  contains placeholders.
- `.env`, `.env.local`, `.env.event-digest`, and `.env.absence-emails` exist
  locally, are gitignored, and were never tracked.
- The browser receives only the Supabase URL and anon/publishable key. The anon
  key is public by design; RLS is the boundary.
- No service-role key, database password, SMTP password, OAuth client secret, or
  private key was found in `src/`.
- No Clerk dependency or second identity provider.
- The production bundle contains one JWT with `role: anon` (public by design),
  per the October audit. Re-check the bundle after any build change.

### Git history

- No `.env` file was ever added (`git log --all -- .env ...` is empty).
- A pattern scan of all reachable commits for Supabase JWTs, `sb_secret_`,
  `sb_publishable_`, Resend keys, `postgres://user:password@`, and private-key
  headers found **no credential values**. The only matches were this
  documentation's own description of the search patterns.
- A pattern scan is not proof. A secret in an unusual format could still be
  present. Review before making the repository more prominent.

### GitHub configuration

- Repository: public, owner `karmanhora`, default branch `main`.
- Collaborators: `karmanhora` only.
- Branch protection: none; rulesets: none.
- Dependabot alerts: disabled.
- Secret-scanning alerts: 0.
- No `.github` workflows, so there is no CI or Actions secret to review.

### Dependency audit

`npm audit --omit=dev` reports **2 high-severity advisories** in
`@modelcontextprotocol/server`, reached through `vgpu`. npm proposes
`npm audit fix --force`, which would install `vgpu@0.3.0` — a breaking change
from the installed 0.6 line. Nothing was upgraded in this review. Treat the
advisory as open until the owner and maintainer assess whether the affected
server code is reachable at runtime or only present in the build toolchain, then
test an upgrade on a branch.

### Third-party licences

The app's direct dependencies and their licences:

| Component | Licence |
| --- | --- |
| React, React DOM, React Router | MIT |
| Vite, Tailwind CSS, `@tailwindcss/vite` | MIT |
| `@supabase/supabase-js` | MIT |
| `lucide-react` | ISC |
| `html5-qrcode` | Apache-2.0 |
| `qrcode.react` | ISC |
| `vgpu`, `@vgpu/wgsl` | MIT |
| IBM Plex Sans (`@fontsource-variable/ibm-plex-sans`) | SIL OFL 1.1 |
| Barlow Condensed (`@fontsource/barlow-condensed`) | SIL OFL 1.1 |
| Playwright (`@playwright/test`) | Apache-2.0 |
| TypeScript | Apache-2.0 |
| `@webgpu/types` | BSD-3-Clause |

The project's `LICENSE` claims only original materials; it does not override
these licences. The Instagram glyph used on the landing page is a third-party
brand mark; do not present it as original artwork.

### Known open items

- Branch protection and required review are not enabled.
- Dependabot alerts and security updates are not enabled.
- Supabase leaked-password protection was recorded as disabled in the October
  audit; confirm and enable it.
- Free-tier Supabase has no managed backups unless a plan was added.
- The domain registrar is not recorded in the repository.
- One person owns every provider account; this is the main continuity risk.
- The digest email is deliberately unscheduled; do not schedule a large run
  without resolving the Resend quota.
- `has_active_membership(uuid)` remains a low-severity information oracle, as
  recorded in `SECURITY_AUDIT_2026-10.md`; tightening it is a deliberate design
  change.
- The repository has no CI workflow; the guard suite is run locally.

## 18. Account independence matrix

| Service | Current dependency | Can another admin be authorised? | Can ownership be transferred? | Recommendation | Handover action |
| --- | --- | --- | --- | --- | --- |
| GitHub | Personal account `karmanhora`; public repository; one collaborator | Yes, as a collaborator or organisation member | Yes, to an organisation or another owner | Keep public; use a collaborator role; consider an organisation for continuity | Invite successor; enable branch protection, Dependabot, secret scanning |
| Vercel | Personal team `team_kUrx9ZtfVzlO4TiGP9wOBLKe`; project `rhs-musicandarts` | Yes, team member | Yes, project transfer to another team/owner | Add a second team member; document the billing owner | Invite successor; confirm env vars and domain |
| Supabase | Personal organisation; project `sjiswrvhrnrxkrfhfjrp` | Yes, organisation/project member | Yes, project transfer to another organisation | Add a second organisation member; enable backups | Invite successor; confirm Auth, functions, storage, migrations |
| Domain registrar | Not recorded in the repository | Depends on the registrar | Yes, with an auth code and owner approval | Record the registrar; enable lock, auto-renew, MFA; add a technical contact | Confirm registrar and DNS ownership |
| Resend | Personal account; domain `rhsattendance.org` | Yes, team member | Yes, domain/account transfer | Add a second team member; keep auth and app keys separate | Invite successor; confirm quota and DNS |
| Google Cloud OAuth | Project behind Google sign-in | Yes, project member | Yes, project transfer | Add a second owner; record the OAuth client and redirect URIs | Invite successor; confirm redirect URIs |
| School relationship | Informal; no ownership or endorsement claimed | Yes, a named school contact | Not applicable | Record who the school contacts and what they have approved | Introduce successor; do not claim endorsement |

## 19. Do not do these during handover

- Do not make the repository private.
- Do not delete branches, rewrite history, or force-push.
- Do not remove commits or tags.
- Do not change the repository name or disable public access.
- Do not transfer account ownership without written approval.
- Do not share passwords, recovery codes, or service-role keys.
- Do not change production environment variables without a record and approval.
- Do not apply migrations without rehearsal and approval.
- Do not change school permissions or user access as part of the handover.
- Do not change the licence, privacy policy, or terms.
- Do not claim school endorsement, district approval, or institutional
  ownership.
- Do not announce a successor who has not signed the agreement.

## 20. Final handover record

Complete and store privately.

- **Handover date:** __________
- **Owner:** Karman Hora
- **Successor:** ______________________________
- **Backup successor (optional):** ______________________________
- **Agreement signed:** [ ] yes  [ ] no — date: __________
- **Contribution option chosen:** [ ] A  [ ] B  [ ] C  [ ] D
- **Access granted:** GitHub [ ]  Vercel [ ]  Supabase [ ]  Resend [ ]
  Registrar [ ]  Google Cloud [ ]  School contact [ ]
- **MFA confirmed:** [ ] yes
- **Backup taken:** [ ] yes — date: __________  restore tested: [ ] yes
- **Production smoke test:** [ ] pass  date: __________
- **Independent maintenance cycle completed:** [ ] yes
- **Credentials rotated:** [ ] yes — dates recorded privately
- **Known open issues:** ______________________________________________
- **School contact:** ________________________________________________
- **Next review date:** __________
- **Owner signature:** ______________________  Date: __________
- **Successor signature:** ___________________  Date: __________
- **Guardian signature (if applicable):** _____  Date: __________

## 21. After handover

- [ ] Confirm the successor can sign in without the owner's accounts.
- [ ] Confirm the owner still owns the copyright and the accounts unless a
      separate transfer was signed.
- [ ] Confirm the school knows the new contact.
- [ ] Schedule the first review.
- [ ] Keep the signed agreement and access inventory private.
- [ ] Do not delete the repository or the site as a graduation cleanup step.
