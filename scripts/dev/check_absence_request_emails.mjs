#!/usr/bin/env node
// ============================================================================
// check_absence_request_emails.mjs — run the real absence-request-email function
// ============================================================================
//   node scripts/dev/check_absence_request_emails.mjs
//
// Why it exists: this repo has no Deno runtime and no Supabase CLI, so the
// scheduled sender cannot be exercised the way it is deployed. This harness
// imports the function unmodified, shims `Deno.env` / `Deno.serve`, and stubs
// `fetch` at the network boundary — PostgREST for the three RPCs and the request
// re-read, api.resend.com for the mail. It covers what the SQL suite cannot: the
// shared secret, the JSON contract, the claim-before-send order, the rendered
// subject/text/HTML (including the school timezone on both sides of a
// daylight-saving change), the Resend payload, a decided or withdrawn request
// that is refused after the claim, and a failed send that is recorded rather
// than retried at once.
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
  SUPABASE_URL: "https://absence-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  RESEND_FROM: "noreply@rhsattendance.org",
  ABSENCE_FROM_NAME: "RHS Music & Arts",
  PUBLIC_APP_URL: "https://app.example.test",
  ABSENCE_REQUEST_EMAIL_SECRET: "absence-secret",
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

const REQUEST_ID = "b0000000-0000-4000-8000-000000000001";
const REVIEWER_ID = "10000000-0000-4000-8000-000000000001";

const scenario = {
  due: [],
  claimId: "c1000000-0000-4000-8000-000000000001",
  request: {
    status: "pending",
    reason: "Family trip to Portland.",
    event_id: "e1000000-0000-4000-8000-000000000001",
    events: {
      name: "Fall Concert",
      date: "2027-05-21T22:00:00.000Z",
      all_day: false,
      archived: false,
    },
  },
  requestReads: 0,
  resendStatus: 200,
  resendError: { message: "The domain is not verified.", name: "validation_error" },
};

const traffic = { due: [], claims: [], completed: [], mails: [], order: [] };

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.includes("/rest/v1/rpc/due_absence_request_emails")) {
    traffic.due.push(JSON.parse(init.body ?? "{}"));
    return Response.json(scenario.due);
  }
  if (url.includes("/rest/v1/rpc/claim_absence_request_email")) {
    traffic.order.push("claim");
    traffic.claims.push(JSON.parse(init.body ?? "{}"));
    return Response.json(scenario.claimId);
  }
  if (url.includes("/rest/v1/rpc/complete_absence_request_email")) {
    traffic.completed.push(JSON.parse(init.body ?? "{}"));
    return Response.json(true);
  }
  if (url.includes("/rest/v1/absence_requests")) {
    scenario.requestReads += 1;
    return Response.json(scenario.request);
  }
  if (url.includes("api.resend.com")) {
    traffic.order.push("mail");
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
  request_id: REQUEST_ID,
  user_id: REVIEWER_ID,
  auth_user_id: "a1000000-0000-4000-8000-000000000001",
  email: "director@example.test",
  recipient: "Dana Director",
  ensemble_id: "51000000-0000-4000-8000-000000000001",
  program_name: "RHS Band",
  event_id: "e1000000-0000-4000-8000-000000000001",
  event_name: "Fall Concert",
  event_start: "2027-05-21T22:00:00.000Z",
  all_day: false,
  student_name: "Sam Student",
  reason: "Family trip to Portland.",
  submitted_at: "2027-05-19T18:30:00.000Z",
  ...over,
});

await import("../../supabase/functions/absence-request-emails/index.ts");

if (typeof handler !== "function") {
  console.error("the function did not call Deno.serve()");
  process.exit(1);
}

const call = (body, headers = {}) =>
  handler(
    new Request("https://absence-test.supabase.co/functions/v1/absence-request-emails", {
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
  traffic.order = [];
  scenario.due = [];
  scenario.claimId = "c1000000-0000-4000-8000-000000000001";
  scenario.request = {
    status: "pending",
    reason: "Family trip to Portland.",
    event_id: "e1000000-0000-4000-8000-000000000001",
    events: {
      name: "Fall Concert",
      date: "2027-05-21T22:00:00.000Z",
      all_day: false,
      archived: false,
    },
  };
  scenario.requestReads = 0;
  scenario.resendStatus = 200;
};

// ---------------------------------------------------------------------------
// 1. Only the scheduler (or the service role) may trigger a mail run
// ---------------------------------------------------------------------------
console.log("1. the shared secret");
reset();
scenario.due = [row()];

let response = await handler(
  new Request("https://absence-test.supabase.co/functions/v1/absence-request-emails", {
    method: "GET",
  })
);
check("GET is refused with 405", response.status === 405);

response = await call({});
check("no secret is refused with 401", response.status === 401);
check("…and sends nothing", traffic.mails.length === 0);

response = await call({}, { "x-absence-request-email-secret": "wrong" });
check("a wrong secret is refused with 401", response.status === 401);

response = await call({}, { Authorization: "Bearer not-the-service-key" });
check("a foreign bearer is refused with 401", response.status === 401);

response = await call({}, { Authorization: "Bearer service-role-key" });
check("the service-role bearer is accepted", response.status === 200);

response = await call({}, { "x-absence-request-email-secret": "absence-secret" });
check("the shared secret is accepted", response.status === 200);

// ---------------------------------------------------------------------------
// 2. A dry run reports the queue without sending
// ---------------------------------------------------------------------------
console.log("2. dry run");
reset();
scenario.due = [row()];

response = await call(
  { dry_run: true, now: "2027-05-19T20:00:00Z" },
  { "x-absence-request-email-secret": "absence-secret" }
);
let body = await response.json();
check("dry run answers ok", body.ok === true && body.dry_run === true);
check("dry run reports one recipient", body.recipients === 1);
check("dry run sends no mail", traffic.mails.length === 0);
check("dry run sends no claim", traffic.claims.length === 0);
check(
  "the testing clock override reaches due_absence_request_emails()",
  traffic.due[0]?.p_now === "2027-05-19T20:00:00.000Z",
  JSON.stringify(traffic.due[0])
);
check("the queue is capped at 200", traffic.due[0]?.p_limit === 200);
check(
  "the dry run names the student, event and school time without an address",
  body.emails?.[0]?.student === "Sam Student" &&
    body.emails?.[0]?.event === "Fall Concert" &&
    body.emails?.[0]?.school_time === "3:00 PM" &&
    !JSON.stringify(body).includes("director@example.test"),
  JSON.stringify(body.emails)
);

// ---------------------------------------------------------------------------
// 3. A real run claims first, then sends, then records the accepted id
// ---------------------------------------------------------------------------
console.log("3. a real send");
reset();
scenario.due = [row()];

response = await call({}, { "x-absence-request-email-secret": "absence-secret" });
body = await response.json();
check("the run answers ok", body.ok === true);
check("one email was accepted", body.accepted === 1);
check("one claim was made", traffic.claims.length === 1);
check(
  "the claim names the request and reviewer",
  traffic.claims[0]?.p_request === REQUEST_ID && traffic.claims[0]?.p_user === REVIEWER_ID
);
check(
  "the claim is written before the mail is handed to Resend",
  traffic.order.join(",") === "claim,mail",
  traffic.order.join(",")
);
check("exactly one mail was sent", traffic.mails.length === 1);
check(
  "Resend is called with the configured key",
  traffic.mails[0]?.authorization === "Bearer resend-key"
);
check("only the one reviewer is on the message", traffic.mails[0]?.body.to.length === 1);
check(
  "the subject names the student and the event",
  traffic.mails[0]?.body.subject === "Absence request: Sam Student — Fall Concert",
  traffic.mails[0]?.body.subject
);
check(
  "the idempotency key is the request + reviewer",
  traffic.mails[0]?.idempotencyKey === `absence-request:${REQUEST_ID}:${REVIEWER_ID}`,
  traffic.mails[0]?.idempotencyKey
);
check(
  "the message is tagged as an absence request",
  traffic.mails[0]?.body.tags?.[0]?.value === "absence-request"
);
check(
  "the text carries the student, event, time and reason",
  [
    "Hello Dana Director,",
    "Sam Student has asked to miss an event in RHS Band.",
    "Event: Fall Concert",
    "Date: Friday, May 21, 2027",
    "Time: 3:00 PM",
    "Program: RHS Band",
    "Family trip to Portland.",
  ].every((line) => traffic.mails[0]?.body.text.includes(line)),
  traffic.mails[0]?.body.text
);
check(
  "the HTML carries the same details and a review link",
  traffic.mails[0]?.body.html.includes("Sam Student") &&
    traffic.mails[0]?.body.html.includes("Fall Concert") &&
    traffic.mails[0]?.body.html.includes("Family trip to Portland.") &&
    traffic.mails[0]?.body.html.includes("https://app.example.test/absences")
);
check(
  "the result is recorded against the claim",
  traffic.completed[0]?.p_id === "c1000000-0000-4000-8000-000000000001" &&
    traffic.completed[0]?.p_ok === true &&
    traffic.completed[0]?.p_resend_email_id === "resend-id"
);

// ---------------------------------------------------------------------------
// 4. A lost claim sends nothing
// ---------------------------------------------------------------------------
console.log("4. duplicate protection");
reset();
scenario.due = [row()];
scenario.claimId = null;

response = await call({}, { "x-absence-request-email-secret": "absence-secret" });
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

response = await call({}, { "x-absence-request-email-secret": "absence-secret" });
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
check("the response carries no address", !JSON.stringify(body).includes("director@example.test"));

// ---------------------------------------------------------------------------
// 6. A request that changed after the claim is not announced
// ---------------------------------------------------------------------------
console.log("6. the request is re-read after the claim");
reset();
scenario.due = [row()];
scenario.request = { ...scenario.request, status: "approved" };
body = await (await call({}, { "x-absence-request-email-secret": "absence-secret" })).json();
check("the request is re-read before rendering", scenario.requestReads === 1);
check("a request decided after the claim sends nothing", traffic.mails.length === 0);
check("…and is reported as failed", body.failed === 1 && traffic.completed[0]?.p_ok === false);

reset();
scenario.due = [row()];
scenario.request = { ...scenario.request, status: "withdrawn" };
body = await (await call({}, { "x-absence-request-email-secret": "absence-secret" })).json();
check("a withdrawn request sends nothing", traffic.mails.length === 0);
check("…and is reported as failed", body.failed === 1);

reset();
scenario.due = [row()];
scenario.request = { ...scenario.request, events: { ...scenario.request.events, archived: true } };
body = await (await call({}, { "x-absence-request-email-secret": "absence-secret" })).json();
check("an archived event sends nothing", traffic.mails.length === 0);
check("…and is reported as failed", body.failed === 1);

// ---------------------------------------------------------------------------
// 7. The school clock, all-day events and escaping
// ---------------------------------------------------------------------------
console.log("7. school-time rendering");
reset();
scenario.due = [
  row({
    event_start: "2027-11-06T16:00:00.000Z",
    student_name: "Ada & <Friends>",
    reason: "Doctor <appointment> & travel",
  }),
];
scenario.request = {
  ...scenario.request,
  reason: "Doctor <appointment> & travel",
  events: {
    name: "Fall <Concert> & More",
    date: "2027-11-06T16:00:00.000Z",
    all_day: false,
    archived: false,
  },
};
await call({}, { "x-absence-request-email-secret": "absence-secret" });
check(
  "a PST event renders in Pacific time",
  traffic.mails[0]?.body.text.includes("Date: Saturday, November 6, 2027") &&
    traffic.mails[0]?.body.text.includes("Time: 9:00 AM"),
  traffic.mails[0]?.body.text
);
check(
  "student, reason and event text are escaped in the HTML",
  traffic.mails[0]?.body.html.includes("Fall &lt;Concert&gt; &amp; More") &&
    traffic.mails[0]?.body.html.includes("Ada &amp; &lt;Friends&gt;") &&
    traffic.mails[0]?.body.html.includes("Doctor &lt;appointment&gt; &amp; travel") &&
    !traffic.mails[0]?.body.html.includes("<Concert>"),
  traffic.mails[0]?.body.html
);
check(
  "the subject keeps the plain names",
  traffic.mails[0]?.body.subject === "Absence request: Ada & <Friends> — Fall <Concert> & More",
  traffic.mails[0]?.body.subject
);

reset();
scenario.due = [row({ event_start: "2027-11-08T16:00:00.000Z", all_day: true })];
scenario.request = {
  ...scenario.request,
  events: { name: "Festival", date: "2027-11-08T16:00:00.000Z", all_day: true, archived: false },
};
await call({}, { "x-absence-request-email-secret": "absence-secret" });
check(
  "an all-day event says the day is all day",
  traffic.mails[0]?.body.text.includes("Time: All day"),
  traffic.mails[0]?.body.text
);

// The event is re-read after the claim: a reschedule reaches the message.
reset();
scenario.due = [row()];
scenario.request = {
  ...scenario.request,
  events: {
    name: "Fall Concert",
    date: "2027-05-22T20:00:00.000Z",
    all_day: false,
    archived: false,
  },
};
await call({}, { "x-absence-request-email-secret": "absence-secret" });
check(
  "a rescheduled event uses its latest time",
  traffic.mails[0]?.body.text.includes("Date: Saturday, May 22, 2027") &&
    traffic.mails[0]?.body.text.includes("Time: 1:00 PM"),
  traffic.mails[0]?.body.text
);

// ---------------------------------------------------------------------------
// 8. Missing configuration fails loudly
// ---------------------------------------------------------------------------
console.log("8. configuration");
reset();
scenario.due = [row()];
const savedKey = ENV.RESEND_API_KEY;
delete ENV.RESEND_API_KEY;
response = await call({}, { "x-absence-request-email-secret": "absence-secret" });
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
