import { useState } from "react";
import { Palette } from "lucide-react";
import { Button, Field, SegmentedControl, Sheet, useToast } from "./ui";
import { BackgroundPicker } from "./BackgroundPicker";
import { shouldOfferPersonalizationPrompt } from "../lib/personalization";
import type { BackgroundId, ThemeChoice } from "../lib/types";
import { usePreferences } from "../hooks/usePreferences";
import { usePrograms } from "../hooks/usePrograms";

/**
 * The appearance prompt, in two entries that share one body.
 *
 *   * `PersonalizationPrompt` — the first-run offer. A student lands on the
 *     dashboard after joining and is shown the two choices they can see the
 *     effect of, then left alone. `personalization_prompt_seen_at` records that
 *     it was answered, whether they saved or skipped.
 *   * `AppearancePromptSheet` — the same prompt on demand from Account settings
 *     → Preferences, for anyone who skipped it in a hurry (or wants to see it
 *     again). Reopening is deliberately *not* answering: it writes no seen
 *     stamp, so it cannot change whether the first-run offer appears.
 *
 * Why the first-run one is only for students: a director already walks the
 * guided setup, whose last step carries these same controls, so asking twice
 * would be the same question in two places.
 *
 * The choices save as they are tapped — the change *is* the feedback — and a
 * refusal from the server puts the old value back and says why.
 */

/**
 * Light/dark and the page background. The one body both entries render, so the
 * prompt and the settings screen cannot drift into offering different choices.
 */
function PersonalizationChoices() {
  const prefs = usePreferences();
  const { toast } = useToast();

  async function chooseTheme(theme: ThemeChoice) {
    if (theme === prefs.preferences.theme) return;
    const message = await prefs.save({ theme });
    if (message) toast.error(message);
  }

  async function chooseBackground(background: BackgroundId) {
    if (background === prefs.preferences.background) return;
    const message = await prefs.save({ background });
    if (message) toast.error(message);
  }

  return (
    <div className="space-y-5">
      <Field label="Light or dark" hint="Follow device changes with the system.">
        <SegmentedControl
          value={prefs.preferences.theme}
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
          value={prefs.preferences.background}
          onChange={(background) => void chooseBackground(background)}
        />
      </div>

      <p className="type-meta border-t border-[var(--cue-line)] pt-3">
        Only yours — nobody else sees them, and Account settings keeps them editable.
      </p>
    </div>
  );
}

/** The first-run offer: shown once, to a student who has never answered it. */
export function PersonalizationPrompt() {
  const app = usePrograms();
  const prefs = usePreferences();
  const { toast } = useToast();

  /** Closed for this visit, so a successful answer does not wait on a re-read. */
  const [closed, setClosed] = useState(false);
  const [answering, setAnswering] = useState(false);

  const open =
    !closed &&
    shouldOfferPersonalizationPrompt({
      preferences: prefs.preferences,
      loading: prefs.loading,
      error: prefs.error,
      isStaff: app.isStaff,
      hasProgram: Boolean(app.program),
    });

  /**
   * Record the answer. A refusal leaves the prompt up — the only honest state,
   * since the server still has no record that this person was asked.
   */
  async function answer() {
    setAnswering(true);
    const message = await prefs.save({ personalize_seen: true });
    setAnswering(false);
    if (message) {
      toast.error(message);
      return;
    }
    setClosed(true);
  }

  return (
    <Sheet
      open={open}
      onClose={() => void answer()}
      title="Make it yours"
      description="Two choices for your account only — nobody else sees them."
      footer={
        <>
          <Button variant="secondary" block onClick={() => void answer()} loading={answering}>
            Skip
          </Button>
          <Button block onClick={() => void answer()} loading={answering}>
            Done
          </Button>
        </>
      }
    >
      <PersonalizationChoices />
    </Sheet>
  );
}

/**
 * The same prompt from Account settings → Preferences.
 *
 * A single "Done" footer rather than Skip/Done: there is nothing to decline
 * here, and closing it must leave the first-run stamp alone. The choices save
 * as they are tapped, exactly as in the sheet a new member meets.
 */
export function AppearancePromptSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Make it yours"
      description="The appearance prompt, reopened — nothing here records that you were asked again."
      footer={
        <Button block onClick={onClose}>
          Done
        </Button>
      }
    >
      <PersonalizationChoices />
    </Sheet>
  );
}

/** A button that opens the prompt on demand. Used beside Reset appearance. */
export function AppearancePromptButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<Palette className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      >
        Open the prompt
      </Button>
      <AppearancePromptSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
