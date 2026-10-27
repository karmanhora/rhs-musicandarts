import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * send-makeup-emails — post-event make-up instructions, sent by staff.
 *
 * This is the only mail endpoint a browser calls, so it is deliberately narrow:
 *   * `verify_jwt = true` (the platform checks the JWT; the function checks the
 *     account again below), and the caller must be staff of the event's program
 *     with `attendance.mark_present`.
 *   * The recipient set is decided by the database — the event's expected roster
 *     minus its present/late/excused records, which is what "absent" stores to —
 *     never from the ids in the request. The request may narrow that set, never
 *     widen it, and a correction on the roll drops that student before a send.
 *   * The event's latest end time is re-read here and again by
 *     `begin_makeup_email_campaign()`; a request that arrives before the event
 *     ends is refused.
 *   * Each student gets their own Resend call, so no recipient sees another's
 *     address. `Idempotency-Key` plus the (campaign, recipient) unique row make a
 *     double-click or a retried chunk the same send; an accepted recipient is
 *     never selected again by the same operation.
 *   * Partial failures are returned per recipient and are not retried
 *     automatically. The teacher can retry only the failed ones.
 *
 * Secrets stay here: `RESEND_API_KEY` is a function secret, never a VITE_
 * variable. `SUPABASE_SERVICE_ROLE_KEY` is used for the authoritative reads.
 */

const DEFAULT_APP_URL = "https://rhsattendance.org";
const SCHOOL_TIME_ZONE = "America/Los_Angeles";

const INK = "#1e4a32";
const ACCENT = "#c7912c";
const MUTED = "#6b6f6b";
const LINE = "#e2e0d6";

const MAX_SUBJECT = 200;
const MAX_INSTRUCTIONS = 4000;
const MAX_BODY = 8000;
const MAX_RECIPIENTS = 500;
const MAX_BODY_BYTES = 24_000;

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

interface Recipient {
  delivery_id: string;
  user_id: string;
  name: string;
  email: string;
  section: string;
  status: string;
  attempts: number;
}

interface Campaign {
  ok: boolean;
  message?: string;
  campaign_id?: string;
  event_id?: string;
  event_name?: string;
  event_start?: string;
  event_end?: string;
  event_archived?: boolean;
  program_name?: string;
  teacher_name?: string;
  recipients?: Recipient[];
}

interface ResultRow {
  user_id: string;
  name: string;
  status: "accepted" | "failed";
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function fillTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole
  );
}

/** The app builds names as "First Last"; a greeting wants the first word. */
function firstName(name: string): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

interface LatestEvent {
  name: string;
  date: string;
  end_date: string | null;
  all_day: boolean;
}

function valueFor(
  campaign: Campaign,
  recipient: Recipient,
  instructions: string,
  event: LatestEvent
) {
  return {
    student_first_name: firstName(recipient.name),
    student_name: recipient.name,
    event_name: event.name || "Event",
    event_date: event.date ? dayFormat.format(new Date(event.date)) : "",
    event_time: event.all_day
      ? "All day"
      : event.date
        ? event.end_date
          ? `${timeFormat.format(new Date(event.date))} – ${timeFormat.format(new Date(event.end_date))}`
          : timeFormat.format(new Date(event.date))
        : "",
    program_name: campaign.program_name ?? "Program",
    teacher_name: campaign.teacher_name ?? "",
    makeup_instructions: instructions,
  };
}

function subjectFor(template: string, values: Record<string, string>): string {
  return fillTemplate(template, values).replace(/[\r\n]+/g, " ").trim();
}

function textFor(body: string, appUrl: string): string {
  return `${body}\n\nOpen the program: ${appUrl}`;
}

function htmlFor(body: string, appUrl: string, senderName: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 12px;">${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f5ef;">
    <div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b201b;font-size:15px;line-height:1.5;">
      <div style="height:4px;background:${INK};border-radius:2px;"></div>
      <p style="margin:20px 0 0;color:${MUTED};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(senderName)}</p>
      <div style="margin-top:16px;">${paragraphs}</div>
      <p style="margin:24px 0 0;">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:${INK};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600;font-size:15px;">Open the program</a>
      </p>
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
      "User-Agent": "rhs-attendance-makeup-email/1.0",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: `${from.name} <${from.email}>`,
      to: [to],
      subject,
      html,
      text,
      tags: [{ name: "category", value: "makeup-email" }],
    }),
  });

  if (response.ok) {
    let id: string | undefined;
    try {
      const body = (await response.json()) as { id?: string };
      id = typeof body.id === "string" ? body.id : undefined;
    } catch {
      /* accepted is enough */
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

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Control characters (other than the newlines/tabs allowed in a message) do
  // not belong in an email body and can confuse a mail client.
  const cleaned = value.replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (cleaned.length > max) return null;
  return cleaned;
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
    return response({ ok: false, error: "Sign in before sending email." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("RESEND_FROM") || Deno.env.get("MAKEUP_FROM_EMAIL");
  const fromName = Deno.env.get("MAKEUP_FROM_NAME") || "RHS Music & Arts";
  const appUrl = (Deno.env.get("PUBLIC_APP_URL") ?? DEFAULT_APP_URL).replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    return response({ ok: false, error: "Make-up email is not configured on the server." }, 500);
  }
  if (!resendKey || !fromEmail) {
    return response(
      {
        ok: false,
        error: "Email is not configured: set RESEND_API_KEY and RESEND_FROM as function secrets.",
      },
      500
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return response({ ok: false, error: "That request is too large." }, 413);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody || "{}") as unknown;
    if (!parsed || typeof parsed !== "object") throw new SyntaxError("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return response({ ok: false, error: "The request was not valid JSON." }, 400);
  }

  const eventId = typeof payload.event_id === "string" ? payload.event_id : "";
  const operationId =
    typeof payload.client_operation_id === "string" ? payload.client_operation_id : "";
  const subjectRaw = cleanText(payload.subject, MAX_SUBJECT);
  const instructionsRaw = cleanText(payload.instructions, MAX_INSTRUCTIONS);
  const bodyRaw = cleanText(payload.body_template, MAX_BODY);

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(eventId) || !uuid.test(operationId)) {
    return response({ ok: false, error: "The event or send operation is missing." }, 400);
  }
  if (subjectRaw === null || !subjectRaw.trim()) {
    return response({ ok: false, error: "Add a subject before sending." }, 400);
  }
  if (instructionsRaw === null) {
    return response({ ok: false, error: "The make-up instructions are too long." }, 400);
  }
  if (bodyRaw === null || !bodyRaw.trim()) {
    return response({ ok: false, error: "Add a message before sending." }, 400);
  }

  let requestedRecipients: string[] | null = null;
  if (payload.recipient_ids !== undefined && payload.recipient_ids !== null) {
    if (!Array.isArray(payload.recipient_ids)) {
      return response({ ok: false, error: "The recipient list is not valid." }, 400);
    }
    if (payload.recipient_ids.length > MAX_RECIPIENTS) {
      return response({ ok: false, error: "That is more than 500 recipients." }, 400);
    }
    const ids: string[] = [];
    for (const value of payload.recipient_ids) {
      if (typeof value !== "string" || !uuid.test(value)) {
        return response({ ok: false, error: "The recipient list contains an invalid id." }, 400);
      }
      ids.push(value);
    }
    requestedRecipients = ids;
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the JWT and resolve the person. `getUser` is a network call to the
  // auth server, not a decode of a token we were handed.
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) {
    return response({ ok: false, error: "Your sign-in has expired. Sign in again and retry." }, 401);
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, deactivated")
    .eq("auth_user_id", authData.user.id)
    .maybeSingle();
  if (profileError) {
    return response({ ok: false, error: "Could not read your staff profile." }, 500);
  }
  if (!profile || profile.deactivated) {
    return response({ ok: false, error: "Your account cannot send email." }, 403);
  }

  // The database re-checks authority, the end time and the recipient set.
  const { data: began, error: beginError } = await admin.rpc("begin_makeup_email_campaign", {
    p_event: eventId,
    p_actor: profile.id,
    p_operation: operationId,
    p_subject: subjectRaw,
    p_instructions: instructionsRaw,
    p_body_template: bodyRaw,
    p_recipients: requestedRecipients,
  });
  if (beginError) {
    console.error("send-makeup-emails: begin failed", beginError.message);
    return response({ ok: false, error: `Could not prepare this email: ${beginError.message}` }, 500);
  }

  const campaign = (began ?? null) as Campaign | null;
  if (!campaign?.ok) {
    const message = campaign?.message ?? "Could not prepare this email.";
    return response(
      { ok: false, error: message },
      message.startsWith("Too many") ? 429 : 403
    );
  }

  const recipients = campaign.recipients ?? [];
  if (recipients.length === 0) {
    return response({
      ok: true,
      campaign_id: campaign.campaign_id,
      accepted: 0,
      failed: 0,
      results: [],
      message: "Nothing left to send for this operation.",
    });
  }

  // Re-check the latest schedule here as well. `begin` did, but a long-lived
  // composer session or a clock skew should not be able to mail a cancelled
  // event. The check is refreshed at least every 15 seconds in the loop.
  let lastCheck = 0;
  let scheduleOk = true;
  let scheduleReason = "";
  // The email describes the latest saved schedule, not the snapshot taken when
  // the composer opened. `checkSchedule` refreshes this with the same read that
  // decides whether the event may still be mailed about.
  let latestEvent: LatestEvent = {
    name: campaign.event_name ?? "Event",
    date: campaign.event_start ?? "",
    end_date: campaign.event_end ?? null,
    all_day: false,
  };

  async function checkSchedule(): Promise<boolean> {
    const now = Date.now();
    if (now - lastCheck < 15_000) return scheduleOk;
    lastCheck = now;

    const { data: latest, error } = await admin
      .from("events")
      .select("name, date, end_date, all_day, archived")
      .eq("id", eventId)
      .maybeSingle();
    if (error || !latest) {
      scheduleOk = false;
      scheduleReason = "This event could not be re-read.";
      return false;
    }
    latestEvent = {
      name: latest.name ?? latestEvent.name,
      date: latest.date ?? latestEvent.date,
      end_date: latest.end_date ?? null,
      all_day: latest.all_day === true,
    };
    if (latest.archived) {
      scheduleOk = false;
      scheduleReason = "This event was archived, so sending stopped.";
      return false;
    }
    const end = latest.end_date ? new Date(latest.end_date).getTime() : NaN;
    const start = latest.date ? new Date(latest.date).getTime() : NaN;
    if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) {
      scheduleOk = false;
      scheduleReason = "This event no longer has a valid end time.";
      return false;
    }
    if (Date.now() < end) {
      scheduleOk = false;
      scheduleReason = "The event's schedule moved and it has not ended yet.";
      return false;
    }
    scheduleOk = true;
    return true;
  }

  const results: ResultRow[] = [];

  for (const recipient of recipients) {
    if (!(await checkSchedule())) {
      // Everything not yet attempted is recorded as failed with the reason;
      // nothing is auto-retried.
      const { error: stopError } = await admin.rpc("record_makeup_email_delivery", {
        p_campaign: campaign.campaign_id,
        p_user: recipient.user_id,
        p_ok: false,
        p_resend_email_id: null,
        p_error: scheduleReason,
      });
      if (stopError) {
        console.error("send-makeup-emails: could not record a stopped send", stopError.message);
      }
      results.push({
        user_id: recipient.user_id,
        name: recipient.name,
        status: "failed",
        error: scheduleReason,
      });
      continue;
    }

    const values = valueFor(campaign, recipient, instructionsRaw, latestEvent);
    const subject = subjectFor(subjectRaw, values);
    const body = fillTemplate(bodyRaw, values);

    let result: { ok: boolean; id?: string; error?: string };
    try {
      result = await sendWithResend(
        resendKey,
        { email: fromEmail, name: fromName },
        recipient.email,
        subject,
        htmlFor(body, appUrl, fromName),
        textFor(body, appUrl),
        // Stable for this campaign + student. Resend collapses a concurrent or
        // ambiguous repeat within its key window, and a deliberate follow-up is
        // a new campaign id, so it still gets a fresh key.
        `makeup:${campaign.campaign_id}:${recipient.user_id}`
      );
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : "network error" };
    }

    const { error: recordError } = await admin.rpc("record_makeup_email_delivery", {
      p_campaign: campaign.campaign_id,
      p_user: recipient.user_id,
      p_ok: result.ok,
      p_resend_email_id: result.id ?? null,
      p_error: result.error ?? null,
    });
    if (recordError) {
      console.error("send-makeup-emails: could not record a delivery", recordError.message);
    }

    results.push({
      user_id: recipient.user_id,
      name: recipient.name,
      status: result.ok ? "accepted" : "failed",
      ...(result.ok ? {} : { error: result.error ?? "unknown error" }),
    });

    if (!result.ok) {
      console.error(
        `send-makeup-emails: send failed for campaign ${campaign.campaign_id}: ${result.error ?? "unknown error"}`
      );
    }
  }

  const accepted = results.filter((row) => row.status === "accepted").length;
  const failed = results.length - accepted;

  console.log(
    `send-makeup-emails: campaign ${campaign.campaign_id}, ${accepted} accepted, ${failed} failed`
  );

  return response({
    ok: true,
    campaign_id: campaign.campaign_id,
    accepted,
    failed,
    results,
  });
});
