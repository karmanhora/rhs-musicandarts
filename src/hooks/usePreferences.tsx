import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getMyPreferences, setMyPreferences } from "../lib/rpc";
import {
  applyBackground,
  applyThemeChoice,
  DEFAULT_DASHBOARD_MODULES,
  DEFAULT_PREFERENCES,
  parsePreferences,
} from "../lib/personalization";
import type {
  BackgroundId,
  DashboardModuleId,
  ProfilePreferences,
  ThemeChoice,
} from "../lib/types";
import { useAuth } from "./useAuth";

/**
 * The signed-in person's own appearance and dashboard choices.
 *
 * Three jobs, and the split matters:
 *
 *   1. **Read once** after the session resolves, and paint. The database is the
 *      record; `lib/personalization.ts` owns the paint (and the `localStorage`
 *      copy the first frame used), so this hook never touches `<html>` directly.
 *   2. **Write through the server.** Every change is applied to the screen
 *      first — a theme toggle that waits for a round-trip feels broken — then
 *      saved. A refusal puts the previous value back and returns the sentence,
 *      which the caller shows in a toast. Nothing is silently swallowed.
 *   3. **Keep onboarding state.** `onboarding_completed_at` is the one field the
 *      guided setup writes; it never gates the app, it only decides whether the
 *      wizard is offered again.
 *
 * A failed read is not fatal: the screen keeps its defaults, the cached paint is
 * left alone (a network blip must not flip a dark app to light), and `error`
 * says what happened so Settings can show it.
 */

export interface PreferencePatch {
  theme?: ThemeChoice;
  background?: BackgroundId;
  dashboard_modules?: DashboardModuleId[];
  onboarding_completed?: boolean;
  /** Answering the first-run appearance prompt, whether saved or skipped. */
  personalize_seen?: boolean;
}

export interface PreferencesState {
  preferences: ProfilePreferences;
  loading: boolean;
  saving: boolean;
  /** Why the last read or write failed. Cleared by the next successful call. */
  error: string | null;
  /** Resolves to an error message, or null when the change was saved. */
  save: (patch: PreferencePatch) => Promise<string | null>;
  /** Back to the shipped appearance and dashboard, leaving setup state alone. */
  reset: () => Promise<string | null>;
  reload: () => Promise<void>;
}

const PreferencesContext = createContext<PreferencesState | null>(null);

/** What the screen should show immediately, before the server has answered. */
function merge(previous: ProfilePreferences, patch: PreferencePatch): ProfilePreferences {
  return {
    theme: patch.theme ?? previous.theme,
    background: patch.background ?? previous.background,
    dashboard_modules: patch.dashboard_modules ?? previous.dashboard_modules,
    onboarding_completed_at:
      patch.onboarding_completed === true
        ? (previous.onboarding_completed_at ?? new Date().toISOString())
        : patch.onboarding_completed === false
          ? null
          : previous.onboarding_completed_at,
    personalization_prompt_seen_at:
      patch.personalize_seen === true
        ? (previous.personalization_prompt_seen_at ?? new Date().toISOString())
        : patch.personalize_seen === false
          ? null
          : previous.personalization_prompt_seen_at,
  };
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [preferences, setPreferences] = useState<ProfilePreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The newest value, for reverting a refused save. State alone is not enough:
   * two quick toggles would both read the value from before the first one.
   */
  const latest = useRef(preferences);
  latest.current = preferences;

  /** Only the newest in-flight save may write its result back. */
  const saveSeq = useRef(0);

  const signedIn = auth.status === "signed-in";
  const authUserId = auth.userId;

  const reload = useCallback(async () => {
    if (!signedIn) {
      // Signed out: the provider is about to unmount, but resetting keeps a
      // stale value from being rendered for a frame during the transition.
      setPreferences(DEFAULT_PREFERENCES);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    const { data, error: readError } = await getMyPreferences();
    if (readError || !data) {
      // Keep the defaults *and* the cached paint: a failed read must not repaint
      // the screen to something the person did not choose.
      setError(readError ?? "Could not read your preferences.");
      setLoading(false);
      return;
    }

    const parsed = parsePreferences(data);
    setPreferences(parsed);
    latest.current = parsed;
    applyThemeChoice(parsed.theme);
    applyBackground(parsed.background);
    setError(null);
    setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void reload();
  }, [reload, authUserId]);

  const save = useCallback(async (patch: PreferencePatch): Promise<string | null> => {
    const previous = latest.current;
    const optimistic = merge(previous, patch);
    latest.current = optimistic;
    setPreferences(optimistic);

    // Paint before the request: these are the two choices whose feedback *is*
    // the change, and waiting for the network would make them feel laggy.
    if (patch.theme) applyThemeChoice(patch.theme);
    if (patch.background) applyBackground(patch.background);

    const seq = ++saveSeq.current;
    setSaving(true);

    const { data, error: saveError } = await setMyPreferences({
      theme: patch.theme ?? null,
      background: patch.background ?? null,
      dashboardModules: patch.dashboard_modules ?? null,
      onboardingCompleted: patch.onboarding_completed ?? null,
      personalizeSeen: patch.personalize_seen ?? null,
    });

    if (seq !== saveSeq.current) {
      // A newer save is in flight and owns the screen now.
      return saveError;
    }

    if (saveError || !data) {
      const message = saveError ?? "Your preferences could not be saved.";
      latest.current = previous;
      setPreferences(previous);
      applyThemeChoice(previous.theme);
      applyBackground(previous.background);
      setError(message);
      setSaving(false);
      return message;
    }

    const parsed = parsePreferences(data);
    latest.current = parsed;
    setPreferences(parsed);
    applyThemeChoice(parsed.theme);
    applyBackground(parsed.background);
    setError(null);
    setSaving(false);
    return null;
  }, []);

  const reset = useCallback(
    () =>
      save({
        theme: "system",
        background: "paper",
        dashboard_modules: [...DEFAULT_DASHBOARD_MODULES],
      }),
    [save]
  );

  const value = useMemo<PreferencesState>(
    () => ({ preferences, loading, saving, error, save, reset, reload }),
    [preferences, loading, saving, error, save, reset, reload]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

/** The signed-in person's preferences. Only valid inside `<PreferencesProvider>`. */
export function usePreferences(): PreferencesState {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used inside <PreferencesProvider>");
  return ctx;
}
