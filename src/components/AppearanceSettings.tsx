import { RotateCcw } from "lucide-react";
import { Alert, Button, Card, Field, SectionTitle, SegmentedControl, useToast } from "./ui";
import { BackgroundPicker } from "./BackgroundPicker";
import { AppearancePromptButton } from "./PersonalizationPrompt";
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
 * The background picker is `BackgroundPicker` — the same radio group of live
 * previews the first-run prompt offers, so the two cannot drift apart.
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
          <BackgroundPicker
            value={preferences.background}
            onChange={(background) => void chooseBackground(background)}
          />
        </div>

        <div className="border-t border-[var(--cue-line)] pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={saving}
              icon={<RotateCcw className="h-4 w-4" />}
              onClick={() => void restore()}
            >
              Reset appearance
            </Button>
            {/* The same two choices, in the sheet a new member meets after
                joining. Reopening writes no setup state. */}
            <AppearancePromptButton />
          </div>
          <p className="type-meta mt-2">
            Reset puts the theme back to your device&rsquo;s and the page back to paper, and returns
            your dashboard blocks to the default order. The prompt is the two-choice sheet a new
            member is offered after joining — reopen it to choose again in one place.
          </p>
        </div>
      </Card>
    </section>
  );
}
