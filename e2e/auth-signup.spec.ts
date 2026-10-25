import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installMocks, profile, USER_ID } from "./support/mocks.mjs";

/**
 * Signing up must not produce an error the person reads as their own mistake.
 *
 * Two of these cover errors that were reproduced on the live site:
 *
 *   * "Confirm with code" with an empty Email field answered with the raw
 *     GoTrue sentence "Only an email address or phone number should be provided
 *     on verify", in a red alert.
 *   * A code from an email whose link had already been opened (the same one-time
 *     token) answered "That code is wrong or has expired", though the address
 *     was confirmed by the link and a password sign-in works immediately.
 *
 * Every request is answered by `e2e/support/mocks.mjs` plus the routes below;
 * nothing here reaches a real Supabase project.
 */

/** The session body `POST /auth/v1/token?grant_type=password` answers with. */
function sessionBody() {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: "qa-fixture-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "qa-fixture-refresh-token",
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: profile.email,
      email_confirmed_at: "2026-09-01T00:00:00.000Z",
      phone: "",
      confirmed_at: "2026-09-01T00:00:00.000Z",
      last_sign_in_at: "2026-10-12T00:00:00.000Z",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-10-12T00:00:00.000Z",
      is_anonymous: false,
    },
  };
}

function json(route: Parameters<Parameters<Page["route"]>[1]>[0], body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });
}

/** A confirmation link that has already been spent, as the app receives it. */
const SPENT_LINK =
  "/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

test.describe("signing up and confirming", () => {
  test.setTimeout(120_000);

  test("signing up with an existing address offers sign-in instead of an error", async ({
    page,
  }) => {
    await installMocks(page, false);
    // Supabase's anti-enumeration answer: no error, no session, no identities.
    await page.route("**/auth/v1/signup*", (route) =>
      json(route, { id: USER_ID, email: profile.email, identities: [] })
    );
    await page.goto("/sign-up");

    await page.getByRole("textbox", { name: "Email", exact: true }).fill(profile.email);
    await page.getByLabel("New password").fill("correct-horse-battery");
    await page.getByLabel("Confirm password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create account" }).click();

    // Guidance, not a failure: no red alert at all.
    await expect(page.getByText(/already has an account/i).first()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/Check your email/i)).toHaveCount(0);

    // And the door it names carries the address over.
    await page.getByRole("button", { name: "Go to sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in\?email=/);
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue(
      profile.email
    );
  });

  test("the code asks for the email address instead of surfacing an API sentence", async ({
    page,
  }) => {
    await installMocks(page, false);
    let verifyCalls = 0;
    await page.route("**/auth/v1/verify*", (route) => {
      verifyCalls += 1;
      return json(route, { msg: "Email link is invalid or has expired" }, 403);
    });

    await page.goto(SPENT_LINK);
    await expect(page).toHaveURL(/\/sign-in$/);

    await page
      .getByRole("textbox", { name: "Confirmation code", exact: true })
      .fill("12345678");
    await page.getByRole("button", { name: "Confirm with code" }).click();

    await expect(page.getByText(/Enter the email address you signed up with/i)).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(verifyCalls).toBe(0);
  });

  test("a spent code signs the person in with the password they just typed", async ({ page }) => {
    await installMocks(page, false);
    await page.route("**/auth/v1/verify*", (route) =>
      json(route, { code: 403, error_code: "otp_expired", msg: "Email link is invalid or has expired" }, 403)
    );
    await page.route("**/auth/v1/token?grant_type=password", (route) => json(route, sessionBody()));

    await page.goto(SPENT_LINK);
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.getByRole("textbox", { name: "Email", exact: true }).fill(profile.email);
    await page.getByLabel("Password").fill("correct-horse-battery");
    await page
      .getByRole("textbox", { name: "Confirmation code", exact: true })
      .fill("12345678");
    await page.getByRole("button", { name: "Confirm with code" }).click();

    // Signed in, on the app, with nothing red on the way.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: /Your account/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a spent code with no password explains itself and offers sign-in", async ({ page }) => {
    await installMocks(page, false);
    await page.route("**/auth/v1/verify*", (route) =>
      json(route, { code: 403, error_code: "otp_expired", msg: "Email link is invalid or has expired" }, 403)
    );

    await page.goto(SPENT_LINK);
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(profile.email);
    await page
      .getByRole("textbox", { name: "Confirmation code", exact: true })
      .fill("12345678");
    await page.getByRole("button", { name: "Confirm with code" }).click();

    await expect(page.getByText(/already been used/i).last()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The email stays typed, so signing in is the only step left.
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue(
      profile.email
    );
  });

  test("the waiting-for-email panel can hand the address to the sign-in screen", async ({
    page,
  }) => {
    await installMocks(page, false);
    await page.route("**/auth/v1/signup*", (route) =>
      json(route, { id: USER_ID, email: profile.email, identities: [{ id: "identity-1" }] })
    );
    await page.goto("/sign-up");

    await page.getByRole("textbox", { name: "Email", exact: true }).fill(profile.email);
    await page.getByLabel("New password").fill("correct-horse-battery");
    await page.getByLabel("Confirm password").fill("correct-horse-battery");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText(/Check your email/i)).toBeVisible();
    await page.getByRole("button", { name: "Sign in instead" }).click();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue(
      profile.email
    );
  });
});
