# Browser support

What this app is built against, what it actually degrades to, and what a visitor
on an unsupported browser sees instead of the app. The `browserslist` field in
`package.json` is the build target; this file is the honest statement of what
each feature *needs*, which is sometimes newer than that list.

Measured against the production bundle (`npm run build`), 2026-10-12.

## The support floor

| Target | Minimum | Why that number |
| --- | --- | --- |
| Chrome / Edge | last 2 versions | Auto-updating; "last 2" is the whole school fleet within a week |
| Firefox | last 2 versions | Auto-updating |
| Safari (macOS) | 15.4 | Tailwind v4's `@property`-based token layer, `color-mix()`, and `dvh` units |
| iOS / iPadOS Safari | **15.4** | Same, plus `env(safe-area-inset-*)` behaviour on standalone PWAs |
| Chrome on Android | 100+ | `color-mix()` and `@property` land at 111; 100 is the oldest that still renders correctly (see below) |
| Samsung Internet | 16+ | Chromium 92 core; renders, with cosmetic differences |
| ChromeOS Chrome | whatever the managed Chromebook runs | Managed ChromeOS is never more than a few majors behind; the floor is Safari 15.4 in practice |

## What the shipped CSS actually requires

Counted in `dist/assets/index-*.css` after a production build:

| Feature | Uses | Oldest engine that parses it | If it is missing |
| --- | --- | --- | --- |
| `@property` | 48 | Chrome/Edge 85, Safari 16.4, Firefox 128 | Tokens still resolve; **transitions on them snap** instead of animating. Nothing breaks. |
| `color-mix()` | 35 | Chrome 111, Safari 16.2, Firefox 113 | `--cue-stage`'s wash and the leaf/gold tints lose their colour and a few surfaces go **flat or transparent**. This is the real floor: it is why Safari 15.4 is listed as the *build* target but 16.2 is the true styling minimum. |
| `@layer` | 5 | Chrome 99, Safari 15.4, Firefox 97 | Cascade order is lost, so utility and base rules collide. The whole layout is affected. |
| `dvh` | 8 | Chrome 108, Safari 15.4, Firefox 101 | `height: 100vh` from the line before it applies instead. On iOS the bottom bar overlaps the last row. Minor. |
| `:is()` | 2 | Chrome 88, Safari 14, Firefox 78 | Two selectors drop out. Cosmetic. |
| `backdrop-filter` | 2 | Chrome 76, Safari 9, Firefox 103 | The sheet scrim is a flat `rgb(0 0 0 / 50%)` instead. Cosmetic. |
| view transitions | 5 | Chrome 111, Safari 18, Firefox — | Route and tab changes are **instant**. This is the designed fallback: `docs/MOTION.md` says these are enhancements, and `viewTransition` on a `NavLink` is ignored when unsupported. |
| `text-wrap: balance` | 1 | Chrome 114, Safari 17.5 | The landing headline breaks where it always would. Cosmetic. |
| `oklch`, `:has()`, `@container`, `aspect-ratio`, `svh` | 0 | — | Not used. Do not add them without updating this table. |

## What the shipped JavaScript requires

| Feature | Where | Fallback |
| --- | --- | --- |
| ES modules | every script | `nomodule` fallback page (see below) |
| `ResizeObserver` | `NotesField` | The note field never refits its calm pockets; it still draws and still stops on teardown. Guarded with `typeof`. |
| `requestIdleCallback` | `NotesField` | `setTimeout(…, 250)` — the note field starts 250 ms later. |
| `IntersectionObserver` | `NotesField` | The loop runs while the tab is visible, including when the hero is scrolled away. |
| `navigator.gpu` | `createEngine.ts` | Whole note field falls back to the Canvas2D engine; if that is unavailable too, the landing page renders with no note field at all (`?notes=off` is the same shape). |
| `navigator.clipboard` | Roster join code | The copy button reports failure through the toast; the code is still selectable text. |
| `navigator.vibrate` | `lib/motion.ts` | No-op. Haptics are never the only signal. |
| `getUserMedia` (camera) | `QrScanner` | The scanner shows a plain-language message and the **type-the-code** pane stays available. |
| `requestFullscreen` | `FullScreenCheckIn` (classroom display) | Guarded with `typeof`; if it is missing or refused, the display still fills the viewport as a plain overlay, and Escape still exits. |
| `navigator.onLine` | `AppShell` | Treated as online; the offline banner simply never appears. |
| `localStorage` | theme, remembered program, Supabase session | Every read and write is inside `try`/`catch`. Private mode degrades to a session-only sign-in and the OS theme preference. |
| `structuredClone`, service workers, File System Access | not used | — |

No service worker is registered, so there is no offline cache to go stale and
nothing to unregister. Offline shows the app shell's banner and lets check-in
fail loudly rather than silently.

## What an unsupported browser sees

Three fallbacks live at the foot of `index.html`, all styled inline so they work
without the bundle's stylesheet:

1. **JavaScript off** → `<noscript>`: "Redmond High School Attendance needs
   JavaScript", plus the paper-record route.
2. **Too old for ES modules** (any browser before ~2018) → `<script nomodule>`:
   names the browsers that work, and points at Chromebook Settings → Check for
   updates.
3. **Runs but never mounts** (stale cache, blocked chunk, a runtime error before
   first paint) → a 10-second boot check plus `error` handling, which renders the
   same panel with "reload, then check your connection".

None of the three claims the visitor's browser is broken when the cause may be
the network, and none of them is a dead end: all three name a human to ask.

## Known honest gaps

- **No support below Safari 15.4.** A visitor on iOS 14 gets the `nomodule` page
  (iOS 14 has modules, so they get the app and the `color-mix()` surfaces render
  flat). Nothing is hidden from them; some tints are wrong.
- **Safari 15.4–16.1** is in the build target but below the styling floor:
  `color-mix()` surfaces render flat. The app is usable; it looks unfinished.
- **Firefox cannot do view transitions** as of this writing, so route changes
  there are instant by design.
- **WebGPU is Chrome/Edge and Safari 26+ only.** Firefox and everything else get
  the Canvas2D engine, which draws the same field at the same speed and is the
  path the guard tests exercise (`?notes=canvas`).
- **The contact to escalate to does not exist yet.** `docs/QA_REPORT.md` lists it
  as a decision for a human: the privacy policy still carries `[CONTACT EMAIL]`
  and the fallback pages say "your director or the RHS main office" until a real
  district contact is filled in.
