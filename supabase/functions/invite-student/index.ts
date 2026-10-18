import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * CORS: reflect the caller's Origin only when it is allowlisted (see
 * delete-account for the rationale). Override with APP_ORIGINS if needed.
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
// (production has no middle token, a preview adds one). See delete-account for
// the rationale.
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
  const response = (body: Record<string, unknown>, status = 200): Response =>
    Response.json(body, { status, headers: cors });

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (request.method !== "POST") {
    return response({ ok: false, error: "Method not allowed." }, 405);
  }

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return response({ ok: false, error: "Sign in before inviting a student." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return response({ ok: false, error: "Student invitations are not configured on the server." }, 500);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return response({ ok: false, error: "The invitation request was not valid JSON." }, 400);
  }

  if (typeof payload !== "object" || payload === null) {
    return response({ ok: false, error: "The invitation request is missing its details." }, 400);
  }

  const body = payload as Record<string, unknown>;
  const ensembleId = typeof body.ensemble_id === "string" ? body.ensemble_id : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const studentName = typeof body.student_name === "string" ? body.student_name.trim() : "";
  if (!ensembleId || !email || !studentName) {
    return response({ ok: false, error: "Enter the student's name and email address." }, 400);
  }

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authenticationError } = await caller.auth.getUser(token);
  if (authenticationError || !user) {
    return response({ ok: false, error: "Your sign-in has expired. Sign in again and retry." }, 401);
  }

  const { data: preparation, error: preparationError } = await caller.rpc(
    "create_program_invite",
    {
      p_ensemble: ensembleId,
      p_email: email,
      p_student_name: studentName,
    }
  );
  if (preparationError) {
    return response({ ok: false, error: `Could not prepare the invitation: ${preparationError.message}` }, 500);
  }

  const invite = preparation as {
    ok?: boolean;
    message?: string;
    invite_id?: string;
    program_name?: string;
  } | null;
  if (!invite?.ok || !invite.invite_id || !invite.program_name) {
    return response(
      { ok: false, error: invite?.message ?? "The program could not create this invitation." },
      400
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      account_type: "student",
      full_name: studentName,
      program_name: invite.program_name,
    },
  });
  if (inviteError) {
    const { error: cleanupError } = await admin.rpc("cancel_program_invite", {
      p_invite_id: invite.invite_id,
    });
    const errorMessage = /already|registered|exists/i.test(inviteError.message)
      ? "That email already has an account. Share this program's join code so they can join."
      : /error sending invite email/i.test(inviteError.message)
      ? "Supabase could not send the invitation. Check that the From address's domain is verified with the email provider (Resend), then try again."
      : `Could not send the invitation: ${inviteError.message}`;
    return response({
      ok: false,
      error: cleanupError
        ? `${errorMessage} The pending invitation could not be cleared: ${cleanupError.message}`
        : errorMessage,
    }, 400);
  }

  return response({
    ok: true,
    message: `Invitation sent to ${email}. They will be added to the roster after accepting.`,
  });
});
