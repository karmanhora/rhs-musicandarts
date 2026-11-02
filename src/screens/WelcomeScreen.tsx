import { Link } from "react-router-dom";
import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { IconButton, Poster, StaffMotif } from "../components/ui";
import { NotesField } from "../components/notes/NotesField";
import { useDark } from "../hooks/useDark";

/**
 * The public front door.
 *
 * It says three things and stops: what this is, what a member actually does
 * here, and where to sign in. The green panel is the program's own colour rather
 * than decoration, and there is no illustration, no gradient and no statistic —
 * the only numbers on this page are the ones a reader needs to act.
 *
 * The composition is deliberately not two columns of prose. The left column is
 * the promise, set in the poster voice the app reserves for the name of the
 * thing a screen is about; the right column is an ordered call sheet, because
 * the three things a member does here happen in that order. The staff motif
 * behind them is the same one the dashboard's focal panel uses, so the public
 * page and the product behind the sign-in look like one thing.
 *
 * `NotesField` is the one thing on this page that is not made of text: a
 * full-viewport swarm of notation drifting behind everything. It is decorative
 * and unreachable — `aria-hidden`, `pointer-events: none` — and it is started
 * only after first paint. The elements marked `data-notes-calm` are the pockets
 * where a reader is being asked to work; the swarm goes quiet there so nothing
 * ever competes with a heading, a paragraph or a button.
 */

/**
 * The three controls on this page, defined once each. A primary action is ink on
 * paper and white on the green panel — in both themes that is simply the highest
 * contrast surface available, which is why it needs no theme branch.
 */
/*
 * The landing page's controls follow the same interaction spec as the app's
 * `Button` (src/components/ui.tsx): hover is colour only, press is the one
 * movement, and the trailing arrow leans toward where it goes. They used to
 * lift a pixel under the pointer, which promised navigation that a press does
 * not deliver — docs/QA_REPORT.md QA-05.
 */
const BTN =
  "group motion-press inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] text-sm font-semibold " +
  "transition-[background-color,color,box-shadow,transform] duration-[var(--motion-base)] ease-[var(--ease-standard)]";
const BTN_PRIMARY = `${BTN} min-h-11 bg-[var(--cue-ink)] px-3.5 text-[var(--cue-panel)] hover:opacity-90 sm:px-4`;
const BTN_ON_GREEN = `${BTN} min-h-12 bg-white px-5 text-[var(--cue-action-hover)] hover:bg-[#f1f0e9]`;
const BTN_OUTLINE_ON_GREEN = `${BTN} min-h-12 border border-white/35 px-5 text-[var(--cue-brand-ink)] hover:bg-white/10`;

const capabilities = [
  {
    title: "Know what's next",
    detail: "Rehearsals, performances and meetings from the program's calendar, in one list.",
  },
  {
    title: "Check in at the door",
    detail: "Scan the code on the rehearsal-room screen, or type the eight characters.",
  },
  {
    title: "One roster, one record",
    detail: "Directors, section leaders and students read the same attendance record.",
  },
];

const programs = [
  {
    name: "Band",
    detail: "RHS Mustang Bands",
    instagram: "https://www.instagram.com/rhsmustangbands/",
  },
  {
    name: "Orchestra",
    detail: "RHS Strings",
    instagram: "https://www.instagram.com/rhs.strings/",
  },
];

/** The arrow that marks every outbound action on this page. It leans. */
function Go() {
  return <ArrowUpRight aria-hidden="true" className="cue-nudge h-4 w-4" />;
}

export function WelcomeScreen() {
  const { dark, toggle } = useDark();

  return (
    /*
     * No page colour here on purpose: the document body already paints
     * `--cue-page`, and leaving this layer transparent is what lets the fixed
     * note canvas — which sits behind every in-flow element — show through the
     * margins and between the sections.
     */
    <div className="relative min-h-full text-[var(--cue-ink)]">
      <NotesField dark={dark} />

      {/* --- masthead: the school and the way in, and nothing else --- */}
      {/* `safe-t` owns the top padding (12px plus the device inset), so this
          element only sets the other three edges. */}
      <header className="safe-t cue-stagger relative mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 pb-3 sm:gap-4 sm:px-8 sm:pb-4" data-notes-calm>
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <img src="/logo.svg" alt="" width={36} height={36} className="h-8 w-8 shrink-0 sm:h-9 sm:w-9" />
          <div className="min-w-0">
            {/* On a phone the name wraps rather than truncates: “Redmond High Sch…”
                is not a wordmark. There is room to truncate again from 640px up. */}
            <p className="type-wordmark text-[0.8125rem] leading-tight sm:truncate sm:text-sm">
              Redmond High School
            </p>
            {/* The strapline needs 142px; a 360px phone leaves 93. It is the one
                piece of the lockup worth losing on a small screen. */}
            <p className="type-meta mt-0.5 hidden truncate sm:block">Music &amp; Arts attendance</p>
          </div>
        </div>
        {/* 8px between adjacent controls: the theme toggle and Sign in were
            6px apart and read as one target. */}
        <div className="flex shrink-0 items-center gap-2">
          <IconButton
            label={dark ? "Use light mode" : "Use dark mode"}
            onClick={toggle}
            icon={
              dark ? (
                <Sun aria-hidden="true" className="h-4 w-4" />
              ) : (
                <Moon aria-hidden="true" className="h-4 w-4" />
              )
            }
          />
          <Link viewTransition to="/sign-in" className={BTN_PRIMARY}>
            Sign in
            <Go />
          </Link>
        </div>
      </header>

      <main className="relative">
        {/* --- the one green surface: the program's own colour, nothing on top of it ---
            It is opaque, so the swarm neither shows through it nor sits behind the
            headline: the panel *is* the calm zone, in the strongest form there is. */}
        {/* The hero is *not* a calm pocket, on purpose. It is opaque, so the field
            can never be seen here — but tagging it as a pocket made 60% of the
            viewport unavailable to the spawner, which squeezed the whole swarm
            into the reading band below and made that band look four times busier
            than it was. The calm zones exist to quiet the places you read; a
            place you cannot see needs no quieting. */}
        <section
          className="relative isolate overflow-hidden border-y-2 border-[var(--cue-gold-on-brand)] bg-[var(--cue-brand-panel)] text-[var(--cue-brand-ink)]"
        >
          {/* The program's motif — five staff lines with notation drifting along
              them. The page's original decorative element, inherited from the
              product rather than invented for the marketing site; the live swarm
              outside this panel is its counterpart. */}
          <StaffMotif className="text-[var(--cue-brand-ink)] opacity-[0.14]" />

          {/* `minmax(0, …)` rather than a bare `fr`: an `auto`-floored track
              takes its floor from the content's min-content, which one long
              unbreakable string can push past the viewport. */}
          <div className="cue-stagger relative z-10 mx-auto grid max-w-6xl grid-cols-1 gap-10 px-5 py-12 sm:gap-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16 lg:py-20">
            <div className="self-center">
              <h1 className="text-[var(--cue-brand-ink)]">
                <Poster tone="stage" rule>
                  Attendance, events and check-in for RHS music and arts.
                </Poster>
              </h1>
              <p className="mt-6 max-w-lg text-[0.9375rem] leading-relaxed text-[var(--cue-brand-ink)]/80">
                Built for RHS students, directors and section leaders — from the first rehearsal to
                the last concert.
              </p>

              {/* Two equal tracks rather than two content-width buttons: the pair
                  is one decision with two answers, so it reads as one control.
                  Content width made them 108px and 158px wide side by side —
                  both `min-h-12`, and visibly not a pair. `max-w-sm` keeps the
                  equal pair compact instead of stretching two half-column
                  slabs, and `grid-cols-1` stacks them full width on a phone,
                  where two equal halves would wrap the longer label onto a
                  second line and make the *heights* uneven instead.
                  docs/QA_REPORT.md QA-10. */}
              <div className="mt-8 grid max-w-sm grid-cols-1 gap-3 sm:grid-cols-2">
                <Link viewTransition to="/sign-in" className={`${BTN_ON_GREEN} w-full`}>
                  Sign in
                  <Go />
                </Link>
                <Link viewTransition to="/sign-up" className={`${BTN_OUTLINE_ON_GREEN} w-full`}>
                  Create an account
                </Link>
              </div>

              <p className="mt-6 max-w-md border-l-2 border-[var(--cue-gold-on-brand)] pl-4 text-sm leading-relaxed text-[var(--cue-brand-ink)]/75">
                Already have a join code from your director? Create an account first, then use it to
                land on your program&rsquo;s roster.
              </p>
            </div>

            {/* The call sheet: an ordered list, because that is what it is. */}
            <div className="self-center lg:pl-2">
              {/* `.type-kicker` sets its own colour, and it lives outside Tailwind's
                  layers — so a plain utility cannot recolour it. The `!` is the
                  override, and gold is the only colour that clears 4.5:1 against
                  the dark green panel in *both* themes. */}
              <p className="type-kicker text-[var(--cue-gold-on-brand)]!">
                What a member does here
              </p>
              <ol className="mt-4 border-t border-white/20">
                {capabilities.map((item, index) => (
                  <li key={item.title} className="flex gap-4 border-b border-white/20 py-5">
                    <span
                      aria-hidden="true"
                      className="type-figure mt-0.5 w-7 shrink-0 text-lg text-[var(--cue-gold-on-brand)]"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[0.9375rem] font-semibold">{item.title}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-[var(--cue-brand-ink)]/75">
                        {item.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* --- the programs --- */}
        {/* One pocket over the whole section, not one per heading: a thin band
            around a heading leaves the paragraph above and below it at full
            strength, and the eye reads the *area*, not the band. */}
        <section
          className="relative mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24"
          data-notes-calm
        >
          <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-3 border-b border-[var(--cue-line)] pb-4">
            <div>
              <p className="type-kicker">Programs</p>
              <h2 className="type-title mt-2">RHS music programs</h2>
            </div>
            <p className="type-meta max-w-sm">
              Open the attendance app for band, or follow the program pages below.
            </p>
          </header>

          {/* Every program gets the same panel, so the cards read as one set. Only
              the content differs: band has an attendance app, orchestra a page. */}
          <div className="cue-stagger mt-10 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {programs.map((program) => (
              <article
                key={program.name}
                className="flex min-w-0 flex-col rounded-[var(--radius-panel)] border border-[var(--cue-line)] bg-[var(--cue-leaf-soft)] p-6 sm:p-7"
              >
                <h3 className="type-poster-sm">{program.name}</h3>
                <p className="mt-1 text-sm font-semibold text-[var(--cue-muted)]">{program.detail}</p>

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-7">
                  <Link viewTransition to="/sign-in" className={BTN_PRIMARY}>
                    {program.name} sign in
                    <Go />
                  </Link>
                  <a
                    href={program.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Follow on Instagram"
                    aria-label={`Follow ${program.detail} on Instagram (opens in a new tab)`}
                    className="instagram-chip"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                      focusable="false"
                      viewBox="0 0 448 512"
                      fill="#ff00ff"
                    >
                      <path d="M224.1 141c-63.6 0-114.9 51.3-114.9 114.9s51.3 114.9 114.9 114.9S339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.5-74.7-74.7s33.5-74.7 74.7-74.7 74.7 33.5 74.7 74.7-33.6 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.8-26.8 26.8-14.9 0-26.8-12-26.8-26.8s12-26.8 26.8-26.8 26.8 12 26.8 26.8zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z" />
                    </svg>
                  </a>
                </div>
              </article>
            ))}

            <article
              aria-label="Coming soon: more music and arts programs"
              className="flex min-w-0 flex-col rounded-[var(--radius-panel)] border border-dashed border-[var(--cue-line-strong)] p-6 sm:p-7"
            >
              <p className="type-kicker">Coming soon</p>
              <h3 className="type-poster-sm mt-3">More programs</h3>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-[var(--cue-muted)]">
                More music and arts programs will be listed here as they join.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="relative border-t border-[var(--cue-line)]">
        <div
          className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-5 text-sm text-[var(--cue-muted)] sm:px-8"
          data-notes-calm
        >
          <div className="min-w-0">
            <span className="type-meta block">Redmond High School · Music &amp; Arts</span>
            <span className="type-meta mt-1 block">© 2026 Karman Hora. All Rights Reserved.</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <nav aria-label="Legal" className="flex items-center gap-5">
              <Link
                viewTransition
                to="/privacy"
                className="motion-press inline-flex min-h-11 items-center underline underline-offset-4 hover:text-[var(--cue-ink)]"
              >
                Privacy Policy
              </Link>
              <Link
                viewTransition
                to="/terms"
                className="motion-press inline-flex min-h-11 items-center underline underline-offset-4 hover:text-[var(--cue-ink)]"
              >
                Terms of Use
              </Link>
              <Link
                viewTransition
                to="/license"
                className="motion-press inline-flex min-h-11 items-center underline underline-offset-4 hover:text-[var(--cue-ink)]"
              >
                Copyright & Licensing
              </Link>
            </nav>
            <Link
              viewTransition
              to="/sign-up"
              /* Leaf, not action: `--cue-action` is a *surface* green, and as text
                 on the dark page it measures 2.4:1. Leaf reads on both pages. */
              className="group motion-press inline-flex min-h-11 items-center gap-1.5 font-semibold text-[var(--cue-leaf)] underline decoration-[var(--cue-gold)] decoration-2 underline-offset-4"
            >
              Join your program
              <Go />
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
