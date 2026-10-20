import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import { Splash } from "./components/Splash";
import { ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import SignedInApp from "./SignedInApp";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { AuthScreen } from "./screens/AuthScreen";
import { LegalScreen } from "./screens/LegalScreen";

/**
 * Which tree the visitor gets: the public landing page, an auth screen, or the
 * app itself — decided by the one thing that actually knows, the Supabase Auth
 * session (see `useAuth`).
 *
 * Previous versions asked Clerk for this and rendered *nothing* until a
 * third-party script plus two API round-trips came back, which is why the
 * landing page used to sit blank. Supabase Auth restores its session from
 * localStorage on the first tick, so this resolves locally.
 */
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <SessionRoutes />
      </AuthProvider>
      <Analytics />
    </ToastProvider>
  );
}

function SessionRoutes() {
  const auth = useAuth();
  const location = useLocation();

  // The stored session is being read (or, on a fresh visit, confirmed absent).
  if (auth.status === "loading") {
    return (
      <Routes>
        {/* Public legal pages resolve before auth does, so a deep link (or a
            district reviewer) never lands on a spinner that hides the notice. */}
        <Route path="/privacy" element={<LegalScreen page="privacy" />} />
        <Route path="/terms" element={<LegalScreen page="terms" />} />
        <Route path="*" element={<Splash label="Signing you in…" />} />
      </Routes>
    );
  }

  /**
   * A password-recovery link takes over the whole screen. Supabase has already
   * signed the person in to change their password; letting them wander into the
   * app first would only make the expired link more confusing.
   */
  if (auth.recovering) {
    return (
      <Routes>
        <Route path="/reset-password" element={<AuthScreen mode="reset" />} />
        {/* A recovery link must not lock the person out of the notice they are
            being asked to accept. */}
        <Route path="/privacy" element={<LegalScreen page="privacy" />} />
        <Route path="/terms" element={<LegalScreen page="terms" />} />
        <Route path="*" element={<Navigate to="/reset-password" replace />} />
      </Routes>
    );
  }

  if (auth.status === "signed-out") {
    // A confirmation link that was already spent lands on the Site URL with
    // `#error=access_denied&error_code=otp_expired`. The account is usually
    // confirmed by then, so do not leave the person on the landing page with no
    // explanation: the sign-in screen says what happened and offers the code
    // fallback from the same email. `/reset-password` keeps its own expired-link
    // panel, and every other path is left alone.
    if (auth.authLinkError && location.pathname === "/") {
      return <Navigate to="/sign-in" replace />;
    }

    return (
      <Routes>
        <Route path="/" element={<WelcomeScreen />} />
        {/* The `*` variants keep working when our own links carry a sub-path. */}
        <Route path="/sign-in/*" element={<AuthScreen mode="sign-in" />} />
        <Route path="/sign-up/*" element={<AuthScreen mode="sign-up" />} />
        <Route path="/forgot-password" element={<AuthScreen mode="forgot" />} />
        <Route path="/reset-password" element={<AuthScreen mode="reset" />} />
        {/* The public notices: open to anyone, signed in or not. */}
        <Route path="/privacy" element={<LegalScreen page="privacy" />} />
        <Route path="/terms" element={<LegalScreen page="terms" />} />
        {/*
          A deep link into the app — most importantly `/checkin?token=…` from a
          scanned QR code — lands on sign-in, and the auth screen sends them on
          to where they were going once they are through.
        */}
        <Route path="*" element={<AuthScreen mode="sign-in" />} />
      </Routes>
    );
  }

  return <SignedInApp />;
}
