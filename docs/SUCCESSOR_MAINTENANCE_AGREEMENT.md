# Successor maintenance agreement (template)

> **TEMPLATE — NOT AN EXECUTED AGREEMENT.**
>
> This is a reusable starting point for the owner, the successor, and their
> reviewers. It is not legal advice, and it has not been reviewed by a lawyer. It
> becomes effective only when the blanks are completed, the choices are made, and
> every required party signs it. Delete any optional clause that does not apply,
> but do not delete the ownership clause.
>
> The owner is a student. A parent or guardian should review and sign this
> agreement while the owner is a minor. Where the school or district needs to be
> a party, use a separate school agreement; this document does not bind them.

**Agreement date:** [DATE]

## Parties

**Owner and copyright holder:** Karman Hora
Email: [OWNER CONTACT EMAIL]
Address: [OWNER ADDRESS, optional]

**Authorised successor:** [SUCCESSOR FULL NAME]
Email: [SUCCESSOR EMAIL]
Address: [SUCCESSOR ADDRESS, optional]

**Parent or guardian of the owner (while the owner is a minor):** [NAME]
Email: [EMAIL]

## Recitals

A. The Owner independently developed the Redmond Music & Arts Attendance App
(the "Application"), including its original source code, documentation, designs,
and related materials (the "Original Materials").

B. The Owner retains copyright ownership of the Original Materials. The
Application is proprietary software published under the notice in the
repository's `LICENSE` file.

C. The Owner expects to graduate from Redmond High School and wants the
Application to continue operating for authorised school programs.

D. The Successor is willing to maintain and operate the Application within a
defined scope, without acquiring ownership of the Original Materials.

E. The parties intend this Agreement to authorise maintenance and operation
only. It is not a copyright assignment, a sale, a partnership, or a school
agreement.

## 1. Definitions

- **Application** — the Redmond Music & Arts Attendance App, the website at
  `rhsattendance.org`, and the repository at
  `github.com/karmanhora/rhs-musicandarts`.
- **Original Materials** — the original source code, database migrations,
  documentation, interface and visual designs, copy, and original artwork
  created for the Application.
- **Third-Party Materials** — libraries, frameworks, fonts, icons, services, and
  other assets owned by someone other than the Owner and governed by their own
  licences.
- **Successor Contributions** — code, documentation, designs, or other material
  the Successor creates for the Application after the Effective Date.
- **School Programs** — the Redmond High School music and arts programs and
  users authorised under the Application's existing permissions.
- **Authorised Scope** — the maintenance and operation described in Schedule A.

## 2. Ownership retained by the Owner

2.1 The Owner owns the copyright and all other rights in the Original Materials,
subject to Third-Party Materials and applicable law.

2.2 This Agreement does not assign, transfer, sell, or otherwise convey any
copyright or ownership interest in the Original Materials to the Successor, the
school, the district, or any other person.

2.3 The Successor must not claim authorship or ownership of the Original
Materials, and must not describe the Application as their own work.

2.4 The Successor must preserve the copyright, licence, and attribution notices
in the repository and on the website.

## 3. Limited authorisation to maintain and operate

3.1 The Owner grants the Successor a limited, non-exclusive, non-transferable,
revocable authorisation to maintain and operate the Application within the
Authorised Scope.

3.2 The authorisation is for the benefit of the Application and its authorised
School Programs. It is not a licence to reuse the Original Materials in another
product.

3.3 The Successor may act only within the Authorised Scope. Anything outside it
requires the Owner's prior written approval.

3.4 The Successor may not grant a sublicence, appoint another maintainer, or
transfer this authorisation.

3.5 No fee is payable under this Agreement unless Schedule A says otherwise.

## 4. Authorised maintenance

Within the Authorised Scope, the Successor may:

- operate the production website and its supporting services;
- fix bugs, regressions, and broken functionality;
- investigate and remediate security vulnerabilities;
- update dependencies, runtimes, and provider configuration after testing;
- maintain backups, monitoring, and restore procedures;
- apply migrations that the Owner has approved, in the documented order;
- develop and deploy features the Owner has approved in writing;
- maintain documentation and the handover record;
- communicate with the school about technical operation and incidents.

## 5. Restrictions

The Successor must not, without a separate written permission from the Owner:

- claim copyright ownership or authorship of the Original Materials;
- copy, republish, or reuse the Original Materials in another project;
- sell, license, sublicense, or commercially exploit the Application or the
  Original Materials;
- change the project's licence or copyright notices;
- make the repository private;
- remove or weaken authentication, row-level security, permission checks, or
  attendance rules;
- change the privacy policy, terms of use, or school-use arrangements;
- add a second identity provider or reverse a documented architecture decision;
- change existing user access, program membership, or permissions as part of a
  handover;
- transfer, disconnect, or recreate provider accounts;
- share credentials, recovery codes, or service-role keys;
- store secrets in the repository, logs, documentation, or chat.

## 6. Third-party materials

6.1 The Successor must comply with the licences of Third-Party Materials.

6.2 This Agreement does not grant any rights in Third-Party Materials beyond
those their own licences provide.

6.3 The Successor must not remove third-party licence notices or add the Owner's
name to a third-party file or dependency.

## 7. Ownership and licensing of future contributions

Choose one option. **Do not leave this section blank.** If no option is chosen,
option A applies.

**Option A — Successor retains copyright, grants the project a licence
(recommended default).**

The Successor retains copyright in the Successor Contributions and grants the
Owner a perpetual, worldwide, non-exclusive, royalty-free licence to use,
reproduce, modify, distribute, and sublicense the Successor Contributions as part
of the Application. This licence survives termination of this Agreement.

**Option B — Assignment to the Owner.**

The Successor assigns to the Owner all copyright in the Successor Contributions
created under this Agreement. The Successor must sign a separate assignment if a
reviewer requires one. This option must be chosen expressly; a commit message is
not an assignment.

**Option C — Third-party or upstream licence.**

The Successor Contributions are governed by [NAME OF LICENCE], and the Successor
has the right to contribute them under that licence. The licence text is recorded
at [PATH OR URL].

**Option D — Contribution-by-contribution.**

The parties will record the arrangement for each contribution in the pull request
or a separate written record before it is merged. Absent a record, option A
applies to that contribution.

**Initials:** Owner ______  Successor ______

## 8. Attribution

8.1 The Successor may identify themselves as a maintainer in project
documentation, for example "Maintained by [NAME] under written authorisation
from Karman Hora."

8.2 That credit must not state or imply that the Successor authored or owns the
Original Materials.

## 9. Confidentiality and credentials

9.1 The Successor must keep credentials, recovery codes, service-role keys, and
private student information confidential.

9.2 Access must use the providers' invitation and role features, not shared
passwords.

9.3 The Successor must enable multi-factor authentication on every provider
account that supports it.

9.4 The Successor must report a suspected credential exposure to the Owner
immediately, and cooperate in rotating the affected credentials.

9.5 On termination, the Successor must stop using the credentials, return or
destroy copies, and confirm in writing that access has been removed.

## 10. Student data and privacy

10.1 Student and staff information belongs to the school and the people it
concerns. The Successor acquires no ownership of it.

10.2 The Successor must follow the published privacy policy, the app's
row-level security, and the school's direction. The Successor must not add new
privacy claims, sell data, or use it for unrelated purposes.

10.3 The Successor must notify the Owner and the school promptly of a security
incident or suspected data breach, and follow
`docs/privacy/SECURITY_AND_INCIDENT_RESPONSE.md`.

## 11. Duration and review

11.1 This Agreement starts on the Effective Date: [DATE].

11.2 It continues until terminated under section 12.

11.3 The parties will review it at least once a year, and whenever the Successor
changes, a provider changes ownership, or the school's arrangements change.

11.4 The Owner's graduation does not by itself terminate this Agreement.

## 12. Termination and replacement

12.1 The Owner may terminate this Agreement in writing with [30] days' notice.

12.2 The Owner may terminate immediately, by written notice, for a security risk,
abuse, a material breach, or conduct that endangers student data.

12.3 The Successor may resign in writing with [30] days' notice.

12.4 During wind-down, the Successor must:

- stop making production changes except emergency security work approved by the
  Owner;
- transfer documentation, open issues, backups, and the handover record;
- remove their access and rotate shared credentials;
- provide a final written report of the system's state.

12.5 Termination ends maintenance authority. It does not transfer copyright and
does not automatically reverse a contribution arrangement already granted in
writing.

12.6 A replacement successor requires a new signed agreement. Access is not
inherited.

## 13. Handover responsibilities

13.1 The Owner will provide the documentation, access, and known-risk information
listed in Schedule D.

13.2 The Successor will complete the handover checklist, test a restore, and
demonstrate one full maintenance cycle before the Owner's access is reduced.

13.3 Neither party is required to hand over a credential value in writing. Use
the provider's invitation and rotation features.

## 14. Availability and standard of work

14.1 The Successor will use reasonable care and skill, consistent with a
volunteer maintainer of a free school tool.

14.2 This Agreement does not promise uninterrupted availability, a particular
response time, or a particular feature roadmap.

14.3 The Successor must tell the Owner and the school about material outages or
risks.

## 15. Liability and governing law

15.1 [To be completed with a reviewer. Do not rely on this template for
liability, indemnity, or insurance terms.]

15.2 This Agreement is governed by the laws of [STATE], and the parties will try
to resolve a dispute in good faith before taking further action.

15.3 If any clause is unenforceable, the rest remains in effect.

## 16. Entire agreement and amendments

16.1 This Agreement and its schedules are the entire agreement about maintenance
authority. It replaces earlier informal understandings about maintenance.

16.2 An amendment must be in writing and signed by the Owner, the Successor, and
the guardian while the Owner is a minor.

16.3 This Agreement does not replace a school data-processing agreement, a
district vendor agreement, or any separate copyright assignment.

## 17. Signatures

**Owner:** ______________________________  Date: __________

**Parent or guardian (while the Owner is a minor):**
______________________________  Date: __________

**Successor:** ______________________________  Date: __________

---

## Schedule A — Authorised scope

Complete this schedule. Be specific; "help with the app" is not a scope.

- **Services the Successor may operate:** [production site, Vercel project,
  Supabase project, Resend account, domain DNS]
- **Maintenance the Successor may perform:** [bugs, security, dependencies,
  backups, monitoring]
- **Features requiring prior written approval:** [all new user-facing features,
  schema changes, auth changes, privacy changes]
- **Response expectations:** [for example, acknowledge a security report within
  48 hours]
- **Fees or expenses:** [none / describe]
- **Approved migration process:** [local rehearsal, owner approval, apply before
  frontend]
- **Emergency authority:** [what may be done without prior approval, and how soon
  the Owner must be told]

## Schedule B — Access inventory

Record service, role, and date. **Never record a password, key, or recovery code
here.**

| Service | Account / project | Role granted | Date granted | Date removed |
| --- | --- | --- | --- | --- |
| GitHub | `karmanhora/rhs-musicandarts` | [collaborator / maintain] | | |
| Vercel | `rhs-musicandarts` | [member] | | |
| Supabase | `sjiswrvhrnrxkrfhfjrp` | [member / developer] | | |
| Resend | [team] | [member] | | |
| Domain registrar | `rhsattendance.org` | [DNS / billing] | | |
| Google Cloud OAuth | [project] | [owner / editor] | | |

## Schedule C — Contribution election

The parties chose: [ ] Option A  [ ] Option B  [ ] Option C  [ ] Option D

Details: ______________________________________________

Initials: Owner ______  Successor ______  Date: __________

## Schedule D — Handover checklist

- [ ] Signed agreement and schedules stored privately.
- [ ] Access granted with least privilege, using invitations.
- [ ] MFA confirmed on every provider account.
- [ ] Current database backup taken; restore tested.
- [ ] Repository cloned and the app run locally by the Successor.
- [ ] `npm run typecheck`, `npm run build`, and `npm run check:headers` pass.
- [ ] The Supabase migration rehearsal passes locally.
- [ ] Production smoke test passes: sign-in, attendance, QR check-in, roster,
  reports, privacy, licence.
- [ ] Known risks and open issues reviewed.
- [ ] School contact and escalation path recorded.
- [ ] Credential rotation completed where access changed.
- [ ] Final handover record signed and dated.
- [ ] Next review date: __________
