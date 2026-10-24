import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { Minimize2, Timer } from "lucide-react";
import { Button, cn } from "./ui";
import type { EventRow } from "../lib/types";
import { fmtTime, mmss, relativeDay } from "../lib/date";

/**
 * The classroom-display view of the live check-in session.
 *
 * It is not a second check-in system: the parent keeps the session, the token,
 * the five-minute timer and the attendance polling, and passes the *same*
 * `checkinUrl` / `entry_code` in here. Nothing about the session is created,
 * extended or validated in this component — closing the display leaves the code
 * running exactly as it was, and a code that expires while the room is looking
 * at it says so instead of pretending to still work.
 *
 * The browser's fullscreen mode is requested by the opener, in its click
 * handler, because Chrome and Safari refuse a `requestFullscreen()` that is not
 * tied to the gesture. If it is unavailable or denied, this overlay still fills
 * the viewport and Escape still leaves it.
 */
export function FullScreenCheckIn({
  event,
  checkinUrl,
  entryCode,
  expiresAt,
  nowMs,
  checkedIn,
  total,
  expired,
  onExit,
}: {
  event: EventRow;
  /** The exact URL the wall QR encodes — the parent builds it from the session token. */
  checkinUrl: string;
  entryCode: string;
  expiresAt: string | null;
  nowMs: number;
  checkedIn: number;
  total: number;
  expired: boolean;
  onExit: () => void;
}) {
  // The parent passes a fresh closure on every render; the effect below must run
  // once, or it would re-register listeners each second the timer ticks.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    let active = true;
    const exit = () => {
      if (active) onExitRef.current();
    };

    // Leaving the browser's fullscreen mode (Escape, the browser's own control)
    // closes the display too. This component never requests fullscreen itself,
    // so a `null` element here is always a real exit — not the transient one
    // React's development StrictMode produces around a discarded mount.
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) exit();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      active = false;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const remainingMs = expiresAt ? Math.max(0, new Date(expiresAt).getTime() - nowMs) : 0;
  const expiringSoon = !expired && remainingMs > 0 && remainingMs <= 60_000;

  // A portal, not a child of the projector card: the screen's staged-entrance
  // animation leaves a `transform` on that ancestor, which would make
  // `position: fixed` fill the card instead of the viewport.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Check-in code, full screen"
      className="fixed inset-0 z-50 overflow-y-auto bg-[var(--cue-page)] text-[var(--cue-ink)]"
    >
      <div className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="type-label">Live check-in</p>
            <h2 className="font-display text-2xl leading-tight font-semibold break-words sm:text-3xl">
              {event.name}
            </h2>
            <p className="type-meta mt-1 tabular">
              {relativeDay(event.date)} · {event.all_day ? "All day" : fmtTime(event.date)}
            </p>
          </div>
          <Button
            autoFocus
            variant="secondary"
            size="lg"
            onClick={() => onExitRef.current()}
            icon={<Minimize2 className="h-4 w-4" />}
          >
            Exit full screen
          </Button>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
          {/* The QR keeps its white field and dark foreground in both themes:
              a projected code has to stay scannable, so it is the one surface
              that does not follow the page tokens. */}
          <div
            className={cn(
              "rounded-[var(--radius-panel)] bg-white p-3 ring-1 ring-[var(--cue-line-strong)] sm:p-4",
              expired && "opacity-20"
            )}
          >
            <QRCodeSVG
              value={checkinUrl}
              size={512}
              level="M"
              fgColor="#173b28"
              bgColor="#ffffff"
              className="block h-[min(48vh,76vw)] max-h-[32rem] w-[min(48vh,76vw)] max-w-[32rem]"
              aria-hidden="true"
            />
          </div>

          <div className="w-full min-w-0">
            <p className="type-label">Or type this code</p>
            <p
              className={cn(
                "mt-1 font-mono text-[clamp(2.25rem,8vw,6rem)] leading-none font-semibold tracking-[0.18em]",
                expired && "text-[var(--cue-subtle)] line-through"
              )}
            >
              {entryCode}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2 text-base font-semibold sm:text-lg">
            <span className="tabular">
              {checkedIn} of {total} checked in
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-2 tabular",
                expiringSoon && "text-[var(--cue-late)]"
              )}
            >
              <Timer aria-hidden="true" className="h-4 w-4" />
              {expired
                ? "Code expired — start a new one"
                : expiresAt
                  ? `New code in ${mmss(expiresAt, nowMs)}`
                  : "Code live"}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
