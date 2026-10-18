# Third-Party Providers & What They May Process (DRAFT)

> **DRAFT.** Statements about providers are taken from their published materials
> and were **not** independently audited. Confirm current terms before relying on
> them.

| Provider | Role | Data it may process | Notes |
|---|---|---|---|
| **Supabase** | Database, Auth, Edge Functions | all student/staff data described in the inventory; account email addresses (delivery handed to Resend) | SOC 2 Type 2, ISO 27001 per vendor; AES-256 at rest / TLS in transit (vendor claim); data lives in the project's chosen AWS region; **backups are plan-dependent** (Free has none) |
| **Vercel** | Static hosting + edge/CDN | request metadata; **no student records by design** (static SPA) | SOC 2 Type 2 / ISO 27001 per vendor; runtime logs can contain request paths/params — keep PII out of URLs where possible; Hobby log retention is short |
| **Resend** | Transactional email — Supabase Auth (SMTP) and the upcoming-events digest (API) | recipient email address; message content (program/event names, times, locations); delivery metadata | the only mail provider; sender domain `rhsattendance.org` verified with SPF/DKIM; no advertising or analytics use; SOC 2 Type 2 per vendor (confirm the current report for the district packet) |
| **Google** | Optional sign-in (OAuth) and public calendar feed | basic profile + email for sign-in; events in a staff-connected public iCal feed | no Calendar API scopes; a staff-authorized Edge Function reads the public feed, not a user's private Google calendar |
| **GitHub** | Source code hosting | **none** (code only; no student data) | ensure no secrets are committed |

## Subprocessors
Supabase uses AWS for hosting; both publish subprocessor lists in their DPA/Trust
Center. Retrieve the current lists for the district packet. *(Names not verified
here.)*

## What the district will likely ask for
- A DPA / SOC 2 report from Supabase and Vercel.
- Confirmation of the Supabase **region** and whether data leaves it.
- Which provider handles email, and under what terms. It is **Resend** — auth
  mail over its SMTP relay and the digest over its API — with the sending domain
  `rhsattendance.org` verified for SPF/DKIM.
- A short statement that no advertising/analytics providers are used.
