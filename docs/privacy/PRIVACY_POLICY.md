# Privacy Policy

**Effective date:** October 18, 2026
**Last updated:** October 18, 2026

This is the published text of the policy served at
[`/privacy`](https://rhsattendance.org/privacy) (`src/screens/LegalScreen.tsx`).
Keep the two in step. Every statement here is drawn from the implementation in
this repository.

## 1. About this policy

This policy explains how the Redmond High School Attendance app (the "App") handles
personal information. The App is an independent, free attendance-management tool
used by music and arts programs at Redmond High School (RHS). It is operated by
an independent developer ("we", "us").

The App is not an official Lake Washington School District service. This policy
does not state or imply district approval, endorsement, or a written agreement
with the school or district.

It applies to the website at rhsattendance.org and to the attendance features it
provides. It does not apply to other websites or to Google's own services.

## 2. What the App does and who it is for

The App lets an approved music or arts program keep a roster, schedule rehearsals
and events, invite members, record attendance and check-ins, and give staff
attendance summaries. Students can see their own attendance and their program's
events.

It is intended for RHS students and staff in approved programs, used at the
direction of school staff. Students may use it only through the account and
program their school or program staff set up.

## 3. Information we collect

We collect the information needed to run attendance for a program:

- **Account information:** your email address, a sign-in account identifier,
  your password (stored in hashed form by our authentication provider, never by
  the App's own database), and whether your email address has been confirmed.
- **Profile information:** your name and display name, an optional biography, an
  optional profile picture you upload, and your instrument or section where a
  program records one.
- **Program membership and roles:** which program(s) you belong to, your role
  (for example student, section leader, secretary, or director), your section,
  and whether your membership is active.
- **Attendance records:** the event, whether you were present, absent, late, or
  excused, the time of a check-in, whether a check-in was late, and an excused
  reason if staff record one.
- **Staff notes:** private notes that program staff may attach to an attendance
  record. These are visible to authorized staff, not to the student the note is
  about.
- **Invitations:** if staff invite someone by email, the invited person's name
  and email address are stored until the invitation is accepted or cancelled. A
  teacher invitation code may also be stored in hashed form.
- **Program scheduling data:** events, event types, dates, times, locations, and
  notes. If staff connect a public Google Calendar feed, the feed address and the
  imported event details are stored for that program.
- **Your own additions:** personal calendar items you create in the App, and
  in-app notifications sent to you.
- **Optional email updates:** each program membership records whether you have
  chosen to receive a daily email about upcoming events (on by default, and you
  can turn it off).
- **Security and technical data:** records of successful and failed check-in
  attempts and join-code attempts (join-code attempts include an IP address),
  plus standard request logs kept by our hosting and database providers, which
  may include IP address, browser type, and timestamps.

## 4. Google Sign-In and Google Calendar

Google sign-in is optional. It is one way to sign in; you can also create an
account with an email address and password. When you choose "Continue with
Google", Google authenticates you and shares basic account information with our
authentication provider, Supabase Auth. That information is typically your name,
email address, profile picture, and a Google account identifier.

We use the email address and Google account identifier to create or sign in to
your App account, and your name may be used to prefill your profile. We do not
receive your Google password. We do not request access to Google Calendar,
Gmail, Google Drive, Google Contacts, or any other Google service, we do not read
your private Google account data, and we do not post anything to Google on your
behalf. Your use of Google sign-in is also governed by Google's own privacy
policy.

Separately, a staff member may choose to paste a public iCal address from Google
Calendar so that the program's events appear in the App. This is not part of
Google sign-in, requests no Google API permissions or OAuth scopes, and does not
access anyone's private calendar. It reads only the public feed at the address
staff provide, and stores that address and the imported event details for the
program. A public calendar feed can be read by anyone who has its URL, so staff
should connect only a calendar approved for public sharing.

## 5. How we use information

- To create and authenticate accounts, confirm email addresses, and let you reset
  a password or change your email address.
- To build and show program rosters, memberships, roles, sections, and
  invitations.
- To schedule events and record attendance, check-ins, late arrivals, excused
  absences, and staff notes.
- To give students their own attendance and staff the summaries and reports their
  role allows.
- To send necessary service emails: address confirmation, password reset,
  invitations, security notices about your account, and optional upcoming-event
  emails you can turn off.
- To keep the App secure and working: preventing abuse, limiting repeated failed
  attempts, troubleshooting errors, and maintaining audit records.

## 6. Who can see your information

Access is enforced by the database itself (row-level security and server-side
checks), not only by which screen you open. Within a program:

- Students can see their own attendance and their program's events; they cannot
  see other students' attendance, and they cannot read staff notes.
- Section leaders can see attendance for their own section, as their permissions
  allow.
- Secretaries and directors can see roster and attendance information for their
  own program.
- Program administrators and the developer, using restricted server credentials
  for support and maintenance, may access information when needed to operate the
  App.
- People in other programs cannot see your program's information.

## 7. Service providers and sharing

We do not sell personal information, show targeted advertising, build advertising
profiles, or share information with data brokers. We do not use third-party
analytics or advertising services. Information is shared only with the providers
needed to run the App, and with the school as described below:

- **Supabase** provides the database, authentication, file storage for profile
  pictures, and server functions. It processes the information described in this
  policy on our behalf.
- **Vercel** hosts the website and serves its files. Its request logs may contain
  technical information such as IP address and the page requested.
- **Resend** delivers email — account confirmation, password reset, invitations,
  and optional event emails — through Supabase Auth and the App's server
  functions. It processes recipients' email addresses and the content of those
  messages.
- **Google** is used only for optional Google sign-in, and, separately, when staff
  choose to import a public Google Calendar feed as described in section 4.
- **The school or program** may be given access to its own program's records on
  request, and we may disclose information if required by law or where necessary
  to protect someone's safety.

## 8. Storage and security

Information is stored in Supabase's hosted PostgreSQL database and private file
storage. Profile pictures are kept in a private storage bucket and shown through
short-lived signed links, not public URLs. Access is limited with database
row-level security, least-privilege roles, and server-side permission checks, and
data is encrypted in transit with TLS. Server credentials are restricted to the
server and are never included in the browser app.

No system is perfectly secure, and we cannot guarantee that unauthorized access,
loss, or misuse will never happen. We do not claim any specific security
certification for the App.

## 9. How long we keep information

Account information and profile details are kept while your account exists.
Attendance records and related event records belong to the program's school
records and are kept for as long as the program needs them for its records; we do
not set a shorter period for them.

When you delete your account, the App deletes your sign-in account and removes
your memberships, roles, reminders, in-app notifications, personal calendar
items, and check-in attempt records. Your profile's name and picture are replaced
with "Deleted account", and your signup information is deleted. Attendance
already recorded stays in the program's records under that de-identified profile,
so the roster's history remains accurate. Staff notes and events you created stay
too, but no longer show you as their author. This is de-identification, not
complete erasure, and it may not be irreversible in every circumstance.

Invitations that are never accepted are removed by a maintenance cleanup, and
program staff can cancel one directly. Check-in sessions and their codes expire after a few minutes. Security and request logs
are kept only as long as needed for abuse prevention, troubleshooting, and
provider operations; we do not currently apply a fixed deletion period to them.
Our providers may keep backups for the period their plans specify.

## 10. Account deletion and your privacy choices

You can delete your own account in the App: open **Account settings**, choose the
Privacy tab, and select **Delete my account**. The App asks you to confirm, then
permanently deletes your sign-in account and profile details as described in
section 9. Programs where you are the only director are archived rather than
deleted, so their attendance records are not lost.

You can also ask a program director to correct a name, section, or membership, or
to remove you from a roster. For requests about the App itself, including access
to or correction of information, contact
[privacy@rhsattendance.org](mailto:privacy@rhsattendance.org). For a school
record, your school's records office handles inspection and correction requests
under the district's records policy (LWSD Policy 3231); we will forward a request
we receive to the program or school.

## 11. Children and student information

The App is intended for Redmond High School students and staff and is not
directed to children under 13. Students should use the account their school or
program provides, and a student under 13 should not create an account.

The App handles student information in a school context. Some of it may be an
education record under FERPA, and the school remains responsible for its
education records. This policy explains our own practices; it is not a contract
with the school, and it does not by itself establish compliance with FERPA,
Washington's student privacy law (RCW 28A.604), or any district requirement.
Those determinations belong to the school or district. If a program serving
students under 13 is added, additional safeguards will be required and this
policy will be updated before that use.

## 12. Cookies, local storage, and sessions

The App does not use advertising or analytics cookies and does not track you
across other websites. To keep you signed in, it stores your Supabase Auth session
in your browser's local storage; signing out removes it from that browser. During
sign-in, the authentication service may keep short-lived values needed to
complete the flow.

Google's sign-in pages are operated by Google and may use Google's own cookies
under Google's privacy policy. Our hosting and database providers keep standard
request logs as described above.

## 13. Security incidents

If we become aware of a security incident involving personal information, we
will investigate, take steps to contain it, and notify affected users and the
school or program as required by applicable law.

## 14. Changes to this policy

We may update this policy when the App or its providers change. The effective
date at the top shows when the current version took effect. For a material
change, we will post the updated policy here and give notice in the App or by
email where appropriate before it applies to information already collected.

## Contact

[privacy@rhsattendance.org](mailto:privacy@rhsattendance.org) — questions about
this policy, or a privacy request about the app itself.

For school-record questions, contact the program director or the school's records
office (LWSD Policy 3231).
