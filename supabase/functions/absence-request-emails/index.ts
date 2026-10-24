import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * absence-request-emails — email a program's reviewers when a student asks to
 * miss an event.
 *
 * Run on a schedule by Supabase Cron (pg_cron + pg_net), the same way the
 * digest, the 48-hour reminder and the new-event announcement are.
 * Server-to-server only: there is no CORS block, because no browser should be
 * able to trigger a mail run.
 *
 *   select vault.create_secret('<ABSENCE_REQUEST_EMAIL_SECRET>', 'absence_request_email_secret');
 *   select cron.schedule('absence-request-emails', '*\/5 * * * *', $$
 *     select net.http_post(
 *       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/absence-request-emails',
 *       headers := jsonb_build_object(
 *         'x-absence-request-email-secret',
 *         (select decrypted_secret from vault.decrypted_secrets
 *           where name = 'absence_request_email_secret'),
 *         'Content-Type', 'application/json'),
 *       body := '{}'::jsonb);
 *   $$);
 *
 * The database decides and this function renders and sends. The migration
 * (20261024223123_absence_request_emails.sql):
 *   * `due_absence_request_emails(now)` returns exactly who is due — a pending
 *     request after the cutover, and a reviewer who is an active member with a
 *     confirmed address and `absence.review`.
 *   * `claim_absence_request_email(request, reviewer)` inserts the unique
 *     delivery row BEFORE the send. Overlapping runs cannot both mail one
 *     reviewer. It re-checks the request state and the capability, so a
 *     decision, a withdrawal or a removed reviewer between the queue read and
 *     the send is respected.
 *   * `complete_absence_request_email(claim, ok, …)` records the Resend
 *     outcome. A failure keeps the row (attempt count) and may be retried, up
 *     to 3 times.
 *
 * This email reaches reviewers only. The student's in-app bell already reports
 * the decision, and no decision email is sent from here.
 */

const DEFAULT_APP_URL = "https://rhsattendance.org";

/** The school's clock, matching the app and the other app emails. */
const SCHOOL_TIME_ZONE = "America/Los_Angeles";

const INK = "#1e4a32";
const ACCENT = "#c7912c";
const MUTED = "#6b6f6b";
const LINE = "#e2e0d6";

const MAX_RECIPIENTS = 200;
const MAX_ATTEMPTS = 3;

interface DueRow {
  request_id: string;
  user_id: string;
  auth_user_id: string;
  email: string;
  recipient: string;
  ensemble_id: string;
  program_name: string;
  event_id: string;
  event_name: string;
  event_start: string;
  all_day: boolean;
  student_name: string;
  reason: string;
  submitted_at: string;
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

const stampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Friday, October 23, 2026" */
function dateLabel(row: DueRow): string {
  return dayFormat.format(new Date(row.event_start));
}

/** "3:00 PM" or "All day" — the start is what a reviewer checks first. */
function timeLabel(row: DueRow): string {
  if (row.all_day) return "All day";
  return timeFormat.format(new Date(row.event_start));
}

function submittedLabel(row: DueRow): string {
  const at = new Date(row.submitted_at);
  return Number.isNaN(at.getTime()) ? "" : stampFormat.format(at);
}

function subjectFor(row: DueRow): string {
  return `Absence request: ${row.student_name} — ${row.event_name}`;
}

function textFor(row: DueRow, appUrl: string): string {
  const lines = [
    `Hello ${row.recipient},`,
    "",
    `${row.student_name} has asked to miss an event in ${row.program_name}.`,
    "",
    `Event: ${row.event_name}`,
    `Date: ${dateLabel(row)}`,
    `Time: ${timeLabel(row)}`,
    `Program: ${row.program_name}`,
  ];
  const submitted = submittedLabel(row);
  if (submitted) lines.push(`Requested: ${submitted}`);
  lines.push(
    "",
    "Reason given:",
    row.reason,
    "",
    "Approve or deny it from the Absences screen. Approving does not mark the student present or absent — it records that the absence was allowed.",
    "",
    `Review it: ${appUrl}/absences`,
    "",
    `You are receiving this because you review absence requests for ${row.program_name}.`
  );
  return lines.join("\n");
}

function htmlFor(row: DueRow, appUrl: string, senderName: string): string {
  const submitted = submittedLabel(row);
  const submittedRow = submitted
    ? `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Requested</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(submitted)}</td></tr>`
    : "";

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f5ef;">
    <div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b201b;font-size:15px;line-height:1.5;">
      <div style="height:4px;background:${INK};border-radius:2px;"></div>
      <p style="margin:20px 0 0;color:${MUTED};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(senderName)}</p>
      <h1 style="margin:4px 0 16px;font-size:24px;line-height:1.25;color:#1b201b;font-weight:700;">Absence request to review</h1>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(row.recipient)},</p>
      <p style="margin:0 0 16px;"><strong>${escapeHtml(row.student_name)}</strong> has asked to miss an event in ${escapeHtml(row.program_name)}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};padding:8px 0;">
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Event</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(row.event_name)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Date</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(dateLabel(row))}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Time</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(timeLabel(row))}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:${MUTED};font-size:14px;vertical-align:top;">Program</td><td style="padding:6px 0;font-weight:600;font-size:15px;">${escapeHtml(row.program_name)}</td></tr>
        ${submittedRow}
      </table>
      <p style="margin:18px 0 6px;color:${MUTED};font-size:13px;text-transform:uppercase;letter-spacing:0.06em;">Reason given</p>
      <p style="margin:0;padding:12px 14px;background:#ffffff;border:1px solid ${LINE};border-radius:6px;white-space:pre-wrap;">${escapeHtml(row.reason)}</p>
      <p style="margin:16px 0 0;">Approve or deny it from the Absences screen. Approving does not mark the student present or absent — it records that the absence was allowed.</p>
      <p style="margin:24px 0 0;">
        <a href="${escapeHtml(appUrl)}/absences" style="display:inline-block;background:${INK};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600;font-size:15px;">Review the request</a>
      </p>
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid ${LINE};color:${MUTED};font-size:13px;">
        <p style="margin:0;">You are receiving this because you review absence requests for ${escapeHtml(row.program_name)}.</p>
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
      "User-Agent": "rhs-attendance-absence-request-emails/1.0",
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
      tags: [{ name: "category", value: "absence-request" }],
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
  const fromEmail = Deno.env.get("RESEND_FROM") || Deno.env.get("ABSENCE_FROM_EMAIL");
  const fromName = Deno.env.get("ABSENCE_FROM_NAME") || "RHS Music & Arts";
  const appUrl = (Deno.env.get("PUBLIC_APP_URL") ?? DEFAULT_APP_URL).replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Absence-request email is not configured on the server." }, 500);
  }

  // Fail closed. The cron job sends the shared secret; the service-role bearer
  // branch is for a controlled manual run.
  const expected = Deno.env.get("ABSENCE_REQUEST_EMAIL_SECRET");
  const presented = request.headers.get("x-absence-request-email-secret");
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const authorised =
    (!!expected && presented === expected) || (!!bearer && bearer === serviceRoleKey);
  if (!authorised) {
    return json({ ok: false, error: "Not authorised to send absence-request email." }, 401);
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
  // always uses the server's now.
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

  const { data, error } = await admin.rpc("due_absence_request_emails", {
    p_now: now.toISOString(),
    p_limit: MAX_RECIPIENTS,
  });
  if (error) {
    console.error("absence-request-emails: due_absence_request_emails failed", error.message);
    return json({ ok: false, error: `Could not read the review queue: ${error.message}` }, 500);
  }

  const rows = (data ?? []) as unknown as DueRow[];

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      now: now.toISOString(),
      recipients: rows.length,
      emails: rows.map((row) => ({
        request_id: row.request_id,
        student: row.student_name,
        event: row.event_name,
        program: row.program_name,
        recipient: row.recipient,
        school_date: dateLabel(row),
        school_time: timeLabel(row),
        subject: subjectFor(row),
      })),
    });
  }

  let sent = 0;
  let skipped = 0;
  const failures: { student: string; event: string; error: string }[] = [];

  for (const row of rows) {
    const { data: claimId, error: claimError } = await admin.rpc("claim_absence_request_email", {
      p_request: row.request_id,
      p_user: row.user_id,
      // Fresh clock, not the one the queue read used.
      p_now: new Date().toISOString(),
    });
    if (claimError) {
      console.error(
        `absence-request-emails: claim failed for request ${row.request_id}`,
        claimError.message
      );
      failures.push({
        student: row.student_name,
        event: row.event_name,
        error: `Could not claim the email: ${claimError.message}`,
      });
      continue;
    }
    if (!claimId) {
      // Already sent, in flight, out of attempts, decided or withdrawn.
      skipped += 1;
      continue;
    }

    // The claim re-read the request, but this is the copy the email describes.
    // A decision or a withdrawal between the queue read and here must not be
    // announced as pending, and the event may have been renamed or archived.
    const { data: fresh, error: freshError } = await admin
      .from("absence_requests")
      .select("status, reason, event_id, events(name, date, all_day, archived)")
      .eq("id", row.request_id)
      .maybeSingle();
    const event = (fresh as { events?: { name?: string; date?: string; all_day?: boolean; archived?: boolean } } | null)
      ?.events;
    if (freshError || !fresh || !event || event.archived || fresh.status !== "pending") {
      const reason = freshError
        ? `Could not re-read the request: ${freshError.message}`
        : !fresh
          ? "The request no longer exists."
          : "The request was decided or withdrawn after the email was queued.";
      await admin.rpc("complete_absence_request_email", {
        p_id: claimId as string,
        p_ok: false,
        p_resend_email_id: null,
        p_error: reason,
      });
      failures.push({ student: row.student_name, event: row.event_name, error: reason });
      continue;
    }

    const current: DueRow = {
      ...row,
      event_name: event.name ?? row.event_name,
      event_start: event.date ?? row.event_start,
      all_day: event.all_day ?? row.all_day,
      reason: fresh.reason ?? row.reason,
    };

    let result: { ok: boolean; id?: string; error?: string };
    try {
      result = await sendWithResend(
        resendKey!,
        { email: fromEmail!, name: fromName },
        row.email,
        subjectFor(current),
        htmlFor(current, appUrl, fromName),
        textFor(current, appUrl),
        `absence-request:${current.request_id}:${current.user_id}`
      );
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : "network error" };
    }

    const { error: completeError } = await admin.rpc("complete_absence_request_email", {
      p_id: claimId as string,
      p_ok: result.ok,
      p_resend_email_id: result.id ?? null,
      p_error: result.error ?? null,
    });
    if (completeError) {
      // Resend's answer is the truth; a bookkeeping failure must be visible but
      // must not turn an accepted send into a retry.
      console.error("absence-request-emails: could not record a result", completeError.message);
    }

    if (result.ok) {
      sent += 1;
    } else {
      failures.push({
        student: row.student_name,
        event: row.event_name,
        error: result.error ?? "unknown error",
      });
      console.error(
        `absence-request-emails: send failed for request ${row.request_id}: ${result.error ?? "unknown error"}`
      );
    }
  }

  console.log(
    `absence-request-emails: ${rows.length} due, ${sent} accepted, ${skipped} skipped, ${failures.length} failed`
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
