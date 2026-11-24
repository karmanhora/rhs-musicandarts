import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

/**
 * `/license` is a public SPA route, but the repository root also contains the
 * `LICENSE` file. On a case-insensitive filesystem (macOS, Windows) Vite's
 * static middleware resolves `/license` to that file and serves the raw text
 * instead of the app. Rewrite the bare route to the SPA entry before the
 * static middleware runs.
 *
 * Production is unaffected: `vercel.json` rewrites every path to `index.html`.
 * This only keeps local development and the Playwright preview honest.
 */
function licenseRoutePlugin(): Plugin {
  return {
    name: "rhs-license-route",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        // Connect's request is an IncomingMessage, but this project's Node types
        // do not surface `url` on it. The cast keeps the middleware typed while
        // leaving the runtime object untouched.
        const request = req as { url?: string };
        const path = (request.url ?? "").split("?")[0].toLowerCase();
        if (path === "/license" || path === "/license/") {
          request.url = "/";
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const isIosBuild = mode === "ios" || mode === "ios-dev";

  if (isIosBuild) {
    const url = env.VITE_SUPABASE_URL ?? "";
    if (!url || !env.VITE_SUPABASE_ANON_KEY) {
      throw new Error(
        `The ${mode} build needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in ` +
          `.env.${mode}.local. Copy the matching .env example and fill it in.`
      );
    }
    if (/localhost|127\.0\.0\.1/i.test(url)) {
      throw new Error(
        `The ${mode} build must use the hosted Supabase project, not ${url}. ` +
          "Set VITE_SUPABASE_URL in the iOS env file; .env.local is for web development."
      );
    }
  }

  if (mode === "ios" && env.VITE_NATIVE_GOOGLE_SIGNIN === "true") {
    throw new Error(
      "VITE_NATIVE_GOOGLE_SIGNIN is development-only. An App Store build must " +
        "ship without Google unless Sign in with Apple is added (guideline 4.8)."
    );
  }

  return {
    envPrefix: ["VITE_", "NEXT_PUBLIC_"],
    // The WGSL loader prepares the landing-page note shader at build time, so the
    // WGSL parser never ships to the browser. It is only reached through the
    // landing page's lazy `notes` chunk, so first paint is unaffected.
    plugins: [licenseRoutePlugin(), react(), tailwindcss(), wgslVitePlugin()],
    build: {
      rollupOptions: {
        output: {
          // Keep the heavy, rarely-needed bundle out of the first paint: the QR
          // scanner (html5-qrcode + qrcode.react) only matters on the check-in
          // screens, which are behind the sign-in.
          manualChunks(id) {
            if (id.includes("html5-qrcode") || id.includes("qrcode.react")) {
              return "qr";
            }
          },
        },
      },
    },
  };
});
