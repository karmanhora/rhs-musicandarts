import ICAL from "npm:ical.js@2.2.1";
import { createClient } from "npm:@supabase/supabase-js@2";

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
const GOOGLE_ICS_HOSTS = new Set(["calendar.google.com", "calendar.googleusercontent.com"]);
const MAX_FEED_BYTES = 1_500_000;
const MAX_EVENTS = 4000;
const MAX_REDIRECTS = 3;

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

function validGoogleUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !GOOGLE_ICS_HOSTS.has(url.hostname.toLowerCase()) ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/calendar\/ical\/[^/]+\/public\/basic\.ics$/i.test(url.pathname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function fetchFeed(initialUrl: URL): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "text/calendar, text/plain;q=0.9" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("Location");
    await response.body?.cancel();
    const nextUrl = location ? validGoogleUrl(new URL(location, url).toString()) : null;
    if (!nextUrl) throw new Error("Google returned an unsupported calendar redirect.");
    url = nextUrl;
  }
  throw new Error("Google Calendar redirected too many times.");
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_FEED_BYTES) throw new Error("The calendar feed is too large to import.");
  if (!response.body) throw new Error("Google returned an empty calendar feed.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error("The calendar feed is too large to import.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function classifyEvent(title: string): string {
  const name = title.toLowerCase();
  if (/\b(no school|holiday|day off|early release|half day)\b/.test(name)) return "No School";
  if (/\b(competition|contest|tournament)\b/.test(name)) return "Competition";
  if (/\bconcert\b/.test(name)) return "Concert";
  if (/\b(game|match)\b/.test(name)) return "Game";
  if (/\b(parade|performance|recital|festival)\b/.test(name)) return "Performance";
  if (/\baudition\b/.test(name)) return "Audition";
  if (/\b(workshop|clinic)\b/.test(name)) return "Workshop";
  if (/\btrip\b/.test(name)) return "Trip";
  if (/\b(fundraiser|booster)\b/.test(name)) return "Fundraiser";
  if (/\b(section meeting|band meeting|parent meeting|meeting)\b/.test(name)) {
    if (name.includes("section meeting")) return "Section Meeting";
    if (name.includes("band meeting")) return "Band Meeting";
    if (name.includes("parent meeting")) return "Parent Meeting";
    return "General Meeting";
  }
  if (/\b(banquet|social|party)\b/.test(name)) return "Banquet";
  return "Rehearsal";
}

function occurrenceDate(time: ICAL.Time, timezone: string | null): Date {
  if (!time.isDate) return time.toJSDate();
  const target = Date.UTC(time.year, time.month - 1, time.day);
  if (timezone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      let guess = target;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const values = Object.fromEntries(
          formatter.formatToParts(new Date(guess)).map(({ type, value }) => [type, Number(value)])
        );
        const represented = Date.UTC(
          values.year,
          values.month - 1,
          values.day,
          values.hour,
          values.minute,
          values.second
        );
        guess += target - represented;
      }
      return new Date(guess);
    } catch {
      // An invalid or missing feed timezone should not shift an all-day event
      // into the prior date for users west of UTC.
    }
  }
  return new Date(target + 12 * 60 * 60 * 1000);
}

function eventRecords(calendarText: string): Record<string, unknown>[] {
  const root = new ICAL.Component(ICAL.parse(calendarText));
  const components = root.getAllSubcomponents("vevent");
  const records: Record<string, unknown>[] = [];
  const recurringThrough = Date.now() + 18 * 30 * 24 * 60 * 60 * 1000;
  const calendarTimezoneValue = root.getFirstPropertyValue("x-wr-timezone");
  const calendarTimezone = typeof calendarTimezoneValue === "string" ? calendarTimezoneValue : null;

  for (const component of components) {
    const master = new ICAL.Event(component);
    if (
      !master.uid ||
      !master.startDate ||
      component.hasProperty("recurrence-id") ||
      component.getFirstPropertyValue("status") === "CANCELLED"
    ) {
      continue;
    }
    const recurring = component.hasProperty("rrule") || component.hasProperty("rdate");
    const iterator = master.iterator();
    let recurrenceId = iterator.next();
    let recurrenceSteps = 0;

    while (recurrenceId) {
      recurrenceSteps += 1;
      if (recurring && recurrenceSteps > 10_000) {
        throw new Error("This calendar has a recurring event that is too old to expand safely.");
      }
      const details = master.getOccurrenceDetails(recurrenceId);
      const occurrence = details.item;
      const startDate = occurrenceDate(details.startDate, calendarTimezone);
      if (recurring && startDate.getTime() > recurringThrough) break;
      const endDate = occurrenceDate(details.endDate, calendarTimezone);
      const title = String(occurrence.summary || master.summary || "Untitled event").trim();
      const uid = recurring ? `${master.uid}::${recurrenceId.toString()}` : master.uid;

      records.push({
        uid,
        name: title.slice(0, 200) || "Untitled event",
        type: classifyEvent(title),
        date: startDate.toISOString(),
        end_date: endDate > startDate ? endDate.toISOString() : null,
        all_day: details.startDate.isDate,
        location: String(occurrence.location || master.location || "").slice(0, 300),
        description: String(occurrence.description || master.description || "").slice(0, 3000),
        updated_at: null,
      });
      if (records.length > MAX_EVENTS) {
        throw new Error(`This calendar has more than ${MAX_EVENTS} events in the import window.`);
      }
      if (!recurring) break;
      recurrenceId = iterator.next();
    }
  }
  return records;
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
    const feed = await fetchFeed(calendarUrl);
    if (!feed.ok) throw new Error(`Google could not provide this calendar (HTTP ${feed.status}).`);
    const records = eventRecords(await readLimitedText(feed));
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