import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ConfigMissingScreen } from "./screens/ConfigMissingScreen";
import { isBackendConfigured } from "./lib/backend-config";
import { initNativeShell } from "./lib/nativeShell";
import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-700.css";
import "@fontsource/fraunces/latin-500.css";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/fraunces/latin-500-italic.css";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "./index.css";

/**
 * Supabase is the only backend now: the database *and* the identity provider, so
 * the two frontend values below are all this app needs to boot. There is no
 * provider component to mount — the client in `lib/supabase.ts` owns the session
 * and `AuthProvider` (inside `App`) reads it.
 */
const missing: string[] = [];
if (!isBackendConfigured) {
  missing.push("VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY");
}

initNativeShell();

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const root = createRoot(container);

/**
 * Tell `index.html`'s boot check that something rendered. The check exists so a
 * visitor whose app never starts gets a readable page instead of a blank one
 * (see the fallback block at the foot of `index.html`); this is the signal that
 * switches it off, and it fires for the config screen too — that is a rendered
 * page with a real explanation on it, not a failure.
 */
function markBooted(): void {
  (window as unknown as Record<string, unknown>).__rhsBooted = true;
}

if (missing.length > 0) {
  root.render(<ConfigMissingScreen missing={missing} />);
  markBooted();
} else {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>
  );
  markBooted();
}
