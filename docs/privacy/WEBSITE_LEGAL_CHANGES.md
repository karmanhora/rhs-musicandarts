# Website Legal Changes Applied (Privacy Policy & Terms of Use in the App)

**Date:** 2026-10-11
**Status:** applied to the working tree, verified locally. **Not committed, not deployed.**
Draft text is live in the app but **not yet in effect** — the pages say so themselves.

This records what was moved from the paper drafts in this folder onto the actual
website, so the two do not drift. The Markdown drafts remain the source of truth
for review; the app pages are the published rendering.

---

## 1. What changed on the website

Before this change the privacy policy, terms, and notice existed **only** as
Markdown files in `docs/privacy/`. Nothing in the running app linked to them and
no route served them, so a student, parent, or district reviewer could not read
them. That is now fixed.

| Area | File | Change |
|---|---|---|
| Public legal pages | `src/screens/LegalScreen.tsx` (new) | Renders **`/privacy`** (Privacy Policy) and **`/terms`** (Terms of Use) as readable pages, each with a visible **draft banner** and `[BRACKETED]` placeholders intact. |
| Routing | `src/App.tsx` | Registers `/privacy` and `/terms` in the **signed-out**, **loading**, and **password-recovery** trees, so the notices are reachable **without signing in**. |
| Routing (signed in) | `src/SignedInApp.tsx` | Registers the same two routes for signed-in users, including the no-roster state. Rendered standalone (no app chrome). |
| Landing page | `src/screens/WelcomeScreen.tsx` | Footer now has a **Privacy Policy** and **Terms of Use** link. |
| Sign-up / auth | `src/screens/AuthScreen.tsx` | Sign-up shows a consent line — "By creating an account you agree to our Terms of Use and Privacy Policy." — and every auth mode has a small Privacy · Terms footer link. |
| Profile | `src/screens/ProfileScreen.tsx` | New **Privacy** section with rows linking to both pages, plus a note that the notices are drafts and that record requests go through LWSD Policy 3231. |

## 2. What was verified (and how)

- `npm run typecheck` — exit 0.
- `npm run build` — exit 0 (Vite build succeeds; only the pre-existing large-chunk warning).
- Dev server (`npm run dev`, loopback only) with the pages fetched **signed out**:
  - `/privacy` and `/terms` return HTTP **200** and render in the browser.
  - Both pages render their full text, the draft banner, and the
    `[DEVELOPER NAME]` / `[CONTACT EMAIL]` / `[DISTRICT CONTACT]` / `[TO BE SET]`
    / `[N] days` placeholders.
  - The **cross-link** between the two pages works (`Read the Terms of Use` →
    `/terms`, `Read the Privacy Policy` → `/privacy`).
  - The **welcome footer** renders `Privacy Policy => /privacy` and
    `Terms of Use => /terms`.
  - The **sign-up** page renders both links and the consent sentence.
  - Browser console: no errors.

**Not verified:** the signed-in `/me` (Profile) links were **not** exercised live —
that needs an authenticated session with a seeded program, which was not available
here. The route registration and the Profile rows are typechecked but unproven at
runtime.

## 3. What is still a placeholder (must be filled before the pages are final)

The pages are deliberately honest about being drafts. Before the district can
rely on them, someone must replace:

- `[TO BE SET]` — effective date (both pages).
- `[CONTACT EMAIL]` — where app-level privacy requests should go (Privacy §9).
- `[DEVELOPER NAME]` and `[DISTRICT CONTACT]` — needed only when the Contact
  section is restored (see §3.1).
- `[N] days` — the stale-pending-invitation window (Privacy §7) — the value must
  match the retention schedule, which currently says **e.g. 30 days, district's call**.
- `[counsel]` markers inside the page text (Privacy §8) — a real reviewer should
  resolve these; they are visible reminders, not final copy.
- The **draft banner** itself — remove only after school/district and, where
  applicable, guardian/legal review.

### 3.1 TODO — restore the Contact section

On the owner's instruction, **Privacy Policy §12 ("Contact") was removed** from
the published page on 2026-10-11. It must be **added back later** once a real
developer name and a district/school contact exist.

- Where it was removed: `src/screens/LegalScreen.tsx`, in the `PRIVACY.sections`
  array — look for the `TODO(add-back)` block, which contains the exact section
  object to restore (no longer numbered 12 if other sections change).
- The Markdown draft [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) **still has** its
  own §12; align the two when the Contact section goes back up.
- The app-level contact email (`[CONTACT EMAIL]`) is still shown in §9, so a
  reader is not left with no way to reach anyone in the meantime.

Do not remove the draft banner until this section is restored and all
placeholders are resolved.

## 4. What remains open (not addressed by this change)

These are tracked in `00_READINESS_AUDIT.md` §6 and `SCHOOL_APPROVAL_CHECKLIST.md`.
The website change closes only the "notices not published" gap.

**Still district-dependent (blocking real student data):**
- Written authorization and a signed data-processing agreement.
- District vendor-approval form.
- Decision on whether a family notice is required.
- Decision on director-account verification and free-text excuse reasons.
- Confirmation that the Google Calendar ICS feed is intentionally public.

**Still provider / developer actions:**
- Rotate the Supabase management token and service-role keys; delete the retired
  Clerk secret. Enable MFA on Supabase, Vercel, GitHub, and the SMTP account.
- Schedule `purge_stale_program_invites()` (migration 028 is applied; nothing
  calls it yet). Add a purge for `checkin_attempts` / `join_code_attempts`.
- Backups (paid tier) or a documented export routine.
- Confirm Supabase/Vercel region, subprocessors, and SMTP configuration.

**Follow-ups this change implies:**
- Keep the app pages in sync with the Markdown drafts, or the two will drift.
- Decide whether to host the same text as static HTML/Markdown for offline or
  non-JavaScript access (the app is a client-rendered SPA; a crawler or a
  no-JavaScript visitor gets an empty page).
- If the district requires a signed "I agree" checkbox rather than a notice line,
  add an explicit acknowledgement to sign-up.

> None of this makes the app "compliant." It publishes accurate drafts and makes
> the notices reachable; the legal review and agreements are still required.

## 5. 2026-10-18 — privacy policy published in full

Google OAuth verification rejected the earlier draft for insufficient detail. The
privacy policy at `/privacy` was rewritten from the implementation and is now the
published, effective text (no draft banner, no placeholders):

- Effective date **2026-10-18**; sections cover what the App is and who it is for,
  every category of information collected, Google Sign-In (authentication only,
  no Calendar/Gmail/Drive scopes), the separate **public iCal** calendar import,
  use, role-based visibility, providers (Supabase, Vercel, Resend, Google),
  row-level security and TLS, actual retention and account-deletion behaviour,
  deletion/access requests, children and school records, and session storage.
- Contact is **privacy@rhsattendance.org**, supplied by the owner for this purpose.
  The mailbox must be created and monitored; it is not the `noreply@` sending
  address.
- It no longer claims a **written school agreement**, district approval, or legal
  compliance. The earlier draft's "under a written agreement" sentence was false.
- The policy deliberately states that attendance records are **de-identified, not
  erased**, on account deletion, matching `prepare_account_deletion()`.
- `purge_stale_program_invites()` is still unscheduled, so the policy does not
  promise a fixed deletion window for unaccepted invitations.
- The Terms of Use page is unchanged and still a draft with its own effective-date
  placeholder; it is a separate document awaiting review.
