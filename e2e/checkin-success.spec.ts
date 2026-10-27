import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { installMocks, PROFILE_ID, PROGRAM_ID, SUPABASE_HOST } from "./support/mocks.mjs";

/**
 * The student check-in confirmation.
 *
 * The deep-link flow (`/checkin?token=…`) is used because it reaches the
 * student outcome without a camera, but it is the same `record_attendance`
 * call the scanner and the typed code make.
 */

const TOKEN = "qa-checkin-token";
const EVENT_ID = "88888888-8888-4888-8888-888888888888";
const EVENT_NAME = "Marching rehearsal — homecoming set";
/** 08:31 in the suite's America/Los_Angeles timezone. */
const CHECKED_IN_AT = "2026-10-12T15:31:00.000Z";

const CHECKED_IN = {
  ok: true,
  message: "Checked in",
  event_id: EVENT_ID,
  event_name: EVENT_NAME,
  checked_in_at: CHECKED_IN_AT,
  is_late: false,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range",
      "content-range": Array.isArray(body) ? `0-${Math.max(body.length - 1, 0)}/${body.length}` : "0-0/1",
    },
    body: JSON.stringify(body),
  });
}

/** The attendance snapshot this page reads before it submits. */
async function mockPriorAttendance(page: Page, rows: unknown[]) {
  await page.route(`${SUPABASE_HOST}/rest/v1/attendance_records*`, (route) =>
    json(route, rows)
  );
}

type MockAnswer = Record<string, unknown> | { status: number; payload: unknown };

async function mockRecordAttendance(
  page: Page,
  body: MockAnswer | (() => Promise<MockAnswer>)
) {
  const calls: number[] = [];
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/record_attendance`, async (route) => {
    calls.push(Date.now());
    const answer = typeof body === "function" ? await body() : body;
    if ("status" in answer && "payload" in answer) {
      await json(route, answer.payload, answer.status);
      return;
    }
    await json(route, answer);
  });
  return calls;
}

test.describe("check-in confirmation", () => {
  test.setTimeout(300_000);

  test("a new check-in plays the success mark once, after the server answers", async ({ page }) => {
    await installMocks(page, true);
    await mockPriorAttendance(page, []);

    let release!: () => void;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = await mockRecordAttendance(page, async () => {
      await answered;
      return CHECKED_IN;
    });

    await page.goto(`/checkin?token=${TOKEN}`);

    // Still pending: no confirmation, no success mark.
    await expect(page.getByText("Checking you in…")).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText("You're checked in!")).toHaveCount(0);
    await expect(page.locator(".cue-success-mark")).toHaveCount(0);

    release();

    await expect(page.getByText("You're checked in!")).toBeVisible();
    await expect(page.getByText(EVENT_NAME)).toBeVisible();
    await expect(page.getByText("Checked in at 8:31 AM")).toBeVisible();
    await expect(page.getByRole("button", { name: "Done" })).toBeVisible();

    const mark = page.locator(".cue-success-mark");
    await expect(mark).toHaveCount(1);
    expect(await mark.evaluate((el) => getComputedStyle(el).animationIterationCount)).toBe("1");
    // A later render must not start a second run.
    const firstStart = await mark.evaluate(
      (el) => el.getAnimations()[0]?.startTime ?? null
    );
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(400);
    expect(
      await mark.evaluate((el) => el.getAnimations()[0]?.startTime ?? null)
    ).toBe(firstStart);

    // The draw finishes on the mark itself, not just in the reduced-motion case.
    await page.waitForTimeout(1200);
    expect(
      await page.locator(".cue-success-check").evaluate(
        (el) => getComputedStyle(el).strokeDashoffset
      )
    ).toBe("0px");

    expect(calls).toHaveLength(1);
  });

  test("an already-recorded check-in is calm and never claims a new one", async ({ page }) => {
    await installMocks(page, true);
    await mockPriorAttendance(page, [
      { event_id: EVENT_ID, checked_in_at: CHECKED_IN_AT },
    ]);
    const calls = await mockRecordAttendance(page, {
      ...CHECKED_IN,
      message: "Checked in",
    });

    await page.goto(`/checkin?token=${TOKEN}`);

    await expect(page.getByText("You're already checked in!")).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText("No new attendance was recorded.")).toBeVisible();
    await expect(page.getByText("Checked in at 8:31 AM")).toBeVisible();
    await expect(page.locator(".cue-success")).toHaveCount(0);
    await expect(page.locator(".cue-success-mark")).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test("an expired code shows the server's refusal and no success", async ({ page }) => {
    await installMocks(page, true);
    await mockPriorAttendance(page, []);
    const calls = await mockRecordAttendance(page, {
      ok: false,
      message: "That code has expired — ask for a fresh one.",
    });

    await page.goto(`/checkin?token=${TOKEN}`);

    await expect(
      page.getByText("That code has expired — ask for a fresh one.").first()
    ).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText("You're checked in!")).toHaveCount(0);
    await expect(page.locator(".cue-success-mark")).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test("a server failure shows an error and no success", async ({ page }) => {
    await installMocks(page, true);
    await mockPriorAttendance(page, []);
    const calls = await mockRecordAttendance(page, {
      status: 500,
      payload: { message: "Could not record attendance." },
    });

    await page.goto(`/checkin?token=${TOKEN}`);

    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText("You're checked in!")).toHaveCount(0);
    await expect(page.locator(".cue-success-mark")).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test("the typed-code form plays the same confirmation", async ({ page }) => {
    await installMocks(page, true);
    // A plain member sees the student form (the fixture person directs a program).
    await page.route(`${SUPABASE_HOST}/rest/v1/memberships*`, (route) =>
      json(route, [
        {
          id: "66666666-6666-4666-8666-666666666666",
          user_id: PROFILE_ID,
          ensemble_id: PROGRAM_ID,
          section_id: null,
          roles: ["member"],
          active: true,
          joined_at: "2026-09-01T00:00:00.000Z",
          email_upcoming_events: true,
          ensemble: {
            id: PROGRAM_ID,
            slug: "band",
            name: "RHS Mustang Band",
            short_name: "Band",
            theme_color: "#17402b",
            logo_url: null,
            active: true,
            created_at: "2026-08-01T00:00:00.000Z",
          },
          section: null,
        },
      ])
    );
    await mockPriorAttendance(page, []);
    const calls: number[] = [];
    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/record_attendance_by_code`, (route) => {
      calls.push(Date.now());
      return json(route, CHECKED_IN);
    });

    await page.goto("/checkin");
    await page.getByRole("tab", { name: "Enter code" }).click({ timeout: 240_000 });
    await page.getByLabel("Check-in code").fill("ABCD2345");
    await page.getByRole("button", { name: "Check in", exact: true }).click();

    await expect(page.getByText("You're checked in!")).toBeVisible();
    await expect(page.locator(".cue-success-mark")).toHaveCount(1);
    expect(calls).toHaveLength(1);
  });

  test("reduced motion shows the confirmation without the draw", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installMocks(page, true);
    await mockPriorAttendance(page, []);
    await mockRecordAttendance(page, CHECKED_IN);

    await page.goto(`/checkin?token=${TOKEN}`);
    await expect(page.getByText("You're checked in!")).toBeVisible({ timeout: 240_000 });

    const state = await page.evaluate(() => {
      const copy = document.querySelector(".cue-success-copy") as HTMLElement | null;
      const ring = document.querySelector(".cue-success-ring") as SVGCircleElement | null;
      const check = document.querySelector(".cue-success-check") as SVGPathElement | null;
      const mark = document.querySelector(".cue-success-mark") as SVGElement | null;
      if (!copy || !ring || !check || !mark) return null;
      return {
        copyDelay: getComputedStyle(copy).animationDelay,
        copyOpacity: getComputedStyle(copy).opacity,
        markDelay: getComputedStyle(mark).animationDelay,
        ringOffset: getComputedStyle(ring).strokeDashoffset,
        checkOffset: getComputedStyle(check).strokeDashoffset,
      };
    });

    expect(state).not.toBeNull();
    expect(state!.copyDelay).toBe("0s");
    expect(state!.markDelay).toBe("0s");
    expect(state!.copyOpacity).toBe("1");
    expect(state!.ringOffset).toBe("0px");
    expect(state!.checkOffset).toBe("0px");
  });
});

/**
 * The event's scheduled end time is what closes check-in, and the rule lives in
 * the database: `record_checkin_for_session` refuses a scan or a typed code past
 * `coalesce(end_date, date + 24 hours)`, and `security_verification_v2.sql`
 * pins that. These two tests are the other half — that the screens agree with it
 * instead of leaving a student a form that cannot work, or a code on the wall
 * for an event that is over.
 */
test.describe("check-in closure", () => {
  test.setTimeout(300_000);

  test("a closed event is reported instead of a success", async ({ page }) => {
    await installMocks(page, true);
    await mockPriorAttendance(page, []);
    const calls = await mockRecordAttendance(page, {
      ok: false,
      message: "That event has already ended — attendance is closed.",
    });

    await page.goto(`/checkin?token=${TOKEN}`);

    await expect(page.getByText("Check-in has closed")).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText(/stopped taking check-ins at its scheduled end time/)).toBeVisible();
    await expect(page.getByText("You're checked in!")).toHaveCount(0);
    await expect(page.locator(".cue-success-mark")).toHaveCount(0);
    // The same refusal a refresh produces: one submission, no success.
    expect(calls).toHaveLength(1);
    // And the form that could no longer record anything is gone.
    await expect(page.getByText("Scan or enter your code")).toHaveCount(0);
  });

  test("the projector shows the event has ended and offers no code", async ({ page }) => {
    await installMocks(page, true);
    const start = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const end = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await page.route(/\/rest\/v1\/events(\?.*)?$/, (route) =>
      json(route, [
        {
          id: EVENT_ID,
          ensemble_id: PROGRAM_ID,
          name: EVENT_NAME,
          type: "rehearsal",
          event_type: "rehearsal",
          date: start.toISOString(),
          end_date: end.toISOString(),
          all_day: false,
          location: "RHS Band Room",
          description: "",
          google_calendar_uid: null,
          google_calendar_updated_at: null,
          google_calendar_synced_at: null,
          checkin_mode: "qr",
          attendance_requirement: "required",
          event_source: "manual",
          archived: false,
          late_minutes: 10,
          reminder_enabled: false,
          reminder_minutes_before: 60,
          created_by: null,
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ])
    );
    let sessionStarts = 0;
    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/start_checkin_session`, (route) => {
      sessionStarts += 1;
      return json(route, {
        ok: false,
        message: "That event has already ended — check-in is closed.",
      });
    });

    await page.goto("/checkin");

    await expect(page.getByText("Check-in has ended")).toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole("button", { name: "Start check-in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New code" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Full-screen display" })).toHaveCount(0);
    // Nothing was even asked of the server: the screen knows the event is over.
    expect(sessionStarts).toBe(0);
  });
});
