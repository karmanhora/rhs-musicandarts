# iOS and TestFlight

This is the release guide for the Capacitor iOS app. The native shell, ML Kit
scanner, URL scheme and camera permission are already set up; this document
covers building, signing, uploading and the manual settings that live outside
the repository.

## What ships

- The bundled web build from `dist/`; there is no `server.url`.
- App id `org.rhsattendance.app`, display name `RHS Music & Arts`.
- iPhone only, portrait only, minimum iOS 15.5 (ML Kit's floor).
- Marketing version `1.0.0`, build `1`.
- The real app icon rendered from `public/logo.svg`, with no alpha channel.
- A solid brand-green launch screen, so there is no white flash.
- `PrivacyInfo.xcprivacy` in the app target: no tracking; name, email, user ID
  and attendance/user content collected for app functionality and linked to the
  user.
- `ITSAppUsesNonExemptEncryption = false`.
- Email/password auth only on iOS by default. Google sign-in is hidden behind
  `NATIVE_GOOGLE_SIGNIN` in `src/lib/nativeAuth.ts`.
- The iOS camera button opens ML Kit's native barcode scanner. The website keeps
  the `html5-qrcode` path.

## Prerequisites

- Node 22+ and npm.
- Xcode with an iOS SDK that supports iOS 15.5+.
- An Apple Developer team with the `org.rhsattendance.app` bundle id.
- CocoaPods. The project uses `ios/App/Podfile` and
  `ios/App/App.xcworkspace`; ML Kit does not publish an SPM package.
- Run `pod install` from `ios/App` once after cloning, or let `npx cap sync ios`
  run it for you. Use `LC_ALL=en_US.UTF-8` if CocoaPods reports a locale error.

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
cap:ios` opens the CocoaPods workspace. After any change to `src/`,
`capacitor.config.ts` or a Capacitor plugin, rerun the build and sync before
archiving.

## Running it

The reliable way to exercise the ML Kit scanner is a physical iPhone. Open the
workspace with `npx cap open ios`, choose the **App** scheme and your iPhone,
then Run. The camera permission prompt appears the first time you tap **Open
camera scanner**.

The iOS Simulator can compile the x86_64 slice:

```bash
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  ARCHS=x86_64 ONLY_ACTIVE_ARCH=NO build CODE_SIGNING_ALLOWED=NO
```

That binary cannot be installed on an Apple Silicon simulator: ML Kit ships
device arm64 and simulator x86_64 slices, but no arm64-simulator slice. The
simulator therefore reports that the app needs to be updated. Use a physical
iPhone (or an Intel Mac's simulator) to run the scanner. The ordinary
`npx cap run ios` simulator path will fail at the same link/installation step.

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

- **The native scanner cannot run in the Apple Silicon Simulator.** ML Kit's
  binaries have no arm64-simulator slice. The x86_64 simulator build succeeds,
  but the arm64-only simulator will not install it. Use a physical iPhone for a
  real scan.
- **No Sign in with Apple.** Apple sign-in was not built.
- **No push notifications.** Email digests and in-app notifications exist; APNs
  does not.
- **No offline mode.** The app needs a network connection for Supabase.
- **Account deletion keeps de-identified attendance.** Deleting an account
  removes the sign-in account and profile details, keeps attendance under
  “Deleted account,” and archives a program where the person was the only
  director. This is school-record behavior, not a bug.
- **iPhone only, portrait only.** iPad is not a target at 1.0.0.
- **The keyboard is native-resized and scrolls the focused field into view.**
  The shell listens for the iOS keyboard show events and centers the focused
  control after the body resize. This is covered by the simulator build and the
  auth layout checks, not by every physical device size.

## Verification status

The release checks run after the ML Kit migration were:

```bash
npm run typecheck
npm run build
npx cap sync ios
npm run test:qa
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  build CODE_SIGNING_ALLOWED=NO
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  ARCHS=x86_64 ONLY_ACTIVE_ARCH=NO \
  build CODE_SIGNING_ALLOWED=NO
```

The QA suite passed all 101 tests, the device and x86_64 simulator builds
succeeded, and the local database run applied 57 migrations with 28 suites
passing (one legacy-schema suite skipped). The built device app declares
iOS 15.5, contains the camera usage description, `PrivacyInfo.xcprivacy`, and
the `BarcodeScannerPlugin` class.

The simulator binary could not be installed on the Apple Silicon simulator
because ML Kit has no arm64-simulator slice. A real iPhone scan is still
required; screenshots were not part of this pass.

The website fallback was rechecked separately at a 390x844 viewport with a fake
camera after the wrapper change: the inline video was visible, playing, inline
(`playsinline`), non-zero, and did not overflow horizontally.
