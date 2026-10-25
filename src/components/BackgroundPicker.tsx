import { Check } from "lucide-react";
import { BACKGROUNDS } from "../lib/personalization";
import type { BackgroundId } from "../lib/types";
import { cn } from "./ui";

/**
 * The page-treatment picker: a radio group of real previews rather than a
 * `<select>`. The whole point is seeing the treatment, and a dropdown of words
 * would ask the person to imagine it. Each preview is a real `.app-page` surface
 * carrying that treatment's own `data-background`, so what is shown is exactly
 * what is applied — and it follows the current light/dark choice, because it is
 * the same CSS.
 *
 * Shared by Account settings → Preferences and the first-run prompt, so the two
 * cannot drift into offering different treatments.
 */
export function BackgroundPicker({
  value,
  onChange,
  disabled,
}: {
  value: BackgroundId;
  onChange: (background: BackgroundId) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div
        role="radiogroup"
        aria-label="Page background"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {BACKGROUNDS.map((option) => {
          const checked = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => onChange(option.id)}
              className={cn(
                "motion-press flex min-h-11 flex-col gap-2 rounded-[var(--radius-control)] border p-2 text-left",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--cue-focus)]",
                checked
                  ? "border-[var(--cue-leaf)] ring-1 ring-[var(--cue-leaf)]"
                  : "border-[var(--cue-line)] hover:bg-[var(--cue-raised)]"
              )}
            >
              <span
                aria-hidden="true"
                data-background={option.id}
                className="app-page block h-12 w-full rounded-[var(--radius-chip)] border border-[var(--cue-line)]"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
                  {option.label}
                  {checked ? (
                    <Check
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-[var(--cue-leaf)]"
                    />
                  ) : null}
                </span>
                <span className="type-meta mt-0.5 block">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="type-meta mt-2">
        Panels stay solid, so a background never sits behind a name, a form or a code.
      </p>
    </>
  );
}
