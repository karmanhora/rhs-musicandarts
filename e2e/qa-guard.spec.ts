import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installMocks, SUPABASE_HOST } from "./support/mocks.mjs";
import {
  ANIMATION_PROBE,
  CALM_CONTRAST_PROBE,
  CONTAINMENT_PROBE,
  OVERFLOW_PROBE,
  SWITCH_PROBE,
  TARGET_PROBE,
} from "./support/probes.mjs";

/**
 * The checks that must never regress.
 *
 * Each one guards a defect the audit found and fixed; docs/QA_REPORT.md names
 * the issue id each test covers. Run with `npx playwright test`.
 */

const WIDTHS = [320, 360, 390, 768, 1440];
const NOTES_READY = (engine?: string) =>
  `() => {
     var el = document.querySelector("[data-notes-field]");
     return !!el && el.getAttribute("data-engine") !== null${
       engine ? ` && el.getAttribute("data-engine") === "${engine}"` : ""
     };
   }`;

type Overflow = {
  documentScrollWidth: number;
  viewport: number;
  overflowBy: number;
  offenders: { selector: string; right: number; width: number }[];
};

async function measureOverflow(page: Page): Promise<Overflow> {
  return (await page.evaluate(OVERFLOW_PROBE)) as Overflow;
}

/**
 * One event dated today, because the calendar agenda opens on today and the
 * shared fixtures are dated relative to the mocks' fixed "now". The extra
 * columns beyond the ones the check-in screen reads are what the event-detail
 * sheet renders.
 */
async function serveTodaysEvent(page: Page): Promise<void> {
  const today = new Date();
  today.setHours(15, 30, 0, 0);
  await page.route(/\/rest\/v1\/events(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "88888888-8888-4888-8888-888888888888",
          ensemble_id: "33333333-3333-4333-8333-333333333333",
          name: "Marching rehearsal — homecoming set",
          type: "rehearsal",
          event_type: "rehearsal",
          date: today.toISOString(),
          end_date: new Date(today.getTime() + 2 * 60 * 60 * 1000).toISOString(),
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
      ]),
    })
  );
}

/* ------------------------------------------------------------------ tests -- */

test.describe("public pages", () => {
  for (const width of WIDTHS) {
    test(`landing page has no horizontal overflow at ${width}px`, async ({ page }) => {
      await installMocks(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const result = await measureOverflow(page);
      expect(result.offenders, JSON.stringify(result.offenders, null, 2)).toEqual([]);
      expect(result.overflowBy).toBeLessThanOrEqual(0);
    });
  }

  for (const width of [320, 360, 390]) {
    test(`auth and legal pages have no horizontal overflow at ${width}px`, async ({ page }) => {
      await installMocks(page);
      await page.setViewportSize({ width, height: 780 });
      for (const path of ["/sign-in", "/sign-up", "/forgot-password", "/privacy", "/terms"]) {
        await page.goto(path);
        await expect(page.locator("main, h1").first()).toBeVisible();
        const result = await measureOverflow(page);
        expect(result.offenders, `${path}: ${JSON.stringify(result.offenders, null, 2)}`).toEqual([]);
        expect(result.overflowBy, path).toBeLessThanOrEqual(0);
      }
    });
  }

  test("privacy policy is public and carries no placeholders", async ({ page }) => {
    await installMocks(page);
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Google Sign-In/ })).toBeVisible();
    await expect(page.locator('a[href="mailto:privacy@rhsattendance.org"]')).toBeVisible();
    const text = await page.locator("main").innerText();
    // A published policy must never ship with `[TO BE SET]`-style placeholders.
    expect(text).not.toMatch(/\[[^\]]+\]/);
  });

  test("masthead does not touch the top edge of the viewport", async ({ page }) => {
    await installMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    // The logo and the Sign in control are the two things the defect touched.
    for (const selector of ['header img[src$="logo.svg"]', 'header a[href="/sign-in"]']) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, `${selector} is not rendered`).not.toBeNull();
      expect(box!.y, `${selector} starts at y=${box!.y}`).toBeGreaterThanOrEqual(8);
    }
  });

  test("every visible control meets the 44px tap target and 8px gap rule", async ({ page }) => {
    await installMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const { small, crowded } = (await page.evaluate(TARGET_PROBE)) as {
      small: { selector: string; w: number; h: number }[];
      crowded: { a: string; b: string; gap: number }[];
    };
    expect(small, `undersized controls: ${JSON.stringify(small, null, 2)}`).toEqual([]);
    expect(crowded, `crowded controls: ${JSON.stringify(crowded, null, 2)}`).toEqual([]);
  });
});

test.describe("signed-in screens", () => {
  // Each of these walks eleven routes, and every route waits for the shell to
  // resolve a session, a program and then a route chunk. That is minutes of
  // honest waiting, not a hang.
  test.setTimeout(300_000);

  // Every screen is rendered from fixtures (e2e/support/mocks.mjs) — no request
  // in this block reaches Supabase.
  const ROUTES = [
    "/",
    "/calendar",
    "/attendance",
    "/roster",
    "/checkin",
    "/me",
    "/analytics",
    "/roles",
    "/settings",
    "/join",
    "/new-program",
    "/teacher",
  ];

  test("calendar managers can open the Google Calendar import sheet", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/calendar");

    const importButton = page.getByRole("button", { name: "Import Google Calendar" });
    await expect(importButton).toBeVisible({ timeout: 20_000 });
    await importButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Google Calendar public iCal URL")).toBeVisible();
    await expect(dialog.getByText(/imported events can be edited/i)).toBeVisible();
  });

  for (const width of [320, 360, 390, 768, 1440]) {
    test(`no screen overflows horizontally at ${width}px`, async ({ page }) => {
      await installMocks(page, true);
      await page.setViewportSize({ width, height: 844 });
      for (const route of ROUTES) {
        await page.goto(route);
        // The shell resolves a session, a program and then a route chunk.
        await page.waitForTimeout(2200);
        const result = await measureOverflow(page);
        expect(result.offenders, `${route}: ${JSON.stringify(result.offenders, null, 2)}`).toEqual(
          []
        );
        expect(result.overflowBy, route).toBeLessThanOrEqual(0);
      }
    });
  }

  // The control floor is checked on three shapes of viewport, not one width:
  // a phone in landscape is 390px of *height* (the sheet, the masthead and the
  // bottom bar all change), and a tablet is where the two-column rows appear.
  // The rest of the device matrix (touch, DPR, 320px, 2560px) lives in
  // .tools/qa/measure.mjs --devices, which measures rather than asserts.
  const TARGET_VIEWPORTS = [
    { name: "phone portrait", width: 390, height: 844 },
    { name: "phone landscape", width: 844, height: 390 },
    { name: "tablet portrait", width: 768, height: 1024 },
  ];

  for (const viewport of TARGET_VIEWPORTS) {
    test(`every visible control meets the 44px tap target and 8px gap rule — ${viewport.name}`, async ({
      page,
    }) => {
      await installMocks(page, true);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of ROUTES) {
        await page.goto(route);
        await page.waitForTimeout(2200);
        const { small, crowded } = (await page.evaluate(TARGET_PROBE)) as {
          small: { selector: string; w: number; h: number }[];
          crowded: { a: string; b: string; gap: number }[];
        };
        expect(small, `${route} undersized: ${JSON.stringify(small, null, 2)}`).toEqual([]);
        expect(crowded, `${route} crowded: ${JSON.stringify(crowded, null, 2)}`).toEqual([]);
      }
    });
  }

  /*
   * Teacher verification (migration 035). The fixture persona declared teacher
   * at sign-up and has redeemed nothing, so this is the pending state — the one
   * the brief requires be unmistakable.
   */
  test("the teacher screen says access is pending and can reveal its code field", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/teacher");
    await page.waitForTimeout(2200);

    await expect(page.getByText(/teacher access is pending/i)).toBeVisible();
    await expect(page.getByText(/keeps its ordinary permissions/i)).toBeVisible();
    await expect(
      page.getByText(/checked on the server/i).first(),
      "the screen does not say where the code is checked"
    ).toBeVisible();

    // A real, labelled field — not a placeholder standing in for one. `exact`
    // because the reveal button's own name ("Show the invitation code") would
    // otherwise match the same substring.
    const field = page.getByLabel("Invitation code", { exact: true });
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("aria-describedby", "teacher-invitation-hint");
    await expect(field).toHaveAttribute("type", "password");

    // The show/hide toggle flips the *input type*, not just an icon.
    const toggle = page.getByRole("button", { name: /show the invitation code/i });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(field).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: /hide the invitation code/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Nothing on this screen prints the code itself.
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("i-love-music");
    expect(text).not.toContain("code_hash");
  });

  test("an already signed-in account can enter its code later from settings", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings");
    await page.waitForTimeout(2200);

    // The unverified state is stated here too, with the way back to the form.
    await expect(page.getByRole("heading", { name: /teacher access/i })).toBeVisible();
    const button = page.getByRole("button", { name: /enter my invitation code/i });
    await expect(button).toBeVisible();

    await button.click();
    await expect(page.getByLabel("Invitation code", { exact: true })).toBeVisible();
    await expect(page.getByText(/teacher access is pending/i)).toBeVisible();
    await expect(page).toHaveURL(/\/teacher$/);
  });

  test("reduced motion is honoured on a signed-in screen too", async ({ page }) => {
    await installMocks(page, true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.waitForTimeout(2200);
    const offenders = (await page.evaluate(ANIMATION_PROBE)) as unknown[];
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  test("a sheet closes on Escape and restores focus", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForTimeout(2200);
    const trigger = page.getByRole("button", { name: /notifications/i });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Focus containment returns the caret to the control that opened it.
    await expect(trigger).toBeFocused();
  });

  test("the keyboard reaches every bottom-tab destination", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForTimeout(2200);
    const nav = page.getByRole("navigation", { name: "Main navigation" }).last();
    const links = await nav.getByRole("link").all();
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      await link.focus();
      await expect(link).toBeFocused();
    }
  });
});

test.describe("flying-notes overlay", () => {
  test("never covers the hero headline", async ({ page }) => {
    await installMocks(page);
    // Reduced motion on purpose: it freezes the headline's masked-line reveal,
    // so the only thing that can differ between the two screenshots is the
    // note field itself.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/?notes=off");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
    const clip = await heading.boundingBox();
    expect(clip).not.toBeNull();
    const without = await page.screenshot({ clip: clip! });

    await page.goto("/");
    await expect(heading).toBeVisible();
    await page.waitForFunction(NOTES_READY(), undefined, { timeout: 20_000 });
    const withNotes = await page.screenshot({ clip: clip! });
    // Identical bytes inside the headline box means not one note pixel reached
    // it — a stricter test than any threshold. The canvas animates, so if a
    // single note were visible here the two would differ.
    expect(Buffer.compare(withNotes, without), "notes changed pixels inside the headline").toBe(0);
  });

  test("stays dim enough behind calm-zone text to hold AA", async ({ page }) => {
    await installMocks(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?notes=canvas");
    await page.waitForFunction(NOTES_READY("canvas"), undefined, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const result = (await page.evaluate(CALM_CONTRAST_PROBE)) as {
      error?: string;
      worst?: { pocket: string; alpha: number; contrast: number }[];
    };
    expect(result.error).toBeUndefined();
    expect(result.worst!.length).toBeGreaterThan(0);
    for (const pocket of result.worst!) {
      expect(
        pocket.contrast,
        `${pocket.pocket} drops body text to ${pocket.contrast}:1 — under AA`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("is unreachable by pointer and by the accessibility tree", async ({ page }) => {
    await installMocks(page);
    await page.goto("/");
    const canvas = page.locator("[data-notes-field]");
    await expect(canvas).toHaveAttribute("aria-hidden", "true");
    await expect(canvas).toHaveCSS("pointer-events", "none");
  });

  test("renders one still frame and no bursts under reduced motion", async ({ page }) => {
    await installMocks(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?notes=canvas");
    await page.waitForFunction(NOTES_READY("canvas"), undefined, { timeout: 20_000 });
    await page.waitForTimeout(400);
    const canvas = page.locator("[data-notes-field]");
    const first = await canvas.screenshot();
    await page.waitForTimeout(1200);
    const second = await canvas.screenshot();
    expect(Buffer.compare(first, second), "the reduced-motion frame is still animating").toBe(0);
  });
});

/*
 * The class of defect the page-level probes cannot see.
 *
 * QA-11 and QA-12 were both "the panel is right and the thing inside it is
 * not": a switch knob painted on the label beside it, and a sheet footer button
 * painted 470px outside the sheet. Neither is page overflow — the body is
 * `overflow: hidden` while a sheet is open — and neither is a size or a spacing
 * problem. Everything below therefore measures the surface **open**, on every
 * engine the suite runs on.
 */
test.describe("open surfaces", () => {
  const VIEWPORTS = [
    { name: "phone portrait", width: 390, height: 844 },
    { name: "phone landscape", width: 844, height: 390 },
    { name: "tablet portrait", width: 768, height: 1024 },
    { name: "desktop", width: 1440, height: 900 },
  ];

  const SURFACES = [
    {
      name: "notifications",
      route: "/",
      open: (page: Page) => page.getByRole("button", { name: /notifications/i }).first().click(),
    },
    {
      name: "program switcher",
      route: "/",
      open: (page: Page) => page.locator('[aria-label^="Switch program"]').first().click(),
    },
    {
      name: "add event",
      route: "/calendar",
      open: (page: Page) => page.getByRole("button", { name: /add event/i }).first().click(),
    },
  ];

  for (const surface of SURFACES) {
    for (const viewport of VIEWPORTS) {
      test(`${surface.name} keeps every child inside itself — ${viewport.name}`, async ({ page }) => {
        await installMocks(page, true);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(surface.route);
        await page.waitForTimeout(2200);
        await surface.open(page);

        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        const result = (await page.evaluate(CONTAINMENT_PROBE)) as {
          found: boolean;
          panel?: { width: number };
          escapes: { selector: string; over: Record<string, number> }[];
        };
        expect(result.found, "the surface opened but no dialog was measured").toBe(true);
        expect(result.panel!.width, "the panel measured as zero-width").toBeGreaterThan(0);
        expect(
          result.escapes,
          JSON.stringify(result.escapes, null, 2)
        ).toEqual([]);

        // Escape still closes it, at every size and on every engine.
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      });
    }
  }
});

test.describe("control internals", () => {
  test("the switch's knob is inside its own track in both states", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/calendar");
    await page.waitForTimeout(2200);

    const first = (await page.evaluate(SWITCH_PROBE)) as {
      found: boolean;
      checked: boolean;
      knobInsideTrack: boolean;
      overlappingLabels: unknown[];
      track: { width: number };
    };
    expect(first.found, "the calendar has no switch for staff").toBe(true);
    expect(first.checked).toBe(false);
    expect(first.knobInsideTrack, JSON.stringify(first)).toBe(true);
    expect(first.overlappingLabels, JSON.stringify(first)).toEqual([]);

    // The other state is the one that travels the full width of the track.
    await page.getByRole("switch").click();
    await page.waitForTimeout(400);
    const second = (await page.evaluate(SWITCH_PROBE)) as {
      checked: boolean;
      knobInsideTrack: boolean;
      overlappingLabels: unknown[];
    };
    expect(second.checked).toBe(true);
    expect(second.knobInsideTrack, JSON.stringify(second)).toBe(true);
    expect(second.overlappingLabels, JSON.stringify(second)).toEqual([]);
    await page.getByRole("switch").click();
  });
});

test.describe("reduced motion", () => {
  test("removes movement without removing a single control", async ({ page }) => {
    await installMocks(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const offenders = (await page.evaluate(ANIMATION_PROBE)) as {
      selector: string;
      animation: string;
      duration: string;
    }[];
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    // And the page is still fully usable.
    await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /privacy policy/i })).toBeVisible();
  });

  test("honours the in-app preference as well as the operating system", async ({ page }) => {
    await installMocks(page);
    await page.goto("/");
    // The OS preference is off, so nothing is reduced until the app says so.
    const before = (await page.evaluate(ANIMATION_PROBE)) as unknown[];
    expect(before.length).toBeGreaterThan(0);
    await page.evaluate(() => {
      document.documentElement.classList.add("reduce-motion");
    });
    const after = (await page.evaluate(ANIMATION_PROBE)) as unknown[];
    expect(after, JSON.stringify(after, null, 2)).toEqual([]);
  });
});

test.describe("live check-in projector", () => {
  // A cold Vite dev server compiles the route chunks on first request; the
  // signed-in screens pay the same cost and allow for it.
  test.setTimeout(300_000);

  /**
   * The eight-character code is one unbreakable token in a card that is only
   * ~320px wide once the live columns appear, so a larger font size silently
   * spills it under the neighbouring column (the code used to be 3.75rem and
   * lost its last character). This renders the session panel — the shared
   * fixtures do not — and measures the real text box, not just the document.
   */
  test("the code stays inside its card at every width", async ({ page }) => {
    const code = "A5TSTYZ2";
    await installMocks(page, true);

    await serveTodaysEvent(page);
    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/start_checkin_session`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          ok: true,
          token: "qa-session-token",
          entry_code: code,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
      })
    );

    await page.goto("/checkin");
    const start = page.getByRole("button", { name: "Start check-in" });
    await expect(start).toBeVisible({ timeout: 60_000 });
    await start.click();
    await expect(page.getByText(code, { exact: true })).toBeVisible();

    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const fit = (await page.evaluate((value) => {
        const element = [...document.querySelectorAll("p")].find(
          (p) => p.textContent?.trim() === value
        );
        const card = element?.closest(".cue-card");
        if (!element || !card) return null;
        const style = getComputedStyle(card);
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const box = card.getBoundingClientRect();
        return {
          left: Math.round(box.left + parseFloat(style.paddingLeft) - text.left),
          right: Math.round(text.right - (box.right - parseFloat(style.paddingRight))),
          overflow: element.scrollWidth - element.clientWidth,
        };
      }, code)) as { left: number; right: number; overflow: number } | null;

      expect(fit, `no code rendered at ${width}px`).not.toBeNull();
      expect(fit!.left, `code spills left at ${width}px`).toBeLessThanOrEqual(0);
      expect(fit!.right, `code spills right at ${width}px`).toBeLessThanOrEqual(0);
      expect(fit!.overflow, `code line box overflows at ${width}px`).toBe(0);
    }
  });

  /**
   * The classroom display must present the *running* session, not start one of
   * its own, and it must be leavable with Escape even where the Fullscreen API
   * is refused. Starting it here would show a different code than the wall;
   * leaving it without closing the overlay would strand a staff member.
   */
  test("the full-screen display shows the live code and leaves on Escape", async ({ page }) => {
    const code = "A5TSTYZ2";
    await installMocks(page, true);

    await serveTodaysEvent(page);
    let sessionStarts = 0;
    await page.route(`${SUPABASE_HOST}/rest/v1/rpc/start_checkin_session`, (route) => {
      sessionStarts += 1;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          ok: true,
          token: "qa-session-token",
          entry_code: code,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
      });
    });

    await page.goto("/checkin");
    const start = page.getByRole("button", { name: "Start check-in" });
    await expect(start).toBeVisible({ timeout: 60_000 });
    await start.click();
    await expect(page.getByText(code, { exact: true })).toBeVisible();

    const open = page.getByRole("button", { name: "Full-screen display" });
    const openBox = await open.boundingBox();
    expect(openBox, "the full-screen opener is missing").not.toBeNull();
    expect(openBox!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    const display = page.getByRole("dialog", { name: "Check-in code, full screen" });
    await expect(display).toBeVisible();
    await expect(display.getByText(code, { exact: true })).toBeVisible();
    await expect(display.getByText(/\d+ of \d+ checked in/)).toBeVisible();

    // It covers the projector, not just the card it was opened from: an
    // ancestor with a retained transform would trap a fixed child.
    const covers = await display.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        left: Math.round(box.left),
        width: Math.round(box.width),
        height: Math.round(box.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(covers.top).toBe(0);
    expect(covers.left).toBe(0);
    expect(covers.width).toBeGreaterThanOrEqual(covers.viewportWidth - 1);
    expect(covers.height).toBeGreaterThanOrEqual(covers.viewportHeight - 1);
    // Opening the display did not mint a second session.
    expect(sessionStarts).toBe(1);

    await page.keyboard.press("Escape");
    await expect(display).toBeHidden();
    // The projector view is still running the same code underneath.
    await expect(page.getByText(code, { exact: true })).toBeVisible();

    // The fallback: a browser that refuses fullscreen still gets the display,
    // and Escape still leaves it.
    await page.evaluate(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new Error("denied"));
    });
    await page.getByRole("button", { name: "Full-screen display" }).click();
    await expect(display).toBeVisible();
    await expect(display.getByText(code, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(display).toBeHidden();
  });
});

test.describe("event detail actions", () => {
  test.setTimeout(300_000);

  /**
   * `Button` is `shrink-0`, and `block` makes it `w-full`, so two of them in a
   * flex row cannot shrink: the second one is pushed out of the sheet and the
   * page scrolls sideways. They are stacked now. `CONTAINMENT_PROBE` cannot
   * catch this because it skips everything inside the sheet's scroll container,
   * so measure the two buttons directly.
   */
  for (const viewport of [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1440, height: 900 },
  ]) {
    test(`Edit and Archive sit on top of each other — ${viewport.name}`, async ({ page }) => {
      await installMocks(page, true);
      await serveTodaysEvent(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/calendar");

      const row = page.getByRole("button", { name: /Marching rehearsal/i }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const edit = page.getByRole("button", { name: "Edit", exact: true });
      const archive = page.getByRole("button", { name: "Archive", exact: true });
      const [editBox, archiveBox, dialogBox] = await Promise.all([
        edit.boundingBox(),
        archive.boundingBox(),
        dialog.boundingBox(),
      ]);
      expect(editBox && archiveBox && dialogBox, "the staff actions are missing").toBeTruthy();

      // Archive starts below Edit, both share a left edge, and neither leaves
      // the sheet.
      expect(archiveBox!.y).toBeGreaterThan(editBox!.y + editBox!.height - 1);
      expect(Math.abs(archiveBox!.x - editBox!.x)).toBeLessThan(2);
      for (const box of [editBox!, archiveBox!]) {
        expect(box.x).toBeGreaterThanOrEqual(dialogBox!.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height + 1);
      }
    });
  }
});
