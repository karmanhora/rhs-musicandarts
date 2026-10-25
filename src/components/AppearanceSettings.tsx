import { Check, RotateCcw } from "lucide-react";
import { Alert, Button, Card, Field, SectionTitle, SegmentedControl, useToast, cn } from "./ui";
import { BACKGROUNDS } from "../lib/personalization";
import type { BackgroundId, ThemeChoice } from "../lib/types";
import { usePreferences } from "../hooks/usePreferences";

/**
 * Appearance: light/dark and the page background.
 *
 * These are personal, not program-wide — nothing here changes what anybody else
 * sees, and nothing here grants anything. The choice is painted the moment it is
 * made and saved beside it; a refusal from the server puts the old value back and
 * says why (see `usePreferences`).
 *
 * The background picker is a radio group of previews rather than a `<select>`:
 * the whole point is seeing the treatment, and a dropdown of words would ask the
 * person to imagine it. Each preview is a real `.app-page` surface with the
 * treatment's own `data-background`, so what is shown is exactly what is applied
 * — and it follows the current light/dark choice, because it is the same CSS.
 */
export function AppearanceSettings() {
  const { preferences, save, reset, saving, error } = usePreferences();
  const { toast } = useToast();

  async function chooseTheme(theme: ThemeChoice) {
    if (theme === preferences.theme) return;
    const message = await save({ theme });
    if (message) toast.error(message);
  }

  async function chooseBackground(background: BackgroundId) {
    if (background === preferences.background) return;
    const message = await save({ background });
    if (message) toast.error(message);
  }

  async function restore() {
    const message = await reset();
    if (message) {
      toast.error(message);
      return;
    }
    toast.success("Appearance reset to the default.");
  }

  return (
    <section aria-labelledby="appearance">
      <SectionTitle className="mb-3">
        <span id="appearance">Appearance</span>
      </SectionTitle>

      {error ? (
        <Alert tone="error" className="mb-3">
          {error}
        </Alert>
      ) : null}

      <Card className="space-y-5">
        <Field
          label="Light or dark"
          hint="Follow device changes with the system; light and dark stay put."
        >
          <SegmentedControl
            value={preferences.theme}
            onChange={(next) => void chooseTheme(next)}
            options={[
              { value: "system", label: "Follow device" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Field>

        <div>
          <p className="type-label mb-2">Background</p>
          <div
            role="radiogroup"
            aria-label="Page background"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          >
            {BACKGROUNDS.map((option) => {
              const checked = preferences.background === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => void chooseBackground(option.id)}
                  className={cn(
                    "motion-press flex min-h-11 flex-col gap-2 rounded-[var(--radius-control)] border p-2 text-left",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--cue-focus)]",
                    checked
                      ? "border-[var(--cue-leaf)] ring-1 ring-[var(--cue-leaf)]"
                      : "border-[var(--cue-line)] hover:bg-[var(--cue-raised)]"
                  )}
                >
                  {/* A real treatment on a real surface: `.app-page` reads
                      `--app-page-color` / `--app-page-image`, which this
                      element's own `data-background` sets. */}
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
        </div>

        <div className="border-t border-[var(--cue-line)] pt-4">
          <Button
            size="sm"
            variant="secondary"
            loading={saving}
            icon={<RotateCcw className="h-4 w-4" />}
            onClick={() => void restore()}
          >
            Reset appearance
          </Button>
          <p className="type-meta mt-2">
            Puts the theme back to your device&rsquo;s and the page back to paper. Your dashboard
            blocks return to the default order too.
          </p>
        </div>
      </Card>
    </section>
  );
}
