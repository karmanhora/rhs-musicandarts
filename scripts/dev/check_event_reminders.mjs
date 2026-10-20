#!/usr/bin/env node
// ============================================================================
// check_event_reminders.mjs — run the real `event-reminders` function locally
// ============================================================================
//   node scripts/dev/check_event_reminders.mjs
//
// Why it exists: this repo has no Deno runtime and no Supabase CLI, so the
// scheduled sender cannot be exercised the way it is deployed. This harness
// imports the function unmodified, shims `Deno.env` / `Deno.serve`, and stubs
// `fetch` at the network boundary — PostgREST for the three RPCs, api.resend.com
// for the mail. It covers what the SQL suite cannot: the shared secret, the JSON
// contract, the rendered subject/text/HTML (including the school timezone on
// both sides of a daylight-saving change), the Resend payload, the claim-before-
// send order, and that a failed send is recorded rather than retried at once.
//
// Read-only, no network, safe to run any time.
// ============================================================================
import { registerHooks } from "node:module";

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

const ENV = {
  SUPABASE_URL: "https://reminder-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  RESEND_FROM: "noreply@rhsattendance.org",
  REMINDER_FROM_NAME: "RHS Music & Arts",
  PUBLIC_APP_URL: "https://app.example.test",
  EVENT_REMINDER_SECRET: "reminder-secret",
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

const scenario = {
  due: [],
  claimId: "c0000000-0000-4000-8000-000000000001",
  event: {
    name: "Fall Concert",
    date: "2027-05-21T22:00:00.000Z",
    end_date: "2027-05-22T00:00:00.000Z",
    all_day: false,
    location: "RHS Auditorium",
    archived: false,
  },
  resendStatus: 200,
  resendError: { message: "The domain is not verified.", name: "validation_error" },
};

const traffic = { due: [], claims: [], completed: [], mails: [], eventReads: 0 };

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.includes("/rest/v1/rpc/due_event_reminders")) {
    traffic.due.push(JSON.parse(init.body ?? "{}"));
    return Response.json(scenario.due);
  }
  if (url.includes("/rest/v1/rpc/claim_event_reminder")) {
    traffic.claims.push(JSON.parse(init.body ?? "{}"));
    return Response.json(scenario.claimId);
  }
  if (url.includes("/rest/v1/rpc/complete_event_reminder")) {
    traffic.completed.push(JSON.parse(init.body ?? "{}"));
    return Response.json(true);
  }
  if (url.includes("/rest/v1/events")) {
    traffic.eventReads += 1;
    return Response.json(scenario.event);
  }
  if (url.includes("api.resend.com")) {
    traffic.mails.push({
      authorization: new Headers(init.headers).get("Authorization"),
      idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
      body: JSON.parse(init.body ?? "{}"),
    });
    if (scenario.resendStatus >= 300) {
      return Response.json(scenario.resendError, { status: scenario.resendStatus });
    }
    return Response.json({ id: "resend-id" }, { status: 200 });
  }
  throw new Error(`unexpected fetch to ${url}`);
};

const row = (over = {}) => ({
  event_id: "e0000000-0000-4000-8000-000000000001",
  user_id: "10000000-0000-4000-8000-000000000001",
  auth_user_id: "a0000000-0000-4000-8000-000000000001",
  email: "student@example.test",
  recipient: "Sam Student",
  ensemble_id: "50000000-0000-4000-8000-000000000001",
  program_name: "RHS Band",
  event_name: "Fall Concert",
  event_start: "2027-05-21T22:00:00.000Z",
  event_end: "2027-05-22T00:00:00.000Z",
  all_day: false,
  location: "RHS Auditorium",
  event_type: "concert",
  ...over,
});

await import("../../supabase/functions/event-reminders/index.ts");

if (typeof handler !== "function") {
  console.error("the function did not call Deno.serve()");
  process.exit(1);
}

const call = (body, headers = {}) =>
  handler(
    new Request("https://reminder-test.supabase.co/functions/v1/event-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === null ? undefined : JSON.stringify(body),
    })
  );

const reset = () => {
  traffic.due = [];
  traffic.claims = [];
  traffic.completed = [];
  traffic.mails = [];
  traffic.eventReads = 0;
  scenario.due = [];
  scenario.claimId = "c0000000-0000-4000-8000-000000000001";
  scenario.event = {
    name: "Fall Concert",
    date: "2027-05-21T22:00:00.000Z",
    end_date: "2027-05-22T00:00:00.000Z",
    all_day: false,
    location: "RHS Auditorium",
    archived: false,
  };
  scenario.resendStatus = 200;
};

// ---------------------------------------------------------------------------
// 1. Only the scheduler may trigger a mail run
// ---------------------------------------------------------------------------
console.log("1. the shared secret");
reset();
scenario.due = [row()];

let response = await handler(
  new Request("https://reminder-test.supabase.co/functions/v1/event-reminders", { method: "GET" })
);
check("GET is refused with 405", response.status === 405);

response = await call({});
check("no secret is refused with 401", response.status === 401);
check("…and sends nothing", traffic.mails.length === 0);

response = await call({}, { "x-event-reminder-secret": "wrong" });
check("a wrong secret is refused with 401", response.status === 401);

response = await call({}, { "x-event-reminder-secret": "reminder-secret" });
check("the shared secret is accepted", response.status === 200);

// ---------------------------------------------------------------------------
// 2. A dry run reports the queue without sending
// ---------------------------------------------------------------------------
console.log("2. dry run");
reset();
scenario.due = [row()];

response = await call(
  { dry_run: true, now: "2026-10-31T16:00:00Z" },
  { "x-event-reminder-secret": "reminder-secret" }
);
let body = await response.json();
check("dry run answers ok", body.ok === true && body.dry_run === true);
check("dry run reports one recipient", body.recipients === 1);
check("dry run sends no mail", traffic.mails.length === 0);
check("dry run sends no claim", traffic.claims.length === 0);
check(
  "the testing clock override reaches due_event_reminders()",
  traffic.due[0]?.p_now === "2026-10-31T16:00:00.000Z",
  JSON.stringify(traffic.due[0])
);
check("the queue is capped at 500", traffic.due[0]?.p_limit === 500);
check(
  "the dry run names the event without an address",
  body.emails?.[0]?.event === "Fall Concert" && !JSON.stringify(body).includes("student@example.test")
);

// ---------------------------------------------------------------------------
// 3. A real run claims, sends once, and records the accepted id
// ---------------------------------------------------------------------------
console.log("3. a real send");
reset();
scenario.due = [row()];

response = await call({}, { "x-event-reminder-secret": "reminder-secret" });
body = await response.json();
check("the run answers ok", body.ok === true);
check("one reminder was accepted", body.accepted === 1);
check("one claim was made", traffic.claims.length === 1);
check(
  "the claim names the event, student and clock",
  traffic.claims[0]?.p_event === "e0000000-0000-4000-8000-000000000001" &&
    traffic.claims[0]?.p_user === "10000000-0000-4000-8000-000000000001" &&
    typeof traffic.claims[0]?.p_now === "string"
);
check("exactly one mail was sent", traffic.mails.length === 1);
check(
  "Resend is called with the configured key",
  traffic.mails[0]?.authorization === "Bearer resend-key"
);
check("only the one student is on the message", traffic.mails[0]?.body.to.length === 1);
check(
  "the subject is the required default",
  traffic.mails[0]?.body.subject === "Reminder: Fall Concert is coming up in 2 days",
  traffic.mails[0]?.body.subject
);
check(
  "the idempotency key is the event + schedule",
  traffic.mails[0]?.idempotencyKey ===
    "event-reminder:e0000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000001:2027-05-21T22:00:00.000Z",
  traffic.mails[0]?.idempotencyKey
);
check(
  "the message is tagged as a reminder",
  traffic.mails[0]?.body.tags?.[0]?.value === "event-reminder"
);
check("the text carries every field", [
  "Hello Sam Student,",
  "Event: Fall Concert",
  "Date: Friday, May 21, 2027",
  "Time: 3:00 PM – 5:00 PM",
  "Location: RHS Auditorium",
  "Program: RHS Band",
].every((line) => traffic.mails[0]?.body.text.includes(line)));
check(
  "the HTML escapes the event text",
  traffic.mails[0]?.body.html.includes("RHS Auditorium") &&
    !traffic.mails[0]?.body.html.includes("<Event>")
);
check(
  "the result is recorded against the claim",
  traffic.completed[0]?.p_id === "c0000000-0000-4000-8000-000000000001" &&
    traffic.completed[0]?.p_ok === true &&
    traffic.completed[0]?.p_resend_email_id === "resend-id"
);

// ---------------------------------------------------------------------------
// 4. A claimed schedule is not sent again
// ---------------------------------------------------------------------------
console.log("4. duplicate protection");
reset();
scenario.due = [row()];
scenario.claimId = null;

response = await call({}, { "x-event-reminder-secret": "reminder-secret" });
body = await response.json();
check("a lost claim sends nothing", traffic.mails.length === 0);
check("…and is reported as skipped", body.skipped === 1 && body.accepted === 0);

// ---------------------------------------------------------------------------
// 5. A Resend failure is recorded, not silently swallowed
// ---------------------------------------------------------------------------
console.log("5. a failed send");
reset();
scenario.due = [row()];
scenario.resendStatus = 422;

response = await call({}, { "x-event-reminder-secret": "reminder-secret" });
body = await response.json();
check("the run still answers ok", body.ok === true);
check("the failure is counted", body.failed === 1 && body.accepted === 0);
check(
  "Resend's reason is quoted",
  body.failures?.[0]?.error?.includes("422") &&
    body.failures?.[0]?.error?.includes("domain is not verified"),
  JSON.stringify(body.failures)
);
check(
  "the claim is completed as a failure",
  traffic.completed[0]?.p_ok === false && traffic.completed[0]?.p_error.includes("422")
);
check("the response carries no address", !JSON.stringify(body).includes("student@example.test"));

// ---------------------------------------------------------------------------
// 6. Time zones, both sides of daylight saving, and optional fields
// ---------------------------------------------------------------------------
console.log("6. school-time rendering");
reset();
scenario.due = [
  row({
    event_start: "2027-11-06T16:00:00.000Z",
    event_end: null,
    location: "",
    all_day: false,
    recipient: "Ada Lovelace",
  }),
];
scenario.event = {
  name: "Fall Concert",
  date: "2027-11-06T16:00:00.000Z",
  end_date: null,
  all_day: false,
  location: "",
  archived: false,
};
response = await call({}, { "x-event-reminder-secret": "reminder-secret" });
body = await response.json();
check(
  "a PDT event renders in Pacific time",
  traffic.mails[0]?.body.text.includes("Date: Saturday, November 6, 2027") &&
    traffic.mails[0]?.body.text.includes("Time: 9:00 AM"),
  traffic.mails[0]?.body.text
);
check(
  "an empty location is omitted, not printed blank",
  !traffic.mails[0]?.body.text.includes("Location:") &&
    !traffic.mails[0]?.body.html.includes(">Location<")
);

reset();
scenario.due = [
  row({
    event_start: "2027-11-08T16:00:00.000Z",
    event_end: null,
    all_day: true,
    location: "Band Room",
  }),
];
scenario.event = {
  name: "Fall Concert",
  date: "2027-11-08T16:00:00.000Z",
  end_date: null,
  all_day: true,
  location: "Band Room",
  archived: false,
};
await call({}, { "x-event-reminder-secret": "reminder-secret" });
check(
  "a PST event renders 8:00 AM, and an all-day event says so",
  traffic.mails[0]?.body.text.includes("Date: Monday, November 8, 2027") &&
    traffic.mails[0]?.body.text.includes("Time: All day"),
  traffic.mails[0]?.body.text
);

// The event is re-read after the claim: a reschedule reaches the message.
reset();
scenario.due = [row()];
scenario.event = {
  name: "Fall Concert",
  date: "2027-05-22T20:00:00.000Z",
  end_date: null,
  all_day: false,
  location: "RHS Auditorium",
  archived: false,
};
await call({}, { "x-event-reminder-secret": "reminder-secret" });
check("the event is re-read before rendering", traffic.eventReads === 1);
check(
  "a rescheduled event announces its latest time",
  traffic.mails[0]?.body.text.includes("Date: Saturday, May 22, 2027") &&
    traffic.mails[0]?.body.text.includes("Time: 1:00 PM"),
  traffic.mails[0]?.body.text
);
check(
  "the idempotency key follows the latest schedule",
  traffic.mails[0]?.idempotencyKey.endsWith(":2027-05-22T20:00:00.000Z"),
  traffic.mails[0]?.idempotencyKey
);

// An archived event after the claim is not mailed.
reset();
scenario.due = [row()];
scenario.event = { ...scenario.event, archived: true };
let archivedBody = await (
  await call({}, { "x-event-reminder-secret": "reminder-secret" })
).json();
check("an event archived after the claim sends nothing", traffic.mails.length === 0);
check("…and the failure is recorded", archivedBody.failed === 1 &&
  traffic.completed[0]?.p_ok === false);

// ---------------------------------------------------------------------------
// 7. Missing configuration fails loudly
// ---------------------------------------------------------------------------
console.log("7. configuration");
reset();
scenario.due = [row()];
const savedKey = ENV.RESEND_API_KEY;
delete ENV.RESEND_API_KEY;
response = await call({}, { "x-event-reminder-secret": "reminder-secret" });
body = await response.json();
check("a missing Resend key is a plain 500", response.status === 500);
check("…naming the missing variable", String(body.error).includes("RESEND_API_KEY"));
check("…and sends nothing", traffic.mails.length === 0);
ENV.RESEND_API_KEY = savedKey;

// ---------------------------------------------------------------------------
console.log(`\n${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:", failures.join(", "));
  process.exit(1);
}
