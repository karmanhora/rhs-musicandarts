/**
 * Make-up email text, shared by the composer and its preview.
 *
 * The sending function in `supabase/functions/send-makeup-emails` performs the
 * same substitution server-side; these helpers exist so the preview shows the
 * teacher exactly what a student will receive. Keep the token list in step.
 */

export const MAKEUP_PLACEHOLDERS = [
  { token: "{student_name}", label: "Student name" },
  { token: "{event_name}", label: "Event name" },
  { token: "{event_date}", label: "Event date" },
  { token: "{event_time}", label: "Event time" },
  { token: "{program_name}", label: "Program name" },
  { token: "{teacher_name}", label: "Teacher name" },
  { token: "{makeup_instructions}", label: "Make-up instructions" },
] as const;

const KNOWN_TOKENS = new Set(MAKEUP_PLACEHOLDERS.map((item) => item.token));

/** The school's clock, matching the event digest and the sending function. */
const SCHOOL_TIME_ZONE = "America/Los_Angeles";

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

export function makeupDateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dayFormat.format(date);
}

export function makeupTimeLabel(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  allDay = false
): string {
  if (allDay) return "All day";
  if (!startIso) return "";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "";
  const startLabel = timeFormat.format(start);
  if (!endIso) return startLabel;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return startLabel;
  return `${startLabel} – ${timeFormat.format(end)}`;
}

export function defaultMakeupSubject(eventName: string): string {
  return `Make-Up Instructions for ${eventName}`;
}

export const DEFAULT_MAKEUP_BODY = `Hello {student_name},

Our attendance records indicate that you were marked absent for {event_name} on {event_date}.

Please complete the following make-up activity or follow these instructions:

{makeup_instructions}

If you believe your attendance was recorded incorrectly, please contact your teacher.

Thank you,
{teacher_name}
{program_name}`;

export interface MakeupTemplateValues {
  student_name: string;
  event_name: string;
  event_date: string;
  event_time: string;
  program_name: string;
  teacher_name: string;
  makeup_instructions: string;
}

export function fillMakeupTemplate(template: string, values: MakeupTemplateValues): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? (values[key as keyof MakeupTemplateValues] ?? "")
      : whole
  );
}

/**
 * Tokens the sender will not replace. A known token is always replaced (with an
 * empty string when the value is missing); anything else is left verbatim and
 * is what the teacher needs to fix before sending.
 */
export function unresolvedPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(/\{[a-z_]+\}/g)) {
    if (!KNOWN_TOKENS.has(match[0] as (typeof MAKEUP_PLACEHOLDERS)[number]["token"])) {
      found.add(match[0]);
    }
  }
  return [...found];
}

/** Everything the preview needs for one student. */
export function makeupValuesFor(
  event: { name: string; date: string; end_date: string | null; all_day: boolean },
  programName: string,
  teacherName: string,
  studentName: string,
  instructions: string
): MakeupTemplateValues {
  return {
    student_name: studentName,
    event_name: event.name,
    event_date: makeupDateLabel(event.date),
    event_time: makeupTimeLabel(event.date, event.end_date, event.all_day),
    program_name: programName,
    teacher_name: teacherName,
    makeup_instructions: instructions,
  };
}
