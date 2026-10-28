/**
 * Google Calendar ICS — shared by the browser import and the scheduled sync.
 *
 * Two entry points need exactly the same three steps: accept only a public
 * Google Calendar iCal address, fetch it (politely — Google rate-limits the
 * anonymous `/calendar/ical/...` endpoint by IP, and the Edge runtime's egress
 * is shared), and turn VEVENTs into the row shape
 * `sync_google_calendar_events` expects.
 *
 * It lives here rather than in either function so the two paths cannot drift: an
 * event the manual import understands is an event the scheduled sync understands.
 */

import ICAL from "npm:ical.js@2.2.1";

const GOOGLE_ICS_HOSTS = new Set(["calendar.google.com", "calendar.googleusercontent.com"]);
const MAX_FEED_BYTES = 1_500_000;
const MAX_EVENTS = 4000;
const MAX_REDIRECTS = 3;

/**
 * `429` is deliberately **not** retried. Google throttles this endpoint by IP
 * and the Edge runtime's egress is shared, so a throttled address stays
 * throttled for far longer than a request can wait — retrying inside the run
 * only consumes more of the same budget (measured 2026-10-27: three attempts
 * per feed, two feeds, still `429`). The scheduled run is the retry.
 */
const RETRY_STATUSES = new Set([503]);
const MAX_ATTEMPTS = 3;
/** The function's wall clock is the budget — never sleep longer than this. */
const MAX_RETRY_WAIT_MS = 4_000;
const DEFAULT_RETRY_WAIT_MS = 800;

const USER_AGENT = "RHSMusicArtsCalendarSync/1.0 (+https://rhsattendance.org)";

/**
 * Google answered `429`: the address is out of budget for now. Callers that
 * loop over several feeds should stop rather than ask again immediately.
 */
export class CalendarThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarThrottledError";
  }
}

/** Only a public Google Calendar feed — https, no port, no credentials. */
export function validGoogleUrl(value: string): URL | null {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `Retry-After` is either seconds or an HTTP date; clamped to our budget. */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_WAIT_MS);
    }
  }
  return Math.min(DEFAULT_RETRY_WAIT_MS * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
}

/**
 * One hop, with a bounded retry. Google answers 429 from its shared egress
 * ranges under load; failing the whole import on the first one loses a real
 * import to a temporary condition.
 */
async function fetchOnce(url: URL): Promise<Response> {
  let waitMs = DEFAULT_RETRY_WAIT_MS;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(waitMs);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "text/calendar, text/plain;q=0.9",
          // Identify the caller rather than submitting the bare runtime
          // default. Measured 2026-10-27: switching the UA did **not** clear
          // Google's 429 from the Edge runtime's shared egress — the throttle
          // is per IP, not per user agent — so this is identification only. The
          // real mitigation is the bounded retry below plus a small number of
          // connected feeds per run.
          "User-Agent": USER_AGENT,
        },
      });
      if (!RETRY_STATUSES.has(response.status)) return response;
      lastError = new Error(`Google could not provide this calendar (HTTP ${response.status}).`);
      waitMs = retryDelayMs(response, attempt);
      await response.body?.cancel();
    } catch (error) {
      // A timeout or connection reset is worth one more try too.
      lastError = error instanceof Error ? error : new Error("Could not reach Google Calendar.");
      waitMs = Math.min(waitMs * 2, MAX_RETRY_WAIT_MS);
    }
  }

  throw lastError ?? new Error("Could not reach Google Calendar.");
}

/** Follows Google's own redirects, re-validating every hop. */
export async function fetchFeed(initialUrl: URL): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchOnce(url);
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

/** VEVENTs (recurrences expanded 18 months ahead) → `sync_google_calendar_events` rows. */
export function eventRecords(calendarText: string): Record<string, unknown>[] {
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

/**
 * Fetch a feed and parse it. Returns `[]` when the calendar is genuinely empty —
 * callers decide what an empty feed means, because the sync RPC refuses to
 * archive anything on one.
 */
export async function fetchGoogleCalendarEvents(url: URL): Promise<Record<string, unknown>[]> {
  const response = await fetchFeed(url);
  if (response.status === 429) {
    throw new CalendarThrottledError(
      "Google is limiting calendar requests right now (HTTP 429). Try again in a few minutes."
    );
  }
  if (!response.ok) throw new Error(`Google could not provide this calendar (HTTP ${response.status}).`);
  return eventRecords(await readLimitedText(response));
}
