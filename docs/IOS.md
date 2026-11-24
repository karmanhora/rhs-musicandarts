# iOS and TestFlight

This is the release guide for the Capacitor iOS app. The native shell, URL
scheme and camera permission are already set up; this document covers building,
signing, uploading and the manual settings that live outside the repository.

## What ships

- The bundled web build from `dist/`; there is no `server.url`.
- App id `org.rhsattendance.app`, display name `RHS Music & Arts`.
- iPhone only, portrait only, minimum iOS 15.0 (Capacitor 8's floor).
- Marketing version `1.0.0`, build `1`.
- The real app icon rendered from `public/logo.svg`, with no alpha channel.
- A solid brand-green launch screen, so there is no white flash.
- `PrivacyInfo.xcprivacy` in the app target: no tracking; name, email, user ID
  and attendance/user content collected for app functionality and linked to the
  user.
- `ITSAppUsesNonExemptEncryption = false`.
- Email/password auth only on iOS by default. Google sign-in is hidden behind
  `NATIVE_GOOGLE_SIGNIN` in `src/lib/nativeAuth.ts`.

## Prerequisites

- Node 22+ and npm.
- Xcode with an iOS SDK that supports iOS 15.0+.
- An Apple Developer team with the `org.rhsattendance.app` bundle id.
- The project uses Swift Package Manager (`ios/App/CapApp-SPM`). There is no
  Podfile and `pod install` is not part of this build.

## Install and build

From the repository root:

```bash
npm install
npm run typecheck
npm run build
npx cap sync ios
npx cap open ios
```

`npm run cap:sync` runs the production build and sync in one step. `npm run
cap:ios` opens Xcode. After any change to `src/`, `capacitor.config.ts` or a
Capacitor plugin, rerun the build and sync before archiving.

## Signing

In Xcode:

1. Select the **App** project, then the **App** target.
2. Open **Signing & Capabilities**.
3. Choose your Team. Keep **Automatically manage signing** on.
4. Confirm the bundle identifier is `org.rhsattendance.app`.
5. If Xcode reports a provisioning conflict, create/download the matching App ID
   and provisioning profile in the Apple Developer portal; do not change the
   bundle id without updating Supabase's redirect configuration too.

The repository intentionally has no team id or signing certificate checked in.

## Supabase redirect URL

In Supabase → Authentication → URL Configuration → Redirect URLs, keep:

```text
org.rhsattendance.app://auth-callback
```

That exact value is registered by `src/lib/nativeAuth.ts` and in
`ios/App/App/Info.plist`. If it is missing, Supabase replaces the redirect with
the site URL and the app never receives the session after a confirmation or
password-reset email.

The iOS app uses a custom scheme, not a universal link. No Associated Domains
capability is required.

## Versioning and upload

1. Set `MARKETING_VERSION` (for example `1.0.0`) and increment
   `CURRENT_PROJECT_VERSION` for every upload in Xcode's target build settings.
   The values in `ios/App/App.xcodeproj/project.pbxproj` are the source used by
   `Info.plist`; App Store Connect rejects a repeated build number.
2. In App Store Connect, create the app record with bundle id
   `org.rhsattendance.app`. The SKU is internal to your account.
3. In Xcode choose **Any iOS Device (arm64)**, then **Product → Archive**.
4. In Organizer choose **Distribute App → App Store Connect → Upload**.
5. Wait for processing, answer export compliance (the app already declares
   `ITSAppUsesNonExemptEncryption = false`), then assign the build to TestFlight.
6. Complete **App Privacy** using the answers in
   [APP_STORE_LISTING.md](APP_STORE_LISTING.md). They must match
   `ios/App/App/PrivacyInfo.xcprivacy`.

Internal testing does not need a review. External TestFlight testing and App
Store submission do.

## Google sign-in toggle

`src/lib/nativeAuth.ts` exports:

```ts
export const NATIVE_GOOGLE_SIGNIN = false;
```

The default is deliberate: Apple guideline 4.8 expects a native app that offers
a third-party login to offer an equivalent privacy-preserving option. Email and
password remain available. Flipping the flag to `true` restores the existing
Google button and privacy note on iOS; do not do that without also deciding how
the app satisfies guideline 4.8 (for example by adding Sign in with Apple) and
re-testing the OAuth browser handoff.

Web Google sign-in is unaffected by this flag.

## Known limitations at 1.0.0

- **QR scanning uses the web camera path inside WKWebView.** The ML Kit plugin
  supports Capacitor 8, but its iOS package is CocoaPods-only and this project
  uses SPM. Adding it requires a project-wide move to CocoaPods; that was not
  done in this release. The camera element is explicitly inline (`playsinline`),
  square and bounded as a safe fallback.
- **No Sign in with Apple.** Apple sign-in was not built.
- **No push notifications.** Email digests and in-app notifications exist; APNs
  does not.
- **No offline mode.** The app needs a network connection for Supabase.
- **Account deletion keeps de-identified attendance.** Deleting an account
  removes the sign-in account and profile details, keeps attendance under
  “Deleted account,” and archives a program where the person was the only
  director. This is school-record behavior, not a bug.
- **iPhone only, portrait only.** iPad is not a target at 1.0.0.
- **The keyboard is native-resized, not separately tested on every device.**
  The default layout fits a 390x844 iPhone; a very short device with the keyboard
  open may still scroll.

## Verification status

The release checks used in this pass are:

```bash
npm run typecheck
npm run build
npx cap sync ios
```

The QA suite, Playwright, the simulator and screenshots were deliberately not
run in this pass. They remain required before an external TestFlight group or
App Store submission if behavior changed after this document was written.
