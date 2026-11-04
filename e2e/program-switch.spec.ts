import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installMocks, PROGRAM_ID, SUPABASE_HOST } from "./support/mocks.mjs";

/**
 * Switching to a program the administrator is not on.
 *
 * The shared fixture persona is a director of the band and a member of the
 * orchestra, and `is_program_admin` is false. This spec answers that one RPC
 * with `true` (registered after `installMocks`, so it runs before the shared
 * handler) and serves a third program — the one nobody on the roster belongs to.
 *
 * The defect this guards: `usePrograms()` resolved the requested program with
 * `memberships.find(…) ?? memberships[0]`, so a program with no roster row fell
 * back to the person's first program *before* the administrator branch was
 * consulted. The switcher closed, the check mark stayed on the band, and the
 * dashboard never changed — the screenshot the owner sent.
 */

const MEAN_GIRLS_ID = "abababab-1111-4111-8111-abababababab";

const band = {
  id: PROGRAM_ID,
  slug: "band",
  name: "RHS Mustang Band",
  short_name: "Band",
  theme_color: "#17402b",
  logo_url: null,
  active: true,
  created_at: "2026-08-01T00:00:00.000Z",
};

const meanGirlsPit = {
  id: MEAN_GIRLS_ID,
  slug: "mean-girls-pit",
  name: "Mean Girls Pit",
  short_name: "Mean Girls Pit",
  theme_color: "#4a2f52",
  logo_url: null,
  active: true,
  created_at: "2026-10-20T00:00:00.000Z",
};

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

/** The caller is a system administrator, and these are every active program. */
async function serveAdministrator(page: Page): Promise<void> {
  await page.route(`${SUPABASE_HOST}/rest/v1/rpc/is_program_admin`, (route) => json(route, true));
  await page.route(/\/rest\/v1\/ensembles\?/, (route) => json(route, [band, meanGirlsPit]));
}

test("a system administrator switches to a program they are not on", async ({ page }) => {
  await installMocks(page, true);
  await serveAdministrator(page);

  await page.goto("/");

  const switcher = page.getByRole("button", { name: /^Switch program/ });
  await expect(switcher).toHaveAccessibleName(/currently RHS Mustang Band/);

  await switcher.click();

  // The off-roster program is listed, and its row says why it is reachable —
  // administrator access, not a membership role it does not have.
  await expect(page.getByText("Mean Girls Pit", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/System administrator — not on this roster/)
  ).toBeVisible();

  await page.getByRole("button", { name: /Mean Girls Pit/ }).click();

  // The regression: this used to stay on the band. The current program must be
  // the one that was clicked, even though there is no membership row for it.
  await expect(page.getByRole("button", { name: /^Switch program/ })).toHaveAccessibleName(
    /currently Mean Girls Pit/
  );

  // …and the program's own capabilities, not a student's view: the dashboard
  // offers the staff actions because `has_permission()` answers for an
  // administrator in every program — while naming the access as administrator
  // access rather than claiming a staff place on a roster they are not on.
  await expect(page.getByText(/as a system administrator/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Take attendance" })).toBeVisible();

  // Switching back is the ordinary roster path and must keep working.
  await page.getByRole("button", { name: /^Switch program/ }).click();
  await page.getByRole("button", { name: /RHS Mustang Band/ }).click();
  await expect(page.getByRole("button", { name: /^Switch program/ })).toHaveAccessibleName(
    /currently RHS Mustang Band/
  );
});
