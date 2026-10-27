import { useEffect, useState } from "react";

/**
 * A ticking `Date.now()` for screens that must notice a schedule boundary while
 * they are open — a check-in window closing, a roll that should re-read itself.
 *
 * Presentation only: it exists so the page redraws at the right moment, never to
 * decide anything. Every rule it appears to apply (whether an event still takes
 * check-ins, whether a make-up email may be sent) is re-decided by the server on
 * the request itself, so a wrong clock here cannot authorise anything.
 *
 * The tick is capped at a minute and re-checked when the tab is focused or
 * becomes visible again: a background tab's timers are throttled, so a long
 * sleep would otherwise leave the screen showing yesterday's answer.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const period = Math.max(1_000, Math.min(intervalMs, 60_000));

    const tick = () => setNow(Date.now());
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      tick();
    };

    const id = window.setInterval(tick, period);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [intervalMs]);

  return now;
}
