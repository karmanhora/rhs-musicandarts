/**
 * Row + RPC types for the multi-program schema.
 *
 * `profiles` is pure person-level identity: roles and section live on
 * `memberships` (per program), which is why nothing here has `roles` on the
 * profile. The database calls a program an `ensemble`; the interface never does
 * — it says **program** (see docs/PLATFORM_PLAN.md §2.4 U14).
 */

export type Role = "student" | "section_leader" | "secretary" | "director";

/** Flexible event type — any text from the database, labelled via EVENT_TYPE_LABEL. */
export type EventType = string;

/** How attendance is collected: QR scan, staff toggles, both, or none. */
export type CheckinMode = "qr" | "toggle" | "both" | "none";

/** Whether the event expects students to check in. */
export type AttendanceRequirement = "required" | "optional" | "none";

/** Where an event came from — the app or the Google Calendar sync. */
export type EventSource = "manual" | "google_calendar";

export type AttendanceStatus = "present" | "absent" | "excused" | "late";

export interface Profile {
  id: string;
  /** Supabase Auth user id (`auth.uid()`) — how this person is found on sign-in. */
  auth_user_id: string | null;
  /** Legacy Clerk id, kept for audit only. Nothing reads it any more (021). */
  clerk_id: string | null;
  full_name: string;
  display_name: string;
  /** External URL, kept for legacy rows. An uploaded picture lives in avatar_path. */
  avatar_url: string;
  /** Object path in the private `avatars` bucket (030); empty when none. */
  avatar_path: string;
  /** Optional short biography, capped at 500 characters. */
  bio: string;
  must_change_password: boolean;
  deactivated: boolean;
  created_at: string;
}

/**
 * One row of `list_program_roles()` (029). System roles carry a `key` matching
 * an `app_role` label; custom roles carry null and belong to one program.
 */
export interface RoleDefinition {
  id: string;
  key: Role | "system_admin" | null;
  name: string;
  description: string;
  /** Where the role's grants may reach. */
  scope: "program" | "section";
  is_system: boolean;
  active: boolean;
  /** Capability codes the role grants (see `lib/permissions.ts`). */
  permissions: string[];
  /** How many people currently hold it — what a change would affect. */
  holder_count: number;
}

/**
 * One row of `user_role_assignments` (029) — an extra role grant beyond
 * `memberships.roles` (custom roles, scoped grants). Revoked rows are kept for
 * the audit trail, so the UI filters on `revoked_at`.
 */
export interface RoleAssignmentRow {
  id: string;
  user_id: string;
  ensemble_id: string;
  role_id: string;
  section_id: string | null;
  granted_at: string;
  revoked_at: string | null;
}

/** One row of `list_role_audit()` (029). */
export interface RoleAuditEntry {
  id: number;
  action: "role.assign" | "role.revoke" | "role.create" | "role.update" | "role.delete" | string;
  created_at: string;
  actor_name: string;
  target_name: string | null;
  detail: {
    role?: string;
    system_role?: boolean;
    holders?: number;
    permissions?: string[];
  } | null;
}

export interface EnsembleRow {
  id: string;
  slug: string;
  name: string;
  short_name: string;
  theme_color: string;
  logo_url: string;
  active: boolean;
  created_at: string;
}

export interface SectionRow {
  id: string;
  ensemble_id: string;
  name: string;
  sort_order: number;
}

export interface MembershipRow {
  id: string;
  user_id: string;
  ensemble_id: string;
  section_id: string | null;
  roles: Role[];
  active: boolean;
  joined_at: string;
  /**
   * Whether this person receives the scheduled upcoming-events email digest for
   * this program (migration 032). Opt-out: true unless they turned it off, and
   * turned off per program — a student in band and orchestra can quiet one.
   */
  email_upcoming_events: boolean;
}

export interface EventRow {
  id: string;
  ensemble_id: string;
  name: string;
  type: EventType;
  event_type: string;
  date: string;
  end_date: string | null;
  all_day: boolean;
  location: string;
  description: string;
  google_calendar_uid: string | null;
  google_calendar_updated_at: string | null;
  google_calendar_synced_at: string | null;
  checkin_mode: CheckinMode;
  attendance_requirement: AttendanceRequirement;
  event_source: EventSource;
  archived: boolean;
  late_minutes: number;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  created_by: string | null;
  created_at: string;
}

/**
 * One confirmed-absent recipient of a make-up email (migration 036). The
 * composer receives names and statuses only — the server holds the addresses
 * and resolves them when it sends.
 */
export interface MakeupEmailRecipient {
  user_id: string;
  name: string;
  section: string;
  status: "absent";
}

/** An active student with no attendance row — shown for review, never mailed. */
export interface MakeupEmailUnmarked {
  user_id: string;
  name: string;
  section: string;
}

/**
 * `makeup_email_context()` (036): whether the event may be mailed about now,
 * why not when it may not, and the two recipient groups. Staff-only; no
 * addresses are returned.
 */
export interface MakeupEmailContext {
  ok: boolean;
  message?: string;
  can_send?: boolean;
  reason?: string | null;
  event?: {
    id: string;
    name: string;
    date: string;
    end_date: string | null;
    all_day: boolean;
    location: string;
    archived: boolean;
  };
  program_name?: string;
  teacher_name?: string;
  recipients?: MakeupEmailRecipient[];
  unmarked?: MakeupEmailUnmarked[];
}

/** One Resend result returned by the `send-makeup-emails` function. */
export interface MakeupEmailSendResult {
  user_id: string;
  name: string;
  status: "accepted" | "failed";
  error?: string;
}

/** The sending function's answer for one chunk of recipients. */
export interface MakeupEmailSendResponse {
  ok: boolean;
  message?: string;
  campaign_id?: string;
  accepted?: number;
  failed?: number;
  results?: MakeupEmailSendResult[];
}

export interface CheckinSessionRow {
  id: string;
  event_id: string;
  token: string;
  entry_code: string;
  created_by: string;
  expires_at: string;
  created_at: string;
}

export interface AttendanceRow {
  id: string;
  event_id: string;
  student_id: string;
  attended: boolean;
  checked_in_at: string | null;
  status: AttendanceStatus;
  excuse_reason: string;
  is_late: boolean;
  marked_by: string | null;
}

export interface AttendanceStaffNoteRow {
  attendance_record_id: string;
  staff_note: string;
  created_by: string | null;
  updated_at: string;
}

export interface PersonalEventRow {
  id: string;
  owner_id: string;
  name: string;
  date: string;
  location: string;
  created_at: string;
}

export type NotificationType = "new_event" | "checkin_open" | "chat_message";

/**
 * The caller's own teacher-credential state (migration 035), as the screens read
 * it. `verified` is the server's answer to `has_teacher_access()`; `pending`
 * means they said they were a teacher at sign-up and have not redeemed a code
 * yet. Nothing here carries a code or a digest — there is no API that returns
 * one.
 */
export interface TeacherAccessStatus {
  verified: boolean;
  pending: boolean;
  admin: boolean;
  /** Set only when the status could not be read; `verified` is then false. */
  error: string | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: { event_id?: string; event_name?: string } | null;
  read: boolean;
  created_at: string;
}

/**
 * Shape returned by every security-definer RPC. One optional bag is simpler than
 * a union per function, and the RPCs themselves always answer `{ ok, message }`
 * on failure.
 */
export interface RpcResult {
  ok: boolean;
  message?: string;
  token?: string;
  entry_code?: string;
  expires_at?: string;
  event_id?: string;
  event_name?: string;
  checked_in_at?: string | null;
  is_late?: boolean;
  enabled?: boolean;
  code?: string;
  percentage?: number;
  present?: number;
  late?: number;
  excused?: number;
  absent?: number;
  total?: number;
  /** Sync only: set when a suspicious feed was refused instead of archived. */
  warning?: string | null;
  /** `my_permissions()`: the caller's effective capability codes in one program. */
  permissions?: string[];
  /** `list_program_roles()`: every role available in the program. */
  roles?: RoleDefinition[];
  /** `list_role_audit()`: recent role/permission changes, newest first. */
  entries?: RoleAuditEntry[];
  /** `create_custom_role()` / `update_custom_role()`: the role that was written. */
  role_id?: string;
  /** `update_custom_role()`: capability widening needs an explicit acknowledgement. */
  needs_confirmation?: boolean;
  /** `update_custom_role()` / `delete_custom_role()`: how many people hold the role. */
  holders?: number;
  /** `update_custom_role()`: the capabilities that would be added. */
  added?: string[];
  /** `join_program()`: which program and roster row the call landed in. */
  profile_id?: string;
  program_id?: string;
  program_name?: string;
  membership_id?: string;
  /** `create_program()`: the slug minted for the program that was just started. */
  slug?: string;
  /** `create_program()`: the join code it began with, for its director to share. */
  join_code?: string;
  /** `join_program()`: true when the caller added a program they were in already. */
  existing?: boolean;
  /** `create_program()`: how many sections its instruments produced. */
  section_count?: number;
  /** `add_program_section()` / `rename_program_section()`: the written section. */
  section_id?: string;
  /** `add_program_section()` / `rename_program_section()`: its name. */
  name?: string;
  /** `remove_program_section()`: members who moved to "No section". */
  moved_to_no_section?: number;
  /** `remove_member()`: attendance rows deleted with the membership. */
  attendance_deleted?: number;

  /** `digest_reachability()`: the window the counts below cover, in days. */
  window_days?: number;
  /** `digest_reachability()`: false for an archived program, which mails nobody. */
  program_active?: boolean;
  /** `digest_reachability()`: events in that window — zero means a quiet week. */
  events?: number;
  /** `digest_reachability()`: active members considered. */
  members?: number;
  /** `digest_reachability()`: how many of them the email can actually reach. */
  reachable?: number;
  /** `digest_reachability()`: every active member and why they are (not) reached. */
  people?: DigestReachabilityRow[];

  /**
   * `teacher_access_status()`: whether this account holds a redeemed teacher
   * invitation (migration 035). There is deliberately no other "is a teacher"
   * flag on the account — the redeemed invitation row is the whole credential.
   */
  verified?: boolean;
  /** `teacher_access_status()`: declared a teacher at sign-up, not yet verified. */
  pending?: boolean;
  /** `teacher_access_status()`: a system administrator, who needs no code. */
  admin?: boolean;
  /** `teacher_access_status()`: the caller's own declared sign-up type. */
  account_type?: string | null;
  /** `teacher_access_status()`: when their invitation was redeemed. */
  redeemed_at?: string | null;
  /** `redeem_teacher_invitation()`: set when too many attempts have failed. */
  rate_limited?: boolean;
}

/**
 * One entry of `list_active_programs()` — what the join screen offers. A join
 * code is never part of this: only whether the program has one set.
 */
export interface ProgramOption {
  slug: string;
  name: string;
  short_name: string;
  theme_color: string;
  logo_url: string;
  has_join_code: boolean;
}

/** One row of `get_attendance_trend`. */
export interface TrendRow {
  id: string;
  name: string;
  type: string;
  date: string;
  event_type: string;
  roster_size: number;
  present_count: number;
  excused_count: number;
  late_count: number;
}

/**
 * One row of the caller's own `my_attendance_trend` — their past required
 * events, newest first, with the status the percentage is built from.
 */
export interface MyAttendanceRow {
  id: string;
  name: string;
  event_type: string;
  date: string;
  status: AttendanceStatus;
  attended: boolean;
  checked_in_at: string | null;
}

/** One row of `get_section_attendance_stats`. */
export interface SectionStatRow {
  section: string;
  member_count: number;
  avg_attendance_pct: number;
  sort_order: number;
}

/**
 * Why one member will, or will not, receive the scheduled upcoming-events email
 * (migration 033). These are the filters `due_event_digests()` applies, in the
 * order it applies them, so a label here and a silent skip there cannot disagree.
 */
export type DigestReachabilityStatus =
  /** None of the reasons below: this person gets the email. */
  | "reachable"
  /** They turned the email off for this program — their choice, not a fault. */
  | "opted_out"
  /** On the roster, but no sign-in account is linked to them. */
  | "no_sign_in"
  /** The account exists but carries no address. */
  | "no_address"
  /** The address exists but was never confirmed. */
  | "unconfirmed"
  /** A deactivated account is muted. */
  | "account_deactivated";

/** One entry of `digest_reachability()` (033): who, and why not. Never an address. */
export interface DigestReachabilityRow {
  user_id: string;
  status: DigestReachabilityStatus;
}

/** A member of the band: the person plus their membership and section. */
export interface RosterMember {
  user_id: string;
  section_id: string | null;
  section_name: string;
  roles: Role[];
  active: boolean;
  joined_at: string;
  profile: Pick<
    Profile,
    | "id"
    | "full_name"
    | "display_name"
    | "avatar_url"
    | "avatar_path"
    | "bio"
    | "deactivated"
    | "created_at"
  >;
}
