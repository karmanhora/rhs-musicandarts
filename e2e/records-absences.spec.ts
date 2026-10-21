import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installMocks, PROFILE_ID } from "./support/mocks.mjs";
import { OVERFLOW_PROBE } from "./support/probes.mjs";

/**
 * The two staff screens added by the 2026-10 expansion: the change history and
 * the export on `/records`, and the absence workflow on `/absences`.
 *
 * Everything is served from `support/mocks.mjs`, so no request leaves the
 * machine. Three things are checked that a type check cannot see: that the
 * screens render the entries the server would send, that the CSV a person
 * actually downloads is escaped and formula-safe, and that the page never
 * scrolls sideways on a phone.
 */

const PROGRAM_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_EVENT = "88888888-8888-4888-8888-888888888888";

const days = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString();

/**
 * The events the screens read. The shared fixture predates `name` and
 * `attendance_requirement`, so each spec that needs the current `EventRow`
 * shape serves its own — the same approach `qa-guard.spec.ts` takes.
 */
const EVENTS = [
  {
    id: HISTORY_EVENT,
    ensemble_id: PROGRAM_ID,
    name: "Marching rehearsal — homecoming set",
    type: "rehearsal",
    event_type: "rehearsal",
    date: days(-2),
    end_date: days(-2),
    all_day: false,
    location: "RHS Band Room",
    description: "",
    checkin_mode: "qr",
    attendance_requirement: "required",
    event_source: "manual",
    archived: false,
    late_minutes: 10,
    reminder_enabled: false,
    reminder_minutes_before: 60,
    created_by: PROFILE_ID,
    created_at: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "99999999-9999-4999-8999-999999999999",
    ensemble_id: PROGRAM_ID,
    name: "Friday night football vs. Bellevue",
    type: "performance",
    event_type: "performance",
    date: days(4),
    end_date: days(4),
    all_day: false,
    location: "Mustang Stadium",
    description: "",
    checkin_mode: "qr",
    attendance_requirement: "required",
    event_source: "manual",
    archived: false,
    late_minutes: 10,
    reminder_enabled: false,
    reminder_minutes_before: 60,
    created_by: PROFILE_ID,
    created_at: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ensemble_id: PROGRAM_ID,
    name: "Optional section social",
    type: "other",
    event_type: "other",
    date: days(6),
    end_date: days(6),
    all_day: false,
    location: "Quad",
    description: "",
    checkin_mode: "toggle",
    attendance_requirement: "optional",
    event_source: "manual",
    archived: false,
    late_minutes: 10,
    reminder_enabled: false,
    reminder_minutes_before: 60,
    created_by: PROFILE_ID,
    created_at: "2026-09-01T00:00:00.000Z",
  },
];

async function serveEvents(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/events(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "content-range": "0-2/3" },
      body: JSON.stringify(EVENTS),
    })
  );
}

/**
 * A roster of four people. The shared `memberships` fixture holds only the
 * caller's own rows, which is right for the program switcher but leaves the
 * student pickers with nobody to pick. Only the roster-shaped select is
 * replaced; the membership select with the embedded program falls through, so
 * the shell still resolves the current program.
 */
const STUDENTS = [
  { id: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1", name: "Marcus Ellery", section: "44444444-4444-4444-8444-444444444444", sectionName: "Brass" },
  { id: "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb1", name: "Priya Raghunathan-Villanueva", section: "55555555-5555-4555-8555-555555555555", sectionName: "Woodwinds" },
  { id: "bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb1", name: "Devon Okafor", section: "77777777-7777-4777-8777-777777777777", sectionName: "Percussion and colorguard" },
];

async function serveRoster(page: Page): Promise<void> {
  const rows = STUDENTS.map((s) => ({
    user_id: s.id,
    section_id: s.section,
    roles: ["member"],
    active: true,
    joined_at: "2026-09-01T00:00:00.000Z",
    profile: {
      id: s.id,
      full_name: s.name,
      display_name: s.name,
      avatar_url: null,
      avatar_path: null,
      bio: null,
      deactivated: false,
      created_at: "2026-09-01T00:00:00.000Z",
    },
    section: { id: s.section, name: s.sectionName },
  }));

  await page.route(/\/rest\/v1\/memberships(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const select = url.searchParams.get("select") ?? "";
    if (!select.includes("profile:profiles")) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "content-range": `0-${rows.length - 1}/${rows.length}` },
      body: JSON.stringify(rows),
    });
  });
}

/** Replace `my_permissions` for one spec (registered last, so it wins). */
async function servePermissions(page: Page, codes: string[]): Promise<void> {
  await page.route(/\/rest\/v1\/rpc\/my_permissions$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, permissions: codes }),
    })
  );
}

async function open(page: Page, path: string): Promise<void> {
  await installMocks(page, true);
  await serveEvents(page);
  await serveRoster(page);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // The lazy route chunk and the first `my_permissions()` answer both land after
  // the shell does, and a cold Vite dev server makes that slower than the 10s
  // default. Every screen here opens with a level-1 heading.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 45_000 });
}

/* ------------------------------------------------------------ change history */

test("a director reads the attendance change history", async ({ page }) => {
  await open(page, "/records");

  await expect(page.getByRole("heading", { name: "Records" })).toBeVisible();
  const history = page.getByRole("region", { name: "Attendance change history" });

  // The trigger's own vocabulary: a stored mark, its replacement, and who did it.
  await expect(
    history.locator("span.font-semibold").getByText("Marcus Ellery", { exact: true })
  ).toBeVisible();
  await expect(history.locator("span").getByText("Absent (stored)")).toBeVisible();
  await expect(history.locator("span").getByText("Excused")).toBeVisible();
  await expect(history.getByText(/Staff correction/)).toBeVisible();
  await expect(history.getByText(/Doctor's note handed in after rehearsal/)).toBeVisible();

  // A cleared mark is "No record", not a stored "Absent" the schema never keeps.
  await expect(
    history
      .locator("span.font-semibold")
      .getByText("Priya Raghunathan-Villanueva", { exact: true })
  ).toBeVisible();
  await expect(
    history.locator("span.inline-flex").getByText("No record").first()
  ).toBeVisible();
  await expect(history.getByText(/Bulk action/)).toBeVisible();
});

test("history filters are sent to the server, not applied in the browser", async ({
  page,
}) => {
  await open(page, "/records");

  const calls: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/rpc\/list_attendance_history$/, async (route) => {
    calls.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fallback();
  });

  await page.getByRole("combobox", { name: "Filter history by student" }).selectOption({
    label: "Marcus Ellery",
  });
  await page.getByRole("button", { name: "Show history" }).click();

  await expect.poll(() => calls.length).toBeGreaterThan(0);
  expect(calls.at(-1)?.p_ensemble).toBe(PROGRAM_ID);
  expect(typeof calls.at(-1)?.p_student).toBe("string");
  expect(calls.at(-1)?.p_limit).toBe(200);
});

/* ------------------------------------------------------------------- exports */

test("the report renders, and the downloaded CSV is escaped and formula-safe", async ({
  page,
}) => {
  await open(page, "/records");
  await page.getByRole("tab", { name: "Export report" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Build report" }).click();
  const report = page.getByRole("region", { name: "Attendance export" });
  await expect(report.getByRole("cell", { name: /Vance, Ada "Addie"/ })).toBeVisible();
  await expect(report.getByRole("cell", { name: "Not recorded" })).toBeVisible();

  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = await readFile(path as string, "utf8");

  expect(download.suggestedFilename()).toMatch(/^attendance-.*\.csv$/);
  // RFC 4180: the comma and the quote inside a name force quoting and doubling.
  expect(csv).toContain('"Vance, Ada ""Addie"""');
  // Spreadsheet formula injection is neutralised with a leading apostrophe.
  expect(csv).toContain("'=HYPERLINK");
  expect(csv).toContain("Not recorded");
  // The audience fields the report must never carry.
  expect(csv.toLowerCase()).not.toContain("@example.");
  expect(csv.toLowerCase()).not.toContain("reason");
});

test("a section leader without the export capability gets no export tab", async ({
  page,
}) => {
  await installMocks(page, true);
  await serveEvents(page);
  await serveRoster(page);
  await servePermissions(page, ["attendance.view_section"]);
  await page.goto("/records", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("tab", { name: "Change history" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export report" })).toHaveCount(0);
});

test("a student cannot open the records screen at all", async ({ page }) => {
  await installMocks(page, true);
  await serveEvents(page);
  await serveRoster(page);
  await servePermissions(page, ["attendance.view_self"]);
  await page.goto("/records", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Records" })).toHaveCount(0);
});

/* -------------------------------------------------------------- absences */

test("a reviewer sees the queue and is told approval is not a mark", async ({ page }) => {
  await open(page, "/absences");

  await expect(page.getByRole("heading", { name: "Absences" })).toBeVisible();
  const queue = page.getByRole("region", { name: "Review queue" });
  await expect(queue.getByText("Devon Okafor")).toBeVisible();
  await expect(queue.getByText("Orthodontist appointment.")).toBeVisible();
  await expect(queue.locator("span").getByText("Pending")).toBeVisible();

  await queue.getByRole("button", { name: "Approve" }).click();
  const decision = page.getByRole("dialog", { name: /Devon Okafor's request/ });
  await expect(decision).toBeVisible();
  await expect(decision.getByLabel("Response (optional)")).toBeVisible();
  await expect(
    decision.getByText(/Saving this does not change anyone's attendance/)
  ).toBeVisible();
});

test("a student sees only their own requests, and cannot review", async ({ page }) => {
  await installMocks(page, true);
  await serveEvents(page);
  await serveRoster(page);
  await servePermissions(page, ["absence.request_self"]);
  await page.goto("/absences", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("region", { name: "Ask to miss an event" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText(/decided by/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Review queue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
});

test("a member without either capability cannot open the screen at all", async ({
  page,
}) => {
  await installMocks(page, true);
  await serveEvents(page);
  await serveRoster(page);
  await servePermissions(page, ["attendance.view_self"]);
  await page.goto("/absences", { waitUntil: "domcontentloaded" });

  // The route gate sends them home rather than rendering an empty form.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Absences" })).toHaveCount(0);
});

/* ---------------------------------------------------------- notifications */

test("the bell opens the notification sheet and marks everything read", async ({ page }) => {
  await open(page, "/");

  await page.getByRole("button", { name: /Notifications — 1 unread/ }).click();
  await expect(page.getByText("Homecoming rehearsal moved")).toBeVisible();

  await expect(page.locator('[aria-label="Unread"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Mark all as read" }).click();
  // The row is no longer unread: the dot is gone even though the badge count
  // only refreshes on the shell's next poll.
  await expect(page.locator('[aria-label="Unread"]')).toHaveCount(0);
});

/* -------------------------------------------------------------- responsive */

for (const width of [360, 390, 1440]) {
  test(`records and absences do not scroll sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });

    await open(page, "/records");
    let overflow = (await page.evaluate(OVERFLOW_PROBE)) as {
      overflowBy: number;
      offenders: unknown[];
    };
    expect(overflow.overflowBy, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(1);

    await page.getByRole("tab", { name: "Export report" }).click();
    await page.getByRole("button", { name: "Build report" }).click();
    await expect(
      page.getByRole("region", { name: "Attendance export" }).getByRole("cell", {
        name: /Vance, Ada "Addie"/,
      })
    ).toBeVisible();
    overflow = (await page.evaluate(OVERFLOW_PROBE)) as {
      overflowBy: number;
      offenders: unknown[];
    };
    expect(overflow.overflowBy, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(1);

    await page.goto("/absences", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Absences" })).toBeVisible({
      timeout: 45_000,
    });
    overflow = (await page.evaluate(OVERFLOW_PROBE)) as {
      overflowBy: number;
      offenders: unknown[];
    };
    expect(overflow.overflowBy, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(1);
  });
}
