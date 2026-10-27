#!/usr/bin/env node
// ============================================================================
// check_makeup_emails.mjs — run the real `send-makeup-emails` function locally
// ============================================================================
//   node scripts/dev/check_makeup_emails.mjs
//
// Imports the function unmodified, shims `Deno.env` / `Deno.serve` and stubs the
// network boundary: Supabase Auth for the JWT check, PostgREST for the profile,
// the event re-read and the two RPCs, and api.resend.com for the mail.
//
// It covers what the SQL suite cannot: the CORS/OPTIONS contract, the bearer
// requirement, malformed input, the mapping of a server refusal to an HTTP
// status, per-recipient sending (one `to`, one idempotency key), placeholder
// substitution in the rendered subject/body, partial failure reporting, the
// archived-after-begin stop, and that no address is returned to the caller.
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
  SUPABASE_URL: "https://makeup-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  RESEND_API_KEY: "resend-key",
  RESEND_FROM: "noreply@rhsattendance.org",
  MAKEUP_FROM_NAME: "RHS Music & Arts",
  PUBLIC_APP_URL: "https://app.example.test",
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

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const EVENT_ID = "e0000000-0000-4000-8000-000000000001";
const OPERATION_ID = "0b000000-0000-4000-8000-000000000001";

const eventStart = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const eventEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const recipient = (over = {}) => ({
  delivery_id: "d0000000-0000-4000-8000-000000000001",
  user_id: "20000000-0000-4000-8000-000000000001",
  name: "Sam Student",
  email: "sam@example.test",
  section: "Trumpet",
  status: "queued",
  attempts: 0,
  ...over,
});

const campaign = (over = {}) => ({
  ok: true,
  campaign_id: "c0000000-0000-4000-8000-000000000001",
  event_id: EVENT_ID,
  event_name: "Fall Concert",
  event_start: eventStart,
  event_end: eventEnd,
  event_archived: false,
  program_name: "RHS Band",
  teacher_name: "Dana Director",
  recipients: [recipient()],
  ...over,
});

const scenario = {
  begin: campaign(),
  event: { date: eventStart, end_date: eventEnd, archived: false },
  profile: { id: PROFILE_ID, deactivated: false },
  authUser: { id: USER_ID, email: "director@example.test" },
  resendStatuses: [],
  resendError: { message: "The domain is not verified.", name: "validation_error" },
};

const traffic = { begins: [], records: [], mails: [], eventReads: 0 };

function nextResendStatus() {
  return scenario.resendStatuses.length ? scenario.resendStatuses.shift() : 200;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method ?? "GET").toUpperCase();

  if (url.includes("/auth/v1/user")) {
    const auth = new Headers(init.headers).get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return Response.json({ message: "no token" }, { status: 401 });
    }
    return Response.json(scenario.authUser);
  }
  if (url.includes("/rest/v1/profiles")) {
    return Response.json(scenario.profile);
  }
  if (url.includes("/rest/v1/events")) {
    traffic.eventReads += 1;
    return Response.json(scenario.event);
  }
  if (url.includes("/rest/v1/rpc/begin_makeup_email_campaign")) {
    const body = JSON.parse(init.body ?? "{}");
    traffic.begins.push(body);
    return Response.json(scenario.begin);
  }
  if (url.includes("/rest/v1/rpc/record_makeup_email_delivery")) {
    traffic.records.push(JSON.parse(init.body ?? "{}"));
    return Response.json(true);
  }
  if (url.includes("api.resend.com")) {
    traffic.mails.push({
      method,
      authorization: new Headers(init.headers).get("Authorization"),
      idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
      body: JSON.parse(init.body ?? "{}"),
    });
    const status = nextResendStatus();
    if (status >= 300) {
      return Response.json(scenario.resendError, { status });
    }
    return Response.json({ id: `resend-${traffic.mails.length}` }, { status: 200 });
  }
  throw new Error(`unexpected fetch to ${method} ${url}`);
};

await import("../../supabase/functions/send-makeup-emails/index.ts");

if (typeof handler !== "function") {
  console.error("the function did not call Deno.serve()");
  process.exit(1);
}

const payload = (over = {}) => ({
  event_id: EVENT_ID,
  client_operation_id: OPERATION_ID,
  subject: "Make-Up Instructions for Fall Concert",
  instructions: "Come to Thursday's make-up rehearsal.",
  body_template:
    "Hi {student_first_name},\n\nOur records show you were absent for {event_name} on {event_date} at {event_time}.\n\n{makeup_instructions}\n\nThank you,\n{teacher_name}\n{program_name}",
  ...over,
});

const call = (body, headers = {}) =>
  handler(
    new Request("https://makeup-test.supabase.co/functions/v1/send-makeup-emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
        ...headers,
      },
      body: body === null ? undefined : JSON.stringify(body),
    })
  );

const reset = () => {
  traffic.begins = [];
  traffic.records = [];
  traffic.mails = [];
  traffic.eventReads = 0;
  scenario.begin = campaign();
  scenario.event = { date: eventStart, end_date: eventEnd, archived: false };
  scenario.profile = { id: PROFILE_ID, deactivated: false };
  scenario.resendStatuses = [];
};

// ---------------------------------------------------------------------------
// 1. Method, CORS and sign-in
// ---------------------------------------------------------------------------
console.log("1. the request boundary");
reset();

let response = await handler(
  new Request("https://makeup-test.supabase.co/functions/v1/send-makeup-emails", {
    method: "OPTIONS",
    headers: { Origin: "https://rhsattendance.org" },
  })
);
check("OPTIONS is answered", response.status === 200);
check(
  "the allowed origin is reflected",
  response.headers.get("Access-Control-Allow-Origin") === "https://rhsattendance.org"
);

response = await handler(
  new Request("https://makeup-test.supabase.co/functions/v1/send-makeup-emails", { method: "GET" })
);
check("GET is refused with 405", response.status === 405);

response = await call(payload(), { Authorization: "" });
check("no bearer is refused with 401", response.status === 401);
check("…and nothing is sent", traffic.mails.length === 0);

response = await call("not-json");
check("malformed JSON is refused with 400", response.status === 400);

response = await call(payload({ subject: "   " }));
check("a blank subject is refused with 400", response.status === 400);
check("…before any send", traffic.mails.length === 0);

response = await call(payload({ event_id: "not-a-uuid" }));
check("a malformed event id is refused with 400", response.status === 400);

// ---------------------------------------------------------------------------
// 2. A server refusal is surfaced, not swallowed
// ---------------------------------------------------------------------------
console.log("2. server refusals");
reset();
scenario.begin = { ok: false, message: "Available after this event ends." };
response = await call(payload());
let body = await response.json();
check("a premature send is refused", response.status === 403);
check("the reason reaches the caller", String(body.error).includes("after this event ends"));
check("…and no mail is sent", traffic.mails.length === 0);

reset();
scenario.begin = {
  ok: false,
  message: "Too many email runs in a short time. Wait a few minutes and try again.",
};
response = await call(payload());
check("the rate limit maps to 429", response.status === 429);

reset();
scenario.profile = null;
response = await call(payload());
check("an account with no profile is refused with 403", response.status === 403);

// ---------------------------------------------------------------------------
// 3. One individual message per recipient, with the teacher's edits
// ---------------------------------------------------------------------------
console.log("3. individualized sending");
reset();
scenario.begin = campaign({
  recipients: [
    recipient(),
    recipient({
      delivery_id: "d0000000-0000-4000-8000-000000000002",
      user_id: "20000000-0000-4000-8000-000000000002",
      name: "Riley Reed",
      email: "riley@example.test",
      section: "Clarinet",
    }),
  ],
});

response = await call(payload());
body = await response.json();
check("the run answers ok", body.ok === true);
check("it reports two accepted", body.accepted === 2 && body.failed === 0);
check("two separate Resend calls were made", traffic.mails.length === 2);
check(
  "each message has exactly one recipient",
  traffic.mails.every((mail) => Array.isArray(mail.body.to) && mail.body.to.length === 1)
);
check(
  "both students received their own copy",
  traffic.mails.some((mail) => mail.body.text.includes("Hi Sam,")) &&
    traffic.mails.some((mail) => mail.body.text.includes("Hi Riley,"))
);
check(
  "the greeting uses the student's first name",
  !traffic.mails.some((mail) => mail.body.text.includes("{student_first_name}")) &&
    traffic.mails.some((mail) => mail.body.text.includes("Hi Sam,"))
);
check(
  "the event date and time are rendered in school time",
  traffic.mails[0]?.body.text.includes("Fall Concert") &&
    traffic.mails[0]?.body.text.includes("Dana Director") &&
    traffic.mails[0]?.body.text.includes("RHS Band")
);
check(
  "the teacher's instructions replace the placeholder",
  traffic.mails[0]?.body.text.includes("Come to Thursday's make-up rehearsal.") &&
    !traffic.mails[0]?.body.text.includes("{makeup_instructions}")
);
check(
  "the idempotency key is stable for campaign + student",
  traffic.mails[0]?.idempotencyKey ===
    "makeup:c0000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000001" &&
    traffic.mails[1]?.idempotencyKey ===
      "makeup:c0000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000002",
  traffic.mails[0]?.idempotencyKey
);
check(
  "Resend gets the configured key",
  traffic.mails.every((mail) => mail.authorization === "Bearer resend-key")
);
check(
  "the subject is the teacher's",
  traffic.mails[0]?.body.subject === "Make-Up Instructions for Fall Concert"
);
check("both results were recorded as accepted", traffic.records.length === 2 &&
  traffic.records.every((record) => record.p_ok === true));
check(
  "the caller receives no addresses",
  !JSON.stringify(body).includes("@example.test")
);

// The server re-reads the event and renders its latest schedule, not the
// snapshot taken when the composer opened.
reset();
scenario.event = {
  name: "Fall Concert",
  date: "2026-10-18T20:00:00.000Z",
  end_date: "2026-10-18T22:00:00.000Z",
  all_day: false,
  archived: false,
};
response = await call(payload());
body = await response.json();
check("a rescheduled event uses its latest date and time",
  body.ok === true &&
    traffic.mails[0]?.body.text.includes("Sunday, October 18, 2026") &&
    traffic.mails[0]?.body.text.includes("1:00 PM – 3:00 PM"),
  traffic.mails[0]?.body.text
);

// A token the app does not know is never invented and never silently dropped:
// it goes out exactly as the teacher typed it, which is why the composer lists
// unresolved tokens and repeats them in the confirmation before sending.
reset();
response = await call(payload({ body_template: "Hi {student_first_name}, see {not_a_token}." }));
body = await response.json();
check(
  "a supported token is substituted and an unknown one is left for the teacher to fix",
  body.ok === true &&
    traffic.mails[0]?.body.text.includes("Hi Sam, see {not_a_token}."),
  traffic.mails[0]?.body.text
);

// ---------------------------------------------------------------------------
// 4. Partial failures are reported separately; accepted ones are not re-sent
// ---------------------------------------------------------------------------
console.log("4. partial failure");
reset();
scenario.begin = campaign({
  recipients: [
    recipient(),
    recipient({
      delivery_id: "d0000000-0000-4000-8000-000000000002",
      user_id: "20000000-0000-4000-8000-000000000002",
      name: "Riley Reed",
      email: "riley@example.test",
    }),
  ],
});
scenario.resendStatuses = [422, 200];

response = await call(payload());
body = await response.json();
check("one accepted and one failed", body.accepted === 1 && body.failed === 1);
check(
  "the failed recipient is named with a reason",
  body.results?.find((row) => row.status === "failed")?.name === "Sam Student" &&
    String(body.results?.find((row) => row.status === "failed")?.error).includes("422")
);
check(
  "both results were recorded",
  traffic.records.length === 2 &&
    traffic.records.some((record) => record.p_ok === false && String(record.p_error).includes("422"))
);
check("the caller receives no addresses", !JSON.stringify(body).includes("@example.test"));

// ---------------------------------------------------------------------------
// 5. The event is re-read; a cancellation mid-run stops the rest
// ---------------------------------------------------------------------------
console.log("5. the schedule is re-checked");
reset();
scenario.begin = campaign({
  recipients: [
    recipient(),
    recipient({
      delivery_id: "d0000000-0000-4000-8000-000000000002",
      user_id: "20000000-0000-4000-8000-000000000002",
      name: "Riley Reed",
      email: "riley@example.test",
    }),
  ],
});
scenario.event = { date: eventStart, end_date: eventEnd, archived: true };

response = await call(payload());
body = await response.json();
check("no message is sent for an archived event", traffic.mails.length === 0);
check("both recipients are reported failed", body.failed === 2);
check(
  "the reason says the event was archived",
  String(body.results?.[0]?.error).toLowerCase().includes("archived"),
  JSON.stringify(body.results)
);
check("the event was re-read", traffic.eventReads >= 1);
check(
  "the stopped sends are recorded as failed",
  traffic.records.length === 2 && traffic.records.every((record) => record.p_ok === false),
  JSON.stringify(traffic.records)
);

// ---------------------------------------------------------------------------
// 6. Nothing left to send is not an error
// ---------------------------------------------------------------------------
console.log("6. an already-completed operation");
reset();
scenario.begin = campaign({ recipients: [] });
response = await call(payload());
body = await response.json();
check("an empty remainder answers ok", body.ok === true);
check("…with nothing accepted or failed", body.accepted === 0 && body.failed === 0);
check("…and no mail", traffic.mails.length === 0);

// ---------------------------------------------------------------------------
// 7. Missing configuration fails loudly
// ---------------------------------------------------------------------------
console.log("7. configuration");
reset();
const savedKey = ENV.RESEND_API_KEY;
delete ENV.RESEND_API_KEY;
response = await call(payload());
body = await response.json();
check("a missing Resend key is a 500", response.status === 500);
check("…naming the variable", String(body.error).includes("RESEND_API_KEY"));
ENV.RESEND_API_KEY = savedKey;

// ---------------------------------------------------------------------------
console.log(`\n${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILED:", failures.join(", "));
  process.exit(1);
}
