import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * CORS: reflect the caller's Origin only when it is allowlisted. A wildcard
 * (`*`) is unnecessary here — the caller authenticates with a Bearer token, so
 * narrowing the allowed origins removes the wildcard without changing behavior
 * for the real app. Set APP_ORIGINS (comma-separated) to override the defaults,
 * e.g. a preview deployment URL.
 */
const DEFAULT_ORIGINS = [
  "https://rhsattendance.org",
  "https://redmond-music-arts-program-mandalora.vercel.app",
  "http://localhost:5173",
];

const allowedOrigins = new Set(
  (Deno.env.get("APP_ORIGINS") ?? DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

// This app's custom domain, plus its Vercel production and preview hosts
// (production has no middle token, a preview adds one). Keeps the project's own
// deployments working without re-allowing arbitrary Vercel apps.
const PROJECT_HOST =
  /^(?:rhsattendance\.org|redmond(-[a-z0-9-]+)?-music-arts-program-mandalora\.vercel\.app)$/i;

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && PROJECT_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  // Echo the origin only when allowed; otherwise fall back to the primary
  // origin (the browser will then block the response — which is the point).
  const allow = isAllowedOrigin(origin) ? origin : DEFAULT_ORIGINS[0]!;
  return {
    "Access-Control-Allow-Origin": allow,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers: cors });
  }

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return Response.json({ error: "Sign in again before deleting your account." }, {
      status: 401,
      headers: cors,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return Response.json({ error: "Account deletion is not configured on the server." }, {
      status: 500,
      headers: cors,
    });
  }

  const caller = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authenticationError } = await caller.auth.getUser(token);
  if (authenticationError || !user) {
    return Response.json({ error: "Your sign-in has expired. Sign in again and retry." }, {
      status: 401,
      headers: cors,
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: preparationError } = await admin.rpc("prepare_account_deletion", {
    p_auth_user_id: user.id,
  });
  if (preparationError) {
    return Response.json({ error: `Could not remove account data: ${preparationError.message}` }, {
      status: 500,
      headers: cors,
    });
  }

  const { error: deletionError } = await admin.auth.admin.deleteUser(user.id);
  if (deletionError) {
    return Response.json({
      error: `Your profile has been de-identified, but sign-in account deletion did not complete. Retry account deletion: ${deletionError.message}`,
    }, { status: 500, headers: cors });
  }

  return Response.json({ ok: true }, { headers: cors });
});
