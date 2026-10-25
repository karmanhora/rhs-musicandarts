/**
 * The few direct table reads the app makes.
 *
 * Everything that writes goes through an RPC (rpc.ts). Reads are RLS-scoped:
 * `profiles` shows you + your co-members, `events` only the band's, attendance
 * only as far as your role reaches. There is no client-side filtering that the
 * database also enforces — no `ensemble_id` is ever passed by the client.
 */
import { supabase } from "./supabase";
import type {
  AttendanceRow,
  AttendanceStaffNoteRow,
  CheckinSessionRow,
  EnsembleRow,
  EventRow,
  MembershipRow,
  NotificationRow,
  PersonalEventRow,
  Profile,
  RoleAssignmentRow,
  RosterMember,
  SectionRow,
} from "./types";

/**
 * Columns of `profiles` that may be shown for another person. `bio` is included
 * because it is a deliberate, self-authored line (capped at 500 characters);
 * `auth_user_id`, `clerk_id` and `must_change_password` never are.
 */
const PUBLIC_PROFILE_COLUMNS =
  "id,full_name,display_name,avatar_url,avatar_path,bio,deactivated,created_at";

export interface EmbeddedMembership extends MembershipRow {
  ensemble: EnsembleRow;
  section: Pick<SectionRow, "id" | "name" | "sort_order"> | null;
}

/**
 * My own profile row, found by the Supabase Auth user id we already hold.
 *
 * `auth_user_id` is `auth.uid()` (migration 021); RLS also limits this select to
 * rows the caller may see, so the filter is a lookup, not the access rule.
 */
export async function fetchProfileByAuthId(authUserId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("auth_user_id", authUserId)
    .maybeSingle<Profile>();
  return (data as Profile | null) ?? null;
}

/**
 * My active memberships, each carrying its program and section.
 * `!inner` is not needed: RLS already limits rows to programs I belong to.
 */
export async function fetchMyMemberships(userId: string): Promise<EmbeddedMembership[]> {
  const { data } = await supabase
    .from("memberships")
    .select(
      "id,user_id,ensemble_id,section_id,roles,active,joined_at,email_upcoming_events," +
        "ensemble:ensembles(id,slug,name,short_name,theme_color,logo_url,active,created_at)," +
        "section:sections(id,name,sort_order)"
    )
    .eq("user_id", userId)
    .eq("active", true);
  return (data ?? []) as unknown as EmbeddedMembership[];
}

/**
 * Every active program. RLS decides the answer: `ensembles_read_members` shows
 * a person their own programs, and a system administrator (`is_program_admin()`)
 * every one — which is how the app can offer a program the administrator is not
 * on without asking the client to trust a flag.
 */
export async function fetchActivePrograms(): Promise<EnsembleRow[]> {
  const { data } = await supabase
    .from("ensembles")
    .select("id,slug,name,short_name,theme_color,logo_url,active,created_at")
    .eq("active", true)
    .order("name");
  return (data ?? []) as unknown as EnsembleRow[];
}

export async function fetchSections(programId: string): Promise<SectionRow[]> {
  const { data } = await supabase
    .from("sections")
    .select("id,ensemble_id,name,sort_order")
    .eq("ensemble_id", programId)
    .order("sort_order")
    .order("name");
  return (data ?? []) as SectionRow[];
}

export async function fetchGoogleCalendarSource(programId: string): Promise<{
  id: string;
  name: string;
  ics_url: string;
  last_synced_at: string | null;
} | null> {
  const { data } = await supabase
    .from("calendar_sources")
    .select("id,name,ics_url,last_synced_at")
    .eq("ensemble_id", programId)
    .eq("provider", "google_ics")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  return data;
}

/** Semantic design tokens for the program; `{}` when none are stored yet. */
export async function fetchThemeTokens(programId: string): Promise<Record<string, string>> {
  const { data } = await supabase
    .from("ensemble_theme_tokens")
    .select("tokens")
    .eq("ensemble_id", programId)
    .maybeSingle<{ tokens: Record<string, string> }>();
  return (data?.tokens ?? {}) as Record<string, string>;
}

/** The whole band roster: membership + person + section, alphabetical. */
export async function fetchRoster(programId: string): Promise<RosterMember[]> {
  const { data } = await supabase
    .from("memberships")
    .select(
      `user_id,section_id,roles,active,joined_at,` +
        `profile:profiles(${PUBLIC_PROFILE_COLUMNS}),` +
        `section:sections(id,name)`
    )
    .eq("ensemble_id", programId);

  const rows = (data ?? []) as unknown as {
    user_id: string;
    section_id: string | null;
    roles: RosterMember["roles"];
    active: boolean;
    joined_at: string;
    profile: RosterMember["profile"] | null;
    section: { id: string; name: string } | null;
  }[];

  return rows
    .filter((r) => r.profile)
    .map((r) => ({
      user_id: r.user_id,
      section_id: r.section_id,
      section_name: r.section?.name ?? "",
      roles: r.roles,
      active: r.active,
      joined_at: r.joined_at,
      profile: r.profile as RosterMember["profile"],
    }))
    .sort((a, b) =>
      (a.profile.display_name || a.profile.full_name).localeCompare(
        b.profile.display_name || b.profile.full_name
      )
    );
}

/**
 * Extra role grants in one program (029): custom roles and scoped grants that
 * sit *beside* `memberships.roles`. RLS shows them to the person they belong to
 * and to staff who manage the program, so the roster screen can render everyone
 * a director is allowed to see — and a member only ever sees their own.
 */
export async function fetchRoleAssignments(programId: string): Promise<RoleAssignmentRow[]> {
  const { data } = await supabase
    .from("user_role_assignments")
    .select("id,user_id,ensemble_id,role_id,section_id,granted_at,revoked_at")
    .eq("ensemble_id", programId)
    .is("revoked_at", null);
  return (data ?? []) as RoleAssignmentRow[];
}

export interface EventQuery {
  /** Inclusive lower bound on `date` (ISO). */
  from?: string;
  /** Exclusive upper bound on `date` (ISO). */
  to?: string;
  includeArchived?: boolean;
}

/** Events of the band, soonest first. Archived events are hidden by default. */
export async function fetchEvents(programId: string, opts: EventQuery = {}): Promise<EventRow[]> {
  let q = supabase
    .from("events")
    .select("*")
    .eq("ensemble_id", programId)
    .order("date", { ascending: true });

  if (!opts.includeArchived) q = q.eq("archived", false);
  if (opts.from) q = q.gte("date", opts.from);
  if (opts.to) q = q.lt("date", opts.to);

  const { data } = await q;
  return (data ?? []) as EventRow[];
}

/** Attendance rows for the band's events in a window. */
export async function fetchAttendance(
  programId: string,
  opts: { from?: string; to?: string } = {}
): Promise<AttendanceRow[]> {
  let q = supabase
    .from("attendance_records")
    .select("*, event:events!inner(id,ensemble_id,date,name)")
    .eq("event.ensemble_id", programId);

  if (opts.from) q = q.gte("event.date", opts.from);
  if (opts.to) q = q.lt("event.date", opts.to);

  const { data } = await q;
  return ((data ?? []) as unknown as AttendanceRow[]).map((r) => ({
    id: r.id,
    event_id: r.event_id,
    student_id: r.student_id,
    attended: r.attended,
    checked_in_at: r.checked_in_at,
    status: r.status,
    excuse_reason: r.excuse_reason,
    is_late: r.is_late,
    marked_by: r.marked_by,
  }));
}

/** Staff notes for the given attendance records (staff only; students see none). */
export async function fetchStaffNotes(
  attendanceRecordIds: string[]
): Promise<AttendanceStaffNoteRow[]> {
  if (attendanceRecordIds.length === 0) return [];
  const { data } = await supabase
    .from("attendance_staff_notes")
    .select("*")
    .in("attendance_record_id", attendanceRecordIds);
  return (data ?? []) as AttendanceStaffNoteRow[];
}

/** The live (or just-expired) check-in session for an event, if any. */
export async function fetchSessionForEvent(eventId: string): Promise<CheckinSessionRow | null> {
  const { data } = await supabase
    .from("checkin_sessions")
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle<CheckinSessionRow>();
  return (data as CheckinSessionRow | null) ?? null;
}

export async function fetchNotifications(limit = 40): Promise<NotificationRow[]> {
  const { data } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as NotificationRow[];
}

/**
 * How many of the caller's own notifications are unread. A `head` count is one
 * cheap round-trip and still RLS-scoped to the caller's rows, so it can never
 * report somebody else's inbox.
 */
export async function fetchUnreadNotificationCount(): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("read", false);
  if (error) return 0;
  return count ?? 0;
}

export async function markNotificationsRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabase.from("notifications").update({ read: true }).in("id", ids);
}

export async function fetchPersonalEvents(): Promise<PersonalEventRow[]> {
  const { data } = await supabase
    .from("personal_events")
    .select("*")
    .order("date", { ascending: true });
  return (data ?? []) as PersonalEventRow[];
}

export async function createPersonalEvent(input: {
  owner_id: string;
  name: string;
  date: string;
  location?: string;
}): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from("personal_events").insert({
    owner_id: input.owner_id,
    name: input.name,
    date: input.date,
    location: input.location ?? "",
  });
  return { error: error ? { message: error.message } : null };
}

export async function deletePersonalEvent(id: string): Promise<void> {
  await supabase.from("personal_events").delete().eq("id", id);
}

// --- Event writes (staff only, enforced by RLS) ------------------------------

export type EventDraft = {
  name: string;
  event_type: string;
  date: string;
  end_date: string | null;
  all_day: boolean;
  location: string;
  description: string;
  checkin_mode: EventRow["checkin_mode"];
  attendance_requirement: EventRow["attendance_requirement"];
  late_minutes: number;
};

export async function insertEvent(
  programId: string,
  createdBy: string,
  draft: EventDraft
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from("events").insert({
    ...draft,
    type: draft.event_type,
    ensemble_id: programId,
    created_by: createdBy,
    event_source: "manual",
  });
  return { error: error ? { message: error.message } : null };
}

export async function updateEvent(
  eventId: string,
  draft: Partial<EventDraft>
): Promise<{ error: { message: string } | null }> {
  const patch = { ...draft, ...(draft.event_type ? { type: draft.event_type } : {}) };
  const { error } = await supabase.from("events").update(patch).eq("id", eventId);
  return { error: error ? { message: error.message } : null };
}

export async function setEventArchived(
  eventId: string,
  archived: boolean
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from("events").update({ archived }).eq("id", eventId);
  return { error: error ? { message: error.message } : null };
}

export async function deleteEvent(
  eventId: string
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from("events").delete().eq("id", eventId);
  return { error: error ? { message: error.message } : null };
}

/**
 * Update my own profile. RLS limits this to rows the caller may write, and the
 * `profiles_guard_self_update` trigger still refuses a change to `deactivated`
 * (the one column that is not self-service) — so nothing here is trusted merely
 * because the browser sent it.
 */
export async function updateMyProfile(
  profileId: string,
  patch: Partial<
    Pick<
      Profile,
      | "full_name"
      | "display_name"
      | "avatar_url"
      | "avatar_path"
      | "bio"
      | "must_change_password"
    >
  >
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from("profiles").update(patch).eq("id", profileId);
  return { error: error ? { message: error.message } : null };
}
