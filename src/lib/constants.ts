import type {
  AbsenceStatus,
  AttendanceAuditEntry,
  AttendanceRequirement,
  AttendanceStatus,
  CheckinMode,
  DigestReachabilityStatus,
  FeedbackCategory,
  FeedbackStatus,
  Role,
} from "./types";

/**
 * Programme vocabulary.
 *
 * The site is the Redmond High School Music and Arts Program. Inside it, each
 * tracker is a **program** — marching band, orchestra, choir — and the database's
 * word for that row is `ensemble`, which must never reach a user. "Band" is only
 * right when the program on screen actually is the band (its own name, or the
 * "Band Meeting" event type below). Event types are stored as lowercase keys and
 * rendered through the labels here (see docs/PLATFORM_PLAN.md §2.4 U2/U14).
 */

/** Short UI / PWA name. */
export const APP_NAME = "Redmond High School Attendance";

/** The umbrella, spelled out — welcome screen, About, the app bar's subtitle. */
export const ORG_NAME = "Redmond High School Attendance";

export interface EventTypeOption {
  /** Canonical lowercase key stored in `events.event_type`. */
  value: string;
  label: string;
  /** Tailwind classes for the type chip. */
  chip: string;
}

/**
 * Five chip tones, and that is the whole vocabulary. A colour has to be
 * explainable before it is used: what a chip is *doing* decides its tone.
 *
 *   ink    the event is what the program exists for (a concert, a performance)
 *   green  routine, expected work (a rehearsal)
 *   gold   something to prepare for (a game, a competition)
 *   slate  administrative (meetings, auditions, trips)
 *   plain  everything else
 */
const CHIP_INK = "bg-[var(--cue-ink)] text-[var(--cue-panel)]";
const CHIP_GREEN = "bg-[var(--cue-present-bg)] text-[var(--cue-present)]";
const CHIP_GOLD = "bg-[var(--cue-late-bg)] text-[var(--cue-late)]";
const CHIP_SLATE = "bg-[var(--cue-excused-bg)] text-[var(--cue-excused)]";
const CHIP_PLAIN = "bg-[var(--cue-raised)] text-[var(--cue-muted)]";

const T = (value: string, label: string, chip: string): EventTypeOption => ({
  value,
  label,
  chip,
});

export const EVENT_TYPES: EventTypeOption[] = [
  T("rehearsal", "Rehearsal", CHIP_GREEN),
  T("concert", "Concert", CHIP_INK),
  T("game", "Game", CHIP_GOLD),
  T("competition", "Competition", CHIP_GOLD),
  T("performance", "Performance", CHIP_INK),
  T("section meeting", "Section Meeting", CHIP_SLATE),
  T("band meeting", "Band Meeting", CHIP_SLATE),
  T("general meeting", "General Meeting", CHIP_SLATE),
  T("parent meeting", "Parent Meeting", CHIP_SLATE),
  T("fundraiser", "Fundraiser", CHIP_SLATE),
  T("event/activity", "Event / Activity", CHIP_PLAIN),
  T("audition", "Audition", CHIP_SLATE),
  T("workshop", "Workshop", CHIP_PLAIN),
  T("trip", "Trip", CHIP_SLATE),
  T("other", "Other", CHIP_PLAIN),
];

const BY_VALUE = new Map(EVENT_TYPES.map((t) => [t.value, t]));

/** Display label for any stored event type, including ones we don't know. */
export function eventTypeLabel(value: string | null | undefined): string {
  if (!value) return "Other";
  const key = value.trim().toLowerCase();
  return BY_VALUE.get(key)?.label ?? titleCase(value);
}

export function eventTypeChip(value: string | null | undefined): string {
  const key = (value ?? "").trim().toLowerCase();
  return BY_VALUE.get(key)?.chip ?? CHIP_PLAIN;
}

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * How students can be marked for an event. These words are the whole
 * vocabulary, so each one names what a person does rather than restating a
 * database value; the sentence under the choice (CHECKIN_MODE_HINT) says what
 * follows from it. Check-in and attendance tracking are two different settings:
 * a QR code says *how* someone is marked, never *whether* it counts.
 */
export const CHECKIN_MODE_LABEL: Record<CheckinMode, string> = {
  qr: "Scan a code",
  toggle: "Staff mark the roll",
  both: "Scan or staff",
  none: "No check-in",
};

/** What each check-in choice actually means, in one sentence. */
export const CHECKIN_MODE_HINT: Record<CheckinMode, string> = {
  qr: "A code is shown on the room's screen and students scan it. Staff can still correct anyone afterwards.",
  toggle: "There is no code. Whoever takes the roll marks each student by hand.",
  both: "A code is shown and staff can also mark the roll — use this when not everyone has a phone.",
  none: "Nobody checks in. Use this for a meeting or a trip where attendance is not tracked.",
};

export const ATTENDANCE_REQUIREMENT_LABEL: Record<AttendanceRequirement, string> = {
  required: "Required",
  optional: "Optional",
  none: "Not tracked",
};

/**
 * What counts toward a student's percentage. "Required" is the only setting
 * that does: an optional event is recorded and reported but never averaged, and
 * an untracked event is invisible to attendance entirely.
 */
export const ATTENDANCE_REQUIREMENT_HINT: Record<AttendanceRequirement, string> = {
  required:
    "Counts toward each student's attendance percentage. A student with no mark counts as a miss.",
  optional: "Still recorded and shown in reports, but left out of the attendance percentage.",
  none: "No attendance is taken, and the event never appears in a percentage or a report.",
};

/**
 * One sentence per meaning, for legends and explainers. The last two are the
 * pair people most often mix up: an explicit absent mark is a staff decision,
 * while "Not recorded" means nobody ever saved a mark. They are deliberately
 * different words everywhere in the app, reports and exports included.
 */
export const ATTENDANCE_MEANING: Record<AttendanceStatus | "none", string> = {
  present: "On time and counted present.",
  late: "Arrived after the event's late mark.",
  excused: "A reviewer excused them, so it is left out of their percentage.",
  absent: "A staff member saved an explicit absent mark.",
  none: "No mark was saved. Reports say “Not recorded” — that is not the same as a saved absent.",
};

export const ATTENDANCE_STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: "Present",
  late: "Late",
  excused: "Excused",
  absent: "Absent",
};

/**
 * One status, one colour, everywhere: present green, late amber, excused slate,
 * absent red. These are the only four colours in the app that mean a state, so
 * they are never used decoratively.
 */
export const ATTENDANCE_STATUS_CHIP: Record<AttendanceStatus, string> = {
  present: "bg-[var(--cue-present-bg)] text-[var(--cue-present)]",
  late: "bg-[var(--cue-late-bg)] text-[var(--cue-late)]",
  excused: "bg-[var(--cue-excused-bg)] text-[var(--cue-excused)]",
  absent: "bg-[var(--cue-absent-bg)] text-[var(--cue-absent)]",
};

export const ABSENCE_STATUS_LABEL: Record<AbsenceStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  withdrawn: "Withdrawn",
};

/**
 * Pending borrows the attention colour, approved the present green, denied the
 * absent red, withdrawn the neutral raised surface. Every chip is paired with
 * its word, never colour alone.
 */
export const ABSENCE_STATUS_CHIP: Record<AbsenceStatus, string> = {
  pending: "bg-[var(--cue-late-bg)] text-[var(--cue-late)]",
  approved: "bg-[var(--cue-present-bg)] text-[var(--cue-present)]",
  denied: "bg-[var(--cue-absent-bg)] text-[var(--cue-absent)]",
  withdrawn: "bg-[var(--cue-raised)] text-[var(--cue-muted)]",
};

/** Why an attendance change happened, said in a person's words. */
export const HISTORY_SOURCE_LABEL: Record<AttendanceAuditEntry["source"], string> = {
  manual: "Staff correction",
  bulk: "Bulk action",
  check_in: "Student check-in",
  absence_request: "Absence decision",
  system: "Automatic",
};

/** A status filter value, including "none" for "no record". */
export const HISTORY_STATUS_LABEL: Record<AttendanceStatus | "none", string> = {
  present: "Present",
  late: "Late",
  excused: "Excused",
  absent: "Absent (recorded)",
  none: "No record",
};

export const ROLE_LABEL: Record<Role, string> = {
  director: "Director",
  secretary: "Secretary",
  section_leader: "Section leader",
  student: "Student",
};

/**
 * Why the weekly email does not reach somebody (033), said the way a director
 * would say it, and what — if anything — can be done about it. `opted_out` is
 * the one reason that is not a problem to fix: the member chose it.
 */
export const DIGEST_STATUS_LABEL: Record<DigestReachabilityStatus, string> = {
  reachable: "Will get it",
  opted_out: "Turned it off",
  no_sign_in: "No sign-in account",
  no_address: "No email address",
  unconfirmed: "Email not confirmed",
  account_deactivated: "Account deactivated",
};

export const DIGEST_STATUS_HINT: Record<DigestReachabilityStatus, string> = {
  reachable: "On the roster, with a confirmed address.",
  opted_out: "Their choice — they can turn it back on under Email in their settings.",
  no_sign_in:
    "On the roster, but no working sign-in account is linked to them — so there is no address to mail.",
  no_address: "Their account has no email address on it.",
  unconfirmed: "We only send to a confirmed address — they have not used the link in their sign-up email.",
  account_deactivated: "A deactivated account is not emailed.",
};

/**
 * Mirrors the mapping the calendar sync applies to synced events, so a manually
 * created event of the same type behaves the same way.
 */
export function defaultCheckinMode(type: string): CheckinMode {
  const t = type.trim().toLowerCase();
  if (
    ["rehearsal", "game", "concert", "competition", "performance"].includes(t)
  ) {
    return "qr";
  }
  return "toggle";
}

/** Attendance requirement follows the check-in mode: no mode = no attendance. */
export function defaultAttendanceRequirement(mode: CheckinMode): AttendanceRequirement {
  return mode === "none" ? "none" : "required";
}

/** Default site palette — also the fallback when a program stores no tokens. */
export const DEFAULT_THEME_TOKENS: Record<string, string> = {
  primary: "#1e4a32",
  primaryDeep: "#143324",
  accent: "#c7912c",
  surface: "#f6f5ef",
  ink: "#1b201b",
};

export const CHECKIN_CODE_LENGTH = 8;

/**
 * Which audience the auth screens are speaking to — student or teacher.
 *
 * At sign-up, this self-declared choice determines whether the account may
 * start a program. It grants no role in an existing program: director, section
 * leader and student memberships still come from the program roster.
 */
export type AuthAudience = "student" | "teacher";

const AUTH_AUDIENCE_KEY = "rhs:auth-audience";

export function readAuthAudience(): AuthAudience {
  try {
    return window.sessionStorage.getItem(AUTH_AUDIENCE_KEY) === "teacher"
      ? "teacher"
      : "student";
  } catch {
    /* private mode: fall back to the default copy */
    return "student";
  }
}

export function writeAuthAudience(audience: AuthAudience): void {
  try {
    window.sessionStorage.setItem(AUTH_AUDIENCE_KEY, audience);
  } catch {
    /* private mode: the choice just doesn't survive the session */
  }
}

/**
 * The feedback form's whole vocabulary. The values are the table's allow-list
 * (migration 20261108150000); the hints say what each one is *for*, so somebody
 * filing a bug does not have to guess between four similar words.
 */
export interface FeedbackCategoryOption {
  value: FeedbackCategory;
  label: string;
  hint: string;
}

export const FEEDBACK_CATEGORIES: FeedbackCategoryOption[] = [
  { value: "bug", label: "Bug Report", hint: "Something crashed or behaved wrongly." },
  { value: "feature", label: "Feature Request", hint: "Something you would like the site to do." },
  { value: "suggestion", label: "General Suggestion", hint: "An idea for making it better." },
  { value: "broken", label: "Something Isn't Working", hint: "A page or button won't do what it should." },
  { value: "other", label: "Other", hint: "Anything that doesn't fit above." },
];

const FEEDBACK_BY_VALUE = new Map(FEEDBACK_CATEGORIES.map((entry) => [entry.value, entry]));

/** A stored category's display label, including one written by a later build. */
export function feedbackCategoryLabel(value: string | null | undefined): string {
  return FEEDBACK_BY_VALUE.get(value as FeedbackCategory)?.label ?? "Other";
}

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: "New",
  reviewing: "Reviewing",
  resolved: "Resolved",
};

/**
 * New borrows the attention colour, reviewing the slate of something in hand,
 * resolved the present green. Only the four attendance statuses are otherwise
 * allowed to carry a colour, and these three reuse their proven token pairs.
 */
export const FEEDBACK_STATUS_CHIP: Record<FeedbackStatus, string> = {
  new: "bg-[var(--cue-late-bg)] text-[var(--cue-late)]",
  reviewing: "bg-[var(--cue-excused-bg)] text-[var(--cue-excused)]",
  resolved: "bg-[var(--cue-present-bg)] text-[var(--cue-present)]",
};

/** What a category means when it appears on a status menu or a filter. */
export const FEEDBACK_STATUS_HINT: Record<FeedbackStatus, string> = {
  new: "Not looked at yet.",
  reviewing: "Being worked on or considered.",
  resolved: "Answered, fixed or deliberately closed.",
};
