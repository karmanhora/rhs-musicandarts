import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * event-announcements — email students when a new event is added.
 *
 * Run on a schedule by Supabase Cron (pg_cron + pg_net), the same way the
 * digest and the 48-hour reminder are. Server-to-server only: there is no CORS
 * block, because no browser should be able to trigger a mail run.
 *
 *   select vault.create_secret('<EVENT_ANNOUNCEMENT_SECRET>', 'event_announcement_secret');
 *   select cron.schedule('event-announcements', '*\/5 * * * *', $$
 *     select net.http_post(
 *       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/event-announcements',
 *       headers := jsonb_build_object(
 *         'x-event-announcement-secret',
 *         (select decrypted_secret from vault.decrypted_secrets
 *           where name = 'event_announcement_secret'),
 *         'Content-Type', 'application/json'),
 *       body := '{}'::jsonb);
 *   $$);
 *
 * The database decides and this function renders and sends. The migration:
 *   * `due_event_announcements(now)` returns exactly who is due — active,
 *     subscribed, confirmed address, student, a manually created event after
 *     the cutover, still to come, and no announcement already claimed.
 *   * `claim_event_announcement(event, user)` inserts the unique delivery row
 *     BEFORE the send. Overlapping runs cannot both mail one student. It
 *     re-checks the event and roster, so an opt-out, removal, archive or
 *     reschedule between the queue read and the send is respected.
 *   * `complete_event_announcement(claim, ok, …)` records the Resend outcome.
 *     A failure keeps the row (attempt count) and may be retried, up to 3 times.
 *
 * Time: event times are stored as instants, so an all-day event and a timed
 * event render correctly across a daylight-saving change. Rendering uses the
 * school's clock (America/Los_Angeles) — the same timezone the app, the digest
 * and the 48-hour reminder use.
 */

const DEFAULT_APP_URL = "https://rhsattendance.org";

/** The school's clock, matching the app and the other event emails. */
const SCHOOL_TIME_ZONE = "America/Los_Angeles";

const INK = "#1e4a32";
const ACCENT = "#c7912c";
const MUTED = "#6b6f6b";
const LINE = "#e2e0d6";

const MAX_RECIPIENTS = 500;
const MAX_ATTEMPTS = 3;

interface DueRow {
  event_id: string;
  user_id: string;
  auth_user_id: string;
  email: string;
  recipient: string;
  ensemble_id: string;
  program_name: string;
  event_name: string;
  event_start: string;
  event_end: string | null;
  all_day: boolean;
  location: string;
  event_type: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Mirrors `EVENT_TYPE_LABEL` in src/lib/constants.ts. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  rehearsal: "Rehearsal",
  concert: "Concert",
  game: "Game",
  competition: "Competition",
  performance: "Performance",
  "section meeting": "Section Meeting",
  "band meeting": "Band Meeting",
  "general meeting": "General Meeting",
  "parent meeting": "Parent Meeting",
  fundraiser: "Fundraiser",
  "event/activity": "Event / Activity",
  audition: "Audition",
  workshop: "Workshop",
  trip: "Trip",
  other: "Other",
};

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function typeLabel(row: DueRow): string {
  const key = (row.event_type ?? "").trim().toLowerCase();
  return EVENT_TYPE_LABELS[key] ?? titleCase(row.event_type || "Other");
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

/** "Friday, October 23, 2026" */
function dateLabel(row: DueRow): string {
  return dayFormat.format(new Date(row.event_start));
}

/** "3:00 PM – 5:00 PM", the start alone, or "All day". */
function timeLabel(row: DueRow): string {
  if (row.all_day) return "All day";
  const start = timeFormat.format(new Date(row.event_start));
  if (!row.event_end) return start;
  const end = timeFormat.format(new Date(row.event_end));
  return `${start} – ${end}`;
}

function subjectFor(row: DueRow): string {
  return `New event: ${row.event_name}`;
}

function textFor(row: DueRow, appUrl: string): string {
  const lines = [
    `Hello ${row.recipient},`,
    "",
    `A new event has been added to ${row.program_name}. Here is when you're expected to be there:`,
    "",
    `Event: ${row.event_name}`,
    `Type: ${typeLabel(row)}`,
    `Date: ${dateLabel(row)}`,
    `Time: ${timeLabel(row)}`,
  ];
  if (row.location.trim()) lines.push(`Location: ${row.location}`);
  lines.push(
    `Program: ${row.program_name}`,
    "",
    "Please make sure you arrive on time. If you have questions, contact your program staff.",
    "",
    `Open the calendar: ${appUrl}/calendar`,
    "",
    `You are receiving this because you are a student in ${row.program_name}.`,
    `Turn event emails off, or back on, under Email in your account settings: ${appUrl}/settings`
  );
  return lines.join("\n");
}

function htmlFor(row: DueRow, appUrl: string, senderName: string): string {
  const location = row.location.trim()
    ? `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Location</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(row.location)}</td></tr>`
    : "";

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f5ef;">
    <div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b201b;font-size:15px;line-height:1.5;">
      <div style="height:4px;background:${INK};border-radius:2px;"></div>
      <p style="margin:20px 0 0;color:${MUTED};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(senderName)}</p>
      <h1 style="margin:4px 0 16px;font-size:24px;line-height:1.25;color:#1b201b;font-weight:700;">New event added</h1>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(row.recipient)},</p>
      <p style="margin:0 0 16px;">A new event has been added to <strong>${escapeHtml(row.program_name)}</strong>. Here is when you&rsquo;re expected to be there:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};padding:8px 0;">
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Event</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(row.event_name)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Type</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(typeLabel(row))}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Date</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(dateLabel(row))}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Time</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(timeLabel(row))}</td></tr>
        ${location}
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Program</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(row.program_name)}</td></tr>
      </table>
      <p style="margin:16px 0 0;">Please make sure you arrive on time. If you have questions, contact your program staff.</p>
      <p style="margin:24px 0 0;">
        <a href="${escapeHtml(appUrl)}/calendar" style="display:inline-block;background:${INK};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600;font-size:15px;">Open the calendar</a>
      </p>
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid ${LINE};color:${MUTED};font-size:13px;">
        <p style="margin:0 0 6px;">You are receiving this because you are a student in ${escapeHtml(row.program_name)}.</p>
        <p style="margin:0;">Turn event emails off — or back on — under <a href="${escapeHtml(appUrl)}/settings" style="color:${INK};">Email in your account settings</a>.</p>
      </div>
      <div style="height:3px;width:56px;background:${ACCENT};border-radius:2px;margin-top:20px;"></div>
    </div>
  </body>
</html>`;
}

async function sendWithResend(
  apiKey: string,
  from: { email: string; name: string },
  to: string,
  subject: string,
  html: string,
  text: string,
  idempotencyKey: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "rhs-attendance-event-announcements/1.0",
      // Resend collapses repeated requests with the same key, which covers the
      // ambiguous case where a response was lost after Resend accepted it.
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: `${from.name} <${from.email}>`,
      to: [to],
      subject,
      html,
      text,
      tags: [{ name: "category", value: "event-announcement" }],
    }),
  });

  if (response.ok) {
    let id: string | undefined;
    try {
      const body = (await response.json()) as { id?: string };
      id = typeof body.id === "string" ? body.id : undefined;
    } catch {
      /* a successful send does not need its id to be readable */
    }
    return { ok: true, id };
  }

  let detail = `${response.status}`;
  try {
    const body = (await response.json()) as { message?: string; name?: string };
    if (body.message) detail = `${response.status} ${body.message}`;
    else if (body.name) detail = `${response.status} ${body.name}`;
  } catch {
    /* a non-JSON error body adds nothing */
  }
  return { ok: false, error: detail };
}

Deno.serve(async (request: Request) => {
  const json = (body: Record<string, unknown>, status = 200): Response =>
    Response.json(body, { status, headers: { "Content-Type": "application/json" } });

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM") || Deno.env.get("ANNOUNCEMENT_FROM_EMAIL");
  const fromName = Deno.env.get("ANNOUNCEMENT_FROM_NAME") || "RHS Music & Arts";
  const appUrl = (Deno.env.get("PUBLIC_APP_URL") ?? DEFAULT_APP_URL).replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Event announcements are not configured on the server." }, 500);
  }

  // Fail closed. The cron job sends the shared secret; the service-role bearer
  // branch is for a controlled manual run.
  const expected = Deno.env.get("EVENT_ANNOUNCEMENT_SECRET");
  const presented = request.headers.get("x-event-announcement-secret");
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const authorised =
    (!!expected && presented === expected) || (!!bearer && bearer === serviceRoleKey);
  if (!authorised) {
    return json({ ok: false, error: "Not authorised to send event announcements." }, 401);
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

  // A clock override is a testing aid, and only a dry run may use it. A real run
  // always uses the server's now, so a caller cannot mail early.
  let now = new Date();
  if (dryRun && typeof payload.now === "string") {
    const parsed = new Date(payload.now);
    if (!Number.isNaN(parsed.getTime())) now = parsed;
  }

  if (!dryRun && (!resendKey || !fromEmail)) {
    return json(
      {
        ok: false,
        error: "Email is not configured: set RESEND_API_KEY and RESEND_FROM as function secrets.",
      },
      500
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin.rpc("due_event_announcements", {
    p_now: now.toISOString(),
    p_limit: MAX_RECIPIENTS,
  });
  if (error) {
    console.error("event-announcements: due_event_announcements failed", error.message);
    return json({ ok: false, error: `Could not read the announcement queue: ${error.message}` }, 500);
  }

  const rows = (data ?? []) as unknown as DueRow[];

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      now: now.toISOString(),
      recipients: rows.length,
      emails: rows.map((row) => ({
        event: row.event_name,
        program: row.program_name,
        recipient: row.recipient,
        starts_at: row.event_start,
        school_date: dateLabel(row),
        school_time: timeLabel(row),
        subject: subjectFor(row),
      })),
    });
  }

  let sent = 0;
  let skipped = 0;
  const failures: { event: string; program: string; error: string }[] = [];

  for (const row of rows) {
    const { data: claimId, error: claimError } = await admin.rpc("claim_event_announcement", {
      p_event: row.event_id,
      p_user: row.user_id,
      // Fresh clock, not the one the queue read used: a run that took a while
      // must not claim an announcement that is no longer appropriate.
      p_now: new Date().toISOString(),
    });
    if (claimError) {
      console.error(
        `event-announcements: claim failed for event ${row.event_id}`,
        claimError.message
      );
      failures.push({
        event: row.event_name,
        program: row.program_name,
        error: `Could not claim the announcement: ${claimError.message}`,
      });
      continue;
    }
    if (!claimId) {
      // Already sent, in flight, out of attempts, or no longer eligible.
      skipped += 1;
      continue;
    }

    // The claim re-read the event, but this is the copy the email describes.
    // Using the latest saved schedule and location is what stops an event
    // edited just after it was created from announcing the old details.
    const { data: fresh, error: freshError } = await admin
      .from("events")
      .select("name, date, end_date, all_day, location, archived")
      .eq("id", row.event_id)
      .maybeSingle();
    if (freshError || !fresh || fresh.archived) {
      const reason = freshError
        ? `Could not re-read the event: ${freshError.message}`
        : fresh?.archived
          ? "The event was archived after the announcement was queued."
          : "The event no longer exists.";
      await admin.rpc("complete_event_announcement", {
        p_id: claimId as string,
        p_ok: false,
        p_resend_email_id: null,
        p_error: reason,
      });
      failures.push({ event: row.event_name, program: row.program_name, error: reason });
      continue;
    }

    const current: DueRow = {
      ...row,
      event_name: fresh.name ?? row.event_name,
      event_start: fresh.date ?? row.event_start,
      event_end: fresh.end_date ?? null,
      all_day: fresh.all_day ?? row.all_day,
      location: fresh.location ?? "",
    };
    const startsAt = new Date(current.event_start);
    const endsAt = current.event_end ? new Date(current.event_end) : null;
    const stillToCome = Number.isNaN(startsAt.getTime())
      ? false
      : current.all_day
        ? (endsAt ?? new Date(startsAt.getTime() + 86_400_000)).getTime() > Date.now()
        : startsAt.getTime() > Date.now();
    if (!stillToCome) {
      const reason = "The event had already started or ended after the announcement was queued.";
      await admin.rpc("complete_event_announcement", {
        p_id: claimId as string,
        p_ok: false,
        p_resend_email_id: null,
        p_error: reason,
      });
      failures.push({ event: current.event_name, program: current.program_name, error: reason });
      continue;
    }

    let result: { ok: boolean; id?: string; error?: string };
    try {
      result = await sendWithResend(
        resendKey!,
        { email: fromEmail!, name: fromName },
        row.email,
        subjectFor(current),
        htmlFor(current, appUrl, fromName),
        textFor(current, appUrl),
        `event-announcement:${current.event_id}:${current.user_id}`
      );
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : "network error" };
    }

    const { error: completeError } = await admin.rpc("complete_event_announcement", {
      p_id: claimId as string,
      p_ok: result.ok,
      p_resend_email_id: result.id ?? null,
      p_error: result.error ?? null,
    });
    if (completeError) {
      // Resend's answer is the truth; a bookkeeping failure must be visible but
      // must not turn an accepted send into a retry.
      console.error("event-announcements: could not record a result", completeError.message);
    }

    if (result.ok) {
      sent += 1;
    } else {
      failures.push({
        event: row.event_name,
        program: row.program_name,
        error: result.error ?? "unknown error",
      });
      console.error(
        `event-announcements: send failed for event ${row.event_id}: ${result.error ?? "unknown error"}`
      );
    }
  }

  console.log(
    `event-announcements: ${rows.length} due, ${sent} accepted, ${skipped} skipped, ${failures.length} failed`
  );

  return json({
    ok: true,
    due: rows.length,
    accepted: sent,
    skipped,
    failed: failures.length,
    failures,
    max_attempts: MAX_ATTEMPTS,
  });
});
