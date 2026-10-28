import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CalendarThrottledError,
  fetchGoogleCalendarEvents,
  validGoogleUrl,
} from "../_shared/google-calendar.ts";

/**
 * sync-google-calendars — keeps every connected feed in step with Google.
 *
 * Run on a schedule by Supabase Cron (pg_cron + pg_net), the same way
 * `event-reminders` and `absence-request-emails` are. Server-to-server only:
 * there is no CORS block, because no browser should be able to trigger a pull.
 *
 *   select vault.create_secret('<CALENDAR_SYNC_SECRET>', 'calendar_sync_secret');
 *   select cron.schedule('google-calendar-sync', '*\/15 * * * *', $$
 *     select net.http_post(
 *       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-google-calendars',
 *       headers := jsonb_build_object(
 *         'x-calendar-sync-secret',
 *         (select decrypted_secret from vault.decrypted_secrets
 *           where name = 'calendar_sync_secret'),
 *         'Content-Type', 'application/json'),
 *       body := '{}'::jsonb,
 *       -- 5s is pg_net's default and cuts the run off mid-fetch, recording a
 *       -- NULL response while the job still reports success.
 *       timeout_milliseconds := 120000);
 *   $$);
 *
 * What a run does, per active `calendar_sources` row:
 *   * fetch the public ICS feed (shared with `import-google-calendar`),
 *   * parse it into the row shape `sync_google_calendar_events` takes,
 *   * call that RPC with `p_replace_all => false`.
 *
 * `false` is deliberate. The RPC's replace pass deletes and re-inserts every
 * synced event, which would churn `events.id` on every run — ids that
 * attendance records, reminders and announcements point at. Without it the RPC
 * still upserts by `google_calendar_uid` and archives the events that left the
 * feed, so an event added, edited or deleted in Google lands here either way.
 *
 * The RPC also refuses to archive on an empty feed, so a Google hiccup that
 * returns zero events cannot wipe a program's calendar; this function skips such
 * a source and leaves `last_synced_at` alone, which is what the Calendar screen
 * shows as a stale sync.
 *
 * One source failing for its own reason (404 after the calendar was made
 * private, a malformed saved URL) never stops the others: each is reported in
 * `results` and the whole run answers 500 so a scheduled failure is visible.
 *
 * A `429` from Google is different — it is the egress address running out of
 * budget, not that calendar. Retrying it inside the run cannot help and makes
 * the window longer, so the run stops there and reports the rest as skipped;
 * the next quarter hour is the real retry.
 */

const MAX_SOURCES = 25;
/** Politeness gap between feeds: one Edge instance, one egress IP. */
const BETWEEN_SOURCES_MS = 400;
/**
 * Stop starting new feeds after this. Every feed can burn up to three attempts
 * with a retry wait, so a run of failing calendars could otherwise reach the
 * platform's wall-clock limit and be killed mid-list — leaving the rest of the
 * programs unsynced with no report saying so.
 */
const RUN_BUDGET_MS = 120_000;

interface SourceRow {
  id: string;
  ensemble_id: string;
  name: string;
  ics_url: string;
}

interface SourceResult {
  source_id: string;
  ensemble_id: string;
  name: string;
  ok: boolean;
  events?: number;
  inserted?: number;
  updated?: number;
  archived?: number;
  warning?: string | null;
  error?: string;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Calendar sync is not configured on the server." }, 500);
  }

  // Fail closed. The cron job sends the shared secret; the service-role bearer
  // branch is for a controlled manual run.
  const expected = Deno.env.get("CALENDAR_SYNC_SECRET");
  const presented = request.headers.get("x-calendar-sync-secret");
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const authorised =
    (!!expected && presented === expected) || (!!bearer && bearer === serviceRoleKey);
  if (!authorised) {
    return json({ ok: false, error: "Not authorised to sync calendars." }, 401);
  }

  let payload: Record<string, unknown> = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "The request body was not valid JSON." }, 400);
    }
  }
  const dryRun = payload.dry_run === true;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Least recently synced first, so a single run under the cap still rotates
  // through every program instead of starving the later ones.
  const { data: sources, error: readError } = await admin
    .from("calendar_sources")
    .select("id,ensemble_id,name,ics_url")
    .eq("provider", "google_ics")
    .eq("active", true)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(MAX_SOURCES);
  if (readError) {
    return json({ ok: false, error: "Could not read the connected calendars." }, 500);
  }

  const rows = (sources ?? []) as SourceRow[];
  const results: SourceResult[] = [];
  const deadline = Date.now() + RUN_BUDGET_MS;
  let throttledThisRun = false;

  for (const source of rows) {
    const base = {
      source_id: source.id,
      ensemble_id: source.ensemble_id,
      name: source.name,
    };

    if (throttledThisRun) {
      results.push({
        ...base,
        ok: false,
        error: "Skipped — Google is rate-limiting this address. The next run picks it up.",
      });
      continue;
    }

    if (Date.now() > deadline) {
      results.push({
        ...base,
        ok: false,
        error: "Skipped — this run ran out of time. The next run picks it up.",
      });
      continue;
    }

    const calendarUrl = validGoogleUrl(source.ics_url ?? "");
    if (!calendarUrl) {
      results.push({
        ...base,
        ok: false,
        error: "The saved address is not a public Google Calendar iCal URL.",
      });
      continue;
    }

    try {
      const records = await fetchGoogleCalendarEvents(calendarUrl);
      if (records.length === 0) {
        results.push({
          ...base,
          ok: false,
          error: "The feed returned no events — nothing was archived.",
        });
        continue;
      }

      if (dryRun) {
        results.push({ ...base, ok: true, events: records.length });
        continue;
      }

      const { data: syncResult, error: syncError } = await admin.rpc(
        "sync_google_calendar_events",
        { p_calendar_source: source.id, p_events: records, p_replace_all: false }
      );
      if (syncError) throw new Error("The events were fetched but could not be saved.");

      const result = syncResult as {
        ok?: boolean;
        message?: string;
        inserted?: number;
        updated?: number;
        archived?: number;
        warning?: string | null;
      } | null;
      if (!result?.ok) throw new Error(result?.message ?? "Could not sync this calendar.");

      results.push({
        ...base,
        ok: true,
        events: records.length,
        inserted: result.inserted ?? 0,
        updated: result.updated ?? 0,
        archived: result.archived ?? 0,
        warning: result.warning ?? null,
      });
    } catch (error) {
      results.push({
        ...base,
        ok: false,
        error: error instanceof Error ? error.message : "Could not sync this calendar.",
      });
      if (error instanceof CalendarThrottledError) throttledThisRun = true;
    }

    await sleep(BETWEEN_SOURCES_MS);
  }

  const failed = results.filter((result) => !result.ok).length;
  return json(
    {
      ok: failed === 0,
      dry_run: dryRun,
      sources: rows.length,
      synced: results.length - failed,
      failed,
      results,
    },
    failed === 0 ? 200 : 500
  );
});
