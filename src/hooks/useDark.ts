import { useCallback, useEffect, useState } from "react";
import { DARK_EVENT, paintDark, preferredDark, setDarkPreference } from "../lib/personalization";

/**
 * Dark mode is a class on <html> (see index.css), decided by the person's saved
 * theme and, when they chose "follow device", by the operating system.
 *
 * The storage key, the paint and the change event all live in
 * `lib/personalization.ts` and are shared with the pre-paint script in
 * `index.html` and with `usePreferences`. This hook is only the React view of
 * them: it reads the current value, repaints when that value changes, and lets a
 * masthead toggle ask for the other one.
 *
 * Every instance listens for the change event, so the shell's toggle, the
 * account sheet and the settings screen stay in step.
 */
export function useDark(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState<boolean>(() =>
    typeof window === "undefined" ? false : preferredDark()
  );

  useEffect(() => {
    paintDark(dark);
    const onChange = () => setDark(preferredDark());
    window.addEventListener(DARK_EVENT, onChange);
    return () => window.removeEventListener(DARK_EVENT, onChange);
  }, [dark]);

  const toggle = useCallback(() => {
    // Writes the stored value *and* paints, so the very next frame is correct
    // even before this component re-renders.
    setDarkPreference(!preferredDark());
  }, []);

  return { dark, toggle };
}
