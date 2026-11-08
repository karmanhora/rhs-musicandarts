import { expect, test } from "@playwright/test";
import { installMocks, SUPABASE_HOST } from "./support/mocks.mjs";
import { OVERFLOW_PROBE } from "./support/probes.mjs";

/**
 * The feedback form and the owner's private inbox.
 *
 * These run against the shared fixture persona (a signed-in director) and the
 * route mocks in `support/mocks.mjs`; the real permissions are proven in
 * `supabase/tests/feedback.sql`. What is checked here is what a browser can only
 * prove: required-field copy, the refusal for a malformed optional address, the
 * success panel, the owner route being closed to a member, and the inbox's
 * filters and status actions rendering from real row shapes.
 */
const ROWS = [
  {
    id: "aaaa1111-1111-4111-8111-111111111111",
    category: "bug",
    message: "The check-in button does nothing after I scan the code.",
    affected_feature: "Check in",
    contact_email: "student@example.org",
    submitted_by: null,
    status: "new",
    created_at: "2026-11-08T10:00:00.000Z",
    updated_at: "2026-11-08T10:00:00.000Z",
  },
  {
    id: "bbbb2222-2222-4222-8222-222222222222",
    category: "feature",
    message: "It would help to see next week at a glance on the home screen.",
    affected_feature: "Home",
    contact_email: null,
    submitted_by: null,
    status: "resolved",
    created_at: "2026-11-07T09:00:00.000Z",
    updated_at: "2026-11-08T09:00:00.000Z",
  },
];

/** Register the owner answers: status true, management calls accepted, rows served. */
async function mockOwnerInbox(page: Parameters<typeof installMocks>[0]): Promise<void> {
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/feedback_owner_status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, owner: true, signed_in: true }),
    })
  );
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/set_feedback_status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, status: "reviewing", message: "Feedback marked as reviewing." }),
    })
  );
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/delete_feedback`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, message: "Feedback deleted." }),
    })
  );
  await page.route(/\/rest\/v1\/feedback_submissions(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(ROWS),
    })
  );
}

test.describe("feedback", () => {
  test.setTimeout(180_000);

  test("a member can send feedback and is told what is required", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/feedback");

    await expect(
      page.getByRole("heading", { level: 1, name: "Tell us what you think" })
    ).toBeVisible({ timeout: 60_000 });

    // Nothing is sent with an empty form: both required fields answer.
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByText("Choose the kind of feedback this is.")).toBeVisible();
    await expect(
      page.getByText("Tell us what happened, or what you would like to see.")
    ).toBeVisible();

    await page.getByRole("button", { name: /Bug Report/ }).click();
    await page
      .getByLabel("What would you like us to know?")
      .fill("The roster page shows a blank section on my phone.");
    await page.getByLabel("Contact email (optional)").fill("not-an-email");
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByText(/doesn't look like an email address/i)).toBeVisible();

    // The address is optional: clearing it sends, and the form is replaced by
    // the confirmation rather than left half-filled.
    await page.getByLabel("Contact email (optional)").fill("");
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByText(/ve got it/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send more feedback" })).toBeVisible();
  });

  test("the inbox route is closed to a member who is not the owner", async ({ page }) => {
    await installMocks(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/feedback/inbox");

    // The shared fixture is not the owner, so the gate sends them home and the
    // inbox never renders — matching the empty list the database would return.
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Feedback inbox" })).toHaveCount(0);
  });

  test("the owner can read, filter, move statuses and delete", async ({ page }) => {
    await installMocks(page, true);
    await mockOwnerInbox(page);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/feedback/inbox");
    await expect(
      page.getByRole("heading", { level: 1, name: "Feedback inbox" })
    ).toBeVisible({ timeout: 60_000 });

    // Summary figures come from the rows, not a second endpoint.
    await expect(page.getByText("Total")).toBeVisible();
    await expect(page.getByText("2").first()).toBeVisible();

    // Status filter hides the resolved row.
    await page.getByRole("tab", { name: "New", exact: true }).click();
    await expect(page.getByText(/check-in button does nothing/)).toBeVisible();
    await expect(page.getByText(/next week at a glance/)).toHaveCount(0);

    // Open the submission and move it through the queue.
    await page.getByRole("button", { name: /Bug Report/ }).click();
    const detail = page.getByRole("dialog", { name: "Bug Report" });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("student@example.org")).toBeVisible();
    await detail.getByRole("button", { name: "Start reviewing" }).click();
    await expect(detail.getByText("Reviewing")).toBeVisible();

    await detail.getByRole("button", { name: "Mark resolved" }).click();
    await expect(detail.getByText("Resolved")).toBeVisible();

    // Deleting asks first, then removes the row.
    await detail.getByRole("button", { name: "Delete this submission" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete this feedback?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText(/check-in button does nothing/)).toHaveCount(0);
  });

  test("neither screen overflows at phone, tablet or desktop width", async ({ page }) => {
    await installMocks(page, true);
    await mockOwnerInbox(page);

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/feedback", "/feedback/inbox"]) {
        await page.goto(path);
        await page.waitForTimeout(1800);
        const result = (await page.evaluate(OVERFLOW_PROBE)) as {
          overflowBy: number;
          offenders: { selector: string; right: number; width: number }[];
        };
        expect(
          result.offenders,
          `${path} at ${width}px: ${JSON.stringify(result.offenders, null, 2)}`
        ).toEqual([]);
        expect(result.overflowBy, `${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
  });
});
