import { DEFAULT_THEME_TOKENS } from "./constants";

/**
 * Semantic token → CSS variable. The token *structure* is shared by every
 * program; only the values differ, so re-theming is a data change (the
 * `ensemble_theme_tokens` row) — never a code change.
 */
const TOKEN_TO_CSS_VAR: Record<string, string> = {
  primary: "--band-primary",
  primaryDeep: "--band-primary-deep",
  accent: "--band-accent",
  surface: "--band-surface",
  ink: "--band-ink",
};

/** Paint the app with a program's tokens (unknown keys are ignored). */
export function applyThemeTokens(tokens?: Record<string, string> | null): void {
  const root = document.documentElement;
  for (const [token, cssVar] of Object.entries(TOKEN_TO_CSS_VAR)) {
    const value = tokens?.[token] ?? DEFAULT_THEME_TOKENS[token];
    if (value) root.style.setProperty(cssVar, value);
  }
  // Keep the browser/OS chrome (address bar, PWA title bar) in step.
  const themeColor = tokens?.primary ?? DEFAULT_THEME_TOKENS.primary;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor ?? "#2d5a1b");
}
