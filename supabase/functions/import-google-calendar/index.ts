import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchGoogleCalendarEvents, validGoogleUrl } from "../_shared/google-calendar.ts";

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

  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return response({ ok: false, error: "Method not allowed." }, 405);

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return response({ ok: false, error: "Sign in before importing a calendar." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return response({ ok: false, error: "Calendar import is not configured on the server." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    const payload: unknown = await request.json();
    if (typeof payload !== "object" || payload === null) throw new Error();
    body = payload as Record<string, unknown>;
  } catch {
    return response({ ok: false, error: "The calendar import request is not valid JSON." }, 400);
  }

  const ensembleId = typeof body.ensemble_id === "string" ? body.ensemble_id : "";
  const calendarUrlText = typeof body.calendar_url === "string" ? body.calendar_url.trim() : "";
  const calendarUrl = validGoogleUrl(calendarUrlText);
  if (!ensembleId || !calendarUrl) {
    return response({
      ok: false,
      error: "Enter a public Google Calendar iCal URL ending in /public/basic.ics.",
    }, 400);
  }

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await caller.auth.getUser(token);
  if (authError || !user) {
    return response({ ok: false, error: "Your sign-in has expired. Sign in again and retry." }, 401);
  }
  const { data: allowed, error: permissionError } = await caller.rpc("has_permission", {
    p_ensemble: ensembleId,
    p_permission: "attendance.manage_events",
  });
  if (permissionError || allowed !== true) {
    return response({ ok: false, error: "You do not have permission to import this program's calendar." }, 403);
  }

  try {
    const records = await fetchGoogleCalendarEvents(calendarUrl);
    if (records.length === 0) {
      throw new Error("The calendar feed contains no events, so nothing was changed.");
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: sources, error: sourceReadError } = await admin
      .from("calendar_sources")
      .select("id,name")
      .eq("ensemble_id", ensembleId)
      .eq("provider", "google_ics")
      .limit(1);
    if (sourceReadError) throw new Error("Could not save this calendar connection.");

    const existing = sources?.[0] as { id: string } | undefined;
    let sourceId: string;
    if (existing) {
      sourceId = existing.id;
    } else {
      const { data: created, error: createError } = await admin
        .from("calendar_sources")
        .insert({
          ensemble_id: ensembleId,
          provider: "google_ics",
          ics_url: calendarUrlText,
          name: "Google Calendar",
          active: true,
        })
        .select("id")
        .single();
      if (createError || !created) throw new Error("Could not save this calendar connection.");
      sourceId = created.id;
    }

    const { data: syncResult, error: syncError } = await admin.rpc(
      "sync_google_calendar_events",
      { p_calendar_source: sourceId, p_events: records, p_replace_all: false }
    );
    if (syncError) {
      if (!existing) await admin.from("calendar_sources").delete().eq("id", sourceId);
      throw new Error("The events were fetched but could not be added to the calendar.");
    }
    const result = syncResult as {
      ok?: boolean;
      message?: string;
      inserted?: number;
      updated?: number;
      archived?: number;
      warning?: string | null;
    } | null;
    if (!result?.ok) {
      if (!existing) await admin.from("calendar_sources").delete().eq("id", sourceId);
      throw new Error(result?.message ?? "Could not sync this calendar.");
    }
    const { error: sourceUpdateError } = await admin
      .from("calendar_sources")
      .update({ ics_url: calendarUrlText, active: true })
      .eq("id", sourceId);
    if (sourceUpdateError) throw new Error("Events imported, but the calendar URL could not be saved.");

    return response({
      ok: true,
      inserted: result.inserted ?? 0,
      updated: result.updated ?? 0,
      archived: result.archived ?? 0,
      warning: result.warning ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not import this calendar.";
    return response({ ok: false, error: message }, 400);
  }
});
