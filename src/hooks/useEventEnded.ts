import { useEffect, useState } from "react";

export interface EventEndState {
  /** True once the server-provided end instant has passed. */
  ended: boolean;
  /** False when there is no usable end time (missing, invalid, or before start). */
  valid: boolean;
  /** Current clock, so the caller can re-render countdowns. */
  now: number;
}

/**
 * Watches one event's end time.
 *
 * This is **presentation only**: it enables the make-up button at the right
 * moment without a refresh. The server re-reads the schedule and re-checks the
 * end time on every send, so a wrong client clock or a timer that never fired
 * cannot authorise anything. The timer is capped at a minute so a sleeping tab
 * recovers on its next tick, and focus/visibility listeners re-check when the
 * tab wakes.
 */
export function useEventEnded(endIso: string | null | undefined, startIso?: string | null): EventEndState {
  const endMs = endIso ? new Date(endIso).getTime() : NaN;
  const startMs = startIso ? new Date(startIso).getTime() : NaN;
  const valid =
    Number.isFinite(endMs) && (!Number.isFinite(startMs) || endMs > startMs);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!valid) return;

    let timer: number | undefined;

    function tick() {
      const current = Date.now();
      setNow(current);
      const remaining = endMs - current;
      if (remaining > 0) {
        // Never a long sleep: background tabs throttle timers, and the button
        // must still be right when the tab comes back.
        timer = window.setTimeout(tick, Math.min(remaining + 200, 60_000));
      } else {
        timer = undefined;
      }
    }

    function wake() {
      if (document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      tick();
    }

    tick();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [endMs, valid]);

  return { ended: valid && now >= endMs, valid, now };
}
