#!/usr/bin/env node
/**
 * Verify the production security headers in `vercel.json`.
 *
 * The CSP pins the three inline scripts in `index.html` by SHA-256, so it is not
 * allowed to drift silently: an edit to one of those scripts without a matching
 * hash would make the browser block it (the theme flash guard, the pre-ES-module
 * fallback and the boot check would stop running). This script:
 *
 *   1. parses `vercel.json` and rejects duplicate or missing headers,
 *   2. checks the required values (nosniff, referrer policy, frame denial),
 *   3. checks the CSP's directives parse, appear once, and keep their shape,
 *   4. hashes every inline script in `dist/index.html` and compares it with
 *      `script-src`,
 *   5. optionally checks a live deployment with `--url <origin>`.
 *
 * Usage:
 *   npm run build && npm run check:headers
 *   npm run check:headers -- --url https://rhsattendance.org
 *
 * It reads no environment file and never prints a secret: everything here is a
 * header value, and the values are public by design.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  console.log(`  ok   ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`  note ${message}`);
}

/* --------------------------------------------------------------- vercel.json */

const configPath = path.join(root, "vercel.json");
let config;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  console.error(`vercel.json could not be read as JSON:\n${error.message}`);
  process.exit(1);
}

const headerEntries = Array.isArray(config.headers) ? config.headers : [];
const catchAll = headerEntries.find((entry) => entry.source === "/(.*)");
if (!catchAll) {
  fail('vercel.json has no headers block whose source is "/(.*)"');
}

/** `key` -> `value`, rejecting a key defined twice (headers must not conflict). */
const headers = new Map();
for (const entry of catchAll?.headers ?? []) {
  const key = String(entry.key).toLowerCase();
  if (headers.has(key)) {
    fail(`header "${entry.key}" is defined more than once`);
    continue;
  }
  headers.set(key, String(entry.value));
}

const expected = new Map([
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-frame-options", "DENY"],
  ["permissions-policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=()"],
]);

for (const [key, value] of expected) {
  if (!headers.has(key)) {
    fail(`missing ${key}`);
  } else if (headers.get(key) !== value) {
    fail(`${key} is "${headers.get(key)}", expected "${value}"`);
  } else {
    pass(`${key}: ${value}`);
  }
}

// Vercel sends this itself on every deployment (`max-age=63072000`); defining it
// here as well would put two HSTS values on one response.
if (headers.has("strict-transport-security")) {
  fail(
    "Strict-Transport-Security is defined in vercel.json, but Vercel already sends " +
      "max-age=63072000 on every response — remove the duplicate"
  );
} else {
  note("Strict-Transport-Security is left to Vercel (max-age=63072000), not duplicated");
}

/* ------------------------------------------------------------------------ CSP */

const csp = headers.get("content-security-policy");
const directives = new Map();
if (!csp) {
  fail("missing content-security-policy");
} else {
  for (const part of csp.split(";")) {
    const value = part.trim();
    if (!value) continue;
    const [name, ...sources] = value.split(/\s+/);
    if (directives.has(name)) fail(`CSP directive "${name}" appears more than once`);
    directives.set(name, sources);
  }
}

const expectDirective = (name, sources) => {
  const actual = directives.get(name);
  if (!actual) {
    fail(`CSP is missing ${name}`);
    return;
  }
  const wanted = sources.slice().sort().join(" ");
  const found = actual.slice().sort().join(" ");
  if (wanted !== found) fail(`CSP ${name} is "${found}", expected "${wanted}"`);
  else pass(`CSP ${name}`);
};

expectDirective("default-src", ["'self'"]);
expectDirective("style-src", ["'self'", "'unsafe-inline'"]);
expectDirective("font-src", ["'self'"]);
expectDirective("img-src", ["'self'", "data:", "blob:", "https://*.supabase.co"]);
expectDirective("frame-src", ["'none'"]);
expectDirective("frame-ancestors", ["'none'"]);
expectDirective("object-src", ["'none'"]);
expectDirective("base-uri", ["'self'"]);
expectDirective("form-action", ["'self'"]);
expectDirective("upgrade-insecure-requests", []);

if ((directives.get("frame-ancestors") ?? []).join(" ") !== "'none'") {
  fail("frame-ancestors and X-Frame-Options disagree");
}

// Only the app origin, Supabase (REST, Auth, Storage, Edge Functions, Realtime)
// and its WebSocket should be reachable as a connection target.
const connect = (directives.get("connect-src") ?? []).slice().sort();
const expectedConnect = [
  "'self'",
  "https://sjiswrvhrnrxkrfhfjrp.supabase.co",
  "wss://sjiswrvhrnrxkrfhfjrp.supabase.co",
].sort();
if (connect.join(" ") !== expectedConnect.join(" ")) {
  fail(`CSP connect-src is "${connect.join(" ")}", expected "${expectedConnect.join(" ")}"`);
} else {
  pass("CSP connect-src (self + the production Supabase project, HTTPS and WSS)");
}

// A wildcard somewhere other than the image allowlist would make the policy
// decorative. `script-src` is checked below by hash instead.
for (const name of ["default-src", "script-src", "style-src", "connect-src", "frame-src"]) {
  const sources = directives.get(name) ?? [];
  if (sources.includes("*") || sources.includes("https:") || sources.includes("http:")) {
    fail(`CSP ${name} contains a wildcard or scheme-wide source: ${sources.join(" ")}`);
  }
}

/* ------------------------------------------------------------ inline scripts */

const distHtml = path.join(root, "dist/index.html");
if (!existsSync(distHtml)) {
  note("dist/index.html not found — run `npm run build` to verify the inline script hashes");
} else {
  const html = await readFile(distHtml, "utf8");
  const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => match[2].trim())
    .map((match) => ({
      attrs: match[1].trim(),
      hash: `sha256-${createHash("sha256").update(match[2], "utf8").digest("base64")}`,
    }));

  const allowed = new Set((directives.get("script-src") ?? []).filter((s) => s.startsWith("'sha256-")));
  if (!allowed.size) fail("CSP script-src has no inline-script hashes");
  if (inline.length === 0) fail("dist/index.html has no inline scripts — the hashes are stale");

  for (const script of inline) {
    if (!allowed.has(`'${script.hash}'`)) {
      fail(
        `dist/index.html has an inline <script${script.attrs ? ` ${script.attrs}` : ""}> whose ` +
          `hash '${script.hash}' is not in CSP script-src`
      );
    }
  }
  for (const hash of allowed) {
    if (!inline.some((script) => `'${script.hash}'` === hash)) {
      fail(`CSP script-src pins ${hash}, which matches no inline script in dist/index.html`);
    }
  }
  if (!failures.length) pass(`CSP script-src covers all ${inline.length} inline scripts by hash`);
}

/* --------------------------------------------------------------- live origin */

const urlIndex = process.argv.indexOf("--url");
if (urlIndex !== -1) {
  const origin = process.argv[urlIndex + 1];
  if (!origin) {
    fail("--url needs an origin, e.g. --url https://rhsattendance.org");
  } else {
    console.log(`\nLive check: ${origin}`);
    let response;
    try {
      response = await fetch(origin, { redirect: "follow" });
    } catch (error) {
      fail(`could not reach ${origin}: ${error.message}`);
    }
    if (response) {
      for (const [key, value] of expected) {
        const actual = response.headers.get(key);
        if (actual !== value) fail(`${origin} returned ${key}: ${actual ?? "(absent)"}`);
        else pass(`${origin} ${key}`);
      }
      if (headers.has("content-security-policy")) {
        const actual = (response.headers.get("content-security-policy") ?? "")
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .sort()
          .join("; ");
        const wanted = csp
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .sort()
          .join("; ");
        if (actual !== wanted) fail(`${origin} returned a different CSP than vercel.json`);
        else pass(`${origin} Content-Security-Policy matches vercel.json`);
      }
      const hsts = response.headers.get("strict-transport-security");
      if (!hsts) fail(`${origin} returned no Strict-Transport-Security`);
      else pass(`${origin} Strict-Transport-Security: ${hsts}`);
    }
  }
}

/* --------------------------------------------------------------------- result */

if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const message of failures) console.error(`  fail ${message}`);
  process.exit(1);
}

console.log("\nSecurity headers look correct.");
