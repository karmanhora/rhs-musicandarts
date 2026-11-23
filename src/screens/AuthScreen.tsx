import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, KeyRound, MailCheck } from "lucide-react";
import { Alert, Button, Field, Input, SegmentedControl, useToast } from "../components/ui";
import { GoogleMark } from "../components/GoogleMark";
import { APP_NAME, readAuthAudience, writeAuthAudience } from "../lib/constants";
import type { AuthAudience } from "../lib/constants";
import { isNativeApp } from "../lib/nativeAuth";
import { useAuth } from "../hooks/useAuth";

type AuthMode = "sign-in" | "sign-up" | "forgot" | "reset";

/**
 * Copy that changes with the audience picked above the form. The form
 * underneath never remounts, so nothing typed is lost when the choice flips.
 */
const AUDIENCE_COPY: Record<
  AuthAudience,
  { kickerUp: string; signUpSub: string; signUpNote: string; afterConfirm: string }
> = {
  student: {
    kickerUp: "New student account",
    afterConfirm: "then enter your program’s join code.",
    signUpSub: "Use the email you want associated with your program.",
    signUpNote:
      "After creating your account, enter your program’s join code. Ask your director if you need one.",
  },
  teacher: {
    kickerUp: "New teacher account",
    afterConfirm: "then enter the teacher invitation code your school issued you.",
    signUpSub:
      "Use your school email — a teacher invitation code is checked against the address on your account.",
    signUpNote:
      "Next, enter the invitation code your school issued you. Until it is verified you keep ordinary student access; once it is verified you can start a program of your own and you’re its director — the roster, attendance and live check-in tools come with it.",
  },
};

/** Headline, sub-heading and aside copy for each mode. */
const MODE_COPY: Record<AuthMode, { title: string; aside: string; asideSub: string }> = {
  "sign-in": {
    title: "Sign in",
    aside: "Sign in to your program.",
    asideSub: "Your events, check-in, and attendance are waiting here.",
  },
  "sign-up": {
    title: "Create your account",
    aside: "Join your program.",
    asideSub:
      "Create your account, then enter the join code your director shared — or, as a teacher, the invitation code your school issued.",
  },
  forgot: {
    title: "Reset your password",
    aside: "Forgot your password?",
    asideSub: "Tell us your email and we'll send you a link to set a new one.",
  },
  reset: {
    title: "Choose a new password",
    aside: "Set a new password.",
    asideSub: "Pick something you'll remember — then you're straight back to your attendance.",
  },
};

/**
 * The sign-in surface, in four modes: sign in, create an account, ask for a
 * password-reset link, and set a new password from that link.
 *
 * One component rather than four screens, because they are the same page: the
 * same branded panel, the same student/teacher choice, the same form controls —
 * only the fields and the words change. It replaces Clerk's hosted `<SignIn />`
 * / `<SignUp />` components with forms bound to Supabase Auth, keeping the
 * layout, the copy and the audience switch exactly as they were.
 */
export function AuthScreen({ mode }: { mode: AuthMode }) {
  const auth = useAuth();
  const native = isNativeApp();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // A scanned QR code's deep link arrives as `/checkin?token=…`. Signing in has
  // to finish where the person was going, not on the home screen.
  const token = params.get("token");
  const afterAuth = token ? `/checkin?token=${encodeURIComponent(token)}` : null;

  const [audience, setAudience] = useState<AuthAudience>(() => {
    const fromUrl = params.get("role");
    if (fromUrl === "teacher" || fromUrl === "student") return fromUrl;
    return readAuthAudience();
  });

  // An address handed over from another auth screen (`/sign-in?email=…`) — the
  // "sign in instead" step after a sign-up met an existing account, or after a
  // confirmation link turned out to be spent. Nobody should retype it.
  const [email, setEmail] = useState(() => params.get("email")?.trim() ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Guidance, not a failure: "that email already has an account", "that code is
   * spent, use your password". Warn-toned and never phrased as the person's
   * mistake, because these are ordinary states of signing up, not errors.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /** Sign-up found an existing account; offer the sign-in door explicitly. */
  const [existingAccount, setExistingAccount] = useState(false);
  /** Sign-up with confirmation switched on: nothing to do but check the inbox. */
  const [awaitingEmail, setAwaitingEmail] = useState(false);
  /** The one error that has an action attached ("Resend the link"). */
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [sent, setSent] = useState(false);
  /** The numeric fallback from the confirmation email ({{ .Token }}). */
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);

  const copy = AUDIENCE_COPY[audience];
  const headline = MODE_COPY[mode];

  useEffect(() => {
    writeAuthAudience(audience);
  }, [audience]);

  // Moving between modes must never carry an error or a half-filled form across.
  useEffect(() => {
    setError(null);
    setNotice(null);
    setPassword("");
    setConfirm("");
    setNeedsConfirmation(false);
    setExistingAccount(false);
    setSent(false);
    setAwaitingEmail(false);
    setCode("");
    setCodeBusy(false);
  }, [mode]);

  /** Remembered in the URL (shareable) and the session (survives a reload). */
  function chooseAudience(next: AuthAudience): void {
    if (next === audience) return;
    setAudience(next);
    writeAuthAudience(next);
    const nextParams = new URLSearchParams(params);
    nextParams.set("role", next);
    setParams(nextParams, { replace: true });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setNeedsConfirmation(false);
    setExistingAccount(false);

    if ((mode === "sign-up" || mode === "reset") && password !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }

    setBusy(true);

    if (mode === "sign-in") {
      const { error: failure } = await auth.signIn(email, password);
      setBusy(false);
      if (failure) {
        setError(failure);
        setNeedsConfirmation(/confirm your email/i.test(failure));
        return;
      }
      if (afterAuth) navigate(afterAuth, { replace: true });
      return;
    }

    if (mode === "sign-up") {
      const { error: failure, needsConfirmation, existingAccount: already } = await auth.signUp(
        email,
        password,
        audience
      );
      setBusy(false);
      if (failure) {
        setError(failure);
        return;
      }
      if (already) {
        // Not a fault: this address is already registered. Say which door to
        // use and carry the address over, rather than "check your email" for a
        // message Supabase deliberately does not send.
        setExistingAccount(true);
        setNotice(
          "That email already has an account. Sign in with your password — or reset it if you don't remember it."
        );
        return;
      }
      if (needsConfirmation) setAwaitingEmail(true);
      return;
    }

    if (mode === "forgot") {
      const { error: failure } = await auth.sendPasswordReset(email);
      setBusy(false);
      if (failure) {
        setError(failure);
        return;
      }
      setSent(true);
      return;
    }

    // mode === "reset"
    const { error: failure } = await auth.updatePassword(password);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    toast.success("Password updated.");
    auth.clearRecovery();
    navigate("/", { replace: true });
  }

  async function resend() {
    setBusy(true);
    const { error: failure } = await auth.resendConfirmation(email);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    toast.success("Sent — check your inbox.");
  }

  /**
   * Confirm with the code instead of the link.
   *
   * Three things this gets right, because each used to be an error on screen:
   *
   *   1. The code needs the address it was sent to. Asking the server without
   *      one answered "Only an email address or phone number should be provided
   *      on verify" — a raw API sentence in a red alert.
   *   2. The link and the code are the same one-time token, so using one spends
   *      the other. A spent token means the address is confirmed already: try
   *      the password we already have, and say so when that does not work.
   *   3. Its length is the project's `mailer_otp_length` (8 here), so accept up
   *      to 10 digits rather than assuming six.
   */
  async function confirmWithCode() {
    setError(null);
    setNotice(null);

    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setNotice("Enter the email address you signed up with, then the code below.");
      return;
    }

    const clean = code.replace(/\s+/g, "");
    if (!/^\d{4,10}$/.test(clean)) {
      setNotice("Enter the code from the confirmation email.");
      return;
    }

    setCodeBusy(true);
    const { error: failure, spent } = await auth.confirmEmail(address, clean);
    setCodeBusy(false);
    if (!failure) {
      toast.success("Email confirmed.");
      navigate(afterAuth ?? "/", { replace: true });
      return;
    }

    if (spent) {
      // The address is almost certainly confirmed already (that is what spends
      // the token), so a password that is already typed should just work.
      if (password) {
        setCodeBusy(true);
        const { error: signInFailure } = await auth.signIn(address, password);
        setCodeBusy(false);
        if (!signInFailure) {
          toast.success("Your email is confirmed — welcome in.");
          navigate(afterAuth ?? "/", { replace: true });
          return;
        }
      }
      setNotice(
        "That code has already been used or has expired. A used link means your email is confirmed — sign in with your password to continue, or send yourself a new link."
      );
      return;
    }

    setError(failure);
  }

  async function continueWithGoogle() {
    setError(null);
    setBusy(true);
    const redirectUrl = new URL(afterAuth ?? "/", window.location.origin);
    if (mode === "sign-up") {
      redirectUrl.searchParams.set("account_type", audience);
    } else {
      redirectUrl.searchParams.delete("account_type");
    }
    const redirectTo = redirectUrl.toString();
    const { error: failure } = await auth.signInWithGoogle(redirectTo, {
      // The web build carries these in the redirect URL; the native build
      // stores them because iOS may cold-launch the app from the callback.
      accountType: mode === "sign-up" ? audience : undefined,
      returnTo: afterAuth ?? "/",
    });
    // On native this returns as soon as the system browser opens; on web the
    // page is already navigating away. Either way, don't leave the button
    // spinning if the person comes back without finishing.
    setBusy(false);
    if (failure) setError(failure);
  }

  /* --- dead ends that deserve a whole panel rather than a form ------------ */

  if (mode === "reset" && !auth.userId) {
    return (
      <AuthLayout mode={mode}>
        <p className="type-label text-[var(--cue-green)]">
          Link expired
        </p>
        <h2 className="type-title mt-2">
          {headline.title}
        </h2>
        <p className="type-meta mt-2">
          That link has already been used, or it belongs to another browser. Ask for a fresh one and
          it will work.
        </p>
        <div className="mt-6 space-y-3">
          <Link to="/forgot-password" className="block">
            <Button block size="lg" icon={<KeyRound className="h-4 w-4" />}>
              Email me a new link
            </Button>
          </Link>
          <Link to="/sign-in" className="block">
            <Button block variant="secondary">
              Back to sign in
            </Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const codeEntry = (
    <div className="rounded-[var(--radius-panel)] border border-[var(--cue-line)] bg-[var(--cue-raised)] p-4">
      <p className="type-label text-[var(--cue-green)]">Have the code?</p>
      <p className="type-meta mt-1">
        The link and this code are the same one-time pass — whichever you use first uses it up.
        {mode === "sign-in" ? " Enter your email above, then the code." : null}
      </p>
      <div className="mt-3 space-y-3">
        <Field label="Confirmation code">
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={10}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="12345678"
            className={native ? "auth-stage-input" : undefined}
          />
        </Field>
        <Button
          type="button"
          block
          variant="secondary"
          loading={codeBusy}
          onClick={() => void confirmWithCode()}
        >
          Confirm with code
        </Button>
      </div>
    </div>
  );

  if (awaitingEmail) {
    return (
      <AuthLayout mode={mode}>
        <MailCheck aria-hidden="true" className="h-5 w-5 text-[var(--cue-green)]" />
        <h2 className="type-title mt-2">
          Check your email
        </h2>
        <p className="type-meta mt-2">
          We sent a confirmation link to{" "}
          <span className="font-semibold text-[var(--cue-ink)]">{email.trim()}</span>. Open it and
          you&rsquo;re in — {copy.afterConfirm}
        </p>
        {error ? (
          <div className="mt-4">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        {notice ? (
          <div className="mt-4">
            <Alert tone="warn">{notice}</Alert>
          </div>
        ) : null}
        <div className="mt-4">{codeEntry}</div>
        <div className="mt-6 space-y-3">
          <Button block variant="secondary" loading={busy} onClick={() => void resend()}>
            Send it again
          </Button>
          <Link
            to={`/sign-in?email=${encodeURIComponent(email.trim())}`}
            className="block"
          >
            <Button block variant="ghost">
              Sign in instead
            </Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout mode={mode}>
        <MailCheck aria-hidden="true" className="h-5 w-5 text-[var(--cue-green)]" />
        <h2 className="type-title mt-2">
          Check your email
        </h2>
        <p className="type-meta mt-2">
          If an account exists for{" "}
          <span className="font-semibold text-[var(--cue-ink)]">{email.trim()}</span>, a link to set
          a new password is on its way. It expires in an hour.
        </p>
        <div className="mt-6">
          <Link to="/sign-in" className="block">
            <Button block variant="secondary">
              Back to sign in
            </Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  /* --- the forms ---------------------------------------------------------- */

  const showsAudience = mode === "sign-up";
  const supportsGoogle = mode === "sign-in" || mode === "sign-up";
  const isSignIn = mode === "sign-in";
  const nativeSignUpNote =
    audience === "teacher"
      ? "Next, enter the teacher invitation code your school issued."
      : "Next, enter the join code your director shared.";
  /** Inline links keep their text treatment but get a 44px touch box. */
  const nativeLegalLink =
    "inline-flex min-h-11 items-center align-middle font-semibold underline underline-offset-2";
  /**
   * Presentation only: the auth provider returns one form-level error string,
   * so use that existing message to decide which fields look invalid. No
   * validation or error handling changes here — the message itself is unchanged.
   */
  const errorText = native ? (error ?? "") : "";
  const emailInvalid = Boolean(errorText && /email|invalid login|credentials|confirm/i.test(errorText));
  const passwordInvalid = Boolean(errorText && /password|invalid login|credentials/i.test(errorText));
  const confirmInvalid = Boolean(errorText && /those two passwords don't match/i.test(errorText));
  const stageInputClass = (invalid: boolean): string | undefined =>
    native ? `auth-stage-input${invalid ? " auth-stage-input--error" : ""}` : undefined;

  return (
    <AuthLayout mode={mode}>
      {showsAudience ? (
        <SegmentedControl
          className={`auth-audience ${native ? "mb-4" : "mb-5"}`}
          value={audience}
          onChange={chooseAudience}
          options={[
            { value: "student", label: "I’m a student" },
            { value: "teacher", label: "I’m a teacher" },
          ]}
        />
      ) : null}

      {/* Keyed to the audience: the copy re-reveals on a switch while the form
          below stays mounted with everything typed. The native shell carries
          the visible stage headline, so its form starts at the fields. */}
      {native ? null : (
        <div key={showsAudience ? audience : mode} className="cue-stagger">
          {mode === "sign-up" ? (
            <div className="mb-1 flex items-center gap-3 md:hidden">
              <Link
                viewTransition
                to="/"
                aria-label="Back to the program"
                className="motion-press inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--cue-ink)]"
              >
                <ArrowLeft aria-hidden="true" className="h-5 w-5" />
              </Link>
              <img
                src="/logo.svg"
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 shrink-0 rounded-[8px]"
              />
              <h2 className="type-title whitespace-nowrap text-[1.25rem] leading-tight">Create account</h2>
            </div>
          ) : null}
          <p
            className={`type-label text-[var(--cue-green)]${
              mode === "sign-up" ? " hidden md:block" : ""
            }`}
          >
            {isSignIn
              ? "Welcome back"
              : mode === "sign-up"
                ? copy.kickerUp
                : mode === "forgot"
                  ? "Password help"
                  : "Recovery link"}
          </p>
          <h2
            className={`type-title mt-2${mode === "sign-up" ? " hidden md:block" : ""}`}
          >
            {isSignIn ? "Sign in" : headline.title}
          </h2>
          <p
            className={`type-meta mt-2${
              mode === "sign-up" ? " auth-web-signup-sub" : ""
            }`}
          >
            {isSignIn ? (
              "Sign in to open your programs and attendance."
            ) : mode === "sign-up" ? (
              <>
                <span className="auth-web-signup-sub-full">{copy.signUpSub}</span>
                <span className="auth-web-signup-sub-short">
                  {audience === "teacher" ? "Use your school email." : "Use your program email."}
                </span>
              </>
            ) : (
              headline.asideSub
            )}
          </p>
        </div>
      )}

      <form
        className={
          native
            ? "auth-stage-form"
            : mode === "sign-up"
              ? "auth-web-signup-form"
              : "mt-4 space-y-3"
        }
        onSubmit={(e) => void submit(e)}
      >
        {auth.authLinkError ? <Alert tone="warn">{auth.authLinkError}</Alert> : null}
        {error && !native ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="warn">{notice}</Alert> : null}
        {existingAccount ? (
          <Link
            to={`/sign-in?email=${encodeURIComponent(email.trim())}`}
            className="block"
          >
            <Button block variant="secondary">
              Go to sign in
            </Button>
          </Link>
        ) : null}

        <Field label="Email" className={native ? "auth-stage-field" : undefined}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            className={stageInputClass(emailInvalid)}
            aria-invalid={emailInvalid ? true : undefined}
            aria-describedby={native && error ? "auth-form-error" : undefined}
          />
        </Field>

        {mode === "forgot" ? null : (
          <Field
            label={mode === "sign-in" ? "Password" : "New password"}
            labelAction={
              native && isSignIn ? (
                <Link to="/forgot-password" className="auth-stage-label-action">
                  Forgot password?
                </Link>
              ) : native && mode === "sign-up" ? (
                <span className="auth-stage-label-hint">8+ characters</span>
              ) : undefined
            }
            hint={
              mode === "sign-in" || (native && mode === "sign-up")
                ? undefined
                : "At least 8 characters, or whatever your director asked for."
            }
            className={native ? "auth-stage-field" : undefined}
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={isSignIn ? "current-password" : "new-password"}
              required
              className={stageInputClass(passwordInvalid)}
              aria-invalid={passwordInvalid ? true : undefined}
              aria-describedby={native && error ? "auth-form-error" : undefined}
            />
          </Field>
        )}

        {mode === "sign-up" || mode === "reset" ? (
          <Field label="Confirm password" className={native ? "auth-stage-field" : undefined}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              required
              className={stageInputClass(confirmInvalid)}
              aria-invalid={confirmInvalid ? true : undefined}
              aria-describedby={native && error ? "auth-form-error" : undefined}
            />
          </Field>
        ) : null}

        <Button
          block
          size="lg"
          type="submit"
          loading={busy}
          className={native ? "auth-stage-primary" : undefined}
        >
          {isSignIn
            ? "Sign in"
            : mode === "sign-up"
              ? "Create account"
              : mode === "forgot"
                ? "Email me a link"
                : "Save and continue"}
        </Button>

        {needsConfirmation ? (
          <Button
            type="button"
            block
            variant="secondary"
            loading={busy}
            onClick={() => void resend()}
          >
            Resend the confirmation email
          </Button>
        ) : null}

      </form>

      {native && error ? (
        <p id="auth-form-error" className="auth-stage-error" role="alert">
          <span aria-hidden="true" className="auth-stage-error-icon">
            !
          </span>
          <span>{error}</span>
        </p>
      ) : null}

      {/* The code panel sits outside the form: inside it, pressing Enter in the
          code field submitted the *sign-in* form instead, which answered with a
          password error for a password nobody had typed yet. */}
      {isSignIn && (auth.authLinkError || needsConfirmation) ? (
        <div className="mt-4">{codeEntry}</div>
      ) : null}

      {supportsGoogle ? (
        <>
          <div
            className={
              native
                ? "auth-stage-divider"
                : "my-5 flex items-center gap-3 text-xs text-[var(--cue-muted)]"
            }
          >
            <span aria-hidden="true" className="h-px flex-1 bg-[var(--cue-border)]" />
            <span>or continue with</span>
            <span aria-hidden="true" className="h-px flex-1 bg-[var(--cue-border)]" />
          </div>
          <Button
            block
            variant="secondary"
            loading={busy}
            icon={<GoogleMark className={native ? "h-5 w-5" : "h-[18px] w-[18px]"} />}
            onClick={() => void continueWithGoogle()}
            className={native ? "auth-stage-google" : undefined}
          >
            Continue with Google
          </Button>
          {native ? (
            <p className="auth-stage-google-note">
              Sign in securely with your Google account.
            </p>
          ) : (
            <p className="mt-2 max-md:mt-1 text-center text-[11px] leading-relaxed text-[var(--cue-muted)]">
              Google sign-in shares only your name, email address, and Google account ID. We never
              request access to your Gmail, Google Calendar, or Drive.{" "}
              <Link
                to="/privacy"
                className="font-semibold underline underline-offset-2"
              >
                Privacy Policy
              </Link>
            </p>
          )}
        </>
      ) : null}

      <div
        className={
          native
            ? "mt-3 text-center text-sm"
            : `mt-5 space-y-3 text-center text-sm${
                mode === "sign-up" ? " max-md:mt-2" : ""
              }`
        }
      >
        {mode === "sign-in" && !native ? (
          <>
            <Link
              to="/forgot-password"
              className="flex min-h-11 items-center justify-center font-semibold text-[var(--cue-green)] underline"
            >
              Forgot your password?
            </Link>
            <Link
              to="/sign-up"
              className="flex min-h-11 flex-col items-center justify-center text-[var(--cue-muted)]"
            >
              New here?
              <span className="font-semibold underline">Create an account</span>
            </Link>
          </>
        ) : null}

        {mode === "sign-up" && !native ? (
          <Link
            to="/sign-in"
            className="flex min-h-11 flex-col items-center justify-center text-[var(--cue-muted)]"
          >
            Already have an account?
            <span className="font-semibold underline">Sign in</span>
          </Link>
        ) : null}

        {(mode === "forgot" || mode === "reset") && !native ? (
          <Link to="/sign-in" className="flex min-h-11 items-center justify-center text-[var(--cue-muted)]">
            <span className="font-semibold underline">Back to sign in</span>
          </Link>
        ) : null}
      </div>

      {mode === "sign-up" ? (
        native ? (
          <p className="auth-stage-signup-note">{nativeSignUpNote}</p>
        ) : (
          <>
            <p className="mt-3 hidden text-center text-sm leading-relaxed text-[var(--cue-muted)] md:block">
              {copy.signUpNote}
            </p>
            <p className="mt-1 text-center text-sm leading-relaxed text-[var(--cue-muted)] md:hidden">
              {nativeSignUpNote}
            </p>
          </>
        )
      ) : null}

      {/* The public notices, one tap from every auth mode. On sign-up this is
          also the consent line; on the others it is just discovery. */}
      <p
        className={
          native
            ? "auth-stage-legal"
            : "mt-4 max-md:mt-1 text-center text-[11px] leading-relaxed text-[var(--cue-muted)]"
        }
      >
        {mode === "sign-up" ? "By creating an account you agree to our " : ""}
        <Link
          to="/terms"
          className={native ? nativeLegalLink : "font-semibold underline underline-offset-2"}
        >
          Terms of Use
        </Link>
        {mode === "sign-up" ? " and " : " \u00b7 "}
        <Link
          to="/privacy"
          className={native ? nativeLegalLink : "font-semibold underline underline-offset-2"}
        >
          Privacy Policy
        </Link>
        {mode === "sign-up" ? "." : ""}
      </p>
    </AuthLayout>
  );
}

/**
 * The two-panel shell every auth mode shares on desktop: the branded aside on
 * the left with the app icon and a way back to the landing page, and the form in
 * the panel on the right. On a phone, create account collapses to one compact
 * panel so it fits without a page scroll.
 */
function AuthLayout({ mode, children }: { mode: AuthMode; children: ReactNode }) {
  const copy = MODE_COPY[mode];

  if (isNativeApp()) {
    return <NativeAuthLayout mode={mode}>{children}</NativeAuthLayout>;
  }

  return (
    <main
      className={`safe-t flex min-h-full items-center justify-center overflow-y-auto bg-[var(--cue-page)] px-4 pb-0 pt-3 text-[var(--cue-ink)] sm:px-6 sm:pb-0 sm:pt-3${
        mode === "sign-up" ? " auth-web-signup-main" : ""
      }`}
    >
      <div className="grid w-full max-w-5xl grid-cols-1 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--cue-line)] bg-[var(--cue-panel)] md:min-h-[540px] md:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <aside
          className={`flex-col justify-between bg-[var(--cue-brand-panel)] p-5 text-[var(--cue-brand-ink)] sm:p-8 md:flex md:p-10 ${
            mode === "sign-up" ? "hidden" : "flex"
          }`}
        >
          <div>
            <Link
              viewTransition
              to="/"
              className="motion-press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] text-sm font-semibold text-[var(--cue-brand-ink)]/80 hover:text-[var(--cue-brand-ink)]"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              Back to the program
            </Link>
            <div className="mt-10 flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[var(--cue-brand-ink)] p-1">
                <img
                  src="/logo.svg"
                  alt=""
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-[8px]"
                />
              </span>
              <p className="type-label text-[var(--cue-gold-on-brand)]">{APP_NAME}</p>
            </div>
            <h1 className="type-title mt-3 max-w-sm text-[var(--cue-brand-ink)]">{copy.aside}</h1>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--cue-brand-ink)]/80">
              {copy.asideSub}
            </p>
          </div>
          <p className="type-label mt-8 text-[var(--cue-brand-ink)]/60">
            Redmond High School · Music &amp; Arts
          </p>
        </aside>

        <section
          className={`flex items-center justify-center px-5 py-4 sm:px-9 sm:py-4 md:px-12${
            mode === "sign-up" ? " auth-web-signup-section" : ""
          }`}
        >
          <div className="w-full max-w-md">{children}</div>
        </section>
      </div>
    </main>
  );
}

/**
 * The native app's auth shell.
 *
 * Only the native build uses this stage. The website keeps its two-column auth
 * layout. The green hero and cream sheet are one normal-flow composition: the
 * sheet overlaps the panel by 28px and nothing is fixed. Create account uses a
 * compact version so its complete form fits a phone viewport; sign-in and the
 * password modes can still scroll when a short phone or the keyboard needs it.
 */
function NativeAuthLayout({ mode, children }: { mode: AuthMode; children: ReactNode }) {
  const showModeSwitch = mode === "sign-in" || mode === "sign-up";
  const compactSignup = mode === "sign-up";
  const headlineLines: Record<AuthMode, [string, string]> = {
    "sign-in": ["Welcome", "back"],
    "sign-up": ["Join your", "program"],
    forgot: ["Forgot your", "password"],
    reset: ["Set a new", "password"],
  };
  const [headlineLead, headlineLast] = headlineLines[mode];

  return (
    <main
      className={`auth-stage min-h-full overflow-y-auto${compactSignup ? " auth-stage--signup" : ""}`}
    >
      <header className={`auth-stage-hero${compactSignup ? " auth-stage-hero--compact" : ""}`}>
        <StageStaff />
        <div className="auth-stage-hero-inner">
          <div className="auth-stage-lockup">
            {compactSignup ? <StageAppIcon /> : <StageMark />}
            <div className="min-w-0">
              <p className="auth-stage-eyebrow">Redmond High School</p>
              <p className="auth-stage-product">Music &amp; Arts Attendance</p>
            </div>
          </div>

          <h1
            className={`auth-stage-headline${compactSignup ? " auth-stage-headline--compact" : ""}`}
          >
            {compactSignup ? (
              <span className="auth-stage-headline-line">
                Join your program
                <span className="auth-stage-period">.</span>
              </span>
            ) : (
              <>
                <span className="auth-stage-headline-line">{headlineLead}</span>
                <span className="auth-stage-headline-line">
                  {headlineLast}
                  <span className="auth-stage-period">.</span>
                </span>
              </>
            )}
          </h1>
          <span aria-hidden="true" className="auth-stage-rule" />
          {compactSignup ? null : (
            <p className="auth-stage-subline">
              Attendance, events and check-in for Band, Orchestra, Choir and Drama.
            </p>
          )}
        </div>
      </header>

      <section className="auth-stage-sheet">
        {showModeSwitch ? (
          <nav aria-label="Account access" className="auth-stage-tabs">
            <Link
              to="/sign-in"
              aria-current={mode === "sign-in" ? "page" : undefined}
              className="auth-stage-tab motion-press"
            >
              Sign in
              <span aria-hidden="true" className="auth-stage-tab-rule" />
            </Link>
            <Link
              to="/sign-up"
              aria-current={mode === "sign-up" ? "page" : undefined}
              className="auth-stage-tab motion-press"
            >
              Create account
              <span aria-hidden="true" className="auth-stage-tab-rule" />
            </Link>
          </nav>
        ) : (
          <Link to="/sign-in" className="auth-stage-back motion-press">
            <span aria-hidden="true">←</span>
            Back to sign in
          </Link>
        )}

        {children}
      </section>
    </main>
  );
}

/** The shipped app icon, shown on the native create-account lockup. */
function StageAppIcon() {
  return (
    <span className="auth-stage-mark p-1.5" aria-hidden="true">
      <img
        src="/logo.svg"
        alt=""
        width={28}
        height={28}
        className="h-7 w-7 rounded-[7px]"
      />
    </span>
  );
}

/** The native stage's cream app mark: green note, gold flag. */
function StageMark() {
  return (
    <span className="auth-stage-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40" className="h-[26px] w-[26px]" focusable="false">
        <ellipse
          cx="15"
          cy="28"
          rx="6"
          ry="4.4"
          transform="rotate(-18 15 28)"
          fill="var(--auth-stage-green)"
        />
        <rect x="19" y="8" width="2.4" height="20" rx="1.2" fill="var(--auth-stage-green)" />
        <path
          d="M21.4 8 C 27 9.4 30.4 13.2 31.1 18.8 C 28.4 14.8 25.1 12.4 21.4 11.5 Z"
          fill="var(--auth-stage-gold)"
        />
      </svg>
    </span>
  );
}

/** Decorative staff lines and one gold eighth note, bleeding off the right. */
function StageStaff() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 420 380"
      preserveAspectRatio="xMidYMid slice"
      className="auth-stage-staff"
    >
      <g stroke="var(--auth-stage-staff-line)" strokeWidth="1">
        <path d="M-24 174H444" />
        <path d="M-24 204H444" />
        <path d="M-24 234H444" />
        <path d="M-24 264H444" />
        <path d="M-24 294H444" />
      </g>
      <g transform="translate(360 234) rotate(6)" fill="var(--auth-stage-gold)" opacity="0.92">
        <ellipse cx="0" cy="0" rx="12" ry="9" transform="rotate(-20)" />
        <rect x="9" y="-92" width="4" height="92" rx="2" />
        <path d="M13 -92 C 34 -86 45 -74 48 -52 C 38 -68 27 -78 13 -82 Z" />
      </g>
    </svg>
  );
}
