import type { PostgrestError } from "@supabase/supabase-js";
import type { AuthAudience } from "./constants";
import { supabase } from "./supabase";
import type {
  AbsenceRequestRow,
  AttendanceAuditEntry,
  AttendanceReportResult,
  AttendanceStatus,
  MakeupEmailContext,
  MakeupEmailSendResponse,
  MyAbsenceRequestRow,
  MyAttendanceRow,
  ProgramOption,
  RoleAuditEntry,
  RpcResult,
  SectionStatRow,
  TeacherAccessStatus,
  TrendRow,
} from "./types";

export interface RpcResponse {
  result: RpcResult | null;
  error: PostgrestError | null;
}

export interface GoogleCalendarImportResult {
  ok: boolean;
  inserted?: number;
  updated?: number;
  archived?: number;
  warning?: string | null;
  message?: string;
}

export async function getSignupAccountType(): Promise<{
  accountType: AuthAudience | null;
  error: string | null;
}> {
  const { data, error } = await supabase.rpc("get_signup_account_type");
  if (error) return { accountType: null, error: error.message };
  if (data === "student" || data === "teacher") return { accountType: data, error: null };
  return { accountType: null, error: null };
}

export async function setSignupAccountType(audience: AuthAudience): Promise<{
  accountType: AuthAudience | null;
  error: string | null;
}> {
  const { data, error } = await supabase.rpc("set_signup_account_type", {
    p_account_type: audience,
  });
  if (error) return { accountType: null, error: error.message };
  if (data === "student" || data === "teacher") return { accountType: data, error: null };
  return { accountType: null, error: "The account type could not be confirmed." };
}

async function callRpc(
  fn: string,
  args: Record<string, unknown> = {}
): Promise<RpcResponse> {
  const { data, error } = await supabase.rpc(fn, args);
  return { result: (data ?? null) as RpcResult | null, error };
}

/**
 * The handful of RPCs that answer with a JSON *array* instead of an
 * `{ ok, message }` object. A refusal still comes back as an object, so the
 * shape of the payload tells the two apart — no guessed flags.
 */
export interface RpcListResponse<T> {
  rows: T[];
  error: PostgrestError | null;
  /** Set only when the server refused the call ("Only directors…"). */
  message: string | null;
}

async function callRpcList<T>(
  fn: string,
  args: Record<string, unknown> = {}
): Promise<RpcListResponse<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (Array.isArray(data)) return { rows: data as T[], error, message: null };
  const refused = (data ?? null) as RpcResult | null;
  return {
    rows: [],
    error,
    message: refused && refused.ok === false ? (refused.message ?? null) : null,
  };
}

// --- Programs (any signed-in person) ----------------------------------------

/**
 * Every active program, so the join screen can offer real names instead of
 * asking somebody to spell a slug. Names and colours are not secret; join codes
 * never appear here — only whether one is set.
 */
export const listActivePrograms = () => callRpcList<ProgramOption>("list_active_programs");

/**
 * Join a program with its code. `p_display_name` is only used when the caller has
 * no profile yet (the code is what proves they may be here; the name is just
 * what to call them). Validated and rate-limited server-side, never in the
 * browser.
 */
export const joinProgram = (slug: string, code: string, displayName?: string) =>
  callRpc("join_program", {
    p_slug: slug,
    p_code: code,
    p_display_name: displayName?.trim() || null,
  });

export async function importGoogleCalendar(
  programId: string,
  calendarUrl: string
): Promise<{ result: GoogleCalendarImportResult | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke<GoogleCalendarImportResult>(
    "import-google-calendar",
    { body: { ensemble_id: programId, calendar_url: calendarUrl.trim() } }
  );
  if (!error) return { result: data, error: null };

  if (error.context instanceof Response) {
    try {
      const body = (await error.context.clone().json()) as { error?: string };
      if (body.error) return { result: null, error: body.error };
    } catch {
      // Keep the Functions client's message when the response is not JSON.
    }
  }
  return { result: null, error: error.message };
}

/**
 * Start a program and become its director. Teacher accounts can do this without
 * approval or a code; student accounts are refused by the server.
 *
 * The name is the only thing the caller controls: the RPC always creates a
 * **new** program with the caller as `{director}`, so this can never be pointed
 * at an existing one. It also handles their first-ever `profiles` row (which is
 * why `displayName` matters when they have none), gives the program a join code
 * to start with, and refuses a blank name or a sixth program inside an hour.
 *
 * `instruments` become the new program's `sections` — the director names what
 * is in it so students can be put in the right place from the start.
 */
export const createProgram = (
  name: string,
  opts?: { shortName?: string; displayName?: string; instruments?: string[] }
) => {
  const instruments = (opts?.instruments ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return callRpc("create_program", {
    p_name: name.trim(),
    p_short_name: opts?.shortName?.trim() || null,
    p_display_name: opts?.displayName?.trim() || null,
    p_instruments: instruments.length > 0 ? instruments : null,
  });
};

// --- Sections / instruments (director) --------------------------------------

/** Director-only: add one instrument/section to the program. */
export const addProgramSection = (programId: string, name: string) =>
  callRpc("add_program_section", { p_ensemble: programId, p_name: name.trim() });

/** Director-only: rename a section; the people in it stay in it. */
export const renameProgramSection = (sectionId: string, name: string) =>
  callRpc("rename_program_section", { p_section: sectionId, p_name: name.trim() });

/** Director-only: delete a section; its members fall under "No section". */
export const removeProgramSection = (sectionId: string) =>
  callRpc("remove_program_section", { p_section: sectionId });

/** Director-only: archive a program from new joins or restore it. */
export const setProgramActive = (programId: string, active: boolean) =>
  callRpc("set_program_active", { p_ensemble: programId, p_active: active });

/** Program staff: invite a new student by email through the server function. */
export async function inviteProgramStudent(
  programId: string,
  email: string,
  studentName: string
): Promise<{ message: string | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    message?: string;
    error?: string;
  }>("invite-student", {
    body: {
      ensemble_id: programId,
      email: email.trim(),
      student_name: studentName.trim(),
    },
  });

  if (error) {
    if (error.context instanceof Response) {
      const body = await error.context.clone().text();
      if (body) {
        try {
          const payload: unknown = JSON.parse(body);
          if (
            typeof payload === "object" &&
            payload !== null &&
            "error" in payload &&
            typeof payload.error === "string"
          ) {
            return { message: null, error: payload.error };
          }
        } catch (parseError) {
          if (!(parseError instanceof SyntaxError)) throw parseError;
        }
      }
    }
    return { message: null, error: error.message };
  }

  if (!data?.ok) {
    return {
      message: null,
      error: data?.error ?? "Could not send the student invitation.",
    };
  }
  return { message: data.message ?? "Invitation sent.", error: null };
}

// --- Join code (director) ---------------------------------------------------

/** Director-only: the program's current join code. */
export const getJoinCode = (programId: string) =>
  callRpc("get_join_code", { p_ensemble: programId });

/** Director-only: replace the program's join code. */
export const setJoinCode = (programId: string, code: string) =>
  callRpc("set_join_code", { p_ensemble: programId, p_code: code });

// --- Roster -----------------------------------------------------------------

/**
 * Director-only, and complete: the person's membership, custom role grants and
 * attendance in *this* program go. Their account (and any other program they
 * belong to) is untouched. `memberId` must be on this program's roster.
 */
export const removeMember = (programId: string, memberId: string) =>
  callRpc("remove_member", { p_ensemble: programId, p_member_id: memberId });

/** Director-only: pause a membership without deleting it (keeps attendance). */
export const deactivateMember = (programId: string, memberId: string) =>
  callRpc("deactivate_member", { p_ensemble: programId, p_member_id: memberId });

/** Director-only. */
export const reactivateMember = (programId: string, memberId: string) =>
  callRpc("reactivate_member", { p_ensemble: programId, p_member_id: memberId });

/**
 * Directors move anyone in the program; a member may move *themselves*
 * (that is what the Profile screen's section picker calls).
 */
export const setMemberSection = (
  programId: string,
  memberId: string,
  sectionId: string | null
) =>
  callRpc("set_member_section", {
    p_ensemble: programId,
    p_member_id: memberId,
    p_section_id: sectionId,
  });

// --- Check-in ---------------------------------------------------------------

/** Staff (director, secretary or section leader): mint a fresh QR + code. */
export const startCheckinSession = (eventId: string) =>
  callRpc("start_checkin_session", { p_event_id: eventId });

/** Student: check in with the token in a QR code (deep link `/checkin?token=…`). */
export const recordAttendance = (token: string) =>
  callRpc("record_attendance", { p_token: token });

/** Student: check in with the 8-character code shown on screen. */
export const recordAttendanceByCode = (code: string) =>
  callRpc("record_attendance_by_code", { p_code: code });

/**
 * Staff: set a student's attendance for an event. `status` may be the legacy
 * boolean or "present" | "absent" | "excused" | "late".
 */
export const overrideAttendance = (
  eventId: string,
  studentId: string,
  status: string | boolean,
  excuseReason?: string,
  staffNote?: string
) => {
  if (typeof status === "boolean") {
    return callRpc("override_attendance", {
      p_event_id: eventId,
      p_student_id: studentId,
      p_attended: status,
    });
  }
  return callRpc("override_attendance", {
    p_event_id: eventId,
    p_student_id: studentId,
    p_status: status,
    p_excuse_reason: excuseReason ?? "",
    p_staff_note: staffNote ?? "",
  });
};

// --- Teacher access (any signed-in account, for itself) ----------------------

/**
 * The caller's own teacher-credential state (migration 035). Used to render
 * "pending until verification" and to decide whether to offer the
 * start-a-program form or the invitation-code form — it never grants anything:
 * `create_program()` asks the database again.
 */
export async function getTeacherAccessStatus(): Promise<TeacherAccessStatus> {
  const { data, error } = await supabase.rpc("teacher_access_status");
  const result = (data ?? null) as RpcResult | null;

  // Fail closed: an unreadable status is "not verified", never a guess.
  if (error) return { verified: false, pending: false, admin: false, error: error.message };
  if (!result?.ok) {
    return {
      verified: false,
      pending: false,
      admin: false,
      error: result?.message ?? "Could not check teacher access.",
    };
  }
  return {
    verified: result.verified === true,
    pending: result.pending === true,
    admin: result.admin === true,
    error: null,
  };
}

/**
 * Redeem a teacher invitation code. The code is normalized, hashed, checked for
 * expiry and email binding and consumed atomically on the server (migration
 * 035) — this call is a request, never a decision, and the plaintext is never
 * stored or logged anywhere.
 */
export const redeemTeacherInvitation = (code: string) =>
  callRpc("redeem_teacher_invitation", { p_code: code.trim() });

// --- My own numbers (any member) -------------------------------------------

/**
 * The caller's own attendance percentage. Same formula as the director-facing
 * analytics, so a student and their director can never see different numbers.
 * Unlike the analytics RPCs this one needs no staff role — it is always about
 * you.
 */
export const getMyAttendancePct = (programId: string) =>
  callRpc("my_attendance_pct", { p_ensemble: programId });

/** The caller's own recent required events, newest first. */
export const getMyAttendanceTrend = (programId: string, limit = 8) =>
  callRpcList<MyAttendanceRow>("my_attendance_trend", { p_ensemble: programId, p_limit: limit });

// --- Roles & capabilities (029) ---------------------------------------------

/**
 * The caller's own effective capabilities in one program. The frontend uses
 * this to decide what to render; every rule behind it is enforced again, per
 * request, by `has_permission()` inside RLS and the RPCs below.
 */
export const getMyPermissions = (programId: string) =>
  callRpc("my_permissions", { p_ensemble: programId });

/** Every role available in the program (system + custom) and what each grants. */
export const listProgramRoles = (programId: string) =>
  callRpc("list_program_roles", { p_ensemble: programId });

/**
 * Grant a role. The server refuses a role the caller does not hold in full, a
 * self-assignment, `system_admin`, and any target who is not on this roster.
 */
export const assignRole = (
  programId: string,
  userId: string,
  roleId: string,
  sectionId?: string | null
) =>
  callRpc("assign_role", {
    p_ensemble: programId,
    p_user: userId,
    p_role: roleId,
    p_section_id: sectionId ?? null,
  });

/** Remove a role, subject to the same authority checks (and never the last director). */
export const revokeRole = (programId: string, userId: string, roleId: string) =>
  callRpc("revoke_role", { p_ensemble: programId, p_user: userId, p_role: roleId });

/** Build a per-program role from delegable capabilities the caller already holds. */
export const createCustomRole = (
  programId: string,
  name: string,
  description: string,
  permissions: string[],
  scope: "program" | "section" = "program"
) =>
  callRpc("create_custom_role", {
    p_ensemble: programId,
    p_name: name,
    p_description: description,
    p_permissions: permissions,
    p_scope: scope,
  });

/**
 * Edit a custom role. Widening a role that people already hold answers with
 * `needs_confirmation` (+ `holders` and `added`) until the caller passes
 * `confirm = true`, so nobody silently gains a capability.
 */
export const updateCustomRole = (
  roleId: string,
  name: string,
  description: string,
  permissions: string[],
  scope: "program" | "section" = "program",
  confirm = false
) =>
  callRpc("update_custom_role", {
    p_role: roleId,
    p_name: name,
    p_description: description,
    p_permissions: permissions,
    p_scope: scope,
    p_confirm: confirm,
  });

/** Delete a custom role; refused while anybody still holds it. */
export const deleteCustomRole = (roleId: string) =>
  callRpc("delete_custom_role", { p_role: roleId });

/** `list_role_audit()` answers `{ ok, entries }`; the entries are typed here. */
export interface RoleAuditResult extends RpcResult {
  entries?: RoleAuditEntry[];
}

/** Recent role/permission changes in one program. */
export async function listRoleAudit(
  programId: string,
  limit = 40
): Promise<{ result: RoleAuditResult | null; error: PostgrestError | null }> {
  const { data, error } = await supabase.rpc("list_role_audit", {
    p_ensemble: programId,
    p_limit: limit,
  });
  return { result: (data ?? null) as RoleAuditResult | null, error };
}

// --- Analytics (director of that program, or a program admin) ---------------

/** Percentage for one student. The program travels with the student id. */
export const getStudentAttendancePct = (studentId: string, programId: string) =>
  callRpc("get_student_attendance_pct", {
    p_student_id: studentId,
    p_ensemble: programId,
  });

/** Per-section averages, canonical order, `[]` when there is nothing yet. */
export const getSectionAttendanceStats = (programId: string) =>
  callRpcList<SectionStatRow>("get_section_attendance_stats", { p_ensemble: programId });

/** The program is derived from the event — a client cannot name another one. */
export const getEventAttendanceSummary = (eventId: string) =>
  callRpc("get_event_attendance_summary", { p_event_id: eventId });

/** Last N required events that have already happened, newest first. */
export const getAttendanceTrend = (programId: string, limit = 10) =>
  callRpcList<TrendRow>("get_attendance_trend", { p_ensemble: programId, p_limit: limit });

// --- Event requirements (20261020111000) -----------------------------------

/**
 * Required attendance average, optional-event turnout and the count of
 * no-attendance events, with the calculation rules in `basis`. Directors only.
 */
export const getEventRequirementStats = (programId: string) =>
  callRpc("get_event_requirement_stats", { p_ensemble: programId });

// --- Attendance history (20261020112000) -----------------------------------

/**
 * Recent attendance changes. Program-wide readers see the whole program; a
 * section leader sees only their section. A student is refused, and has no
 * direct-table path either.
 */
/** `list_attendance_history()` answers `{ ok, entries, limit }`, not a bare list. */
export interface AttendanceHistoryResult extends RpcResult {
  entries?: AttendanceAuditEntry[];
}

export async function listAttendanceHistory(
  programId: string,
  filters: {
    event?: string | null;
    student?: string | null;
    from?: string | null;
    to?: string | null;
    oldStatus?: string | null;
    newStatus?: string | null;
    actor?: string | null;
    limit?: number;
  } = {}
): Promise<{ result: AttendanceHistoryResult | null; error: PostgrestError | null }> {
  const { data, error } = await supabase.rpc("list_attendance_history", {
    p_ensemble: programId,
    p_event: filters.event ?? null,
    p_student: filters.student ?? null,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_old_status: filters.oldStatus ?? null,
    p_new_status: filters.newStatus ?? null,
    p_actor: filters.actor ?? null,
    p_limit: filters.limit ?? 100,
  });
  return { result: (data ?? null) as AttendanceHistoryResult | null, error };
}

/**
 * One staff mark with an optional short reason, recorded on the audit entry.
 * Every permission and section rule is inherited from `override_attendance`.
 */
export const overrideAttendanceWithReason = (
  eventId: string,
  studentId: string,
  status: AttendanceStatus,
  excuseReason: string,
  staffNote: string,
  reason: string
) =>
  callRpc("override_attendance_with_reason", {
    p_event_id: eventId,
    p_student_id: studentId,
    p_status: status,
    p_excuse_reason: excuseReason,
    p_staff_note: staffNote,
    p_reason: reason,
  });

/**
 * Many students in one action. Each still passes the caller's own capability
 * and section checks; the answer says how many saved and how many were refused.
 */
export const markAttendanceBulk = (
  eventId: string,
  studentIds: string[],
  status: AttendanceStatus,
  reason = ""
) =>
  callRpc("mark_attendance_bulk", {
    p_event_id: eventId,
    p_student_ids: studentIds,
    p_status: status,
    p_reason: reason,
  });

// --- Absence requests (20261020113000) --------------------------------------

/** Student: ask to miss one future event. Duplicates are refused by the server. */
export const createAbsenceRequest = (eventId: string, reason: string) =>
  callRpc("create_absence_request", { p_event_id: eventId, p_reason: reason });

/** Student: withdraw one of my own pending requests. */
export const withdrawAbsenceRequest = (requestId: string) =>
  callRpc("withdraw_absence_request", { p_request_id: requestId });

/** The caller's own requests in one program, newest first. */
export const listMyAbsenceRequests = (programId: string, limit = 25) =>
  callRpcList<MyAbsenceRequestRow>("list_my_absence_requests", {
    p_ensemble: programId,
    p_limit: limit,
  });

/** Reviewer queue, with server-side filters. Requires `absence.review`. */
export const listAbsenceRequests = (
  programId: string,
  filters: {
    status?: string;
    event?: string | null;
    section?: string | null;
    student?: string | null;
    limit?: number;
  } = {}
) =>
  callRpcList<AbsenceRequestRow>("list_absence_requests", {
    p_ensemble: programId,
    p_status: filters.status ?? "pending",
    p_event: filters.event ?? null,
    p_section: filters.section ?? null,
    p_student: filters.student ?? null,
    p_limit: filters.limit ?? 200,
  });

/** Reviewer: approve or deny one pending request, with an optional response. */
export const decideAbsenceRequest = (
  requestId: string,
  decision: "approved" | "denied",
  note = ""
) =>
  callRpc("decide_absence_request", {
    p_request_id: requestId,
    p_decision: decision,
    p_note: note,
  });

/** Reviewer: let a student ask again after a decision. */
export const allowAbsenceResubmission = (requestId: string) =>
  callRpc("allow_absence_resubmission", { p_request_id: requestId });

// --- Attendance reports (20261020114000) ------------------------------------

/**
 * Permission-checked report rows. `p_from` is inclusive and `p_to` exclusive, so
 * a day range should be [start of first day, start of day after the last].
 */
export async function getAttendanceReport(params: {
  programId: string;
  event?: string | null;
  from?: string | null;
  to?: string | null;
  student?: string | null;
  section?: string | null;
  status?: string | null;
  requirement?: string | null;
  limit?: number;
}): Promise<{ report: AttendanceReportResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc("attendance_report_rows", {
    p_ensemble: params.programId,
    p_event: params.event ?? null,
    p_from: params.from ?? null,
    p_to: params.to ?? null,
    p_student: params.student ?? null,
    p_section: params.section ?? null,
    p_status: params.status ?? null,
    p_requirement: params.requirement ?? null,
    p_limit: params.limit ?? 5000,
  });
  if (error) return { report: null, error: error.message };
  return { report: (data ?? null) as AttendanceReportResult | null, error: null };
}

// --- Notification centre (20261020110000) ----------------------------------

/** Mark every one of the caller's own unread notifications read. */
export const markAllNotificationsRead = () => callRpc("mark_all_notifications_read");

// --- Email (any signed-in member, for themselves) ---------------------------

/**
 * Turn the upcoming-events email digest for one program on or off.
 *
 * The server writes only the caller's own membership for the program named
 * here — there is no user id in the request, so this cannot be pointed at
 * somebody else. Refused with a message when the caller is not on that roster.
 */
export const setEmailUpcomingEvents = (programId: string, enabled: boolean) =>
  callRpc("set_email_upcoming_events", { p_ensemble: programId, p_enabled: enabled });

/**
 * Staff of one program: who the scheduled upcoming-events email will reach, and
 * the reason each member it misses is missed.
 *
 * It answers with the *state* of an address — confirmed, unconfirmed, absent —
 * and never the address itself, which is why staff may ask it at all. The server
 * refuses anyone who is not staff of that program, and `days` is clamped to
 * 1–30 server-side just like the sender's own window.
 */
export const getDigestReachability = (programId: string, days = 7) =>
  callRpc("digest_reachability", { p_ensemble: programId, p_days: days });

// --- Post-event make-up email (migration 036) -------------------------------

/**
 * Staff-only context for the make-up composer: whether the event has ended and
 * may be mailed about, the event/program/teacher names, the confirmed-absent
 * recipients, and — separately — students with no attendance record.
 *
 * It returns no addresses; the sending function resolves those on the server.
 * Refused for anyone who is not staff of the event's program.
 */
export async function getMakeupEmailContext(
  eventId: string
): Promise<{ context: MakeupEmailContext | null; error: string | null }> {
  const { data, error } = await supabase.rpc("makeup_email_context", { p_event: eventId });
  if (error) return { context: null, error: error.message };
  return { context: (data ?? null) as MakeupEmailContext | null, error: null };
}

/**
 * Send one chunk of a make-up operation. The Edge Function re-checks the
 * caller's staff role, the event's latest end time and the eligible absentees,
 * so `recipientIds` can only narrow the server's list. Passing the same
 * `operationId` again resumes the same campaign and skips anyone already
 * accepted; that is what makes a retry safe.
 */
export async function sendMakeupEmailChunk(payload: {
  eventId: string;
  operationId: string;
  subject: string;
  instructions: string;
  bodyTemplate: string;
  recipientIds?: string[];
}): Promise<{ result: MakeupEmailSendResponse | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke<MakeupEmailSendResponse>(
    "send-makeup-emails",
    {
      body: {
        event_id: payload.eventId,
        client_operation_id: payload.operationId,
        subject: payload.subject,
        instructions: payload.instructions,
        body_template: payload.bodyTemplate,
        ...(payload.recipientIds ? { recipient_ids: payload.recipientIds } : {}),
      },
    }
  );

  if (!error) return { result: data ?? null, error: null };

  if (error.context instanceof Response) {
    try {
      const body = (await error.context.clone().json()) as { error?: string };
      if (body.error) return { result: null, error: body.error };
    } catch {
      // Keep the Functions client's message when the response is not JSON.
    }
  }
  return { result: null, error: error.message };
}
