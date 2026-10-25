import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installMocks, PROGRAM_ID, SUPABASE_HOST } from "./support/mocks.mjs";

/**
 * `/invitations` — the system administrator's staff-invitation desk.
 *
 * The shared fixture persona is *not* an administrator (`is_program_admin` is
 * false, and has no `system.manage`), so the route gate would bounce this screen
 * home. This spec answers that one RPC first — registered after `installMocks`,
 * so this handler runs before the shared one — and keeps its own invitation list
 * so issuing and cancelling are visible across a reload exactly like the real
 * RPCs would make them.
 *
 * What is asserted is the behaviour the feature exists for: a code is shown
 * once, a used code shows who used it, and a cancelled one stops being usable.
 */

interface Invitation {
  id: string;
  label: string;
  intended_email: string | null;
  expires_at: string | null;
  redeemed_at: string | null;
  redeemed_email: string | null;
  redeemed_by_name: string | null;
  revoked_at: string | null;
  created_at: string;
  program_id: string | null;
  program_name: string | null;
  role_name: string | null;
  role_key: string | null;
  role_is_system: boolean | null;
  status: "available" | "redeemed" | "expired" | "revoked";
}

const ROLES = [
  {
    id: "role-director",
    key: "director",
    name: "Director",
    description: "Runs the program.",
    scope: "program",
    is_system: true,
    active: true,
    permissions: ["roles.assign"],
    holder_count: 1,
  },
  {
    id: "role-secretary",
    key: "secretary",
    name: "Secretary",
    description: "Runs day-to-day attendance.",
    scope: "program",
    is_system: true,
    active: true,
    permissions: ["attendance.mark_present"],
    holder_count: 0,
  },
];

async function serveInvitations(page: Page): Promise<Invitation[]> {
  const rows: Invitation[] = [
    {
      id: "inv-available",
      label: "Dana — new director",
      intended_email: "dana@example.org",
      expires_at: "2026-11-08T12:00:00.000Z",
      redeemed_at: null,
      redeemed_email: null,
      redeemed_by_name: null,
      revoked_at: null,
      created_at: "2026-10-24T12:00:00.000Z",
      program_id: PROGRAM_ID,
      program_name: "RHS Mustang Band",
      role_name: "Director",
      role_key: "director",
      role_is_system: true,
      status: "available",
    },
    {
      id: "inv-used",
      label: "Sam — assistant",
      intended_email: null,
      expires_at: null,
      redeemed_at: "2026-10-23T18:20:00.000Z",
      redeemed_email: "sam.okafor@example.org",
      redeemed_by_name: "Sam Okafor",
      revoked_at: null,
      created_at: "2026-10-20T12:00:00.000Z",
      program_id: PROGRAM_ID,
      program_name: "RHS Mustang Band",
      role_name: "Secretary",
      role_key: "secretary",
      role_is_system: true,
      status: "redeemed",
    },
  ];

  await page.route(`${SUPABASE_HOST}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/rest/v1/rpc/")) return route.fallback();

    const fn = url.pathname.slice("/rest/v1/rpc/".length);
    // A caller with no arguments sends no body; asking for JSON then throws and
    // would leave that request (and the screen behind it) hanging forever.
    let post: Record<string, unknown> = {};
    try {
      post = (route.request().postDataJSON() as Record<string, unknown>) ?? {};
    } catch {
      post = {};
    }
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });

    // The one fact that opens the screen. Everything else the shared mocks
    // already answer plausibly, and the client paints its full capability set
    // from an administrator's answer.
    if (fn === "is_program_admin") return json(true);

    // Every capability, including `system.manage`, exactly as `has_permission()`
    // answers for a system administrator. Without this the client's route gate
    // would keep the shared fixture's director list and bounce the screen home.
    if (fn === "my_permissions") {
      return json({
        ok: true,
        permissions: [
          "profile.view_self",
          "profile.edit_self",
          "profile.manage_users",
          "roster.view_program",
          "attendance.view_self",
          "attendance.view_section",
          "attendance.view_program",
          "attendance.mark_section",
          "attendance.mark_present",
          "attendance.edit_records",
          "attendance.manage_checkin_sessions",
          "attendance.manage_events",
          "attendance.manage_roster",
          "attendance.view_staff_notes",
          "attendance.export_reports",
          "absence.request_self",
          "absence.review",
          "events.view_program",
          "calendar.view_sources",
          "attendance.view_analytics",
          "roles.view",
          "roles.assign",
          "roles.revoke",
          "program.manage_settings",
          "system.manage",
        ],
      });
    }

    if (fn === "list_program_roles") return json({ ok: true, roles: ROLES });

    if (fn === "list_teacher_invitations") return json({ ok: true, invitations: rows });

    if (fn === "configure_teacher_invitation") {
      const role = ROLES.find((entry) => entry.id === post.p_role_id) ?? null;
      rows.unshift({
        id: `inv-${rows.length + 1}`,
        label: post.p_label || "Untitled invitation",
        intended_email: post.p_intended_email ?? null,
        expires_at: post.p_expires_at ?? null,
        redeemed_at: null,
        redeemed_email: null,
        redeemed_by_name: null,
        revoked_at: null,
        created_at: new Date().toISOString(),
        program_id: post.p_ensemble_id ?? null,
        program_name: post.p_ensemble_id ? "RHS Mustang Band" : null,
        role_name: role?.name ?? null,
        role_key: role?.key ?? null,
        role_is_system: role?.is_system ?? null,
        status: "available",
      });
      return json({ ok: true, invitation_id: `inv-${rows.length + 1}` });
    }

    if (fn === "revoke_teacher_invitation") {
      const row = rows.find((entry) => entry.id === post.p_invitation_id);
      if (row) {
        row.revoked_at = new Date().toISOString();
        row.status = "revoked";
      }
      return json({ ok: true, message: "Revoked — that code can no longer be redeemed." });
    }

    return route.fallback();
  });

  return rows;
}

test("lists ready and used codes, and names who used one", async ({ page }) => {
  await installMocks(page, true);
  await serveInvitations(page);

  await page.goto("/invitations");

  await expect(page.getByRole("heading", { name: "Invitation codes" })).toBeVisible();

  // Ready: the label, the roster it grants, and what it is bound to.
  await expect(page.getByText("Dana — new director")).toBeVisible();
  await expect(page.getByText("Bound to dana@example.org")).toBeVisible();

  // Used: the person who redeemed it, by name and address.
  await expect(page.getByText(/Sam Okafor/)).toBeVisible();
  await expect(page.getByText(/sam\.okafor@example\.org/)).toBeVisible();
  // The section itself, not the badge of the same name.
  await expect(page.getByRole("heading", { name: "Used", level: 2 })).toBeVisible();
});

test("shows a new code once, then never again", async ({ page }) => {
  await installMocks(page, true);
  await serveInvitations(page);

  await page.goto("/invitations");
  await page.getByRole("button", { name: "New invitation" }).first().click();

  const dialog = page.getByRole("dialog", { name: "New invitation" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Who is it for?").fill("Test invitee");
  await dialog.getByLabel("Program").selectOption(PROGRAM_ID);
  await expect(dialog.getByLabel("Role on that roster")).toBeEnabled();
  await dialog.getByLabel("Role on that roster").selectOption("role-director");

  const code = await dialog.getByLabel("Invitation code").inputValue();
  expect(code).toMatch(/^RHS-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await dialog.getByRole("button", { name: "Create code" }).click();

  // The one moment the plaintext exists.
  const issued = page.getByRole("dialog", { name: "Write this code down" });
  await expect(issued).toBeVisible();
  await expect(issued.getByText(code)).toBeVisible();

  await issued.getByRole("button", { name: "Done" }).click();

  // It is on the list now, and the code itself is nowhere on the page.
  await expect(page.getByText("Test invitee")).toBeVisible();
  await expect(page.getByText(code)).toHaveCount(0);
});

test("cancelling a code takes it out of the ready list", async ({ page }) => {
  await installMocks(page, true);
  const rows = await serveInvitations(page);
  expect(rows).toHaveLength(2);

  await page.goto("/invitations");

  await page.getByRole("button", { name: "Cancel Dana — new director" }).click();

  const confirm = page.getByRole("dialog", { name: "Cancel this invitation?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel invitation" }).click();

  // It leaves the ready list (the only code was the one just cancelled) and is
  // kept, marked cancelled, under the record.
  await expect(page.getByText("No codes waiting")).toBeVisible();
  await expect(page.getByText("Dana — new director")).toBeVisible();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
});
