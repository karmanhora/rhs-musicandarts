import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installMocks, memberships } from "./support/mocks.mjs";

/**
 * The shared fixtures are pinned to a fixed "now" in the past, so the dashboard
 * has nothing upcoming to draw from them. These two events are relative to the
 * real today: one tomorrow (the focal panel) and one after (the "Coming up"
 * block this test hides). Same columns the screens read.
 */
async function serveUpcomingEvents(page: Page): Promise<void> {
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setHours(15, 30, 0, 0);
  const later = new Date(Date.now() + 4 * 86_400_000);
  later.setHours(19, 0, 0, 0);

  const event = (id: string, name: string, date: Date) => ({
    id,
    ensemble_id: "33333333-3333-4333-8333-333333333333",
    name,
    event_type: "rehearsal",
    date: date.toISOString(),
    end_date: new Date(date.getTime() + 2 * 60 * 60 * 1000).toISOString(),
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
    created_by: null,
    created_at: "2026-09-01T00:00:00.000Z",
  });

  await page.route(/\/rest\/v1\/events(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "content-range": "0-1/2" },
      body: JSON.stringify([
        event("88888888-8888-4888-8888-888888888888", "Marching rehearsal — homecoming set", tomorrow),
        event("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Friday night football vs. Bellevue", later),
      ]),
    })
  );
}

/**
 * Serve the fixture persona as a plain student who has never been asked.
 *
 * Two states have to be arranged, and the shared mock deliberately ships
 * neither: the band membership carries the `director` role there (staff are not
 * asked), and the appearance prompt is stamped as answered. Registered after
 * `installMocks`, so these handlers answer first. The preferences handler is
 * stateful because the RPC is: answering the prompt must still read as answered
 * after a reload.
 */
async function serveUnaskedStudent(page: Page): Promise<void> {
  await page.route("**/rest/v1/memberships?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "content-range": "0-1/2" },
      body: JSON.stringify(memberships.map((m) => ({ ...m, roles: ["member"] }))),
    })
  );

  const state: Record<string, unknown> = {
    ok: true,
    theme: "system",
    background: "paper",
    dashboard_modules: [
      "coming_up",
      "my_attendance",
      "my_programs",
      "program_facts",
      "quick_links",
    ],
    onboarding_completed_at: null,
    personalization_prompt_seen_at: null,
  };

  await page.route(/\/rest\/v1\/rpc\/(my|set_my)_preferences$/, (route) => {
    const fn = new URL(route.request().url()).pathname.split("/").pop();
    if (fn === "set_my_preferences") {
      const patch = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      if (typeof patch.p_theme === "string") state.theme = patch.p_theme;
      if (typeof patch.p_background === "string") state.background = patch.p_background;
      if (Array.isArray(patch.p_dashboard_modules)) {
        state.dashboard_modules = patch.p_dashboard_modules;
      }
      if (patch.p_personalize_seen === true) {
        state.personalization_prompt_seen_at ??= "2026-10-26T00:00:00.000Z";
      }
      if (patch.p_personalize_seen === false) state.personalization_prompt_seen_at = null;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(state),
    });
  });
}

/**
 * Per-person appearance and dashboard choices (migration 20261025120000).
 *
 * These assert what the person actually sees, not that a request was sent:
 *
 *   * a chosen background is on `<html>` at once, and still there after a
 *     reload — the boot script in `index.html` is what makes that second half
 *     true, and it is the half a flash of the default would break;
 *   * hiding a dashboard block removes it, and it stays removed;
 *   * a dark choice paints the page, and signing out forgets it on this device
 *     (the shared-phone case).
 *
 * Every request is answered by `e2e/support/mocks.mjs`; nothing here reaches a
 * real Supabase project.
 */
test.describe("personal appearance and dashboard", () => {
  test.setTimeout(120_000);

  test("a background is applied at once and survives a reload", async ({ page }) => {
    await installMocks(page, true);
    await page.goto("/settings");

    await page.getByRole("tab", { name: "Preferences" }).click();
    await page.getByRole("radio", { name: /Ruled/ }).click();

    // Painted by the choice, before any reload.
    await expect(page.locator("html")).toHaveAttribute("data-background", "ruled");

    // The first frame after a reload reads the cached choice, so this is the
    // assertion that would catch a splash or default page flashing back.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-background", "ruled");

    // …and it is painted *before* the saved preferences come back. The request
    // is held open here, so if React were the painter this would still read
    // "paper" — which is exactly the flash the boot script exists to prevent.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/rest/v1/rpc/my_preferences", async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-background", "ruled");
    release();
  });

  test("each background preview keeps its own treatment when another is chosen", async ({
    page,
  }) => {
    await installMocks(page, true);
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Preferences" }).click();

    const previews = page.locator(
      '[role="radiogroup"][aria-label="Page background"] [role="radio"] [data-background]'
    );
    const EACH_PREVIEW = () =>
      previews.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return {
            treatment: node.getAttribute("data-background"),
            image: style.backgroundImage,
            color: style.backgroundColor,
          };
        })
      );
    const treatment = (all: Awaited<ReturnType<typeof EACH_PREVIEW>>, id: string) =>
      all.find((entry) => entry.treatment === id)!;

    const before = await EACH_PREVIEW();

    // The four previews are four different surfaces: two plain (paper, mint —
    // told apart by colour) and two patterned, ruled and grid being different
    // patterns.
    expect(treatment(before, "paper").image).toBe("none");
    expect(treatment(before, "mint").image).toBe("none");
    expect(treatment(before, "paper").color).not.toBe(treatment(before, "mint").color);
    expect(treatment(before, "ruled").image).not.toBe(treatment(before, "grid").image);

    // Choosing a treatment changes the page and the selected card's indicator —
    // never the content of a preview. Grid is the one that used to bleed a grid
    // onto every card through inherited custom properties.
    for (const [label, id] of [
      ["Grid", "grid"],
      ["Ruled", "ruled"],
      ["Paper", "paper"],
      ["Rehearsal", "mint"],
    ] as const) {
      await page.getByRole("radio", { name: new RegExp(label) }).click();
      await expect(page.locator("html")).toHaveAttribute("data-background", id);
      expect(await EACH_PREVIEW()).toEqual(before);
    }
  });

  test("hiding a dashboard block removes it and keeps it hidden", async ({ page }) => {
    await installMocks(page, true);
    await serveUpcomingEvents(page);
    await page.goto("/");

    // The fixture has one event today and two ahead, so the block is there.
    await expect(page.getByText("Coming up", { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await page.goto("/settings");
    await page.getByRole("tab", { name: "Preferences" }).click();
    const toggle = page.getByRole("switch", { name: "Show Coming up on the dashboard" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.goto("/");
    await expect(page.getByText("Coming up", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("Coming up", { exact: true })).toHaveCount(0);
  });

  test("the guided setup can be finished, and is not offered again", async ({ page }) => {
    await installMocks(page, true);
    await page.goto("/setup");

    await expect(page.getByText(/Step 1 of 4/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Continue" }).click();

    // The join code is the one thing a student needs, so step 2 shows it.
    await expect(page.getByText(/Step 2 of 4/)).toBeVisible();
    await expect(page.getByText("RHSBAND", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByText(/Step 3 of 4/)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByText(/Step 4 of 4/)).toBeVisible();
    await page.getByRole("button", { name: "Finish setup" }).click();

    // Finished: it lands home, and the account sheet stops offering setup.
    const account = page.getByRole("button", { name: /Your account/ });
    await expect(account).toBeVisible({ timeout: 20_000 });
    await account.click();
    await expect(page.getByRole("dialog").getByText("Finish setting up")).toHaveCount(0);
  });

  /* ------------------------------------------------------------------ *
   * The first-run appearance prompt (migration 20261026120000).
   * ------------------------------------------------------------------ */

  test("a student is offered the appearance prompt once, after joining", async ({ page }) => {
    await installMocks(page, true);
    await serveUnaskedStudent(page);
    await page.goto("/");

    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Make it yours")).toBeVisible({ timeout: 20_000 });

    // Both choices take effect while the sheet is open — the change is the
    // preview, so there is nothing to "try out" and nothing to lose.
    await sheet.getByRole("tab", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await sheet.getByRole("radio", { name: /Ruled/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-background", "ruled");

    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Answered means answered: the choices survive, the question does not return.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-background", "ruled");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("skipping the prompt is enough to stop being asked", async ({ page }) => {
    await installMocks(page, true);
    await serveUnaskedStudent(page);
    await page.goto("/");

    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Make it yours")).toBeVisible({ timeout: 20_000 });

    await sheet.getByRole("button", { name: "Skip" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-background", "paper");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("dark is painted, then forgotten on sign-out", async ({ page }) => {
    await installMocks(page, true);
    await page.goto("/settings");

    await page.getByRole("tab", { name: "Preferences" }).click();
    await page.getByRole("tab", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.getByRole("button", { name: /Your account/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Sign out" }).click();

    // The device's own preference (light in this project's config) takes over,
    // and no copy of the last person's appearance is left behind.
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    const cached = await page.evaluate(() => ({
      theme: window.localStorage.getItem("rhs-band:dark"),
      background: window.localStorage.getItem("rhs:appearance:background"),
    }));
    expect(cached).toEqual({ theme: null, background: null });
  });
});
