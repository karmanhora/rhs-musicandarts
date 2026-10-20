import { CheckCircle2 } from "lucide-react";
import { Badge, Card, cn } from "./ui";
import { fmtTime } from "../lib/date";
import type { CheckinKind } from "../lib/checkin";
import type { RpcResult } from "../lib/types";

/**
 * The circle and checkmark that draw themselves when a check-in is recorded.
 * Kept separate from the copy so another surface can reuse the mark, and
 * hidden from assistive tech — the confirmation text says what happened.
 */
export function CheckInSuccessMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("cue-success-mark", className)}
    >
      <circle className="cue-success-track" cx="50" cy="50" r="45" strokeWidth="2.5" />
      <circle className="cue-success-ring" cx="50" cy="50" r="45" strokeWidth="3.5" />
      <path className="cue-success-check" d="M30 51.5 44 65 70 36" strokeWidth="5.5" />
    </svg>
  );
}

/**
 * The end of a check-in. Only the `new` state — the server confirmed a check-in
 * that did not exist before this request — plays the drawing animation. A
 * repeat scan (`repeat`) and a success the client could not classify
 * (`unknown`) get the same facts without the celebration, because the one
 * thing this screen must never do is claim a new check-in that did not happen.
 */
export function CheckInConfirmation({
  kind,
  outcome,
}: {
  kind: CheckinKind;
  outcome: RpcResult;
}) {
  const late = Boolean(outcome.is_late);
  const time = outcome.checked_in_at ? fmtTime(outcome.checked_in_at) : null;
  const title =
    kind === "new"
      ? "You're checked in!"
      : kind === "repeat"
        ? "You're already checked in!"
        : "Checked in";

  return (
    <Card
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-late={late ? "true" : undefined}
      className={cn("overflow-hidden text-center", kind === "new" ? "cue-success p-6 sm:p-7" : "p-5 sm:p-6")}
    >
      {kind === "new" ? (
        <div className="cue-success-stage">
          <span aria-hidden="true" className="cue-success-glow" />
          <span aria-hidden="true" className="cue-success-ripple" />
          <CheckInSuccessMark />
        </div>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "mx-auto flex h-14 w-14 items-center justify-center rounded-full",
            kind === "repeat"
              ? "bg-[var(--cue-raised)] text-[var(--cue-subtle)]"
              : "bg-[var(--cue-present-bg)] text-[var(--cue-present)]"
          )}
        >
          <CheckCircle2 className="h-7 w-7" />
        </span>
      )}

      <div className={cn("mx-auto max-w-sm", kind === "new" ? "cue-success-copy mt-4" : "mt-3")}>
        <p className="type-title text-balance">{title}</p>
        {kind === "repeat" ? (
          <p className="type-meta mt-1.5">No new attendance was recorded.</p>
        ) : kind === "unknown" ? (
          <p className="type-meta mt-1.5">Your attendance is recorded.</p>
        ) : null}
      </div>

      {outcome.event_name || time ? (
        <div
          className={cn(
            "mx-auto mt-4 max-w-sm border-t border-[var(--cue-line)] pt-3",
            kind === "new" && "cue-success-details"
          )}
        >
          {outcome.event_name ? (
            <p className="type-heading flex flex-wrap items-center justify-center gap-2">
              <span className="min-w-0">{outcome.event_name}</span>
              {late ? (
                <Badge className="bg-[var(--cue-late-bg)] text-[var(--cue-late)]">Late</Badge>
              ) : null}
            </p>
          ) : null}
          <p className="type-meta mt-1 tabular">
            {time ? `Checked in at ${time}` : "Check-in recorded"}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
