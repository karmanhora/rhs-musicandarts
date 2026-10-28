import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  Field,
  IconButton,
  Input,
  List,
  PageHeader,
  Row,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  Textarea,
  Toggle,
  cn,
  useToast,
} from "../components/ui";
import {
  createPersonalEvent,
  deleteEvent,
  deletePersonalEvent,
  fetchGoogleCalendarSource,
  fetchEvents,
  fetchPersonalEvents,
  insertEvent,
  setEventArchived,
  updateEvent,
} from "../lib/queries";
import type { EventDraft } from "../lib/queries";
import { importGoogleCalendar } from "../lib/rpc";
import type {
  AttendanceRequirement,
  CheckinMode,
  EventRow,
  PersonalEventRow,
} from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import {
  ATTENDANCE_REQUIREMENT_LABEL,
  CHECKIN_MODE_LABEL,
  EVENT_TYPES,
  defaultAttendanceRequirement,
  defaultCheckinMode,
  eventTypeChip,
  eventTypeLabel,
} from "../lib/constants";
import {
  addMonths,
  endOfDay,
  fmtDate,
  fmtMonthYear,
  fmtTime,
  googleCalendarUrl,
  isSameDay,
  monthMatrix,
  relativeDay,
  startOfDay,
  untilLabel,
} from "../lib/date";

/**
 * `/calendar` — the month the old app opened on, plus the agenda that answers
 * "what am I doing that day?".
 *
 * Students see their program's schedule and their own private reminders. Staff also
 * get the event form (add, edit, archive) — the same fields the calendar sync
 * writes, so a hand-made rehearsal and a synced one behave identically.
 */

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** `<input type="date">` wants yyyy-mm-dd in *local* time, never an ISO stamp. */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeKey(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Local wall-clock date + time → the ISO instant the database stores.
 *
 * Returns null rather than throwing when someone clears the date or time input:
 * a half-filled native input yields NaN, and `toISOString()` on an Invalid Date
 * would blow up mid-save instead of telling the director what is missing.
 */
function isoFrom(dateStr: string, timeStr: string, allDay: boolean): string | null {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = (allDay ? "00:00" : timeStr || "00:00").split(":").map(Number);
  if (!year || !month || !day || Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return new Date(year, month - 1, day, hours, minutes).toISOString();
}

interface FormState {
  id: string | null;
  name: string;
  event_type: string;
  date: string;
  time: string;
  endTime: string;
  all_day: boolean;
  location: string;
  description: string;
  checkin_mode: CheckinMode;
  attendance_requirement: AttendanceRequirement;
  late_minutes: string;
  /** UI-only: once someone chooses a mode by hand, stop deriving it from type. */
  modeTouched: boolean;
  requirementTouched: boolean;
}

function newForm(day: Date): FormState {
  const mode = defaultCheckinMode("rehearsal");
  return {
    id: null,
    name: "",
    event_type: "rehearsal",
    date: dateKey(day),
    time: "16:00",
    endTime: "",
    all_day: false,
    location: "",
    description: "",
    checkin_mode: mode,
    attendance_requirement: defaultAttendanceRequirement(mode),
    late_minutes: "0",
    modeTouched: false,
    requirementTouched: false,
  };
}

function formFromEvent(e: EventRow): FormState {
  return {
    id: e.id,
    name: e.name,
    event_type: e.event_type || e.type,
    date: dateKey(new Date(e.date)),
    time: timeKey(e.date),
    endTime: e.end_date ? timeKey(e.end_date) : "",
    all_day: e.all_day,
    location: e.location,
    description: e.description,
    checkin_mode: e.checkin_mode,
    attendance_requirement: e.attendance_requirement,
    late_minutes: String(e.late_minutes),
    modeTouched: true,
    requirementTouched: true,
  };
}

const MODE_OPTIONS = (Object.keys(CHECKIN_MODE_LABEL) as CheckinMode[]).map((m) => ({
  value: m,
  label: CHECKIN_MODE_LABEL[m],
}));

const REQUIREMENT_OPTIONS = (
  Object.keys(ATTENDANCE_REQUIREMENT_LABEL) as AttendanceRequirement[]
).map((r) => ({ value: r, label: ATTENDANCE_REQUIREMENT_LABEL[r] }));

export function CalendarScreen() {
  const app = usePrograms();
  const { toast } = useToast();
  const programId = app.program?.id ?? null;
  const profileId = app.profile?.id ?? null;
  const canManageEvents = app.can("attendance.manage_events");

  const today = useMemo(() => startOfDay(new Date()), []);
  const [cursor, setCursor] = useState<Date>(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<Date>(today);

  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [personal, setPersonal] = useState<PersonalEventRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<EventRow | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: "event" | "personal"; id: string; name: string } | null
  >(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reminder, setReminder] = useState("");
  const [calendarSource, setCalendarSource] = useState<{
    id: string;
    name: string;
    ics_url: string;
    last_synced_at: string | null;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [calendarUrl, setCalendarUrl] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!programId || !canManageEvents) {
      setCalendarSource(null);
      return;
    }
    let active = true;
    void fetchGoogleCalendarSource(programId).then((source) => {
      if (active) setCalendarSource(source);
    });
    return () => {
      active = false;
    };
  }, [programId, canManageEvents]);

  /** The grid shows a few days either side so a month never looks empty.
   * (Deliberately not named `window`: that would shadow the global one.) */
  const range = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const from = new Date(first);
    from.setDate(from.getDate() - 7);
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const to = new Date(last);
    to.setDate(to.getDate() + 7);
    return { from: startOfDay(from).toISOString(), to: endOfDay(to).toISOString() };
  }, [cursor]);

  const load = useCallback(async () => {
    if (!programId) return;
    try {
      setError(null);
      const [list, mine] = await Promise.all([
        fetchEvents(programId, {
          from: range.from,
          to: range.to,
          includeArchived: showArchived,
        }),
        fetchPersonalEvents(),
      ]);
      setEvents(list);
      setPersonal(mine);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the calendar.");
      setEvents([]);
    }
  }, [programId, range.from, range.to, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const map = new Map<string, EventRow[]>();
    for (const e of events ?? []) {
      const key = dateKey(new Date(e.date));
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }
    return map;
  }, [events]);

  const personalByDay = useMemo(() => {
    const map = new Map<string, PersonalEventRow[]>();
    for (const p of personal) {
      const key = dateKey(new Date(p.date));
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
    return map;
  }, [personal]);

  const weeks = useMemo(() => monthMatrix(cursor.getFullYear(), cursor.getMonth()), [cursor]);
  const dayEvents = byDay.get(dateKey(selectedDay)) ?? [];
  const dayPersonal = personalByDay.get(dateKey(selectedDay)) ?? [];
  const isThisMonth =
    cursor.getFullYear() === today.getFullYear() && cursor.getMonth() === today.getMonth();

  async function saveForm() {
    if (!form || !programId || !profileId) return;
    if (!form.name.trim()) {
      setFormError("Give the event a name.");
      return;
    }
    const startIso = isoFrom(form.date, form.time, form.all_day);
    if (!startIso) {
      setFormError(
        form.all_day ? "Pick a date." : "Pick a date and a start time."
      );
      return;
    }
    const draft: EventDraft = {
      name: form.name.trim(),
      event_type: form.event_type,
      date: startIso,
      end_date:
        form.all_day || !form.endTime ? null : isoFrom(form.date, form.endTime, false),
      all_day: form.all_day,
      location: form.location.trim(),
      description: form.description.trim(),
      checkin_mode: form.checkin_mode,
      attendance_requirement: form.attendance_requirement,
      late_minutes: Number(form.late_minutes) || 0,
    };

    setSaving(true);
    setFormError(null);
    const editing = Boolean(form.id);
    const { error: writeError } = editing
      ? await updateEvent(form.id as string, draft)
      : await insertEvent(programId, profileId, draft);
    setSaving(false);

    if (writeError) {
      setFormError(writeError.message);
      return;
    }
    setForm(null);
    toast.success(editing ? "Event updated." : "Event added.");
    await load();
  }

  async function toggleArchived(event: EventRow) {
    setBusyId(event.id);
    const { error: writeError } = await setEventArchived(event.id, !event.archived);
    setBusyId(null);
    if (writeError) {
      toast.error(writeError.message);
      return;
    }
    toast.success(event.archived ? "Event restored." : "Event archived.");
    setDetail(null);
    await load();
  }

  async function removeConfirmed() {
    if (!confirm) return;
    setBusyId(confirm.id);
    if (confirm.kind === "personal") {
      await deletePersonalEvent(confirm.id);
    } else {
      const { error: writeError } = await deleteEvent(confirm.id);
      if (writeError) {
        setBusyId(null);
        toast.error(writeError.message);
        setConfirm(null);
        return;
      }
    }
    setBusyId(null);
    setConfirm(null);
    setDetail(null);
    toast.success("Deleted.");
    await load();
  }

  async function addReminder() {
    if (!profileId || !reminder.trim()) return;
    const { error: writeError } = await createPersonalEvent({
      owner_id: profileId,
      name: reminder.trim(),
      date: startOfDay(selectedDay).toISOString(),
    });
    if (writeError) {
      toast.error(writeError.message);
      return;
    }
    setReminder("");
    toast.success("Added to your own calendar.");
    await load();
  }

  async function importCalendar() {
    if (!programId || !calendarUrl.trim()) {
      setImportError("Enter the calendar's public iCal URL.");
      return;
    }
    setImporting(true);
    setImportError(null);
    const { result, error: importFailure } = await importGoogleCalendar(programId, calendarUrl);
    setImporting(false);
    if (importFailure || !result?.ok) {
      setImportError(importFailure || result?.message || "Could not import this calendar.");
      return;
    }
    setImportOpen(false);
    toast.success(
      `Calendar imported: ${result.inserted ?? 0} added, ${result.updated ?? 0} updated.`
    );
    if (result.warning) toast.error(result.warning);
    setCalendarSource(await fetchGoogleCalendarSource(programId));
    await load();
  }

  if (!programId) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="cue-stagger mx-auto max-w-6xl space-y-6 px-4 py-5 pb-10 sm:px-6 sm:py-6">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <PageHeader
        kicker={app.program?.short_name || app.program?.name || "Program"}
        title={fmtMonthYear(cursor.getFullYear(), cursor.getMonth())}
        note={`${events?.length ?? 0} ${
          (events?.length ?? 0) === 1 ? "event" : "events"
        } in view · pick a day to read its schedule`}
        actions={
          <>
            {/* 8px between the two arrows: at 0 they were one 88px target with a
                seam down the middle. */}
            <div className="flex items-center gap-2">
              <IconButton
                label="Previous month"
                icon={<ChevronLeft className="h-4 w-4" />}
                onClick={() => setCursor((c) => addMonths(c, -1))}
              />
              <IconButton
                label="Next month"
                icon={<ChevronRight className="h-4 w-4" />}
                onClick={() => setCursor((c) => addMonths(c, 1))}
              />
            </div>
            {!isThisMonth ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
                  setSelectedDay(today);
                }}
              >
                Today
              </Button>
            ) : null}
            {app.isStaff ? (
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setFormError(null);
                  setForm(newForm(selectedDay));
                }}
              >
                Add event
              </Button>
            ) : null}
          </>
        }
      />

      {canManageEvents ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--cue-line)] pb-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Google Calendar</p>
            <p className="type-meta">
              {calendarSource ? `Connected: ${calendarSource.name}` : "No calendar connected"}
              {/* The scheduled sync refreshes this without anyone pressing Import;
                  a stale stamp is how a broken feed (404, throttle) shows up. */}
              {calendarSource?.last_synced_at
                ? ` · Synced ${untilLabel(calendarSource.last_synced_at)}`
                : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={<CalendarDays className="h-4 w-4" />}
            onClick={() => {
              setCalendarUrl(calendarSource?.ics_url ?? "");
              setImportError(null);
              setImportOpen(true);
            }}
          >
            Import Google Calendar
          </Button>
        </div>
      ) : null}

      {/* --- the grid: a month as a ruled table, not a tray of tiles --- */}
      <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
        <div className="grid grid-cols-7 border-b border-[var(--cue-line)]">
          {WEEKDAYS.map((w, i) => (
            <span key={`${w}-${i}`} className="type-label py-1.5 text-center">
              {w}
            </span>
          ))}
        </div>
        <div
          className={cn(
            "grid grid-cols-7",
            "[&>*]:border-t [&>*]:border-l [&>*]:border-[var(--cue-line)]",
            "[&>*:nth-child(7n + 1)]:border-l-0 [&>*:nth-child(-n + 7)]:border-t-0"
          )}
        >
          {weeks.flatMap((week, wi) =>
            week.map((day, di) => {
              if (!day) return <span key={`${wi}-${di}`} className="min-h-14" />;
              const key = dateKey(day);
              const list = byDay.get(key) ?? [];
              const mine = personalByDay.get(key) ?? [];
              const isToday = isSameDay(day, today);
              const isSelected = isSameDay(day, selectedDay);
              const marks = list.length + mine.length;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={`${fmtDate(day)} — ${
                    marks === 0 ? "nothing scheduled" : `${marks} scheduled`
                  }`}
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedDay(startOfDay(day))}
                  className={cn(
                    "flex min-h-14 flex-col items-center gap-1 px-0.5 pt-1.5 transition-colors sm:min-h-16",
                    /* The day you are on is tinted leaf rather than grey, so the
                       month and the agenda below are visibly the same choice. */
                    isSelected ? "bg-[var(--cue-leaf-soft)]" : "hover:bg-[var(--cue-raised)]",
                    /* Today keeps a leaf ring all month, whatever is selected. */
                    isToday && "shadow-[inset_0_0_0_2px_var(--cue-leaf)]"
                  )}
                >
                  <span
                    className={cn(
                      "type-figure text-lg",
                      isToday ? "text-[var(--cue-leaf)]" : "text-[var(--cue-ink)]",
                      isSelected && "font-bold"
                    )}
                  >
                    {day.getDate()}
                  </span>
                  {/* Green: something the program runs. Gold: your own reminder. */}
                  <span className="flex h-1.5 items-center gap-0.5">
                    {list.slice(0, 3).map((e) => (
                      <span key={e.id} className="h-1.5 w-1.5 bg-[var(--cue-green)]" />
                    ))}
                    {mine.length > 0 ? (
                      <span className="h-1.5 w-1.5 bg-[var(--cue-gold)]" />
                    ) : null}
                  </span>
                  {marks > 3 ? (
                    <span className="type-meta text-[10px] leading-none tabular">{marks}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>

      {app.isStaff ? (
        <div className="flex items-center gap-2">
          <Toggle checked={showArchived} onChange={setShowArchived} label="Show archived events" />
          <span className="text-sm font-semibold">Show archived events</span>
          <span className="type-meta">— cancelled things you may still need the history for</span>
        </div>
      ) : null}

      {/* --- agenda for the chosen day ---
           The dateline carries the page: the day in the poster voice, the
           month beside it, the count on the far side. It is what makes a
           selected square in the grid resolve into an actual day. */}
      <section className="space-y-3">
        <header className="section-rule">
          <div className="flex items-baseline gap-3">
            <span className="type-figure text-4xl leading-none">{selectedDay.getDate()}</span>
            <span className="min-w-0">
              <span className="type-kicker block">
                {isSameDay(selectedDay, today) ? "Today" : relativeDay(selectedDay.toISOString())}
              </span>
              <span className="type-heading block">
                {selectedDay.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              </span>
            </span>
          </div>
          <span className="type-meta shrink-0 tabular">
            {dayEvents.length + dayPersonal.length} scheduled
          </span>
        </header>

        {events === null ? (
          <Skeleton className="h-24 w-full" />
        ) : dayEvents.length === 0 && dayPersonal.length === 0 ? (
          <div className="cue-card rounded-[var(--radius-panel)]">
            <EmptyState
              icon={<CalendarDays className="h-4 w-4" />}
              title="Nothing on this day"
              body={
                app.isStaff
                  ? "Add a rehearsal, performance or meeting to the schedule, or pick another day."
                  : "Nothing scheduled for this program — or pick another day."
              }
            />
          </div>
        ) : (
          <List>
            {dayEvents.map((e) => {
              return (
                <Row
                  key={e.id}
                  className="gap-4"
                  leading={
                    <time className="w-20 shrink-0 text-right tabular">
                      <span className="type-figure block text-lg leading-tight">
                        {e.all_day ? "All day" : fmtTime(e.date)}
                      </span>
                      {!e.all_day && e.end_date ? (
                        <span className="type-meta block text-[11px] leading-tight">
                          to {fmtTime(e.end_date)}
                        </span>
                      ) : null}
                    </time>
                  }
                  title={
                    <span className="flex items-baseline gap-2">
                      <span className="truncate">{e.name}</span>
                      <Badge className={eventTypeChip(e.event_type)}>
                        {eventTypeLabel(e.event_type)}
                      </Badge>
                      {e.archived ? (
                        <Badge className="bg-[var(--cue-raised)] text-[var(--cue-muted)]">
                          Cancelled
                        </Badge>
                      ) : null}
                    </span>
                  }
                  subtitle={
                    e.location ? (
                      <span className="inline-flex items-center gap-1">
                        <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        {e.location}
                      </span>
                    ) : undefined
                  }
                  trailing={
                    <ChevronRight
                      aria-hidden="true"
                      className="cue-nudge h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                    />
                  }
                  onClick={() => setDetail(e)}
                />
              );
            })}

            {dayPersonal.map((p) => (
              <Row
                key={p.id}
                className="gap-4"
                leading={
                  <span className="type-meta flex w-20 shrink-0 items-center gap-1.5">
                    <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--cue-gold)]" />
                    Yours
                  </span>
                }
                title={p.name}
                subtitle={p.location || "Private to you — never affects attendance"}
                trailing={
                  <IconButton
                    label={`Delete ${p.name}`}
                    variant="ghost"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setConfirm({ kind: "personal", id: p.id, name: p.name })}
                  />
                }
              />
            ))}
          </List>
        )}

        {profileId ? (
          <Card className="space-y-3">
            <p className="type-heading">Add your own reminder</p>
            <div className="flex items-end gap-2">
              <Field className="flex-1">
                <Input
                  value={reminder}
                  onChange={(e) => setReminder(e.target.value)}
                  placeholder="Percussion practice"
                  aria-label="Your own reminder"
                />
              </Field>
              <Button
                variant="secondary"
                icon={<Plus className="h-4 w-4" />}
                disabled={!reminder.trim()}
                onClick={() => void addReminder()}
              >
                Add
              </Button>
            </div>
            <p className="type-meta">
              It lands on {relativeDay(selectedDay.toISOString()).toLowerCase()}, only you can see
              it, and it never affects attendance.
            </p>
          </Card>
        ) : null}
      </section>

      {/* --- event detail --- */}
      <Sheet
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.name ?? "Event"}
        description={detail ? eventTypeLabel(detail.event_type) : undefined}
      >
        {detail ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="flex items-center gap-2 font-semibold tabular">
                <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
                {relativeDay(detail.date)} ·{" "}
                {detail.all_day ? "All day" : fmtTime(detail.date)}
                {!detail.all_day && detail.end_date ? ` – ${fmtTime(detail.end_date)}` : ""}
              </p>
              {detail.location ? (
                <p className="flex items-center gap-2 font-semibold">
                  <MapPin aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
                  {detail.location}
                </p>
              ) : null}
              {detail.description ? (
                <p className="text-sm whitespace-pre-wrap text-[var(--cue-muted)]">
                  {detail.description}
                </p>
              ) : null}
            </div>

            <dl className="cue-card cue-list overflow-hidden rounded-[var(--radius-panel)] text-sm">
              <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                <dt className="type-label">Check-in</dt>
                <dd className="font-medium">{CHECKIN_MODE_LABEL[detail.checkin_mode]}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                <dt className="type-label">Attendance</dt>
                <dd className="font-medium">
                  {ATTENDANCE_REQUIREMENT_LABEL[detail.attendance_requirement]}
                </dd>
              </div>
              {detail.event_source === "google_calendar" ? (
                <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                  <dt className="type-label">Source</dt>
                  <dd className="font-medium">Synced from the school calendar</dd>
                </div>
              ) : null}
            </dl>

            <Button
              block
              variant="secondary"
              onClick={() =>
                window.open(
                  googleCalendarUrl({
                    name: detail.name,
                    date: detail.date,
                    endDate: detail.end_date,
                    location: detail.location,
                    details: detail.description,
                    allDay: detail.all_day,
                  }),
                  "_blank",
                  "noopener"
                )
              }
            >
              Add to Google Calendar
            </Button>

            {app.isStaff ? (
              <div className="space-y-2">
                {/* Stacked, not a flex row: `Button` is `shrink-0` and `block`
                    makes it `w-full`, so two of them in a row cannot shrink and
                    the second one is pushed outside the sheet (see the footer
                    note in `ui.tsx`). */}
                <div className="space-y-2">
                  <Button
                    block
                    variant="secondary"
                    icon={<Pencil className="h-4 w-4" />}
                    onClick={() => {
                      setFormError(null);
                      setForm(formFromEvent(detail));
                      setDetail(null);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    block
                    variant="secondary"
                    loading={busyId === detail.id}
                    icon={
                      detail.archived ? (
                        <ArchiveRestore className="h-4 w-4" />
                      ) : (
                        <Archive className="h-4 w-4" />
                      )
                    }
                    onClick={() => void toggleArchived(detail)}
                  >
                    {detail.archived ? "Restore" : "Archive"}
                  </Button>
                </div>
                {app.isDirector ? (
                  <Button
                    block
                    variant="danger"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() =>
                      setConfirm({ kind: "event", id: detail.id, name: detail.name })
                    }
                  >
                    Delete event
                  </Button>
                ) : (
                  <p className="type-meta">
                    Archiving hides it from the program; only a director can delete it.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import Google Calendar"
        description="Bring this program's events into the calendar."
        size="tall"
        footer={
          <>
            <Button
              variant="secondary"
              block
              onClick={() => setImportOpen(false)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button block loading={importing} onClick={() => void importCalendar()}>
              Import calendar
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {importError ? <Alert tone="error">{importError}</Alert> : null}
          <Field
            label="Public iCal URL"
            hint="Use the public address in iCal format from Google Calendar settings. Imported events can be edited in this calendar."
          >
            <Input
              type="url"
              value={calendarUrl}
              onChange={(event) => setCalendarUrl(event.target.value)}
              placeholder="https://calendar.google.com/calendar/ical/.../public/basic.ics"
              autoComplete="url"
              aria-label="Google Calendar public iCal URL"
            />
          </Field>
        </div>
      </Sheet>

      {/* --- add / edit form (staff) --- */}
      <Sheet
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "Edit event" : "Add event"}
        description={
          form?.id
            ? "Everyone in this program gets a notification when you save."
            : "Everyone in this program gets a notification. Students also get an email with the date, time and where to be."
        }
        size="tall"
        footer={
          <>
            <Button variant="secondary" block onClick={() => setForm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button block loading={saving} onClick={() => void saveForm()}>
              {form?.id ? "Save changes" : "Add event"}
            </Button>
          </>
        }
      >
        {form ? (
          <div className="space-y-4">
            {formError ? <Alert tone="error">{formError}</Alert> : null}

            {!form.id ? (
              <p className="type-meta rounded-[var(--cue-radius)] bg-[var(--cue-raised)] px-3 py-2.5">
                Saving emails the students in this program the event name, date, start time and
                location. It sends once — editing the event later does not email again. Students who
                turned off event emails in Account settings get the notification only.
              </p>
            ) : null}

            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Tuesday rehearsal"
              />
            </Field>

            <Field label="Type">
              <Select
                value={form.event_type}
                onChange={(e) => {
                  const next = e.target.value;
                  setForm((f) => {
                    if (!f) return f;
                    const mode = f.modeTouched ? f.checkin_mode : defaultCheckinMode(next);
                    return {
                      ...f,
                      event_type: next,
                      checkin_mode: mode,
                      attendance_requirement: f.requirementTouched
                        ? f.attendance_requirement
                        : defaultAttendanceRequirement(mode),
                    };
                  });
                }}
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="flex items-center justify-between gap-3 border-b border-[var(--cue-line)] pb-2">
              <span className="text-sm font-semibold">All day</span>
              <Toggle
                checked={form.all_day}
                onChange={(next) => setForm({ ...form, all_day: next })}
                label="All day"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">
                <Input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                />
              </Field>
              {form.all_day ? null : (
                <Field label="Starts">
                  <Input
                    type="time"
                    value={form.time}
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                  />
                </Field>
              )}
            </div>

            {form.all_day ? null : (
              <Field
                label="Ends"
                hint={
                  // The end time is what closes check-in: with one saved, the
                  // QR code stops working the moment the event does
                  // (`record_checkin_for_session`). Without one, check-in stays
                  // open for 24 hours after the start, which is the state a
                  // teacher reporting "the code still works" is usually in.
                  form.checkin_mode === "qr" || form.checkin_mode === "both"
                    ? "Check-in stops when this time passes. Left empty, the code keeps working for 24 hours after the start."
                    : "Leave empty if you don't know — it's optional."
                }
              >
                <Input
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                />
              </Field>
            )}

            <Field label="Location">
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="Rehearsal room"
              />
            </Field>

            <Field label="Details" hint="Shown when someone taps the event.">
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Bring your marching shoes."
              />
            </Field>

            <Field label="How do students check in?">
              <SegmentedControl
                className="flex-wrap"
                value={form.checkin_mode}
                onChange={(mode) =>
                  setForm((f) =>
                    f
                      ? {
                          ...f,
                          checkin_mode: mode,
                          modeTouched: true,
                          attendance_requirement: f.requirementTouched
                            ? f.attendance_requirement
                            : defaultAttendanceRequirement(mode),
                        }
                      : f
                  )
                }
                options={MODE_OPTIONS}
              />
            </Field>

            <Field label="Attendance">
              <SegmentedControl
                value={form.attendance_requirement}
                onChange={(r) =>
                  setForm((f) => (f ? { ...f, attendance_requirement: r, requirementTouched: true } : f))
                }
                options={REQUIREMENT_OPTIONS}
              />
            </Field>

            <Field
              label="Counts as late after"
              hint="Minutes past the start time. 0 turns late marking off."
            >
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                value={form.late_minutes}
                onChange={(e) => setForm({ ...form, late_minutes: e.target.value })}
              />
            </Field>

            {form.attendance_requirement === "required" && form.checkin_mode === "qr" ? (
              <Alert tone="info">
                Students scan the code you project from the Check in screen. Their percentage only
                counts events marked Required.
              </Alert>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <ConfirmSheet
        open={confirm !== null}
        title={confirm?.kind === "personal" ? "Delete your reminder?" : "Delete this event?"}
        body={
          confirm?.kind === "personal"
            ? `“${confirm?.name}” will be removed from your calendar.`
            : `“${confirm?.name}” and its attendance records will be deleted for good. Archiving keeps the history — that's usually what you want.`
        }
        confirmLabel="Delete"
        loading={busyId !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void removeConfirmed()}
      />
    </div>
  );
}
