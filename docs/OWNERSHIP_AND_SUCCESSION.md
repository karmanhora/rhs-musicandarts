# Ownership and succession policy

**Owner:** Karman Hora
**Effective:** 1 November 2026
**Status:** owner policy, adopted for this project. It is not legal advice, and it
does not replace a signed agreement. Have a parent or guardian and, where
appropriate, a lawyer review any agreement before it is signed.

This policy records how copyright ownership and maintenance authority are meant
to work for the Redmond Music & Arts Attendance App. It deliberately separates
three things that are easy to confuse:

1. **Copyright ownership** of the original work.
2. **Permission to maintain and operate** the application.
3. **Ownership or licensing of new contributions.**

Only the first is transferred by a copyright assignment. The second is a limited
authorisation. The third must be decided for each contribution.

## 1. What this policy covers

It covers the original materials created for this project:

- the application's source code in `src/`, `supabase/`, and `scripts/`;
- the database schema, migrations, policies, and server functions in
  `supabase/`;
- the documentation in `docs/` and the repository's root documents;
- the interface, visual design, copy, and original artwork created for the app;
- the project's name and the way it is presented, to the extent those are
  protectable.

It does **not** claim ownership of:

- third-party libraries, frameworks, fonts, icons, or other assets, which remain
  subject to their own licences (see [`../LICENSE`](../LICENSE) and the
  third-party section of the [`/license`](https://rhsattendance.org/license)
  page);
- student, staff, or program data entered into the app, which belongs to the
  school and the people it concerns, not to the copyright holder;
- the school's name, marks, or logo artwork, which are used only to identify the
  programs the app serves;
- GitHub, Vercel, Supabase, Resend, Google, or domain-registrar accounts, which
  are governed by those providers' terms and are separate from copyright.

## 2. Ownership today

Karman Hora is the copyright holder of the original materials in this project.
The project was independently developed and is independently maintained.

Publication does not change that. The website is public, the GitHub repository is
public, and the repository is part of the owner's portfolio. None of that grants
a licence to reuse the original code, and none of it transfers ownership.

No ownership has been transferred to Redmond High School, the Lake Washington
School District, another student, a future developer, or any organisation. This
policy does not claim school endorsement or institutional ownership, and it does
not change any permission the school or a program already has.

## 3. The retained-ownership model

The owner keeps copyright ownership of the original work while allowing a
qualified person to keep the application running. The rules are:

- **Publishing does not transfer ownership.** A public repository is not a
  dedication to the public domain.
- **School use does not transfer ownership.** Permission to use the app is not an
  assignment of the software.
- **Maintenance does not transfer ownership.** Fixing bugs, rotating keys, or
  deploying releases does not make the maintainer the author.
- **Graduation does not transfer ownership.** Leaving school changes who is
  available to maintain the app, not who owns it.
- **A contribution does not transfer ownership by default.** Future
  contributions need their own written arrangement (section 7).
- **Account access is not ownership.** Being an administrator of GitHub, Vercel,
  Supabase, Resend, or the domain is an operational role, not a copyright
  interest.
- **Only a written assignment transfers copyright.** It must be signed by the
  owner (and a parent or guardian while the owner is a minor) and must identify
  the materials being assigned. An email that says "you can maintain it" is not
  an assignment.

## 4. Copyright ownership and maintenance authority are different

| Question | Copyright holder | Authorised successor |
| --- | --- | --- |
| Who owns the original source, documentation, and designs? | Karman Hora | No one else, unless a written assignment says so |
| Who may grant a licence to reuse the original work? | Karman Hora | No one, unless the written authorisation expressly says so |
| Who may change the project's licence or copyright notices? | Karman Hora | No one |
| Who may fix bugs and security issues? | Karman Hora | Yes, within the authorised scope |
| Who may update dependencies and infrastructure? | Karman Hora | Yes, within the authorised scope |
| Who may deploy approved features? | Karman Hora | Yes, within the authorised scope |
| Who may operate the live app for authorised programs? | Karman Hora | Yes, within the authorised scope |
| Who may add or remove program users? | Program staff under the app's existing permissions | Only as the app's existing permissions allow; a handover is not a reason to change access |
| Who owns a new contribution? | Determined by the contribution terms | Determined by the contribution terms |
| Who may revoke the maintenance authorisation? | Karman Hora | No one |

## 5. What a successor may be authorised to do

A written authorisation may cover:

- operating the production website and its supporting services;
- fixing bugs and regressions;
- responding to security vulnerabilities and incidents;
- updating dependencies, runtimes, and provider configuration;
- maintaining backups, monitoring, and restore procedures;
- applying already-approved database migrations, in the documented order;
- developing and deploying features that the owner has approved in writing;
- maintaining documentation and the handover record;
- communicating with the school about technical operation.

It may **not**, unless a separate written permission says so:

- claim copyright ownership or authorship of the original work;
- change the project's licence, sell it, or grant a sublicence;
- reuse the original code in another product;
- transfer the project to another person or organisation;
- appoint another maintainer;
- remove or alter copyright, licence, or privacy notices;
- change the privacy policy, terms, or school-use arrangements;
- change the app's authentication model, database security model, or
  attendance rules as part of routine maintenance;
- transfer, disconnect, or re-create provider accounts;
- make the repository private.

## 6. Responsibilities of future maintainers

A maintainer is responsible for:

- **Availability.** Keeping the site deployable and noticing when it is not.
- **Security.** Applying security fixes promptly, protecting credentials, and
  following the incident steps in
  [`privacy/SECURITY_AND_INCIDENT_RESPONSE.md`](privacy/SECURITY_AND_INCIDENT_RESPONSE.md).
- **Data protection.** Preserving row-level security, least-privilege access, and
  the commitments in the published privacy policy. Never weakening RLS to make a
  screen work.
- **Backups.** Keeping a current backup and testing a restore, not just assuming
  one exists.
- **Dependencies.** Reviewing updates and advisories, and testing before
  deploying.
- **Documentation.** Recording changes, migrations, incidents, and access
  changes.
- **Notices.** Preserving [`../LICENSE`](../LICENSE), the `/license` page, and
  the privacy policy.
- **School liaison.** Telling the school about outages, material changes, or
  incidents that affect its records.
- **Continuity.** Keeping enough documentation that a second qualified person
  could take over.
- **Scope discipline.** Asking the owner before work outside the authorised
  scope, especially anything with production effect.

## 7. Future contributions

Do not assume that a future contribution belongs to the owner. Before a
contribution is merged, the owner and contributor must record one of these
arrangements in writing:

1. **Retained copyright with a licence to the project (recommended default).**
   The contributor keeps copyright in their contribution and grants the owner a
   perpetual, worldwide, non-exclusive, royalty-free licence to use, reproduce,
   modify, distribute, and sublicense it as part of this application.
2. **Assignment.** The contributor assigns copyright in the contribution to the
   owner in a signed written instrument. A commit message or a chat message is
   not an assignment.
3. **Third-party or upstream licence.** The contribution is already governed by
   a compatible third-party licence, and that licence is recorded.

If no arrangement is recorded, the contribution is not assumed to be owned by
the owner. A contributor may also be contributing in the course of employment or
school work, in which case their employer or school may own it; confirm that
before merging.

Record the choice in the signed maintenance agreement, in the relevant pull
request, and in the project's documentation. Do not rewrite old contributions to
match a new decision.

## 8. School use and continuity

- The application is intended to serve authorised Redmond High School music and
  arts programs.
- Authorised programs may continue using the application subject to the
  permissions and agreements that apply to them.
- The school's use of the app does not transfer ownership of the software to the
  school or district.
- This policy does not claim that the school has approved, endorsed, or adopted
  the app. Any such claim requires documented authorisation from the school or
  district.
- Graduation does not automatically terminate the application's maintenance
  authorisation or any school-use arrangement. A specific written agreement
  controls if it says otherwise.
- Technical maintenance and copyright ownership are separate. A change of
  maintainer does not change who owns the original work.
- A handover is not a reason to change existing user access, program membership,
  or permissions. Those changes follow the app's existing rules and the school's
  direction.
- Student data remains subject to the published privacy policy and the school's
  records rules. A successor does not acquire rights to it.

## 9. How a successor is appointed

1. **Identify a candidate.** Prefer someone with basic programming ability, good
   judgement, and a connection to the school or program that will outlast the
   owner's graduation.
2. **Assess technical ability.** Use the checks in
   [`GRADUATION_HANDOVER.md`](GRADUATION_HANDOVER.md): run the app locally, read
   the schema, make a small change on a branch, explain the security model, and
   restore a backup.
3. **Agree the scope.** Write down what the successor will and will not do, how
   quickly they will respond, and who they report to.
4. **Sign the agreement.** Use
   [`SUCCESSOR_MAINTENANCE_AGREEMENT.md`](SUCCESSOR_MAINTENANCE_AGREEMENT.md) or
   a reviewed equivalent. The owner signs; a parent or guardian signs while the
   owner is a minor; the successor signs.
5. **Grant least-privilege access.** Invite the successor to the provider
   accounts. Do not share passwords, recovery codes, or service-role keys. Do not
   make the successor the account owner.
6. **Hand over.** Follow the checklist, including a backup, a credential review,
   and a production smoke test.
7. **Confirm independent operation.** Watch the successor complete one full
   maintenance cycle without help: branch, change, review, deploy, verify,
   record.
8. **Record the handover.** Sign and date the record, list the access granted,
   and schedule a review.

## 10. Duration, review, replacement, and revocation

- **Start.** The authorisation starts on the date in the signed agreement.
- **Review.** Review it at least once a year, and whenever the successor changes,
  a provider changes ownership, or the school's arrangements change.
- **Termination by the owner.** The owner may revoke the authorisation in writing.
  For a security risk, abuse, or a serious breach, revocation may be immediate.
  Otherwise, allow a reasonable wind-down period (30 days unless the agreement
  says otherwise).
- **Termination by the successor.** The successor may resign in writing, with
  enough notice for an orderly handover.
- **Wind-down.** Remove the successor's access, rotate shared credentials,
  transfer backups and documentation, identify unfinished work, and record the
  final state.
- **Effect on ownership.** Revocation ends maintenance authority. It does not
  transfer copyright, and it does not automatically undo a contribution
  arrangement that was already granted in writing.
- **Replacement.** A replacement successor needs a new written authorisation.
  Access is not inherited.

## 11. Requirements for written agreements

At minimum, a maintenance agreement should:

- identify the owner and the successor, with contact details;
- identify the project, repository, site, and provider accounts;
- state that copyright ownership stays with the owner;
- define the authorised scope and the exclusions;
- set the duration and the review and termination process;
- address ownership and licensing of future contributions;
- require confidentiality and least-privilege credential handling;
- require compliance with third-party licences and the privacy policy;
- describe handover, wind-down, and record-keeping;
- state the governing law and how disputes will be handled;
- be signed and dated by the owner, the successor, and a parent or guardian while
  the owner is a minor.

A template is provided in
[`SUCCESSOR_MAINTENANCE_AGREEMENT.md`](SUCCESSOR_MAINTENANCE_AGREEMENT.md). It is
a starting point for review, not an executed agreement.

## 12. Records to keep

Keep these with the project's private handover records (not in the public
repository if they contain personal information):

- the signed agreement and its schedules;
- the access inventory (service, role, date granted, date removed — never
  passwords or keys);
- the completed handover checklist;
- credential rotation dates (not the values);
- contribution elections;
- incident notes and notifications;
- backup dates and restore test results;
- review dates and the next review date.

## 13. Accounts and infrastructure are separate from copyright

GitHub, Vercel, Supabase, Resend, Google OAuth, and the domain registrar are
provider relationships. They can be transferred, shared, or replaced without
transferring copyright, and transferring copyright does not transfer them.

Recommended practice:

- keep the repository **public** as a portfolio, and grant maintenance access as
  a collaborator rather than by sharing the owner's login;
- use an organisation or team account for long-term projects where possible;
- invite the successor as a member with the narrowest role that works;
- keep billing and renewal responsibility explicit;
- never put credentials in the repository, a chat, or this documentation.

The account-by-account position is in
[`GRADUATION_HANDOVER.md`](GRADUATION_HANDOVER.md).

## 14. Review checklist

Before a handover is treated as complete, confirm:

- [ ] The successor understands that copyright is retained by the owner.
- [ ] The written agreement is signed and dated.
- [ ] The scope and exclusions are specific.
- [ ] The contribution arrangement is chosen and recorded.
- [ ] Access is least-privilege and does not include shared passwords.
- [ ] A current backup exists and a restore has been tested.
- [ ] The production smoke test passes.
- [ ] The successor can operate the app without the owner's daily involvement.
- [ ] The school knows who to contact.
- [ ] The next review date is recorded.

## 15. Related documents

- [`../LICENSE`](../LICENSE) — the proprietary licence notice.
- [`SUCCESSOR_MAINTENANCE_AGREEMENT.md`](SUCCESSOR_MAINTENANCE_AGREEMENT.md) —
  the reusable agreement template.
- [`SUCCESSOR_ONBOARDING.md`](SUCCESSOR_ONBOARDING.md) — the technical guide.
- [`GRADUATION_HANDOVER.md`](GRADUATION_HANDOVER.md) — the checklist and account
  matrix.
- [`../README.md`](../README.md) — project overview and copyright section.
- [`FEATURE_DECISIONS.md`](FEATURE_DECISIONS.md) — decisions that must not be
  reversed without the owner.
- [`DEV.md`](DEV.md) — the developer contract.
