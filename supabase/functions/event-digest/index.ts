import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * event-digest — the scheduled "what's coming up" email.
 *
 * Why this exists: events reach people through the in-app bell (`notifications`,
 * migration 016), which only helps someone who opens the app. A rehearsal moved
 * to Thursday is otherwise found by whoever happens to look. This function runs
 * on a schedule and mails each subscribed member the events their programs have
 * coming up.
 *
 * Server-to-server only. It is called by Supabase Cron (pg_cron + pg_net), the
 * same way `sync_google_calendar` is, and authenticates with the
 * `x-event-digest-secret` header. There is no CORS block on purpose: no browser
 * should be able to trigger a mail run.
 *
 *   -- 5pm Pacific: `0 0 * * *` UTC is 5pm PDT / 4pm PST
 *   select vault.create_secret('<EVENT_DIGEST_SECRET>', 'event_digest_secret');
 *   select cron.schedule('event-digest', '0 0 * * *', $$
 *     select net.http_post(
 *       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/event-digest',
 *       headers := jsonb_build_object(
 *         'x-event-digest-secret',
 *         (select decrypted_secret from vault.decrypted_secrets
 *           where name = 'event_digest_secret'),
 *         'Content-Type', 'application/json'),
 *       body := '{"days": 7}'::jsonb);
 *   $$);
 *
 * The job reads the secret from Vault because `cron.job` keeps its command in
 * plain text — the statement that creates the job is not where a secret belongs.
 *
 * The database does the deciding and this function only renders and sends:
 * `due_event_digests()` (migration 032) returns exactly who is owed an email —
 * active, subscribed, confirmed address, at least one event in the window, and
 * no delivery logged for today. `record_event_digests()` then logs it, which is
 * what makes a retried or overlapping run send one email rather than two. A send
 * that fails is deliberately not recorded, so the next run picks it up again.
 *
 * A member whose events span two programs gets one email listing both, and one
 * delivery row per program, so opting out of one program leaves the other's
 * events arriving.
 */

const DEFAULT_APP_URL = "https://rhsattendance.org";

/** The school's clock. Event times are stored as instants; a digest has to name them in local time. */
const SCHOOL_TIME_ZONE = "America/Los_Angeles";

/** Brand ink, matching the app's `--cue-ink` default theme (#1e4a32 / #c7912c). */
const INK = "#1e4a32";
const ACCENT = "#c7912c";
const MUTED = "#6b6f6b";
const LINE = "#e2e0d6";

const MAX_RECIPIENTS = 500;

interface DigestEvent {
  id: string;
  name: string;
  date: string;
  end_date: string | null;
  all_day: boolean;
  location: string;
  event_type: string;
}

interface DueRow {
  user_id: string;
  auth_user_id: string;
  email: string;
  recipient: string;
  ensemble_id: string;
  program_name: string;
  event_count: number;
  events: DigestEvent[];
}

interface Recipient {
  userId: string;
  email: string;
  name: string;
  programs: { ensembleId: string; programName: string; events: DigestEvent[] }[];
}

/** Event text is user-supplied and lands in a mail client: escape it. */
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
  weekday: "short",
  month: "short",
  day: "numeric",
});

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

/** "Thu, Oct 15 · 6:30 PM" — or just the day when the event has no clock time. */
function whenLabel(event: DigestEvent): string {
  const day = dayFormat.format(new Date(event.date));
  if (event.all_day) return `${day} · all day`;
  const start = timeFormat.format(new Date(event.date));
  if (!event.end_date) return `${day} · ${start}`;
  const end = timeFormat.format(new Date(event.end_date));
  return `${day} · ${start}–${end}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function buildSubject(recipient: Recipient): string {
  const total = recipient.programs.reduce((sum, p) => sum + p.events.length, 0);
  const first = recipient.programs[0]!;
  if (recipient.programs.length === 1) {
    return `${total} upcoming ${plural(total, "event", "events")} in ${first.programName}`;
  }
  return `${total} upcoming ${plural(total, "event", "events")} across your programs`;
}

function buildText(recipient: Recipient, appUrl: string): string {
  const lines: string[] = [`Hi ${recipient.name},`, ""];
  lines.push(
    recipient.programs.length === 1
      ? `Here is what ${recipient.programs[0]!.programName} has coming up:`
      : "Here is what your programs have coming up:"
  );

  for (const program of recipient.programs) {
    lines.push("", program.programName);
    for (const event of program.events) {
      const where = event.location ? ` — ${event.location}` : "";
      lines.push(`  • ${event.name}: ${whenLabel(event)}${where}`);
    }
  }

  lines.push(
    "",
    `Open the program: ${appUrl}`,
    "",
    "You are getting this because you are on the roster of a program with upcoming events.",
    `Turn these emails off, or back on, under Email in your account settings: ${appUrl}/me`
  );
  return lines.join("\n");
}

function buildHtml(recipient: Recipient, appUrl: string, senderName: string): string {
  const intro =
    recipient.programs.length === 1
      ? `Here is what <strong>${escapeHtml(recipient.programs[0]!.programName)}</strong> has coming up:`
      : "Here is what your programs have coming up:";

  const sections = recipient.programs
    .map((program) => {
      const rows = program.events
        .map(
          (event) => `
            <tr>
              <td style="padding:10px 12px 10px 0;border-top:1px solid ${LINE};white-space:nowrap;vertical-align:top;color:${MUTED};font-size:14px;">${escapeHtml(whenLabel(event))}</td>
              <td style="padding:10px 0;border-top:1px solid ${LINE};vertical-align:top;">
                <div style="font-weight:600;color:#1b201b;font-size:15px;">${escapeHtml(event.name)}</div>
                ${event.location ? `<div style="color:${MUTED};font-size:13px;">${escapeHtml(event.location)}</div>` : ""}
              </td>
            </tr>`
        )
        .join("");

      return `
        <h2 style="margin:24px 0 4px;font-size:15px;letter-spacing:0.02em;text-transform:uppercase;color:${INK};">${escapeHtml(program.programName)}</h2>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border-bottom:1px solid ${LINE};">
          ${rows}
        </table>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f5ef;">
    <div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b201b;font-size:15px;line-height:1.5;">
      <div style="height:4px;background:${INK};border-radius:2px;"></div>
      <p style="margin:20px 0 0;color:${MUTED};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(senderName)}</p>
      <h1 style="margin:4px 0 16px;font-size:24px;line-height:1.25;color:#1b201b;font-weight:700;">Coming up</h1>
      <p style="margin:0;">Hi ${escapeHtml(recipient.name)}, ${intro}</p>
      ${sections}
      <p style="margin:28px 0 0;">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:${INK};color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:6px;font-weight:600;font-size:15px;">Open the program</a>
      </p>
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid ${LINE};color:${MUTED};font-size:13px;">
        <p style="margin:0 0 6px;">You are getting this because you are on the roster of a program with upcoming events.</p>
        <p style="margin:0;">Turn these emails off — or back on — under <a href="${escapeHtml(appUrl)}/me" style="color:${INK};">Email in your account settings</a>.</p>
      </div>
      <div style="height:3px;width:56px;background:${ACCENT};border-radius:2px;margin-top:20px;"></div>
    </div>
  </body>
</html>`;
}

function groupByRecipient(rows: DueRow[]): Recipient[] {
  const byUser = new Map<string, Recipient>();
  for (const row of rows) {
    let recipient = byUser.get(row.user_id);
    if (!recipient) {
      recipient = { userId: row.user_id, email: row.email, name: row.recipient, programs: [] };
      byUser.set(row.user_id, recipient);
    }
    recipient.programs.push({
      ensembleId: row.ensemble_id,
      programName: row.program_name,
      events: row.events ?? [],
    });
  }
  return [...byUser.values()];
}

async function sendWithResend(
  apiKey: string,
  from: { email: string; name: string },
  recipient: Recipient,
  subject: string,
  html: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Resend asks direct HTTP clients to identify themselves.
      "User-Agent": "rhs-attendance-event-digest/1.0",
    },
    body: JSON.stringify({
      from: `${from.name} <${from.email}>`,
      to: [recipient.email],
      subject,
      html,
      text,
      // A digest is not a campaign. Resend has no per-message tracking switch —
      // open/click tracking is a domain setting — so the domain keeps it off.
      tags: [{ name: "category", value: "event-digest" }],
    }),
  });

  if (response.ok) return { ok: true };

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
  // An empty secret is not a configured one: with `??`, DIGEST_FROM_NAME= would
  // build a From header with no display name and RESEND_FROM= would skip the
  // fallback. `||` treats blank as absent.
  const fromEmail = Deno.env.get("RESEND_FROM") || Deno.env.get("DIGEST_FROM_EMAIL");
  const fromName = Deno.env.get("DIGEST_FROM_NAME") || "RHS Music & Arts";
  const appUrl = (Deno.env.get("PUBLIC_APP_URL") ?? DEFAULT_APP_URL).replace(/\/+$/, "");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "The digest is not configured on the server." }, 500);
  }

  // Fail closed: without a secret of its own this endpoint would be an open mail
  // trigger, so it refuses to run rather than guessing. The bearer branch accepts
  // only the exact key the platform injected as SUPABASE_SERVICE_ROLE_KEY — on
  // this project the legacy `service_role` JWT from the repo's `.env` is not that
  // value and is rejected (401, observed 2026-10-11), so the supported way to
  // run a mail run by hand is the `x-event-digest-secret` header.
  const expected = Deno.env.get("EVENT_DIGEST_SECRET");
  const presented = request.headers.get("x-event-digest-secret");
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const authorised =
    (!!expected && presented === expected) || (!!bearer && bearer === serviceRoleKey);
  if (!authorised) {
    return json({ ok: false, error: "Not authorised to send digests." }, 401);
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

  const requestedDays = typeof payload.days === "number" ? payload.days : 7;
  const days = Math.min(Math.max(Math.trunc(requestedDays), 1), 30);
  const dryRun = payload.dry_run === true;

  if (!dryRun && (!resendKey || !fromEmail)) {
    return json(
      {
        ok: false,
        error:
          "Email is not configured: set RESEND_API_KEY and RESEND_FROM as function secrets.",
      },
      500
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const digestDate = now.toISOString().slice(0, 10);

  const { data, error } = await admin.rpc("due_event_digests", {
    p_digest_date: digestDate,
    p_from: now.toISOString(),
    p_to: until.toISOString(),
    p_limit: MAX_RECIPIENTS,
  });
  if (error) {
    console.error("event-digest: due_event_digests failed", error.message);
    return json({ ok: false, error: `Could not read the digest queue: ${error.message}` }, 500);
  }

  const rows = (data ?? []) as unknown as DueRow[];
  const recipients = groupByRecipient(rows);

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      days,
      digest_date: digestDate,
      recipients: recipients.length,
      emails: recipients.map((recipient) => ({
        programs: recipient.programs.map((program) => ({
          program: program.programName,
          events: program.events.map((event) => `${event.name} (${whenLabel(event)})`),
        })),
        subject: buildSubject(recipient),
      })),
    });
  }

  const sent: { userId: string; ensembleIds: string[]; digestDate: string; eventIds: string[] }[] = [];
  const failures: { program: string; error: string }[] = [];

  for (const recipient of recipients) {
    const subject = buildSubject(recipient);
    const html = buildHtml(recipient, appUrl, fromName);
    const text = buildText(recipient, appUrl);

    let result: { ok: boolean; error?: string };
    try {
      result = await sendWithResend(
        resendKey!,
        { email: fromEmail!, name: fromName },
        recipient,
        subject,
        html,
        text
      );
    } catch (cause) {
      result = { ok: false, error: cause instanceof Error ? cause.message : "network error" };
    }

    if (!result.ok) {
      // Deliberately not recorded: the next run will offer this person again.
      failures.push({
        program: recipient.programs.map((p) => p.programName).join(", "),
        error: result.error ?? "unknown error",
      });
      console.error(
        `event-digest: send failed for ${recipient.email}: ${result.error ?? "unknown error"}`
      );
      continue;
    }

    for (const program of recipient.programs) {
      sent.push({
        userId: recipient.userId,
        ensembleIds: [program.ensembleId],
        digestDate,
        eventIds: program.events.map((event) => event.id),
      });
    }
  }

  let recorded = 0;
  if (sent.length) {
    const batch = sent.map((entry) => ({
      user_id: entry.userId,
      ensemble_id: entry.ensembleIds[0],
      digest_date: entry.digestDate,
      event_ids: entry.eventIds,
    }));
    const { data: inserted, error: recordError } = await admin.rpc("record_event_digests", {
      p_rows: batch,
    });
    if (recordError) {
      // The mail is already out; say so plainly rather than reporting a failure
      // that would trigger a re-send.
      console.error("event-digest: recording deliveries failed", recordError.message);
      return json({
        ok: false,
        days,
        digest_date: digestDate,
        emailed: sent.length,
        recorded: 0,
        error: `Emails were sent but the run could not be logged: ${recordError.message}. They may repeat on the next run.`,
      }, 500);
    }
    recorded = typeof inserted === "number" ? inserted : 0;
  }

  console.log(
    `event-digest: ${days}d window, ${recipients.length} recipients, ${sent.length} logged, ${failures.length} failed`
  );

  return json({
    ok: true,
    days,
    digest_date: digestDate,
    recipients: recipients.length,
    emailed: sent.length,
    recorded,
    failed: failures.length,
    failures,
  });
});
