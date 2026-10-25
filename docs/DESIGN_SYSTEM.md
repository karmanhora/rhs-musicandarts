# Cue Desk design system

## Direction

Cue Desk treats the app as a rehearsal-room operations tool: event first, status
clearly labeled, and controls large enough to use between cues. Layouts use
asymmetric editorial/operational hierarchy instead of repeated icon-card grids.
The landing page uses a labeled example roster, not a claim that sample
attendance is live.

## Color

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--cue-page` | `#FAF9F4` | `#111713` | Main page background |
| `--cue-panel` | `#FFFFFF` | `#1B231D` | Main panels and cards |
| `--cue-raised` | `#F1F0E9` | `#242E27` | Form groups, secondary surfaces |
| `--cue-ink` | `#20241F` | `#F4F2E9` | Primary text |
| `--cue-muted` | `#575E57` | `#B7C0B8` | Supporting text |
| `--cue-border` | `#D8D9D0` | `#39443B` | Rules and control boundaries |
| `--cue-green` | `#214D35` | `#79AA82` | Primary action, on-time status |
| `--cue-gold` | `#D5A33A` | `#E5B64F` | RHS heritage accent, attention |
| `--cue-late` | `#A74432` | `#F08B73` | Late/error status; always label it |
| `--cue-focus` | `#79520A` | `#F2C761` | Keyboard focus indicator |

Dark surfaces, borders, and text are chosen independently rather than produced
by inverting the light theme. Program-level colors continue to use the existing
`band-*` semantic variables and `applyThemeTokens`; these names are retained to
avoid changing the many existing utility classes or per-program theming.

## Typography

- **Display:** Barlow Condensed, locally bundled Latin subset, weights 600 and
  700. Use `font-display` for event names, section labels, and large counts.
- **Text/UI:** IBM Plex Sans Variable, locally bundled with Unicode subsets.
  Use the `font-sans` default for body text, forms, and roster names.
- Keep body copy comfortably readable; reserve condensed uppercase text for
  short labels and headings, never long instructions or paragraphs.

The font packages are bundled by Vite. No font stylesheet or font file is
requested from a third-party host at runtime.

## Polish references

- **Flighty:** borrow compact status labels, high-visibility countdowns, and a
  clear distinction between current and upcoming states.
- **Strava:** borrow progress that feels tied to a real personal effort, not a
  decorative dashboard percentage.
- **Apple Sports:** borrow the live counter's strong numerals and the way a
  changing score remains readable at a glance.
- **Mandalora Studios** (studiosmandalora.github.io/web): borrow motion
  structure only — masked line reveals for display headings, left-to-right rule
  draws, arrow nudges, and a slow status breathe, all at app-length durations.
  No branding, gradients, glows, custom cursor, or scroll-linked effects are
  borrowed.

These are references for hierarchy and feedback, not assets or copied layouts.

## Shape, spacing, and elevation

- `--radius-control: 10px`: buttons, inputs, compact status surfaces.
- `--radius-panel: 14px`: major panels. Do not round every nested group.
- `--radius-sheet: 18px`: bottom sheets only.
- Prefer Tailwind's 4px spacing scale. Keep 16px minimum page gutters on phones;
  use 24px at larger widths.
- `--elevation-panel` is a quiet 2px lift in light mode and a restrained shadow
  in dark mode. Borders and hierarchy do most of the work.
- Primary touch controls are at least 44px tall. Icon-only controls use an
  accessible name and a 44px square target.

## Shared components

- Use `Button` for actions (`primary`, `secondary`, `accent`, `ghost`, `danger`).
  `loading` communicates an in-flight action; it does not delay the action.
- Use `Card` for a single content group. Prefer a rule or status edge to nesting
  multiple cards.
- Use `Field`, `Input`, `Select`, and `Textarea` so labels, focus, and contrast
  remain consistent.
- Use `Alert` for recoverable errors and explicit status messages. Never rely on
  color alone.
- Use `Skeleton` for loading layouts, `EmptyState` for empty data with a next
  action, and `ProgressRing` with a text value for percentages.
- Use `Sheet` for focused mobile tasks. It supports Escape, focus containment,
  focus restoration, and touch drag dismissal.

## Accessibility

- Visible keyboard focus is required. Keep keyboard operation and semantic
  labels when changing visuals.
- Status colors must be accompanied by text or an icon with an accessible name.
- Avoid truncating essential roster names; long names may wrap in dense views.
- The `prefers-reduced-motion` media query removes movement without removing
  any state change or interaction.

## Avoid

No gradients, glow effects, glass panels, emoji/stock illustrations, scattered
music glyphs, filler welcome copy, or repeated generic feature tiles. The
rehearsal identity comes from the names, schedule, live count, and condensed
instrument-board typography.

## Loading-screen exception: one musical quote

The loading surfaces — the full-screen `Splash` in `src/components/Splash.tsx`
and the route-level `RouteSkeleton` in `src/SignedInApp.tsx` — carry one short
attributed musical line, picked at random per mount from `src/lib/quotes.ts`.
It is a deliberate exception to the "no filler copy" rule above, and it stays
inside these limits:

- **One line, attributed, at most two lines long** on its 384px column. The
  selection rules (verifiable attribution, no lyrics, no copyrighted excerpts)
  are stated in `src/lib/quotes.ts`; the district's music staff are the people
  to approve any addition to the list.
- **Picked once per mount, never on a timer.** Text does not move under a
  reader's eyes, and being random is decoration rather than information —
  nothing in the product depends on which line appears.
- **No motion of its own,** so it needs no reduced-motion branch; the loader
  next to it is the only thing that moves.
- **It holds AA contrast on both surfaces:** 8.88:1 for the sentence and
  5.55–6.17:1 for the gold attribution on the green splash, 6.05–9.36:1 and
  4.81–9.12:1 on the app's page, in light and dark (measured on the rendered
  elements, floor 4.5:1).

## Landing-page exception: the note field

`src/screens/WelcomeScreen.tsx` alone may carry a full-viewport swarm of
notation, drawn by `src/components/notes/`. It is a deliberate, single exception
to the "no scattered music glyphs" rule above; no other screen draws one. It
stays inside these limits:

- **It is decoration, not information.** The canvas is `aria-hidden` with
  `pointer-events: none`, and it carries no text, numbers or state. The page
  reads completely — and works completely — without it.
- **Notes are flat, crisp and slightly varied in opacity.** No gradient, no
  glow, no blur, no shadow, and no glass.
- **Colours come from the palette variables above** (`--cue-gold`,
  `--cue-gold-on-brand`, `--cue-leaf`, `--cue-mint`, `--cue-stage-ink`), resolved
  with `getComputedStyle` and re-read when the theme flips. Nothing is
  hardcoded. Two of the five are near-white tints that would vanish on the cream
  page, so `src/components/notes/palette.ts` mixes those toward `--cue-ink` until
  each clears a visibility floor against `--cue-page`: a note may be faint, but
  it must never be invisible in either theme.
- **Readable pockets.** Elements tagged `data-notes-calm` mark the places a
  reader is working. Inside them notes fall to roughly a fifth of their opacity,
  so no heading, paragraph or control competes with motion. Unused slots stay
  degenerate; up to six are supported.
- **The green hero panel stays opaque.** It is the strongest calm zone there is:
  the field never sits behind the headline or the hero buttons, which keeps those
  at full AA contrast regardless of the animation. Notes are densest in the
  masthead, the margins and the stretches between sections.
- **Reduced motion is a still picture.** One static, sparse frame; no drifting,
  no pointer response, no bursts.
- **It is verified by pixels, not by eye.** `npx vgpu check` validates both
  shaders, and a headless harness renders the real `notes.wgsl` on an adapter and
  asserts on the readback: coverage, palette variety, vertex-shader motion, the
  calm fade, the pointer push, the click burst and its expiry.

## Page treatments (personal background)

Account settings → Preferences offers four page treatments, stored per person in
`profile_preferences.background` (migration 20261025120000). A treatment is one
attribute on `<html>` — `data-background` — that `src/index.css` turns into
`--app-page-color` and `--app-page-image`; `.app-page` on the signed-in shell
paints them. `src/lib/personalization.ts` is the catalogue, and the database's
allow-list mirrors it.

| id | What it is | Where the colour comes from |
| --- | --- | --- |
| `paper` | the shipped page | `--cue-page` |
| `mint` | a green wash behind the panels | `--cue-leaf-soft` |
| `ruled` | 1px rules every 32px | `--cue-line` on `--cue-page` |
| `grid` | a 1px grid every 32px | `--cue-line` on `--cue-page` |

Rules, and the reasons for them:

- **Tokens only.** Each treatment names an existing variable; nothing here adds a
  hex value or a second palette. Both themes follow automatically.
- **No gradient, glow, blur or image.** The two patterns are single-colour lines
  with hard stops from the same `--cue-line` token as every hairline in the app.
  Below a panel it reads as a rule, which is the design system's own vocabulary.
- **Panels stay opaque.** `--cue-panel` is untouched, so a treatment never sits
  behind a name, a form, a roster row or a QR code. Nothing moves under text.
- **There is no "raised" treatment.** `--cue-leaf` (the colour of the page's text
  links) measures 4.47:1 on `--cue-raised`, under AA, so that surface is not
  offered as a page rather than shipped failing.
- **Contrast was measured, not assumed.** On the surfaces a treatment uses, in
  light: ink 16.13:1 on paper and 15.20:1 on mint; muted 5.63:1 on raised and
  5.71:1 on mint; subtle 4.99:1 on paper, 4.64:1 on raised and 4.71:1 on mint;
  leaf 4.81:1 on paper and 4.53:1 on mint. `--cue-subtle` was deepened from
  `#697268` to `#636c63` for the raised and mint cases (it had measured 4.25:1
  and 4.31:1 there). Dark-mode pairs are 7.39:1 or better for muted, and 4.74:1
  or better for subtle, on the same surfaces.
- **The first frame is already themed.** `index.html` reads the cached treatment
  (and the cached light/dark choice) before React starts, so a reload never
  flashes paper over a chosen background. The cache is per device and is cleared
  when the session ends — on a shared phone the next person never sees the last
  one's page.
- **Previews are the real thing.** A picker swatch is a `.app-page` element with
  that treatment's own `data-background`, so it is the same CSS that will be
  applied, in the theme currently on screen.
- **Scope is the signed-in shell.** The public pages, the splash and the
  full-screen check-in keep their own surfaces: a page treatment must never
  compete with a QR code, a form or the brand panel.
