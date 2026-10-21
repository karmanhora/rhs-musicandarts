/**
 * The capability vocabulary, mirrored from migration 029.
 *
 * The database is the authority: `has_permission()` decides every read and every
 * write, and `my_permissions()` is what this app renders from. Everything in
 * this file is *presentation and gating* — the labels a person sees, and which
 * buttons and tabs appear. Keeping the two in step matters (a control whose
 * action the server refuses is worse than no control), so the codes here are the
 * exact `permissions.code` values the migration seeds.
 *
 * `ROLE_PERMISSION_FALLBACK` exists only to paint the right interface in the
 * instant before `my_permissions()` answers: `usePrograms()` derives the current
 * user's flags from their roles synchronously, then replaces them with the
 * server's answer. It never grants anything on its own.
 */
import type { Role } from "./types";

export type PermissionCode =
  | "profile.view_self"
  | "profile.edit_self"
  | "profile.manage_users"
  | "roster.view_program"
  | "attendance.view_self"
  | "attendance.view_section"
  | "attendance.view_program"
  | "attendance.mark_section"
  | "attendance.mark_present"
  | "attendance.edit_records"
  | "attendance.manage_checkin_sessions"
  | "attendance.manage_events"
  | "attendance.manage_roster"
  | "attendance.view_staff_notes"
  | "attendance.export_reports"
  | "absence.request_self"
  | "absence.review"
  | "events.view_program"
  | "calendar.view_sources"
  | "attendance.view_analytics"
  | "roles.view"
  | "roles.assign"
  | "roles.revoke"
  | "program.manage_settings"
  | "system.manage";

export type PermissionCategory =
  | "profile"
  | "roster"
  | "attendance"
  | "absence"
  | "events"
  | "calendar"
  | "analytics"
  | "roles"
  | "program"
  | "system";

export interface PermissionMeta {
  code: PermissionCode;
  label: string;
  /** One line, written for a director deciding whether to hand it out. */
  description: string;
  category: PermissionCategory;
  /** The narrowest thing it can be granted over. */
  scope: "self" | "section" | "program" | "global";
  /**
   * Whether authorized staff may put it in a *custom* role. Mirrors the
   * database column of the same name (029) — sensitive capabilities are
   * system-role-only.
   */
  delegable: boolean;
}

/** Display order for the grouped capability list. */
export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  "attendance",
  "events",
  "calendar",
  "analytics",
  "roster",
  "roles",
  "program",
  "profile",
  "system",
];

export const PERMISSION_CATEGORY_LABEL: Record<PermissionCategory, string> = {
  profile: "Profile",
  roster: "Roster",
  attendance: "Attendance",
  absence: "Absences",
  events: "Events",
  calendar: "Calendar",
  analytics: "Analytics",
  roles: "Roles & permissions",
  program: "Program settings",
  system: "System",
};

export const PERMISSIONS: PermissionMeta[] = [
  { code: "profile.view_self", label: "View own profile", description: "See your own profile details.", category: "profile", scope: "self", delegable: true },
  { code: "profile.edit_self", label: "Edit own profile", description: "Change your display name, biography and picture.", category: "profile", scope: "self", delegable: true },
  { code: "profile.manage_users", label: "Manage user profiles", description: "Correct another member's profile details.", category: "profile", scope: "program", delegable: false },

  { code: "roster.view_program", label: "View the roster", description: "See the members of this program and their sections.", category: "roster", scope: "program", delegable: true },

  { code: "attendance.view_self", label: "View own attendance", description: "See your own attendance record and percentage.", category: "attendance", scope: "self", delegable: true },
  { code: "attendance.view_section", label: "View section attendance", description: "See attendance for the members of your own section.", category: "attendance", scope: "section", delegable: true },
  { code: "attendance.view_program", label: "View program attendance", description: "See attendance records for the whole program.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.mark_section", label: "Mark own section", description: "Mark attendance for members of your own section only.", category: "attendance", scope: "section", delegable: true },
  { code: "attendance.mark_present", label: "Mark any member", description: "Mark attendance for any member of the program.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.edit_records", label: "Edit attendance records", description: "Correct or excuse an existing attendance record.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.manage_checkin_sessions", label: "Open check-in", description: "Start a QR / code check-in session for an event.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.manage_events", label: "Manage events", description: "Create and edit events for this program.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.manage_roster", label: "Manage the roster", description: "Add, pause and reactivate members; move sections.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.view_staff_notes", label: "Read staff notes", description: "See the private notes staff write on attendance records.", category: "attendance", scope: "program", delegable: true },
  { code: "attendance.export_reports", label: "Export attendance reports", description: "Download this program's attendance as a spreadsheet-ready report.", category: "analytics", scope: "program", delegable: true },

  { code: "absence.request_self", label: "Request an absence", description: "Ask a director to excuse you from an upcoming event.", category: "absence", scope: "self", delegable: true },
  { code: "absence.review", label: "Review absence requests", description: "See, approve and deny students' absence requests for this program.", category: "absence", scope: "program", delegable: true },

  { code: "events.view_program", label: "View program events", description: "See this program's calendar and events.", category: "events", scope: "program", delegable: true },
  { code: "calendar.view_sources", label: "View calendar settings", description: "See connected calendar feeds for this program.", category: "calendar", scope: "program", delegable: true },

  { code: "attendance.view_analytics", label: "View analytics", description: "See program attendance analytics and trends.", category: "analytics", scope: "program", delegable: true },

  { code: "roles.view", label: "View roles & capabilities", description: "See the roles in this program and what they grant.", category: "roles", scope: "program", delegable: true },
  { code: "roles.assign", label: "Assign roles", description: "Grant a role to a member, within their own authority.", category: "roles", scope: "program", delegable: false },
  { code: "roles.revoke", label: "Revoke roles", description: "Remove a role from a member.", category: "roles", scope: "program", delegable: false },

  { code: "program.manage_settings", label: "Manage program settings", description: "Join code, archiving, and other program-wide settings.", category: "program", scope: "program", delegable: false },
  { code: "system.manage", label: "System administration", description: "Cross-program administration. Reserved for explicit system administrators.", category: "system", scope: "global", delegable: false },
];

const BY_CODE = new Map<string, PermissionMeta>(PERMISSIONS.map((p) => [p.code, p]));

/** Label for any code, including one this build does not know about yet. */
export function permissionLabel(code: string): string {
  return BY_CODE.get(code)?.label ?? code;
}

export function permissionMeta(code: string): PermissionMeta | undefined {
  return BY_CODE.get(code);
}

/** Only these may be put into a custom role — the database enforces this too. */
export const DELEGABLE_PERMISSIONS: PermissionMeta[] = PERMISSIONS.filter((p) => p.delegable);

/**
 * Capabilities each system role grants, mirroring the `role_permissions` seed.
 * Used to paint the interface before the server's answer arrives, and to explain
 * a role in the UI. `system_admin` is the `program_admins` table, not a
 * `memberships.roles` value, so it is not part of the `Role` union.
 */
export const ROLE_PERMISSION_FALLBACK: Record<Role, PermissionCode[]> = {
  student: [
    "profile.view_self",
    "profile.edit_self",
    "events.view_program",
    "roster.view_program",
    "attendance.view_self",
    "absence.request_self",
  ],
  section_leader: [
    "profile.view_self",
    "profile.edit_self",
    "events.view_program",
    "roster.view_program",
    "attendance.view_self",
    "attendance.view_section",
    "attendance.mark_section",
    "attendance.view_staff_notes",
    "attendance.manage_checkin_sessions",
    "absence.request_self",
  ],
  secretary: [
    "profile.view_self",
    "profile.edit_self",
    "events.view_program",
    "roster.view_program",
    "attendance.view_self",
    "attendance.view_program",
    "attendance.mark_present",
    "attendance.edit_records",
    "attendance.view_staff_notes",
    "attendance.manage_checkin_sessions",
    "attendance.manage_events",
    "calendar.view_sources",
    "absence.request_self",
  ],
  director: [
    "profile.view_self",
    "profile.edit_self",
    "profile.manage_users",
    "events.view_program",
    "roster.view_program",
    "attendance.view_self",
    "attendance.view_program",
    "attendance.mark_present",
    "attendance.edit_records",
    "attendance.view_staff_notes",
    "attendance.manage_checkin_sessions",
    "attendance.manage_events",
    "attendance.manage_roster",
    "calendar.view_sources",
    "attendance.view_analytics",
    "roles.view",
    "roles.assign",
    "roles.revoke",
    "program.manage_settings",
    "absence.request_self",
    "absence.review",
    "attendance.export_reports",
  ],
};

/** The union of every role a person holds — the client-side mirror of the SQL. */
export function permissionsForRoles(roles: Role[]): PermissionCode[] {
  const out = new Set<PermissionCode>();
  for (const role of roles) for (const code of ROLE_PERMISSION_FALLBACK[role] ?? []) out.add(code);
  return [...out];
}
