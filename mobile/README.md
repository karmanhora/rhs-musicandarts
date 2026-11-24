# RHS Music & Arts — native iOS app

A SwiftUI application for Redmond High School's music and arts programs, built
alongside the existing website and Capacitor app. It talks to the **same**
Supabase project, database, auth and RLS policies — there is no second backend.

**Status: Phase 1 — foundation only.** There is no sign-in form, no attendance
query and no check-in yet. What exists is a runnable app target, a validated
configuration, a Supabase client, session restoration, role-aware navigation and
placeholder screens.

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
| Email/password sign-in and registration | Phase 2 |
| Email confirmation (`verifyOtp`, length is the project's OTP length) | Phase 2 |
| Password recovery (deep link, then `updateUser`) | Phase 2 |
| Google OAuth (system browser + custom-scheme return) | Phase 2 |
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
Supabase and an Apple Developer entitlement and key. Neither exists today. That
is a product decision, not something this foundation silently chooses.

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

**The app does not decide a role from a local setting.** `RoleResolving` is a
Phase 1 placeholder (`PendingRoleResolver`) that returns no answer, so a
signed-in account stays on "Checking your access" rather than being assumed a
student. Phase 2 resolves it from the backend: memberships and staff capability
through `has_permission()` / `my_permissions()` (migration 029), because a person
can be a student in one program and staff in another. The program switcher comes
with it.

## Design system

`Core/DesignSystem/`: one palette (deep green, warm cream, measured secondary
ink, one attention colour), four SF Pro type roles, one spacing scale, a 44pt
minimum target, and `Haptics`. Light and dark come from dynamic colours, so no
view branches on the appearance. Grouping is done with rules and native lists,
not a card per element; there are no gradients, no React screens and no
`WKWebView`.

`Resources/Assets.xcassets` holds the accent colour, the brand green, the launch
background and an **empty** app-icon slot. The real icon artwork is Phase 2.

## Verification (Phase 1)

Recorded from the run that produced this folder:

- `xcodebuild … build` — succeeded (Simulator, Debug).
- `xcodebuild … test` — configuration, navigation and app-state suites passed.
- App installed and launched on the iPhone 17e Simulator, including the
  `-RHSPreviewConfiguration -RHSDemoRole` navigation check.
- `npm run typecheck` and `npm run build` at the repository root — unchanged and
  passing; the website was not modified.

The scanner is camera-only, so a real scan cannot be verified in the Simulator —
and it does not exist yet in any case. No physical-device run was performed.

## What is deliberately not here

No `WKWebView`, no copied dashboard layout, no new backend, no migration, no
push notifications, no offline cache, no App Store record, and no change to the
website, the Capacitor project or the Supabase project.
