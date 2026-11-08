import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installMocks, SUPABASE_HOST } from "./support/mocks.mjs";

/**
 * Which door a signed-in account with no roster lands on.
 *
 * Two code flows live side by side in this app and mean different things: a
 * *program join code* puts somebody on a director's roster, and a *teacher
 * invitation code* verifies teacher access. A teacher who had chosen "teacher"
 * at sign-up used to land on the student join screen and meet the join-code box
 * first — the screenshot the owner sent — so the two codes could be typed into
 * the wrong field. Now the teacher landing page is the invitation form and
 * nothing else, while a student still lands on the join form.
 *
 * The fixture persona declared teacher at sign-up (`get_signup_account_type`
 * answers "teacher") and holds no redeemed invitation, so serving no
 * memberships puts it in exactly that state.
 */

function json(route: { fulfill: (r: object) => Promise<unknown> }, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range",
      "content-range": Array.isArray(body) ? `0-${body.length - 1}/${body.length}` : "0-0/1",
    },
    body: JSON.stringify(body),
  });
}

/** Signed in, but on no roster yet. */
async function serveNoRoster(page: Page): Promise<void> {
  await page.route(/\/rest\/v1\/memberships\?/, (route) => json(route, []));
}

/** The same persona, but the invitation code has already been redeemed. */
async function serveVerifiedTeacher(page: Page): Promise<void> {
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/teacher_access_status`, (route) =>
    json(route, { ok: true, verified: true, pending: false, admin: false })
  );
}

test("a teacher with no roster sees only the invitation form", async ({ page }) => {
  await installMocks(page, true);
  await serveNoRoster(page);

  await page.goto("/");

  await expect(page.getByText("Teacher / director registration", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Invitation code" })).toBeVisible();

  // The student door is not part of teacher onboarding: no join-code field, no
  // "join a program" heading, none of the director's-code copy.
  await expect(page.getByRole("textbox", { name: "Join code" })).toHaveCount(0);
  await expect(page.getByText("Join a program", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Type the code your director gave you/)).toHaveCount(0);
});

test("a teacher who opens /join with no roster is sent to the invitation form", async ({
  page,
}) => {
  await installMocks(page, true);
  await serveNoRoster(page);

  await page.goto("/join");

  // The student join code is not part of teacher onboarding, not even by URL:
  // the two codes must never be on the same screen, where one gets typed into
  // the other's field.
  await expect(page).toHaveURL(/\/teacher$/);
  await expect(page.getByRole("textbox", { name: "Invitation code" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Join code" })).toHaveCount(0);
});

test("a verified teacher with no roster lands on starting a program, not joining one", async ({
  page,
}) => {
  await installMocks(page, true);
  await serveNoRoster(page);
  await serveVerifiedTeacher(page);

  await page.goto("/");

  // A redeemed invitation is the teacher's whole onboarding: the next thing to
  // do is name their program. The student join form must not reappear.
  await expect(page).toHaveURL(/\/new-program$/);
  await expect(page.getByText("Start your own program", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Program name" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Join code" })).toHaveCount(0);
  await expect(page.getByText("Join a program", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Join a program with a code instead")).toHaveCount(0);
});

test("a verified teacher who opens /join is sent to start a program", async ({ page }) => {
  await installMocks(page, true);
  await serveNoRoster(page);
  await serveVerifiedTeacher(page);

  await page.goto("/join");

  await expect(page).toHaveURL(/\/new-program$/);
  await expect(page.getByRole("textbox", { name: "Program name" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Join code" })).toHaveCount(0);
});

test("a student with no roster still lands on the join form", async ({ page }) => {
  await installMocks(page, true);
  await serveNoRoster(page);
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/get_signup_account_type`, (route) =>
    json(route, "student")
  );

  await page.goto("/");

  await expect(page.getByText("Join a program", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Join code" })).toBeVisible();

  // …and the teacher form is not the default for a student.
  await expect(page.getByRole("textbox", { name: "Invitation code" })).toHaveCount(0);
});
