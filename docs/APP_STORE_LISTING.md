# App Store listing

Draft copy for App Store Connect. Claims are limited to what the app currently
does. Replace every `PLACEHOLDER` before submission.

## Name and subtitle

**Name (27 characters)**

```text
RHS Music & Arts Attendance
```

**Subtitle (29 characters)**

```text
Attendance and event check-in
```

## Promotional text (170 characters max)

```text
Keep every rehearsal, performance and attendance record in one place. Students check in by QR code or short code; directors manage events, rosters and the roll.
```

## Description

```text
RHS Music & Arts Attendance keeps attendance and event check-in in one place for Redmond High School music and arts programs.

For students:
• See your program's upcoming rehearsals and events.
• Check in by scanning the QR code on the rehearsal-room screen or typing its short code.
• Review your own attendance.
• Ask for an absence and follow the response.

For directors and program staff:
• Keep a roster with sections and roles.
• Add events and open a live check-in with a QR code and short entry code.
• Mark the roll manually when needed.
• Review attendance records and export reports.
• Manage join codes, invitations and program settings.

Accounts use email and password. Access is limited to authorized program members. The app is free, has no ads and offers no in-app purchases.

RHS Music & Arts Attendance is an independent tool used by Redmond High School music and arts programs.
```

## Keywords (100 characters max)

```text
attendance,check-in,roster,music,band,choir,orchestra,drama,school,events,program
```

## Category and rating

- **Primary category:** Education
- **Secondary category:** Productivity
- **Age rating:** 4+ (no objectionable content, no unrestricted web access, no
  public user-generated content, no gambling, no ads, no purchases).
- **Made for Kids:** No. The app is used by high-school students and staff, and
  accounts are issued through school programs.

## URLs

- **Support URL:** `https://rhsattendance.org/support` — PLACEHOLDER; publish a
  real support page before submission.
- **Privacy Policy URL:** `https://rhsattendance.org/privacy`
- **Terms of Use:** `https://rhsattendance.org/terms`
- **Marketing URL (optional):** `https://rhsattendance.org`

## App Privacy answers

These must match `ios/App/App/PrivacyInfo.xcprivacy`.

**Tracking:** No. The app does not track users across apps or websites and does
not use an advertising identifier.

**Data linked to the user:** Yes, for all four types below.

**Purposes:** App Functionality for all four.

| Data type | Collected | Linked | Tracking | Purpose |
| --- | --- | --- | --- | --- |
| Name | Yes | Yes | No | App Functionality |
| Email Address | Yes | Yes | No | App Functionality |
| User ID | Yes | Yes | No | App Functionality |
| Other User Content (attendance records) | Yes | Yes | No | App Functionality |

Do not declare Analytics, Advertising, Purchases, Location, Contacts, Health,
Financial Info, Browsing History, Search History, Diagnostics, Device ID or
Photos. The app does not use them.

## Reviewer notes template

```text
Demo account
Email: PLACEHOLDER_REVIEWER_EMAIL
Password: PLACEHOLDER_REVIEWER_PASSWORD
Program join code (if the account is not already on the roster): PLACEHOLDER_JOIN_CODE

How to review
1. Sign in with the demo account above.
2. The Home screen shows the next event and the program's attendance summary.
3. Open Check-in. Enter the 8-character code from the demo details, or use Scan QR to open the camera and scan a code. The demo code is valid only while the review event's check-in window is open; if it has closed, contact PLACEHOLDER_SUPPORT_EMAIL and we will extend it.
4. Open Attendance to see the roll and Calendar to see events.
5. Open Account → Privacy to reach the account-deletion control.

Notes
- The iOS build uses email and password only. Google sign-in is available on the website but is intentionally hidden in the native app at 1.0.0.
- Account deletion removes the sign-in account and profile details. Attendance already recorded stays de-identified under “Deleted account,” because it is a school record. A program with no other director is archived rather than deleted.
- Camera access is used only to scan attendance QR codes.
- No purchase or subscription is required.
```

## Screenshot shot list

Capture on the required iPhone display sizes in App Store Connect (currently a
6.9-inch iPhone set; add 6.5-inch if the account asks for it). Use real app data,
not mockups, and keep the status bar clean.

1. **Sign in** — brand-green stage, app icon, email/password form, “Forgot
   password?” visible.
2. **Home** — next event, attendance summary and the student's program.
3. **Check-in** — the Scan QR / Enter code choice with the camera well visible.
4. **Live check-in (staff)** — full-screen QR code and short entry code for the
   room.
5. **Attendance roll** — a real roster with present/late/excused/absent states
   and the save control.
6. **Calendar or Absences** — an event list or a pending absence request,
   showing the program's real schedule and workflow.

Avoid screenshots that show a real student's name, email, attendance or absence
details. Use the review/demo program and fictional or redacted roster names.

## What not to claim

- Do not claim offline use, push notifications, Sign in with Apple or iPad
  support; none ship in 1.0.0. Native ML Kit scanning does ship on iPhone.
- Do not claim district endorsement or official school ownership. The app is an
  independent tool used by school programs.
- Do not describe attendance deletion as complete: attendance is retained
  de-identified, and the listing/privacy answers must say so.
