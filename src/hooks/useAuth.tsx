import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import type { AuthAudience } from "../lib/constants";
import { getSignupAccountType, setSignupAccountType } from "../lib/rpc";
import { supabase } from "../lib/supabase";

/**
 * The signed-in session, from Supabase Auth.
 *
 * This is the whole of the app's idea of "who is signed in": one subscription to
 * Supabase Auth, plus the five calls the screens need. Everything below it —
 * `profiles`, memberships, roles, RLS — resolves the caller server-side from the
 * token this hook holds the mirror of, so no screen ever decides who they are.
 *
 * The identity that matters is `userId`: it is `auth.uid()`, the value stored in
 * `profiles.auth_user_id` (supabase/migrations/021), which is how the database
 * maps an account to a person.
 */

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  /** `auth.uid()` — the value `profiles.auth_user_id` holds. */
  userId: string | null;
  email: string | null;
  /** Self-declared at sign-up; determines whether this account may start programs. */
  accountType: AuthAudience | null;
  accountTypeLoading: boolean;
  accountTypeSetupError: string | null;
  /**
   * Whether Supabase Auth has confirmed this address
   * (`user.email_confirmed_at`). Shown on the account settings screen so a
   * person is never left guessing whether the confirmation link worked.
   */
  emailVerified: boolean;
  /**
   * Set when the page was opened from an email link Supabase had already
   * consumed (`otp_expired` / "Email link is invalid or has expired"). The
   * account is usually confirmed already; the notice says to sign in or use
   * the code from the same email.
   */
  authLinkError: string | null;
  /** Name the account was created with, if we ever asked for one. */
  displayName: string | null;
  /**
   * True when the page was opened from a password-recovery link. The app shows
   * "set a new password" and nothing else until that is done (or skipped).
   */
  recovering: boolean;
  clearRecovery: () => void;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: (redirectTo: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    audience: AuthAudience,
    displayName?: string
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<{ error: string | null }>;
  /** Re-send the sign-up confirmation; email confirmation is on for this project. */
  resendConfirmation: (email: string) => Promise<{ error: string | null }>;
  /**
   * Confirm with the `{{ .Token }}` code from the confirmation email. The
   * link in that email is single-use, and a mail scanner or a second click can
   * spend it; the code is the fallback the template promises. Its length is the
   * project's `mailer_otp_length` (8 on this project), so never hardcode six.
   */
  confirmEmail: (email: string, code: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
  /**
   * Start a change of the sign-in email. Supabase Auth owns the address, so
   * this only *asks*: the confirmation links it sends are what actually move it
   * (and with "secure email change" on, both the old and the new address must
   * be confirmed before anything changes). Nothing here is stored locally.
   */
  updateEmail: (email: string) => Promise<{ error: string | null }>;
  /** End every *other* session, keeping this device signed in. */
  signOutOthers: () => Promise<{ error: string | null }>;
  deleteAccount: () => Promise<{ error: string | null }>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Supabase's messages are accurate and technical; these are the handful students
 * actually meet, said the way the rest of the app talks. Anything not listed —
 * including any network or server fault — is passed through untouched, because
 * hiding it is how a "wrong password" ends up masking a broken deployment.
 */
function readable(message: string): string {
  const text = message.trim();

  // The minimum length is a project setting, not a constant: quote whatever the
  // server says rather than a number this file would have to guess.
  const tooShort = text.match(/password should be at least (\d+)/i);
  if (tooShort) return `Your password needs to be at least ${tooShort[1]} characters.`;

  const known: [RegExp, string][] = [
    [/invalid login credentials/i, "That email and password don't match. Check them and try again."],
    [/email not confirmed/i, "Confirm your email first — we sent you a link when you signed up."],
    [
      /user already registered/i,
      "That email already has an account. Sign in instead, or reset the password.",
    ],
    [
      /new password should be different/i,
      "That is your current password — pick a new one.",
    ],
    [/unable to validate email address|invalid format/i, "That doesn't look like an email address."],
    [
      /email rate limit exceeded|over_email_send_rate_limit/i,
      "Too many emails just now — wait a minute and try again.",
    ],
    // Delivery failed, not validation: GoTrue's transport answered a generic
    // 500. The transport is Resend's SMTP relay, so this is Resend refusing us
    // for a reason of its own — a domain that has not finished verifying, a
    // revoked key, or a rate limit. "Error sending confirmation email" tells a
    // student nothing and reads like their mistake, so name the side it is on
    // and give the one route that needs no email.
    [
      /error sending [a-z ]*email/i,
      "We couldn't send that email — that's on our side, not your account. Try again in a minute, or use Continue with Google with this same address to get in now.",
    ],
    [
      /token has expired|invalid.*(token|otp)|otp.*(expired|invalid)/i,
      "That code is wrong or has expired. Check the email, or send yourself a new one.",
    ],
    [
      /security purposes|only request this after/i,
      "Just a moment — wait a few seconds before trying that again.",
    ],
    [
      /auth session missing|session_not_found/i,
      "Your sign-in link has expired. Ask for a new one.",
    ],
  ];
  for (const [pattern, friendly] of known) {
    if (pattern.test(text)) return friendly;
  }
  return text || "Something went wrong. Try again.";
}

/**
 * A confirmation or recovery link that has already been used lands with
 * `#error=access_denied&error_code=otp_expired` (or a query-string equivalent).
 * Supabase has already confirmed the account on the first request, so this is
 * not a failure to hide: capture the code before supabase-js clears the URL,
 * remove it, and return a sentence the sign-in screen can show. Only the
 * one-time-token codes are treated this way — an OAuth `access_denied` is a
 * different refusal and keeps its existing path.
 */
function takeExpiredLinkNotice(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const read = (key: string) => hash.get(key) ?? url.searchParams.get(key);
  const errorCode = read("error_code");
  const description = read("error_description") ?? "";
  const expired =
    errorCode === "otp_expired" ||
    /email link is invalid or has expired|one-time token not found/i.test(description);
  if (!expired) return null;

  for (const key of ["error", "error_code", "error_description"]) {
    hash.delete(key);
    url.searchParams.delete(key);
  }
  url.hash = hash.toString();
  window.history.replaceState(window.history.state, "", url.toString());

  return "That email link has already been used or has expired. If your address is already confirmed, sign in below. If not, the code from the same email still works — or send yourself a new link.";
}

const initialAuthLinkError = takeExpiredLinkNotice();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [recovering, setRecovering] = useState(false);
  const [accountTypeSetupError, setAccountTypeSetupError] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<AuthAudience | null>(null);
  const [accountTypeLoading, setAccountTypeLoading] = useState(true);
  const [oauthAccountType] = useState<AuthAudience | null>(() => {
    const value = new URL(window.location.href).searchParams.get("account_type");
    return value === "student" || value === "teacher" ? value : null;
  });

  useEffect(() => {
    let active = true;

    // The stored session, if there is one — this is what makes a refresh keep
    // you signed in, and what makes the first paint after a reload correct
    // rather than a flash of the landing page.
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setStatus(data.session ? "signed-in" : "signed-out");
    });

    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      setSession(next);
      setStatus(next ? "signed-in" : "signed-out");
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      // A sign-out must drop the recovery screen too, or the next person on a
      // shared phone would land on a password form they cannot submit.
      if (event === "SIGNED_OUT") setRecovering(false);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setAccountType(null);
      setAccountTypeSetupError(null);
      setAccountTypeLoading(false);
      return;
    }

    let active = true;
    setAccountTypeLoading(true);
    const request = oauthAccountType
      ? setSignupAccountType(oauthAccountType)
      : getSignupAccountType();

    void request.then(({ accountType: storedType, error }) => {
      if (!active) return;
      setAccountType(storedType);
      setAccountTypeSetupError(error);
      setAccountTypeLoading(false);
      if (!error && oauthAccountType) {
        const url = new URL(window.location.href);
        url.searchParams.delete("account_type");
        window.history.replaceState(window.history.state, "", url.toString());
      }
    });

    return () => {
      active = false;
    };
  }, [session?.user.id, oauthAccountType]);

  const clearRecovery = useCallback(() => {
    setRecovering(false);
    // The token is spent once we have the new password; drop it from the URL so
    // a refresh (or a shared link) cannot replay it.
    const url = new URL(window.location.href);
    for (const key of ["code", "error", "error_description", "type"]) url.searchParams.delete(key);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    return { error: error ? readable(error.message) : null };
  }, []);

  const signInWithGoogle = useCallback(async (redirectTo: string) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    return { error: error ? readable(error.message) : null };
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, audience: AuthAudience, displayName?: string) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        // Supabase Auth is the record of "who is this account"; `profiles` is
        // the record of "who is this person", and it is created on the join
        // screen. The account type is a self-declared signup choice.
        options: {
          data: {
            account_type: audience,
            ...(displayName?.trim() ? { full_name: displayName.trim() } : {}),
          },
          emailRedirectTo: `${window.location.origin}/`,
        },
      });
      if (error) return { error: readable(error.message), needsConfirmation: false };
      // With email confirmation on (this project's setting) `signUp` returns
      // no session, so the person has to confirm before they can sign in.
      return { error: null, needsConfirmation: !data.session };
    },
    []
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    return { error: error ? readable(error.message) : null };
  }, []);

  const resendConfirmation = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    return { error: error ? readable(error.message) : null };
  }, []);

  const confirmEmail = useCallback(async (email: string, code: string) => {
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.replace(/\s+/g, ""),
      type: "signup",
    });
    return { error: error ? readable(error.message) : null };
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    return { error: error ? readable(error.message) : null };
  }, []);

  const updateEmail = useCallback(async (email: string) => {
    const { error } = await supabase.auth.updateUser(
      { email: email.trim() },
      { emailRedirectTo: `${window.location.origin}/settings` }
    );
    return { error: error ? readable(error.message) : null };
  }, []);

  /**
   * `scope: "others"` revokes every refresh token except this device's — the
   * right answer after a shared laptop or a password change. Unlike a global
   * sign-out it leaves the person where they are.
   */
  const signOutOthers = useCallback(async () => {
    const { error } = await supabase.auth.signOut({ scope: "others" });
    return { error: error ? readable(error.message) : null };
  }, []);

  const deleteAccount = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke<{ ok: boolean; error?: string }>(
      "delete-account"
    );
    if (error) {
      if (error.context instanceof Response) {
        const body = await error.context.clone().text();
        if (body) {
          try {
            const payload: unknown = JSON.parse(body);
            if (
              typeof payload === "object" &&
              payload !== null &&
              "error" in payload &&
              typeof payload.error === "string"
            ) {
              return { error: payload.error };
            }
          } catch (parseError) {
            if (!(parseError instanceof SyntaxError)) throw parseError;
          }
        }
      }
      return { error: readable(error.message) };
    }
    if (!data?.ok) return { error: data?.error ?? "Account deletion did not complete." };

    const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
    return {
      error: signOutError
        ? `Your account was deleted, but this device could not sign out: ${readable(signOutError.message)}`
        : null,
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      userId: session?.user?.id ?? null,
      email: session?.user?.email ?? null,
      accountType,
      accountTypeLoading,
      accountTypeSetupError,
      emailVerified: Boolean(session?.user?.email_confirmed_at),
      authLinkError: initialAuthLinkError,
      displayName:
        (session?.user?.user_metadata?.full_name as string | undefined)?.trim() || null,
      recovering,
      clearRecovery,
      signIn,
      signInWithGoogle,
      signUp,
      signOut,
      sendPasswordReset,
      resendConfirmation,
      confirmEmail,
      updatePassword,
      updateEmail,
      signOutOthers,
      deleteAccount,
    }),
    [
      status,
      session,
      accountType,
      accountTypeLoading,
      recovering,
      accountTypeSetupError,
      clearRecovery,
      signIn,
      signInWithGoogle,
      signUp,
      signOut,
      sendPasswordReset,
      resendConfirmation,
      confirmEmail,
      updatePassword,
      updateEmail,
      signOutOthers,
      deleteAccount,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The signed-in session. Only valid inside `<AuthProvider>`. */
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
