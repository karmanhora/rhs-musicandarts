import { App } from "@capacitor/app";
import { AppLauncher } from "@capacitor/app-launcher";
import { Capacitor } from "@capacitor/core";
import type { AuthAudience } from "./constants";
import { supabase } from "./supabase";

/**
 * The scheme registered in `ios/App/App/Info.plist` and in Supabase's
 * Authentication → URL Configuration → Redirect URLs. Both must stay in step:
 * a redirect that Supabase does not recognise is replaced with the Site URL,
 * which would leave the app on the website instead of returning here.
 */
export const NATIVE_AUTH_SCHEME = "org.rhsattendance.app";
export const NATIVE_AUTH_REDIRECT = `${NATIVE_AUTH_SCHEME}://auth-callback`;

/**
 * Apple guideline 4.8: the App Store build ships email + password only unless
 * the owner explicitly adds an equally prominent privacy-preserving login.
 * The `ios-dev` Vite mode turns Google on for the local simulator; the `ios`
 * release mode never reads that development flag.
 */
export const NATIVE_GOOGLE_SIGNIN =
  import.meta.env.VITE_NATIVE_GOOGLE_SIGNIN === "true";

const PENDING_OAUTH_KEY = "rhs-music-arts-native-oauth";
const PENDING_OAUTH_MAX_AGE_MS = 30 * 60 * 1000;

export interface NativeOAuthPending {
  accountType?: AuthAudience;
  returnTo: string;
}

/**
 * Remember the sign-up choice and destination before leaving for Google.
 *
 * iOS can terminate the app while the system browser is open, so this cannot
 * live in React state or `sessionStorage`: it has to survive a cold launch.
 * Only the route and the declared audience are stored — never a token.
 */
export function rememberNativeOAuth(pending: NativeOAuthPending): void {
  try {
    window.localStorage.setItem(
      PENDING_OAUTH_KEY,
      JSON.stringify({ ...pending, savedAt: Date.now() })
    );
  } catch {
    /* Private mode or storage unavailable: sign-in still works, just without the handoff. */
  }
}

/** Drop a pending handoff that will not be completed (an OAuth start error). */
export function clearNativeOAuth(): void {
  try {
    window.localStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Consume the handoff saved before OAuth; expired or malformed state is ignored. */
export function takeNativeOAuth(): NativeOAuthPending | null {
  try {
    const raw = window.localStorage.getItem(PENDING_OAUTH_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(PENDING_OAUTH_KEY);

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as {
      accountType?: unknown;
      returnTo?: unknown;
      savedAt?: unknown;
    };
    if (
      typeof value.savedAt !== "number" ||
      Date.now() - value.savedAt > PENDING_OAUTH_MAX_AGE_MS
    ) {
      return null;
    }

    const accountType =
      value.accountType === "student" || value.accountType === "teacher"
        ? value.accountType
        : undefined;
    const returnTo =
      typeof value.returnTo === "string" &&
      value.returnTo.startsWith("/") &&
      !value.returnTo.startsWith("//")
        ? value.returnTo
        : "/";

    return { accountType, returnTo };
  } catch {
    return null;
  }
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativeAuthRedirect(): string {
  return NATIVE_AUTH_REDIRECT;
}

export interface NativeAuthOutcome {
  /** False for a deep link that is not an auth callback. */
  handled: boolean;
  /** The link was a password-recovery link. */
  recovery: boolean;
  error: string | null;
}

const NOT_HANDLED: NativeAuthOutcome = { handled: false, recovery: false, error: null };

function failure(message: string): NativeAuthOutcome {
  return { handled: true, recovery: false, error: message };
}

/**
 * Finish a Supabase Auth redirect delivered by iOS.
 *
 * Supabase's implicit flow appends the session to the redirect URL's fragment
 * (`#access_token=…&refresh_token=…`). The app's document URL is the Capacitor
 * origin, not that callback, so `detectSessionInUrl` cannot see it; this reads
 * it explicitly. The code and token-hash branches are here for links that use
 * the other Supabase flows.
 */
export async function completeNativeAuth(rawUrl: string): Promise<NativeAuthOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return NOT_HANDLED;
  }

  if (url.protocol !== `${NATIVE_AUTH_SCHEME}:`) return NOT_HANDLED;

  const target = url.hostname || url.pathname.replace(/^\/+/, "");
  if (target !== "auth-callback") return NOT_HANDLED;

  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const read = (key: string) => hash.get(key) ?? url.searchParams.get(key);

  const type = read("type");
  const errorMessage = read("error_description") ?? read("error");
  if (errorMessage) {
    return failure(errorMessage === "access_denied" ? "Sign-in was cancelled." : errorMessage);
  }

  const accessToken = read("access_token");
  const refreshToken = read("refresh_token");
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) return failure(error.message);
    return { handled: true, recovery: type === "recovery", error: null };
  }

  const code = read("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failure(error.message);
    return { handled: true, recovery: type === "recovery", error: null };
  }

  const tokenHash = read("token_hash");
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as Parameters<typeof supabase.auth.verifyOtp>[0]["type"],
    });
    if (error) return failure(error.message);
    return { handled: true, recovery: type === "recovery", error: null };
  }

  return failure("The sign-in link did not include a session.");
}

/**
 * Open the OAuth URL in the system browser. Google refuses its sign-in page in
 * an embedded WKWebView, and SFSafariViewController does not reliably hand a
 * custom-scheme redirect back to the app; the system browser plus a registered
 * scheme is the dependable iOS path.
 */
export async function openNativeOAuth(url: string): Promise<string | null> {
  try {
    const { completed } = await AppLauncher.openUrl({ url });
    return completed ? null : "Could not open the system browser.";
  } catch (error) {
    return error instanceof Error ? error.message : "Could not open the system browser.";
  }
}

/**
 * Listen for auth callbacks while the app is running, and consume the URL that
 * launched it when iOS starts the app cold from a link.
 */
export async function listenForNativeAuth(
  onOutcome: (outcome: NativeAuthOutcome) => void
): Promise<() => void> {
  if (!isNativeApp()) return () => undefined;

  let disposed = false;
  const seen = new Set<string>();

  const handle = (rawUrl: string) => {
    if (disposed || seen.has(rawUrl)) return;
    seen.add(rawUrl);
    void completeNativeAuth(rawUrl)
      .then((outcome) => {
        if (!disposed && outcome.handled) onOutcome(outcome);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        onOutcome({
          handled: true,
          recovery: false,
          error: error instanceof Error ? error.message : "Could not complete sign-in.",
        });
      });
  };

  const listener = await App.addListener("appUrlOpen", ({ url }) => handle(url));
  if (disposed) {
    void listener.remove();
    return () => undefined;
  }

  void App.getLaunchUrl()
    .then((launch) => {
      if (launch?.url) handle(launch.url);
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    void listener.remove();
  };
}
