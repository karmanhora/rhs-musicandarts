#!/usr/bin/env node
// ============================================================================
// check_event_digest.mjs — run the real `event-digest` edge function locally
// ============================================================================
//   node scripts/dev/check_event_digest.mjs
//
// Why it exists: this repo has no Deno runtime and no Supabase CLI, so the
// sender cannot be exercised the way it is deployed. This harness imports the
// function *unmodified*, shims `Deno.env` / `Deno.serve`, and stubs `fetch` at
// the network boundary — PostgREST for the two RPCs, api.resend.com for the
// mail — then drives the handler with real `Request`s. That covers the parts a
// SQL suite cannot: the shared secret, the JSON contract with
// `due_event_digests()`, the rendered subject/HTML/text, the Resend payload,
// the one-email-per-person grouping, and that a failed send is not logged.
//
// It proves the function's logic, not the deployment: nothing here reaches a
// real database or a real Resend account. Read-only, safe to run any time.
// ============================================================================
import { registerHooks } from "node:module";

// `npm:` specifiers are Deno's; Node needs the package name.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("npm:")) {
      return next(specifier.slice(4).replace(/@\d+(\.\d+)*$/, ""), context);
    }
    return next(specifier, context);
  },
});

let pass = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : `\n       ${detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// The Deno surface the function uses, and a fetch stub that records traffic
// ---------------------------------------------------------------------------
const ENV = {
  SUPABASE_URL: "https://digest-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  RESEND_FROM: "noreply@rhsattendance.org",
  DIGEST_FROM_NAME: "RHS Music & Arts",
  PUBLIC_APP_URL: "https://app.example.test",
  EVENT_DIGEST_SECRET: "digest-secret",
};

let handler = null;
globalThis.Deno = {
  env: {
    get: (key) => ENV[key],
  },
  serve: (fn) => {
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => {} };
  },
};

/** What the stubbed network is told to answer with, per scenario. */
const scenario = {
  due: [],
  resendStatus: 200,
  resendError: {
    statusCode: 403,
    name: "validation_error",
    message: "The rhsattendance.org domain is not verified. Please verify the domain before sending emails.",
  },
};

const traffic = { due: [], recorded: null, mails: [] };

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.includes("/rest/v1/rpc/due_event_digests")) {
    traffic.due.push(JSON.parse(init.body ?? "{}"));
    return Response.json(scenario.due);
  }
  if (url.includes("/rest/v1/rpc/record_event_digests")) {
    traffic.recorded = JSON.parse(init.body ?? "{}");
    return Response.json(Array.isArray(traffic.recorded.p_rows) ? traffic.recorded.p_rows.length : 0);
  }
  if (url.includes("api.resend.com")) {
    traffic.mails.push({
      authorization: new Headers(init.headers).get("Authorization"),
      body: JSON.parse(init.body ?? "{}"),
    });
    if (scenario.resendStatus >= 300) {
      return Response.json(scenario.resendError, { status: scenario.resendStatus });
    }
    return Response.json({ id: "email-id" }, { status: 200 });
  }
  throw new Error(`unexpected fetch to ${url}`);
};

// ---------------------------------------------------------------------------
// Canned rows in the shape `due_event_digests()` returns
// ---------------------------------------------------------------------------
const event = (over = {}) => ({
  id: "e0000000-0000-4000-8000-00000000000" + (traffic.due.length + 1),
  name: "Wind Ensemble Rehearsal",
  date: "2026-10-15T01:30:00.000Z",
  end_date: "2026-10-15T03:30:00.000Z",
  all_day: false,
  location: "Band Room",
  event_type: "rehearsal",
  ...over,
});

const dueRow = (over = {}) => ({
  user_id: "10000000-0000-4000-8000-000000000001",
  auth_user_id: "a0000000-0000-4000-8000-000000000001",
  email: "student@example.test",
  recipient: "Sam Student",
  ensemble_id: "50000000-0000-4000-8000-000000000001",
  program_name: "RHS Band",
  event_count: 1,
  events: [event()],
  ...over,
});

await import("../../supabase/functions/event-digest/index.ts");

if (typeof handler !== "function") {
  console.error("the function did not call Deno.serve()");
  process.exit(1);
}

const call = (body, headers = {}) =>
  handler(
    new Request("https://digest-test.supabase.co/functions/v1/event-digest", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === null ? undefined : JSON.stringify(body),
    })
  );

const reset = () => {
  traffic.due = [];
  traffic.recorded = null;
  traffic.mails = [];
  scenario.due = [];
  scenario.resendStatus = 200;
};

// ---------------------------------------------------------------------------
// 1. Only the scheduler may trigger a mail run
// ---------------------------------------------------------------------------
console.log("1. the shared secret");
reset();
scenario.due = [dueRow()];

const noSecret = await call({ days: 7 });
check("a request with no secret is refused", noSecret.status === 401, `got ${noSecret.status}`);
check("…and no mail was attempted", traffic.mails.length === 0);
check("…and the queue was never read", traffic.due.length === 0);

const wrongSecret = await call({ days: 7 }, { "x-event-digest-secret": "nope" });
check("a wrong secret is refused", wrongSecret.status === 401, `got ${wrongSecret.status}`);
check("…and no mail was attempted", traffic.mails.length === 0);

const bearer = await call({ days: 7 }, { Authorization: "Bearer service-role-key" });
check(
  "an operator's service-role bearer is accepted",
  bearer.status === 200,
  `got ${bearer.status} ${await bearer.text()}`
);
check("…and one mail went out", traffic.mails.length === 1);

const getMethod = await handler(
  new Request("https://digest-test.supabase.co/functions/v1/event-digest", { method: "GET" })
);
check("a GET is refused", getMethod.status === 405, `got ${getMethod.status}`);

// ---------------------------------------------------------------------------
// 2. Dry run: shows what would go out, sends nothing
// ---------------------------------------------------------------------------
console.log("2. dry run");
reset();
scenario.due = [
  dueRow(),
  dueRow({
    ensemble_id: "50000000-0000-4000-8000-000000000002",
    program_name: "RHS Orchestra",
    events: [event({ id: "e2", name: "Orchestra Sectional", all_day: true, end_date: null })],
  }),
];

const dry = await call({ days: 7, dry_run: true }, { "x-event-digest-secret": "digest-secret" });
const dryBody = await dry.json();
check("a dry run succeeds", dry.status === 200 && dryBody.ok === true, JSON.stringify(dryBody));
check("…and reports no mail attempted", traffic.mails.length === 0);
check("…and logs nothing", traffic.recorded === null);
check(
  "…and collapses one person's two programs into a single email",
  dryBody.recipients === 1 && dryBody.emails.length === 1,
  JSON.stringify(dryBody.emails)
);
check(
  "…naming both programs and their events",
  dryBody.emails[0].programs.length === 2 &&
    dryBody.emails[0].programs[0].events[0].includes("Wind Ensemble Rehearsal") &&
    dryBody.emails[0].programs[1].events[0].includes("all day"),
  JSON.stringify(dryBody.emails)
);
check(
  "…with a subject that admits there is more than one program",
  dryBody.emails[0].subject === "2 upcoming events across your programs",
  dryBody.emails[0].subject
);
check(
  "…passing the window through to the database",
  traffic.due.length === 1 && traffic.due[0].p_limit === 500 && !!traffic.due[0].p_from,
  JSON.stringify(traffic.due)
);

// ---------------------------------------------------------------------------
// 3. A real run: the mail and the log
// ---------------------------------------------------------------------------
console.log("3. sending");
reset();
scenario.due = [
  dueRow(),
  dueRow({
    user_id: "10000000-0000-4000-8000-000000000002",
    email: "other@example.test",
    recipient: "Robin Other",
    ensemble_id: "50000000-0000-4000-8000-000000000002",
    program_name: "RHS Orchestra",
  }),
];

const sent = await call({ days: 7 }, { "x-event-digest-secret": "digest-secret" });
const sentBody = await sent.json();
check("the run succeeds", sent.status === 200 && sentBody.ok === true, JSON.stringify(sentBody));
check("…exactly one mail per person", traffic.mails.length === 2, `got ${traffic.mails.length}`);

const mail = traffic.mails[0];
check(
  "…authenticated with the Resend key",
  mail.authorization === "Bearer resend-key",
  mail.authorization
);
check(
  "…addressed to the member from the verified domain",
  mail.body.to?.[0] === "student@example.test" &&
    mail.body.from === "RHS Music & Arts <noreply@rhsattendance.org>",
  JSON.stringify({ to: mail.body.to, from: mail.body.from })
);
check(
  "…with a subject naming the program and the count",
  mail.body.subject === "1 upcoming event in RHS Band",
  mail.body.subject
);

const html = mail.body.html ?? "";
const text = mail.body.text ?? "";
check(
  "…carrying a local time, not UTC",
  html.includes("Wed, Oct 14") && html.includes("6:30 PM"),
  html.match(/Wed[^<]*/)?.[0]
);
check("…and the location", html.includes("Band Room"));
check(
  "…linking back to the app and to the settings that turn it off",
  html.includes("https://app.example.test") &&
    html.includes("https://app.example.test/me"),
  html.match(/https:\/\/app\.example\.test[^"]*/g)?.join(" ")
);
check(
  "…with a plain-text alternative for every HTML part",
  text.includes("Wind Ensemble Rehearsal") && text.includes("Turn these emails off"),
  text
);
check(
  "…tagged as a digest, not a campaign",
  mail.body.tags?.[0]?.name === "category" && mail.body.tags?.[0]?.value === "event-digest",
  JSON.stringify(mail.body.tags)
);

check(
  "the run is logged once per program",
  Array.isArray(traffic.recorded?.p_rows) && traffic.recorded.p_rows.length === 2,
  JSON.stringify(traffic.recorded)
);
check(
  "…against the person and the program the mail covered",
  traffic.recorded.p_rows[0].user_id === "10000000-0000-4000-8000-000000000001" &&
    traffic.recorded.p_rows[0].ensemble_id === "50000000-0000-4000-8000-000000000001",
  JSON.stringify(traffic.recorded.p_rows[0])
);
check(
  "…keeping the event ids that were announced",
  Array.isArray(traffic.recorded.p_rows[0].event_ids) &&
    traffic.recorded.p_rows[0].event_ids.length === 1,
  JSON.stringify(traffic.recorded.p_rows[0].event_ids)
);
check("…and reported back", sentBody.recorded === 2, JSON.stringify(sentBody));

// ---------------------------------------------------------------------------
// 4. A failed send is reported and retried, never logged as sent
// ---------------------------------------------------------------------------
console.log("4. a failed send");
reset();
scenario.due = [dueRow()];
scenario.resendStatus = 403;

const failed = await call({ days: 7 }, { "x-event-digest-secret": "digest-secret" });
const failedBody = await failed.json();
check(
  "the run reports the failure rather than claiming success",
  failedBody.ok === true && failedBody.failed === 1 && failedBody.emailed === 0,
  JSON.stringify(failedBody)
);
check("…and does not record it, so the next run retries", traffic.recorded === null);
check(
  "…quoting Resend's reason",
  String(failedBody.failures?.[0]?.error).includes("domain is not verified"),
  JSON.stringify(failedBody.failures)
);

// ---------------------------------------------------------------------------
// 5. Refuses to run half-configured, and escapes what members can type
// ---------------------------------------------------------------------------
console.log("5. configuration and escaping");
reset();
scenario.due = [dueRow()];
const savedKey = ENV.RESEND_API_KEY;
delete ENV.RESEND_API_KEY;
const unconfigured = await call({ days: 7 }, { "x-event-digest-secret": "digest-secret" });
const unconfiguredBody = await unconfigured.json();
check(
  "a missing Resend key is a plain error, not a crash",
  unconfigured.status === 500 && String(unconfiguredBody.error).includes("RESEND_API_KEY"),
  JSON.stringify(unconfiguredBody)
);
const dryWithoutKey = await call(
  { days: 7, dry_run: true },
  { "x-event-digest-secret": "digest-secret" }
);
check("…while a dry run still works without one", dryWithoutKey.status === 200);
ENV.RESEND_API_KEY = savedKey;

reset();
scenario.due = [
  dueRow({
    events: [event({ name: '<img src=x onerror="alert(1)"> & "quoted"' })],
  }),
];
const escaped = await call({ days: 7 }, { "x-event-digest-secret": "digest-secret" });
await escaped.json();
const escapedHtml = traffic.mails[0].body.html;
check(
  "an event name cannot inject markup into the email",
  !escapedHtml.includes("<img src=x") &&
    escapedHtml.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"),
  escapedHtml.match(/.*onerror.*/)?.[0]
);

// ---------------------------------------------------------------------------
// 6. A bad window is clamped, not obeyed
// ---------------------------------------------------------------------------
console.log("6. the window");
reset();
scenario.due = [];
const clamped = await call({ days: 9999 }, { "x-event-digest-secret": "digest-secret" });
const clampedBody = await clamped.json();
check("an absurd window is clamped to 30 days", clampedBody.days === 30, JSON.stringify(clampedBody));
const backwards = await call({ days: -5 }, { "x-event-digest-secret": "digest-secret" });
check("a negative window is clamped to 1 day", (await backwards.json()).days === 1);
reset();
scenario.due = [];
const nonsense = await call(null, { "x-event-digest-secret": "digest-secret" });
check("an empty body still uses the 7-day default", (await nonsense.json()).days === 7);

// ---------------------------------------------------------------------------
console.log("");
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  for (const label of failures) console.log(`  - ${label}`);
  process.exit(1);
}
console.log(`EVENT DIGEST SENDER PASSED (${pass} checks)`);
