import { useCallback, useEffect, useState } from "react";

const KEY = "rhs-band:reduce-motion";
const EVENT = "rhs-band:reduce-motion-changed";
const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Stored preference, or the operating system's. `null` means "follow the
 * system", which is the default — an explicit choice wins over it.
 */
export type MotionPreference = "system" | "reduced" | "full";

function read(): MotionPreference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "reduced" || stored === "full") return stored;
  } catch {
    /* private mode — fall through to the system preference */
  }
  return "system";
}

/** The device's current answer, read safely outside a browser. */
function systemReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.(QUERY).matches ?? false)
  );
}

/**
 * The reduced-motion switch, as a class on <html>.
 *
 * `index.css` already honours `prefers-reduced-motion`; the `.reduce-motion`
 * class applies the same rule to a person who has *chosen* less movement in the
 * app (a shared classroom machine, a vestibular sensitivity the OS does not
 * know about). Nothing animates differently otherwise — this only ever adds the
 * reduction.
 */
function paint(preference: MotionPreference): void {
  const reduce = preference === "reduced" || (preference === "system" && systemReduced());
  document.documentElement.classList.toggle("reduce-motion", reduce);
}

export function useReducedMotion(): {
  preference: MotionPreference;
  setPreference: (next: MotionPreference) => void;
  /** True when motion is actually reduced right now. */
  reduced: boolean;
} {
  const [preference, setState] = useState<MotionPreference>(() =>
    typeof window === "undefined" ? "system" : read()
  );
  /**
   * The device's own setting is state, not a value read during render. When it
   * changes — a person turns animation effects back on in the OS, or a browser
   * stops emulating a reduced-motion preference — the field has to be rebuilt,
   * not left on the single frame it drew under the old answer.
   */
  const [deviceReduced, setDeviceReduced] = useState<boolean>(() => systemReduced());

  useEffect(() => {
    paint(preference);
    const onChange = () => setState(read());
    window.addEventListener(EVENT, onChange);

    const media = window.matchMedia?.(QUERY);
    const onMedia = () => setDeviceReduced(media?.matches ?? false);
    media?.addEventListener?.("change", onMedia);
    return () => {
      window.removeEventListener(EVENT, onChange);
      media?.removeEventListener?.("change", onMedia);
    };
  }, [preference, deviceReduced]);

  const setPreference = useCallback((next: MotionPreference) => {
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* ignore — the class still changes for this session */
    }
    paint(next);
    window.dispatchEvent(new Event(EVENT));
    setState(next);
  }, []);

  const reduced = preference === "reduced" || (preference === "system" && deviceReduced);

  return { preference, setPreference, reduced };
}
