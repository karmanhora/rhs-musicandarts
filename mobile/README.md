# RHS Music & Arts — native iOS app

A SwiftUI application for Redmond High School's music and arts programs, built
alongside the existing website and Capacitor app. It talks to the **same**
Supabase project, database, auth and RLS policies — there is no second backend.

**Status: Phase 2 in progress.** Email/password sign-in and registration, email
confirmation, password recovery, session restoration and sign-out are
implemented against the existing Supabase identity. Signing in resolves the
person's own profile, active memberships and `is_program_admin()` to choose the
student or staff shell — or to say, honestly, that no roster includes them.
Attendance, check-in, the join flow and teacher-invitation redemption are not
built yet; every attendance screen is still a labelled placeholder.

| | |
| --- | --- |
| Interface | SwiftUI, iPhone, portrait |
| Language | Swift 6 (language mode), built with Xcode 27.2 / Swift 6.4.2 |
| Minimum iOS | 17.0 |
| Backend | The existing Supabase project (`sjiswrvhrnrxkrfhfjrp`) |
| Auth | Supabase Auth (identity = `profiles.auth_user_id`) |
| Package | [supabase-swift](https://github.com/supabase/supabase-swift) 2.55+ via SPM |

The Capacitor app in `../ios` is untouched and still ships as
`org.rhsattendance.app`. Nothing in this folder is part of that Xcode project.

## Setup

Requires Xcode with the iOS 17 SDK or later. No CocoaPods, no Node, no build
script: open the project and build.

```bash
cp mobile/Config/Local.example.xcconfig mobile/Config/Local.xcconfig
# edit that file with the same two public values the website uses in .env.local:
#   SUPABASE_URL       (Dashboard → Project Settings → API)
#   SUPABASE_ANON_KEY  (the anon / publishable key)
```

`Local.xcconfig` is gitignored. In xcconfig syntax `//` starts a comment, so the
URL keeps Xcode's empty-substitution escape: `https:/$()/project.supabase.co`.

A Debug build may point at a loopback Supabase stack (`http://127.0.0.1:54321`);
`AppConfiguration` accepts plain http only for a loopback host, and
`Info.plist` carries `NSAllowsLocalNetworking` for that case. Remote hosts still
require https.

Both values are public by design: the publishable key grants nothing on its own
because every table is behind RLS. **A service-role key is refused at launch** —
`AppConfiguration` decodes the key's JWT role and rejects anything that is not
`anon`, and rejects non-publishable strings outright.

Then:

```bash
open mobile/RHSApp.xcodeproj      # scheme: RHSApp
```

## Build, test, run

```bash
# Build for the Simulator
xcodebuild -project mobile/RHSApp.xcodeproj -scheme RHSApp \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17e' \
  build CODE_SIGNING_ALLOWED=NO

# Unit tests (configuration + navigation + app state)
xcodebuild -project mobile/RHSApp.xcodeproj -scheme RHSApp \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17e' test

# Install and launch
xcrun simctl install booted "$(xcodebuild -project mobile/RHSApp.xcodeproj -scheme RHSApp -configuration Debug -sdk iphonesimulator -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR/{print $2; exit}')/RHSApp.app"
xcrun simctl launch booted org.rhsattendance.native.dev
```

### Showing the navigation without real credentials

A Debug build accepts two launch arguments, and a Release build ignores both:

```bash
xcrun simctl launch booted org.rhsattendance.native.dev \
  -RHSPreviewConfiguration -RHSDemoRole teacher   # or student
```

- `-RHSPreviewConfiguration` uses a **fake** publishable key and the host
  `preview.supabase.co`. It authenticates nothing and contacts no project. It
  exists so the shell can be seen before `Local.xcconfig` is filled in.
- `-RHSDemoRole` opens that role's tab bar in a **demo session**: no Supabase
  account is signed in, nothing is written or read, and Profile labels it as a
  preview. Without it, a signed-in account waits on the "Checking your access"
  screen — that is deliberate (see *Roles*).

Prior to any of this, the app shows its configuration screen. With real values
and no session, it shows the signed-out screen and the configured Supabase host.

## Configuration model

| Setting | Source | Development | Production |
| --- | --- | --- | --- |
| `PRODUCT_BUNDLE_IDENTIFIER` | `Config/Dev.xcconfig` / `Prod.xcconfig` | `org.rhsattendance.native.dev` | `org.rhsattendance.native` |
| `RHS_BUILD_ENVIRONMENT` | same | `development` | `production` |
| Display name | `RHS_APP_DISPLAY_NAME` | `RHS Music & Arts Dev` | `RHS Music & Arts` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | `Config/Local.xcconfig` (`#include?`) | from your local file | from your local file |
| Auth callback | `Config/Info.plist` (`CFBundleURLSchemes` = bundle id) | `org.rhsattendance.native.dev://auth-callback` | `org.rhsattendance.native://auth-callback` |

`AppConfiguration.load()` reads the resolved Info.plist, so a missing value
(including an unexpanded `$(…)` or a `YOUR-…` placeholder) is an error with a
message naming the file to fix. It is never a silent fallback to production or
to an unrelated project.

The auth callback URL is derived from the bundle identifier, which is why the
development app and the production app cannot consume each other's links.

## Supabase integration

- `Core/Supabase/SupabaseContainer.swift` is the only place a `SupabaseClient`
  is created. It receives `AppConfiguration`; nothing hardcodes a URL or key.
- Session storage is the SDK's Apple-platform default, **`KeychainLocalStorage`**.
  Sessions survive relaunch in the Keychain, and the SDK's default `autoRefresh`
  renews tokens. The app stores no token of its own.
- `Core/Authentication/AuthSessionService.swift` restores the persisted session
  (`auth.currentSession`, then `auth.session` for a validated/refreshed value)
  and signs out. A refused refresh surfaces as a failure screen, not a fake
  sign-out.
- Dependency injection lives in `App/AppDependencies.swift`, the composition
  root. `AuthSessionProviding` and `RoleResolving` are protocols so tests and
  future repositories receive implementations rather than globals.
- No table, column or RPC is declared in Phase 1. When repositories arrive, they
  must use the schema in `../supabase/migrations` — nothing is invented, and no
  migration is added by this app.

## Auth architecture (what Phase 2 implements)

Supabase Auth is the only identity provider, matching the website. Every method
must produce the same `auth.users` identity, which the database resolves:
`auth.uid()` → `profiles.auth_user_id` (migration 021) → `current_profile_id()`
→ every RLS policy and RPC.

| Flow | Status |
| --- | --- |
| Session restoration + token refresh | Implemented |
| Sign-out | Implemented |
| Email/password sign-in and registration | Implemented |
| Email confirmation (link callback or the emailed code, via `verifyOTP`) | Implemented |
| Password recovery (link callback, then a new password) | Implemented |
| Google OAuth (system browser + custom-scheme return) | Not built — see below |
| Sign in with Apple | Not built — see below |
| Account linking | **Not implemented, deliberately** |

Existing rules the native app must preserve:

- **No signup trigger.** `profiles` is created by `join_program()` on somebody's
  first program; re-adding an `auth.users` trigger would create a second profile
  per account. The native app must never create a profile itself.
- **Student signup** records the audience (`set_signup_account_type`) but does
  not grant anything. Students join with a director's join code.
- **Teacher access** needs a redeemed invitation code
  (`redeem_teacher_invitation()`); a declared teacher is not a verified one.
- **Program membership** and roles live on `memberships`, never on `profiles`.
- **No automatic account merging.** Matching email addresses are not proof of
  ownership. Supabase Auth's own verified identity-linking is the only path, and
  the website's approach must be inspected before anything is added.

### Sign in with Apple

App Store guideline 4.8 requires an equivalent privacy-preserving option when a
third-party login (Google) is offered. The Capacitor build avoids this by
shipping email/password only (`docs/IOS.md`). If the native app offers Google, it
must also offer Sign in with Apple, with the Apple provider configured in
Supabase and an Apple Developer entitlement and key. Neither exists today, and
neither redirect URL is registered in Supabase yet — which is why Phase 2 ships
email/password only. That is a product decision, not something this code
silently chooses.

### Required external configuration (not applied)

Before any OAuth or email link can return to the native app, add its redirect
URLs in **Supabase → Authentication → URL Configuration → Redirect URLs**:

```text
org.rhsattendance.native.dev://auth-callback
org.rhsattendance.native://auth-callback
```

Keep every existing redirect (including `org.rhsattendance.app://auth-callback`
for the Capacitor app) and the current Site URL. Nothing in this phase changes
the Supabase project, and no redirect has been added.

## Roles and navigation

`AppRole` decides which five-tab shell opens. It is presentation only — the
server still authorises every read and write.

| Student | Staff |
| --- | --- |
| Home | Dashboard |
| Events | Events |
| Check-in | Scanner |
| Attendance | Roster |
| Profile | Profile |

**The app does not decide a role from a local setting.** `SupabaseRoleResolver`
asks the backend: the person's own profile (`profiles.auth_user_id`), their
active `memberships` roles, and `is_program_admin()`. Any staff system role
(`director`, `secretary`, `section_leader`) or a system administrator opens the
staff shell; student memberships open the student shell; no active membership
shows "You're not on a program yet" with no form the backend would refuse.

This is the first slice of the capability layer, not the whole of it. Custom
roles, section-scoped staff and the program switcher need `my_permissions()` per
program (migration 029) and arrive with the program screens; until then a
custom-role-only staff member sees the narrower student shell. A person who is
staff in one program and a student in another is not yet switched per program.

## Design system

`Core/DesignSystem/`: one palette (deep green, warm cream, measured secondary
ink, one attention colour), four SF Pro type roles, one spacing scale, a 44pt
minimum target, and `Haptics`. Light and dark come from dynamic colours, so no
view branches on the appearance. Grouping is done with rules and native lists,
not a card per element; there are no gradients, no React screens and no
`WKWebView`.

`Resources/Assets.xcassets` holds the accent colour, the brand green, the launch
background and an **empty** app-icon slot. The real icon artwork is Phase 2.

## Verification

Recorded from the runs that produced this folder:

- `xcodebuild … test` — 43 unit tests passed: configuration and key safety,
  navigation, app state, callback parsing and role mapping.
- App built and launched on the iPhone 17e Simulator with the real local config;
  the sign-in screen was captured (`DerivedData/screenshots/auth-local.png`,
  gitignored), as were the student and staff shells via the Debug demo session.
- **Live auth against the local Supabase stack** (`supabase --workdir .devstack
  start`, values from `.env.local`): a real sign-up produced a session, sign-out
  succeeded, and the same email and password signed back in. With confirmations
  temporarily enabled, a second sign-up required confirmation; its email was
  read from the local Mailpit inbox, the confirmation link was verified, and
  password sign-in followed. Both checks ran through `SupabaseAuthService`
  inside the app's test host. Local-only test users remain in the dev stack.
- `npm run typecheck`, `npm run build` and `npm run test:qa` at the repository
  root — passing; the website was not modified.

**Not verified:** the hosted project's auth. The local stack's default
confirmation template sends a link, not a numeric code, so the six-digit
`confirmEmail` path and the app's own deep-link handling were not exercised end
to end (the link's token was verified through the SDK). Google and Apple sign-in
remain unbuilt. No physical-device run was performed, and the scanner
(camera-only) does not exist yet.

## What is deliberately not here

No `WKWebView`, no copied dashboard layout, no new backend, no migration, no
push notifications, no offline cache, no App Store record, and no change to the
website, the Capacitor project or the Supabase project.
