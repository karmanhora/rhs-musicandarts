/**
 * Appearance and dashboard choices that belong to a person, not a program.
 *
 * Three things live here, and nothing else:
 *
 *   1. The catalogue — which backgrounds and dashboard blocks exist, what they
 *      are called, and which column each block sits in. This is the *only* list;
 *      the database's allow-lists in migration 20261025120000 mirror it, and the
 *      parser below drops anything this build does not know about, so a row
 *      written by a newer build can never crash an older one.
 *   2. Resolution — a stored `theme` becomes "is the page dark right now".
 *   3. The paint cache — `localStorage`, written whenever a choice changes and
 *      read by `index.html` before React starts, which is what stops a saved
 *      appearance from flashing the default for one frame.
 *
 * The database is the record (`my_preferences()` / `set_my_preferences()`); the
 * cache is only a copy for the first paint. `usePreferences` keeps them in step.
 *
 * Deliberately absent: per-program defaults. `ensemble_theme_tokens` paints the
 * program palette and stays read-only to clients; a person's background is their
 * own and never changes for anybody else.
 */
import type {
  BackgroundId,
  DashboardModuleId,
  ProfilePreferences,
  ThemeChoice,
} from "./types";

/** Effective light/dark choice, in `localStorage`. `index.html` reads the same key. */
export const DARK_STORAGE_KEY = "rhs-band:dark";

/** Background id for the first paint. `index.html` reads the same key. */
export const BACKGROUND_STORAGE_KEY = "rhs:appearance:background";

/** Fired after any write, so every `useDark()` in the tree reacts together. */
export const DARK_EVENT = "rhs-band:dark-changed";

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

export interface BackgroundOption {
  id: BackgroundId;
  label: string;
  /** One line, written for somebody choosing; not marketing copy. */
  description: string;
}

/**
 * Four restrained treatments, all drawn from existing tokens — no image, no
 * gradient, no blur. Each is a `data-background` value on `<html>`; the CSS in
 * `index.css` turns it into a page colour and, for the last two, hairline rules
 * built from `--cue-line` so both themes stay legible.
 *
 * There is no "raised" treatment on purpose: `--cue-leaf` measures 4.47:1 on
 * `--cue-raised`, which is under AA for the text links that sit on the page
 * (docs/DESIGN_SYSTEM.md). A treatment must not quietly fail the contrast bar.
 */
export const BACKGROUNDS: BackgroundOption[] = [
  { id: "paper", label: "Paper", description: "The standard cream page." },
  { id: "mint", label: "Rehearsal", description: "A soft green wash behind the panels." },
  { id: "ruled", label: "Ruled", description: "Faint horizontal rules, like a score pad." },
  { id: "grid", label: "Grid", description: "A quiet 32px grid across the page." },
];

export type ModuleColumn = "main" | "aside";

export type ModuleAudience = "everyone" | "staff" | "student";

export interface DashboardModuleOption {
  id: DashboardModuleId;
  label: string;
  description: string;
  /** Which of the dashboard's two columns it belongs to. */
  column: ModuleColumn;
  /**
   * Who it can appear for. A block that does not apply is skipped at render and
   * not offered in settings — but it may still sit in a saved list, which is why
   * the parser keeps it rather than rewriting somebody's order.
   */
  audience: ModuleAudience;
}

/**
 * The dashboard's optional blocks. The next-event panel is *not* here: it is the
 * page's focal point and cannot be hidden, so there is no stored value for it.
 */
export const DASHBOARD_MODULES: DashboardModuleOption[] = [
  {
    id: "coming_up",
    label: "Coming up",
    description: "The next few events, with dates and times.",
    column: "main",
    audience: "everyone",
  },
  {
    id: "my_attendance",
    label: "Your attendance",
    description: "Your rate across required events, and the events behind it.",
    column: "main",
    audience: "everyone",
  },
  {
    id: "my_programs",
    label: "Your programs",
    description: "Every program you are on, and a way to switch.",
    column: "aside",
    audience: "everyone",
  },
  {
    id: "program_facts",
    label: "Program at a glance",
    description: "Events ahead, sections, your role and your memberships.",
    column: "aside",
    audience: "staff",
  },
  {
    id: "quick_links",
    label: "Quick links",
    description: "Check in and the calendar, one tap away.",
    column: "aside",
    audience: "student",
  },
];

/** The shipped layout: the same blocks, in the same order, as before. */
export const DEFAULT_DASHBOARD_MODULES: DashboardModuleId[] = DASHBOARD_MODULES.map((m) => m.id);

export const DEFAULT_PREFERENCES: ProfilePreferences = {
  theme: "system",
  background: "paper",
  dashboard_modules: [...DEFAULT_DASHBOARD_MODULES],
  onboarding_completed_at: null,
  personalization_prompt_seen_at: null,
};

/**
 * Whether the first-run appearance prompt still applies to this person.
 *
 * Only students are asked: staff have the fuller guided setup, which already
 * carries the same two controls. A program is required for the same reason —
 * somebody who has not joined anywhere has nothing to personalize yet.
 */
export function shouldOfferPersonalizationPrompt({
  preferences,
  loading,
  error,
  isStaff,
  hasProgram,
}: {
  preferences: ProfilePreferences;
  loading: boolean;
  /** A failed read means we cannot know; asking would be a guess, and answering it would fail. */
  error: string | null;
  isStaff: boolean;
  hasProgram: boolean;
}): boolean {
  return (
    !loading &&
    !error &&
    hasProgram &&
    !isStaff &&
    preferences.personalization_prompt_seen_at === null
  );
}

export const THEMES: ThemeChoice[] = ["system", "light", "dark"];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEMES as string[]).includes(value);
}

export function isBackgroundId(value: unknown): value is BackgroundId {
  return typeof value === "string" && BACKGROUNDS.some((option) => option.id === value);
}

export function isDashboardModuleId(value: unknown): value is DashboardModuleId {
  return typeof value === "string" && DASHBOARD_MODULES.some((option) => option.id === value);
}

/** Whether a block can appear for this person. Mirrors the screens' gates. */
export function moduleApplies(
  option: DashboardModuleOption,
  { isStaff }: { isStaff: boolean }
): boolean {
  if (option.audience === "everyone") return true;
  return option.audience === "staff" ? isStaff : !isStaff;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn `my_preferences()`'s jsonb into something this build can render.
 *
 * Unknown values fall back to the default; unknown blocks are dropped; a
 * repeated block keeps its first position. An explicitly empty list is honoured
 * (a page with only the next-event panel is a legitimate choice), which is why
 * the fallback is only used when the field is not an array at all.
 */
export function parsePreferences(value: unknown): ProfilePreferences {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  const theme = isThemeChoice(source.theme) ? source.theme : DEFAULT_PREFERENCES.theme;
  const background = isBackgroundId(source.background)
    ? source.background
    : DEFAULT_PREFERENCES.background;

  const rawModules = Array.isArray(source.dashboard_modules)
    ? source.dashboard_modules
    : DEFAULT_DASHBOARD_MODULES;

  const seen = new Set<DashboardModuleId>();
  const modules: DashboardModuleId[] = [];
  for (const entry of rawModules) {
    if (!isDashboardModuleId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    modules.push(entry);
  }

  const timestamp = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null;

  return {
    theme,
    background,
    dashboard_modules: modules,
    onboarding_completed_at: timestamp(source.onboarding_completed_at),
    personalization_prompt_seen_at: timestamp(source.personalization_prompt_seen_at),
  };
}

/* -------------------------------------------------------------------------- */
/* Light and dark                                                             */
/* -------------------------------------------------------------------------- */

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function osPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

/** The stored choice, or `null` when the device's own preference wins. */
export function storedDark(): boolean | null {
  try {
    const stored = localStorage.getItem(DARK_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    /* private mode — fall through to the OS preference */
  }
  return null;
}

export function preferredDark(): boolean {
  return storedDark() ?? osPrefersDark();
}

/** A stored theme becomes the one boolean the stylesheet understands. */
export function resolveDark(theme: ThemeChoice): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return osPrefersDark();
}

export function paintDark(dark: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", dark);
  // Let the browser tint form controls / scrollbars to match.
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0c0f0a" : "#2d5a1b");
}

/**
 * Write the light/dark choice and paint it. `null` clears the stored value, so
 * the device's own preference takes over again (this is what "Follow device"
 * means, and it keeps following the OS when it changes).
 */
export function setDarkPreference(dark: boolean | null): void {
  try {
    if (dark === null) localStorage.removeItem(DARK_STORAGE_KEY);
    else localStorage.setItem(DARK_STORAGE_KEY, String(dark));
  } catch {
    /* private mode — the paint below still applies for this session */
  }
  paintDark(dark ?? osPrefersDark());
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DARK_EVENT));
}

export function applyThemeChoice(theme: ThemeChoice): void {
  setDarkPreference(theme === "system" ? null : theme === "dark");
}

/* -------------------------------------------------------------------------- */
/* Background                                                                 */
/* -------------------------------------------------------------------------- */

export function readCachedBackground(): BackgroundId {
  try {
    const stored = localStorage.getItem(BACKGROUND_STORAGE_KEY);
    return isBackgroundId(stored) ? stored : "paper";
  } catch {
    return "paper";
  }
}

/**
 * Apply a page treatment. The class on `<html>` is the whole mechanism: each
 * value sets `--app-page-color` and, for the ruled and grid treatments, an
 * `--app-page-image` of hairlines. Nothing here knows a colour.
 */
export function applyBackground(background: BackgroundId): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-background", background);
  }
  try {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, background);
  } catch {
    /* private mode — the page looks right until the next reload */
  }
}

/**
 * Forget the appearance held on this device.
 *
 * Called when the session ends. On a shared phone the next person must never see
 * the last one's background or dark-mode choice — not even for one frame — so
 * this also repaints to the device's own preference rather than leaving the old
 * values on `<html>` until the next screen happens to mount.
 */
export function clearAppearanceCache(): void {
  try {
    localStorage.removeItem(BACKGROUND_STORAGE_KEY);
    localStorage.removeItem(DARK_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-background", "paper");
  }
  paintDark(osPrefersDark());
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DARK_EVENT));
}
