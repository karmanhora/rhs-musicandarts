# Production security headers

The site is a static Vite build served by Vercel, so HTTP response headers are
configured in [`vercel.json`](../vercel.json) and apply to **every** route —
the SPA rewrite means `/calendar`, `/checkin?token=…` and `/privacy` all get the
same header set as `/`.

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | A browser must not second-guess a file's `Content-Type`. Uploaded avatar objects are served by Supabase, not this origin, but this closes MIME sniffing on the app's own scripts and assets. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Full paths stay on this origin. Cross-origin requests — Supabase REST/Auth/Storage, and the "Add to Google Calendar" link — receive only the origin, so a check-in token in a URL is not leaked in a `Referer` header. |
| `X-Frame-Options` | `DENY` | The app is never embedded in another site. This is the pre-CSP equivalent of `frame-ancestors 'none'` and both are set: older browsers read this one, modern ones read the CSP directive. |
| `Permissions-Policy` | `camera=(self), microphone=(), geolocation=(), payment=(), usb=()` | QR attendance needs the camera on this origin only. Nothing here needs a microphone, location, payment or USB device, so those features are denied outright. |
| `Content-Security-Policy` | see below | Restricts scripts, connections, images and fonts to what the app actually uses. |
| `Strict-Transport-Security` | *(not set here)* | Vercel already sends `max-age=63072000` on every response. Defining it again in `vercel.json` would put two HSTS values on one response for no gain, so it is deliberately left to the platform. `npm run check:headers -- --url https://rhsattendance.org` verifies it is still present. |

## The CSP, source by source

```
default-src 'self';
script-src 'self' 'sha256-ZA06yQvIItYbO7+M5xWyx28Y94tvKzNLJZj//wo/xZc='
                     'sha256-lMxn7PtmlmKIAq0k0Mgcr0uJMjDjcwgU3ehbzNgRdyo='
                     'sha256-YabaTZVGsMPLF74Q/RS1XIFCfPfABBxaezLEEdAhjBQ=';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://*.supabase.co;
font-src 'self';
connect-src 'self' https://sjiswrvhrnrxkrfhfjrp.supabase.co
                   wss://sjiswrvhrnrxkrfhfjrp.supabase.co;
media-src 'self';
worker-src 'self';
manifest-src 'self';
frame-src 'none';
frame-ancestors 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
upgrade-insecure-requests
```

- **`script-src` has no `'unsafe-inline'`.** The three inline scripts at the foot
  of [`index.html`](../index.html) are allowed by SHA-256 instead: the theme
  flash guard, the pre-ES-module fallback, and the boot check. Everything else is
  a bundled module under `/assets`, which `'self'` covers. There is no
  `'unsafe-eval'`: React 19, `html5-qrcode`, `qrcode.react`, `lucide-react` and
  the WGSL/WebGPU path do not evaluate strings at runtime, and a test load of
  every screen found no eval violation.
- **`style-src` needs `'unsafe-inline'`.** React sets `style={{ … }}` attributes
  in a handful of components (progress fills, avatar sizes, layout values) and
  the boot fallback in `index.html` carries a `<style>` block. A style nonce
  would not cover React's inline attributes, so this is the honest minimum;
  inline *styles* are a far smaller risk than inline scripts.
- **`img-src`** allows `data:`/`blob:` (the avatar cropper's preview is a blob
  URL) and `https://*.supabase.co` for signed avatar URLs. The wildcard is for
  Supabase-hosted images only — the private `avatars` bucket on the current
  project, plus legacy `profiles.avatar_url` values written by the old app,
  whose public bucket could live on a different Supabase project. It does not
  allow other image hosts; a legacy URL on a non-Supabase host now falls back to
  initials rather than loading.
- **`font-src 'self'`** is exact: both fonts come from `@fontsource` packages and
  are bundled into `/assets/*.woff2`. There is no Google Fonts request.
- **`connect-src`** names the one Supabase project (`sjiswrvhrnrxkrfhfjrp`).
  Auth, PostgREST, Storage signing, Edge Functions (`functions/v1`) and Realtime
  are all that origin; `wss:` is for Realtime. If `VITE_SUPABASE_URL` ever
  points at a different project, update this directive or the app will look
  empty — that is the intended failure, not a bug.
- **Google Sign-In needs no Google origin in the CSP.** "Continue with Google"
  is `supabase.auth.signInWithOAuth`, which navigates the whole page to
  `https://<project>.supabase.co/auth/v1/authorize?provider=google`, and
  Supabase redirects to Google. Top-level navigation is not restricted by CSP
  (there is no `navigate-to` directive), and no Google script, iframe, font or
  image is loaded by this app. Similarly, the "Add to Google Calendar" link and
  the Instagram links are ordinary navigations, and staff-pasted iCal URLs are
  fetched by the `import-google-calendar` Edge Function server-side, never by
  the browser.
- **`frame-ancestors 'none'` + `X-Frame-Options: DENY`** because nothing embeds
  the app. The installed PWA runs standalone, not in a frame.
- **`form-action 'self'`**: the app's forms are React handlers, not HTML form
  posts; nothing posts to another origin.
- **`base-uri 'self'`, `object-src 'none'`**: neither a `<base>` hijack nor a
  plugin embed is part of this app.

## Updating the CSP

`vercel.json` is plain JSON, so it cannot carry comments — this file is the
comment. Two rules:

1. **Editing an inline script in `index.html` means updating its hash.** Run:

   ```bash
   npm run build && npm run check:headers
   ```

   The check hashes every inline `<script>` in `dist/index.html`, compares it
   with `script-src`, and prints the missing/extra `'sha256-…'` value if they
   disagree. Nothing is deployed by it. (Vite does not minify these classic
   inline scripts, so the source in `index.html` and the built copy hash the
   same.)
2. **Adding a new external service** means adding exactly the origin that
   service needs, with the reason written down here. Do not add `https:` or `*`
   to `default-src`, `script-src` or `connect-src`.

If a new directive turns out to break a flow in production, the safe rollback is
to rename the header to `Content-Security-Policy-Report-Only` (same value) and
redeploy. Browsers then report violations in the console without blocking
anything, and the deployed app keeps working while the policy is corrected.

## Verifying

Local, before deploying:

```bash
npm run build
npm run check:headers
```

This validates the JSON, rejects duplicate/conflicting headers, checks every
required directive and the inline-script hashes, and confirms HSTS is left to
Vercel.

After deploying, verify the actual response — never assume the build proved it:

```bash
curl -sI https://rhsattendance.org/ | grep -iE 'content-security-policy|x-content-type|referrer-policy|x-frame-options|permissions-policy|strict-transport'
npm run check:headers -- --url https://rhsattendance.org
```

Or in browser DevTools: **Network → the document request → Response Headers**
(reload with the request selected; a cached document may not show a fresh header
set). **Console** should show no `Content-Security-Policy` errors. A
`securitypolicyviolation` also appears in the Console with the blocked URI and
directive, which is the fastest way to see what a new feature needs.

Security scanners: [securityheaders.com](https://securityheaders.com/?q=https%3A%2F%2Frhsattendance.org)
and [Mozilla Observatory](https://developer.mozilla.org/en-US/observatory/analyze?url=https%3A%2F%2Frhsattendance.org)
will grade the live response. Both penalise `style-src 'unsafe-inline'` and
`img-src https://*.supabase.co`; those are deliberate, documented trade-offs, not
oversights.

### What was actually tested

A production build was served with these exact headers and walked in Chromium
with the QA fixtures (`e2e/support/mocks.mjs`): `/`, `/sign-in`, `/sign-up`,
`/forgot-password`, `/privacy`, `/terms`, `/checkin`, and the signed-in routes
`/calendar`, `/attendance`, `/roster`, `/me`, `/analytics`, `/roles`,
`/settings`, `/join`, `/new-program`, `/teacher`, plus the Google Calendar
import sheet. No CSP violation, page error or render failure occurred; the
inline theme/boot scripts ran, self-hosted fonts and the logo loaded, blob
previews loaded, and an injected inline script was blocked (proving the policy
is enforced, not merely ignored). "Continue with Google" navigated to the
Supabase authorize endpoint as expected.

## Risks that remain

- `style-src 'unsafe-inline'` weakens style-injection protection. It does not
  allow script execution.
- The CSP allows all of `https://*.supabase.co` for **images only**. A
  compromised or hostile Supabase-hosted image URL could be embedded; no script
  can run from it.
- `img-src` no longer loads legacy avatars from non-Supabase hosts; those
  profiles show initials.
- A CSP does not protect against a compromised build or a malicious dependency
  bundled into `/assets` — `script-src 'self'` trusts the app's own bundle.
- These headers apply to Vercel deployments only. `npm run dev` and
  `npm run preview` are unaffected, so CSP regressions are only caught by the
  manual harness above (or by a future automated proxy).
