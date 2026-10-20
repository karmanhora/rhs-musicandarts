# Motion system

Motion gives immediate feedback to a rehearsal action; it is not decoration.
Only `transform` and `opacity` are animated. Actions are never delayed until an
animation finishes.

## Tokens

| Token | Value | Intended use |
| --- | --- | --- |
| `--motion-short` | `110ms` | Press feedback and quick route exit |
| `--motion-base` | `180ms` | Check-in mark, roster arrival, route entry |
| `--motion-long` | `260ms` | Sheet entrance and ring arrival |
| `--motion-tempo` | `80ms` | Shared interval if a short sequence needs staggering |
| `--ease-standard` | `cubic-bezier(0.2, 0.75, 0.25, 1)` | Ordinary state changes |
| `--spring-snappy` | `cubic-bezier(0.2, 1.12, 0.35, 1)` | Small count/mark response |
| `--spring-settle` | `cubic-bezier(0.22, 1, 0.36, 1)` | Arrival and completion |
| `--spring-gentle` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Sheet arrival |

Timed loops are limited to the low-contrast skeleton sheen, the landing page's
note field, and the live view's slow opacity breathe on the "live" dot — one
loop, opacity only, and the word "live" never depends on it. If a sequence adds
staggered items, derive all intervals from `--motion-tempo`; do not add
independent timings.

The public landing hero uses one short, entrance-only reveal, with each text
group staggered by `--motion-tempo`. It is removed for reduced-motion
preferences, like every other CSS animation.

## Moments

- **Press:** `motion-press` scales to 0.985 while held. Input is not blocked.
- **Route:** Links that opt into React Router's View Transitions API use a short
  directional root transition. Browsers without the API navigate immediately
  with no dependency or custom animation fallback.
- **Navigation:** The active bottom-tab underline uses one shared element name,
  so it moves between tabs during supported View Transitions. It remains a
  static active-state underline when the API is unavailable.
- **Staged entrance:** one shared ladder reveals a screen's top-level groups
  once, stepped by `--motion-tempo`, and nothing is hidden behind it. The
  student home leads with its header and hero event; the check-in screen lands
  the program header, then the form, then the Today hint; the staff check-in
  screen lands the mode control, then the event picker, then the live view; the
  auth screen lands its audience picker, then the copy, then the form — and the
  copy re-reveals when the student/teacher choice changes, keyed so the form
  underneath never remounts.
- **Segmented control:** the active pill settles between tabs with opacity and
  a small scale instead of a background swap — no layout movement. Each tab
  owns its own pill, so option rows that wrap stay aligned, and keyboard focus
  stays on the tab being pressed.
- **Check-in form:** switching Scan QR / Enter code swaps a pane keyed to the
  tab, which arrives from the side of the choice that was picked in one
  `--motion-base` beat. The code-entry meter under the input fills with
  `scaleX` as characters land — a transform, so typing never reflows the form;
  the hint and the disabled button stay the authoritative signals.
- **Display lines:** headings that carry a moment — the check-in title, both
  confirmation headings, and the projector's event name — reveal from behind a
  static mask: the text slides up inside an `overflow` clip, so only `transform`
  moves. One settle per line, never letter-by-letter.
- **Drawn rule:** a short accent rule draws itself left to right beneath those
  headings, one tempo step behind the line — green on time, gold when late.
- **Arrow nudge:** an icon that promises a direction — the event picker's
  chevron — moves 4px toward it on hover or press.
- **Check-in:** only a server-confirmed *new* check-in draws the confirmation.
  The ring traces itself in 620ms, the check draws behind it in 360ms, and the
  copy and event details fade in as they finish — the whole sequence settles in
  about a second, and nothing waits on it. On-time uses green; late uses gold
  and explicit late text. The RPC is idempotent, so a repeat scan answers `ok`
  without a new row: that gets the calm already-checked-in card with no draw,
  and refusal/error keeps the error treatment and a distinct optional haptic
  pattern. Reduced motion shows the finished mark and copy immediately.
- **Live view:** starting a check-in lands the code panel first and the roster
  column second. The code panel is keyed to the session token, so a refreshed
  code re-arrives as an arrival rather than swapping pixels silently. The
  checked-in meter grows with `scaleX` instead of a width change, and both the
  checked-in and the missing count roll into place. The status dot breathes
  slowly while the roster polls.
- **Live roster:** a newly keyed check-in row arrives with a short upward move;
  the changed live count rolls into place. The waiting-for-the-first-scan label
  settles once into "live", and "Everyone's here" settles in when the last
  section empties. Polling and check-in remain usable throughout.
- **Attendance ring:** the ring settles in on first display; the numeric
  percentage remains visible and authoritative.
- **Sheet:** the panel settles upward. On touch, a downward drag dismisses it
  after 120px or a quick downward release; otherwise it snaps back. Escape and
  the close button remain available.
- **Skeleton:** a slow, subtle sheen uses a single transform-only sweep.
- **Landing hero:** the masthead, the hero's two columns and the two program
  articles arrive once with opacity and a small vertical transform, stepped by
  `--motion-tempo`.
- **Landing note field:** the page's one page-wide loop, and the one place in
  the product where motion is ambient rather than a response to an action. A
  full-viewport swarm of notation drifts along a sine-based stream from
  lower-left to upper-right, with a minority of slower counter-streams, tumbling
  gently, larger and faster the nearer its depth layer. Five-line staff ribbons
  undulate behind it. The cursor or finger pushes nearby notes away with a soft
  radius; a click or tap releases a small burst that fades inside 1.4s; scroll
  shears the flow a little so the page feels continuous. It pauses only while the tab
  is hidden, so it keeps moving all the way down the page, and it steps its own particle count down
  when the average frame time stays above 20ms for two seconds.

  It is the exception that proves the rule about delight: it never carries
  information, it never sits behind the headline or the buttons (the opaque
  green panel and the `data-notes-calm` pockets keep it out of the way), and it
  degrades to a single still frame under `prefers-reduced-motion: reduce` — no
  drift, no pointer response, no bursts. Its full description, limits and the
  evidence behind it are in docs/DESIGN_SYSTEM.md.

## Reference note

The reveal structure — masked title lines, left-to-right rule draws, arrow
nudges, a slow status breathe, and a `scaleX` progress fill — follows the
Mandalora Studios reference site (studiosmandalora.github.io/web). Only the
technique is borrowed: durations and travel are cut to app tempo (a 520ms
reveal from a 125% start against the reference's ~1.15s reveals), and its
branding, gradients, glows, custom cursor, and scroll-linked effects are not
used.

The landing page's note field borrows nothing from that reference and is the
one effect here with no analogue in it: a scroll-linked *shift* in flow
direction and speed (never a scroll-scrubbed timeline), and pointer influence
that is a soft repulsion rather than a custom cursor.

## Reduced motion and haptics

`prefers-reduced-motion: reduce` disables movement and transitions globally;
staggered groups mount immediately, because their delays are cleared along with
the animation, and all controls and state changes still work. The landing page's
note field is not a CSS animation, so it honours the same preference in
JavaScript: the engines render a single static, sparse frame and never start a
loop, and clicks produce no burst. Haptics use the browser's optional
`navigator.vibrate` API and are a no-op when unavailable. They are feedback,
never the only signal that an action succeeded or failed.

## Budget and validation

No animation library is added. CSS cubic-bezier presets and a small
`navigator.vibrate` guard cover the implemented needs without a runtime motion
dependency. QR scanning remains dynamically imported by `QrScanner`; screen
routes are lazy-loaded.

The note field is the one addition with a real runtime cost, so it is kept off
the first paint: `NotesField` has no static import into `src/components/notes/`,
and the whole directory — glyph atlas, both engines, and vgpu — arrives as a
lazy chunk from a `requestIdleCallback` after the hero has rendered. The initial
JS bundle grows by roughly 4 kB for the canvas host and its listeners. Its
shaders are validated with `npx vgpu check`, and its behaviour is asserted on
real readback pixels by the harness described in docs/DESIGN_SYSTEM.md rather
than judged by eye.

Device frame pacing, haptic behavior, and the 60fps target still require
physical-device recording and review.
