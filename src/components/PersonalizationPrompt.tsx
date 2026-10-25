import { useState } from "react";
import { Button, Field, SegmentedControl, Sheet, useToast } from "./ui";
import { BackgroundPicker } from "./BackgroundPicker";
import { shouldOfferPersonalizationPrompt } from "../lib/personalization";
import type { BackgroundId, ThemeChoice } from "../lib/types";
import { usePreferences } from "../hooks/usePreferences";
import { usePrograms } from "../hooks/usePrograms";

/**
 * The first-run appearance prompt.
 *
 * A student lands on the dashboard after joining and is offered the two choices
 * they can actually see the effect of — light/dark and the page behind the
 * panels — then is left alone. It is a Sheet because this is a phone-first app,
 * and it is *offered*, never enforced: skipping is one tap, nothing is gated on
 * it, and both settings stay editable in Account settings.
 *
 * Why it is only for students: a director already walks the guided setup, whose
 * last step carries these same controls (`AppearanceSettings`), so asking twice
 * would be the same question in two places.
 *
 * The choices are saved as they are tapped — the change *is* the feedback — and
 * answering either way stamps `personalization_prompt_seen_at`. That stamp is
 * separate from the teacher setup's `onboarding_completed_at` on purpose: a
 * student answering a two-line prompt must not consume a wizard they may later
 * need as a director (migration 20261026120000).
 */
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
          Both can be changed any time in Account settings → Preferences.
        </p>
      </div>
    </Sheet>
  );
}
