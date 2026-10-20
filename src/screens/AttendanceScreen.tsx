import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardList,
  QrCode,
  Search,
  StickyNote,
  Users,
} from "lucide-react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ConfirmSheet,
  EmptyState,
  Field,
  Input,
  Metric,
  MetricStrip,
  PageHeader,
  Poster,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  Stage,
  TempoBars,
  Textarea,
  Toggle,
  cn,
  useToast,
} from "../components/ui";
import { MakeupEmailPanel } from "../components/MakeupEmailComposer";
import { fetchAttendance, fetchEvents, fetchRoster, fetchStaffNotes } from "../lib/queries";
import { overrideAttendance } from "../lib/rpc";
import type { AttendanceRow, AttendanceStatus, EventRow, RosterMember } from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import {
  ATTENDANCE_STATUS_CHIP,
  ATTENDANCE_STATUS_LABEL,
  eventTypeChip,
  eventTypeLabel,
} from "../lib/constants";
import { endOfDay, fmtTime, relativeDay, startOfDay } from "../lib/date";

/**
 * `/attendance` — the roll.
 *
 * One event, everyone in it, one tap per student. The screen is deliberately a
 * single work surface rather than a column of cards: the figures, the filters
 * and the names all describe the same event, so they share one panel. Passing
 * the existing staff note back through every status change matters:
 * `override_attendance` replaces the note wholesale, and saving a status with an
 * empty note would silently erase it.
 */

const STATUS_OPTIONS: { value: AttendanceStatus; label: string }[] = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "excused", label: "Excused" },
  { value: "absent", label: "Absent" },
];

/** Closest to now first, and today always wins — that is the roll you mark. */
function rank(event: EventRow): number {
  const ms = Math.abs(new Date(event.date).getTime() - Date.now());
  const today = new Date(event.date).toDateString() === new Date().toDateString();
  return today ? ms - 1000 * 60 * 60 * 24 * 7 : ms;
}

export function AttendanceScreen() {
  const app = usePrograms();
  const navigate = useNavigate();
  const { toast } = useToast();
  const programId = app.program?.id ?? null;

  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [roster, setRoster] = useState<RosterMember[] | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const [section, setSection] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [onlyUnmarked, setOnlyUnmarked] = useState(false);

  const [editing, setEditing] = useState<RosterMember | null>(null);
  const [draftStatus, setDraftStatus] = useState<AttendanceStatus>("present");
  const [draftExcuse, setDraftExcuse] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyStudent, setBusyStudent] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulking, setBulking] = useState(false);

  const selected = useMemo(
    () => (events ?? []).find((e) => e.id === selectedId) ?? null,
    [events, selectedId]
  );

  // --- load the event list + the roster ------------------------------------
  const loadBase = useCallback(async () => {
    if (!programId) return;
    try {
      setError(null);
      const [list, people] = await Promise.all([fetchEvents(programId), fetchRoster(programId)]);
      setEvents(list);
      setRoster(people);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the roll.");
      setEvents([]);
      setRoster([]);
    }
  }, [programId]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // Pick a sensible default once, then leave the choice alone.
  useEffect(() => {
    if (selectedId || !events || events.length === 0) return;
    const sorted = [...events].sort((a, b) => rank(a) - rank(b));
    setSelectedId(sorted[0].id);
  }, [events, selectedId]);

  // --- load that event's attendance ---------------------------------------
  const loadAttendance = useCallback(async () => {
    if (!programId || !selected) {
      setAttendance([]);
      setNotes(new Map());
      return;
    }
    try {
      const rows = await fetchAttendance(programId, {
        from: startOfDay(selected.date).toISOString(),
        to: endOfDay(selected.date).toISOString(),
      });
      const mine = rows.filter((r) => r.event_id === selected.id);
      setAttendance(mine);

      const noteRows = await fetchStaffNotes(mine.map((r) => r.id));
      const map = new Map<string, string>();
      for (const n of noteRows) map.set(n.attendance_record_id, n.staff_note);
      setNotes(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this event's marks.");
      setAttendance([]);
      setNotes(new Map());
    }
  }, [programId, selected]);

  useEffect(() => {
    void loadAttendance();
  }, [loadAttendance]);

  // --- derived -------------------------------------------------------------
  // Only people who are actually in the program take the roll — someone a
  // director removed must not sit in the denominator as "not marked" forever.
  const students = useMemo(
    () =>
      (roster ?? [])
        .filter((m) => m.active && !m.roles.includes("director"))
        .sort((a, b) =>
          a.section_name === b.section_name
            ? (a.profile.display_name || a.profile.full_name).localeCompare(
                b.profile.display_name || b.profile.full_name
              )
            : a.section_name.localeCompare(b.section_name)
        ),
    [roster]
  );

  const byStudent = useMemo(() => {
    const map = new Map<string, AttendanceRow>();
    for (const a of attendance) map.set(a.student_id, a);
    return map;
  }, [attendance]);

  const counts = useMemo(() => {
    let present = 0;
    let late = 0;
    let excused = 0;
    for (const s of students) {
      const row = byStudent.get(s.user_id);
      if (!row) continue;
      if (row.status === "present") present += 1;
      else if (row.status === "late") late += 1;
      else if (row.status === "excused") excused += 1;
    }
    const marked = present + late + excused;
    return { present, late, excused, marked, unmarked: Math.max(0, students.length - marked) };
  }, [students, byStudent]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students.filter((s) => {
      if (section !== "all" && (s.section_name || "none") !== section) return false;
      if (onlyUnmarked && byStudent.has(s.user_id)) return false;
      if (!q) return true;
      return (
        s.profile.full_name.toLowerCase().includes(q) ||
        s.profile.display_name.toLowerCase().includes(q)
      );
    });
  }, [students, section, onlyUnmarked, query, byStudent]);

  const sectionOptions = useMemo(() => {
    const countsBySection = new Map<string, number>();
    for (const s of students) {
      const key = s.section_name || "none";
      countsBySection.set(key, (countsBySection.get(key) ?? 0) + 1);
    }
    const options = app.sections
      .map((sec) => ({ key: sec.name, label: sec.name, n: countsBySection.get(sec.name) ?? 0 }))
      .filter((c) => c.n > 0);
    if ((countsBySection.get("none") ?? 0) > 0) {
      options.push({ key: "none", label: "No section", n: countsBySection.get("none") ?? 0 });
    }
    return options;
  }, [students, app.sections]);

  // --- writes --------------------------------------------------------------
  const existingNote = useCallback(
    (studentId: string) => {
      const row = byStudent.get(studentId);
      return row ? (notes.get(row.id) ?? "") : "";
    },
    [byStudent, notes]
  );

  async function mark(
    studentId: string,
    status: AttendanceStatus,
    excuse = "",
    note = ""
  ): Promise<boolean> {
    if (!selected) return false;
    const { result, error: rpcError } = await overrideAttendance(
      selected.id,
      studentId,
      status,
      excuse,
      note
    );
    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not save that mark.");
      return false;
    }
    return true;
  }

  /** One-tap present — keeps any staff note that was already there. */
  async function quickPresent(student: RosterMember) {
    setBusyStudent(student.user_id);
    const ok = await mark(student.user_id, "present", "", existingNote(student.user_id));
    setBusyStudent(null);
    if (ok) await loadAttendance();
  }

  function openEditor(student: RosterMember) {
    const row = byStudent.get(student.user_id);
    setEditing(student);
    setDraftStatus(row?.status ?? "present");
    setDraftExcuse(row?.excuse_reason ?? "");
    setDraftNote(row ? (notes.get(row.id) ?? "") : "");
  }

  async function saveEditor() {
    if (!editing) return;
    setSaving(true);
    const ok = await mark(
      editing.user_id,
      draftStatus,
      draftStatus === "excused" ? draftExcuse : "",
      draftNote
    );
    setSaving(false);
    if (!ok) return;
    setEditing(null);
    toast.success("Saved.");
    await loadAttendance();
  }

  async function markAllRemaining() {
    if (!selected) return;
    const remaining = students.filter((s) => !byStudent.has(s.user_id));
    setBulking(true);
    let failed = 0;
    for (const student of remaining) {
      const ok = await mark(student.user_id, "present");
      if (!ok) failed += 1;
    }
    setBulking(false);
    setBulkOpen(false);
    await loadAttendance();
    if (failed > 0) {
      toast.warn(`Marked ${remaining.length - failed} present — ${failed} wouldn't save.`);
    } else {
      toast.success(`Marked ${remaining.length} present.`);
    }
  }

  if (!programId) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-16 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const pct = students.length ? Math.round((counts.marked / students.length) * 100) : 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-5">
        {error ? <Alert tone="error">{error}</Alert> : null}

        {/* The roll gets a stage rather than a title bar: the event you are
            marking is the page, and the one action worth taking — mark the
            rest present — belongs next to it, not buried in a filter row. */}
        {selected ? (
          <Stage motif className="px-5 py-6 sm:px-7">
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
              <div className="min-w-0">
                <p className="type-kicker text-[var(--cue-gold-on-brand)]">
                  {app.program?.short_name || app.program?.name || "Program"} · the roll
                </p>
                <h1 className="mt-2.5 text-[var(--cue-stage-ink)]">
                  <Poster tone="stage" rule>
                    {selected.name}
                  </Poster>
                </h1>
                <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.8125rem] text-[var(--cue-stage-ink)]/80">
                  <span className="inline-flex items-center gap-1.5 tabular">
                    <CalendarDays aria-hidden="true" className="h-4 w-4 opacity-70" />
                    {relativeDay(selected.date)} ·{" "}
                    {selected.all_day ? "All day" : fmtTime(selected.date)}
                  </span>
                  <Badge className="border border-[var(--cue-stage-line)] bg-white/10 text-[var(--cue-stage-ink)]">
                    {eventTypeLabel(selected.event_type)}
                  </Badge>
                </p>
              </div>

              <div className="flex w-full flex-col gap-4 sm:w-auto sm:min-w-[15rem]">
                <div>
                  <p className="type-kicker text-[var(--cue-stage-ink)]/60">Marked</p>
                  {/* Keyed on the count, so every mark that lands shows itself. */}
                  <p className="type-figure mt-1 flex items-baseline gap-1.5 text-4xl text-[var(--cue-stage-ink)] tabular">
                    <span key={counts.marked} className="cue-odometer">
                      {counts.marked}
                    </span>
                    <span className="text-xl text-[var(--cue-stage-ink)]/55">
                      of {students.length}
                    </span>
                    {counts.unmarked > 0 ? (
                      <TempoBars className="ml-1 self-center text-[var(--cue-gold-on-brand)]" />
                    ) : null}
                  </p>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/15">
                    <div
                      className="cue-meter-fill h-full rounded-full bg-[var(--cue-gold-on-brand)]"
                      style={{ transform: `scaleX(${pct / 100})` }}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {counts.unmarked > 0 ? (
                    <button
                      type="button"
                      onClick={() => setBulkOpen(true)}
                      className="motion-press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--cue-stage-ink)] px-4 text-sm font-semibold text-[var(--cue-forest)] hover:-translate-y-px hover:bg-white"
                    >
                      <Check aria-hidden="true" className="h-4 w-4" />
                      Mark {counts.unmarked} present
                    </button>
                  ) : null}
                  {events && events.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setPickerOpen(true)}
                      className="motion-press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--cue-stage-line)] px-4 text-sm font-semibold text-[var(--cue-stage-ink)] hover:-translate-y-px hover:bg-white/10"
                    >
                      <CalendarDays aria-hidden="true" className="h-4 w-4" />
                      Change event
                    </button>
                  ) : null}
                  {selected.checkin_mode === "qr" ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/checkin?event=${selected.id}`)}
                      className="motion-press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--cue-stage-line)] px-4 text-sm font-semibold text-[var(--cue-stage-ink)] hover:-translate-y-px hover:bg-white/10"
                    >
                      <QrCode aria-hidden="true" className="h-4 w-4" />
                      Students scan instead
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </Stage>
        ) : (
          <PageHeader
            kicker={`${app.program?.short_name || app.program?.name || "Program"} · the roll`}
            title="Attendance"
            note="Pick the event you are taking attendance for."
            actions={
              events && events.length > 0 ? (
                <Button
                  variant="secondary"
                  icon={<CalendarDays className="h-4 w-4" />}
                  iconAfter={<ChevronDown className="h-4 w-4" />}
                  onClick={() => setPickerOpen(true)}
                >
                  Choose event
                </Button>
              ) : null
            }
          />
        )}

        {app.isSectionLeader && !app.isDirector && !app.isSecretary ? (
          <Alert tone="info">
            You can mark the students in your own section. Everyone else is read-only for you.
          </Alert>
        ) : null}

        {events === null ? (
          <Skeleton className="h-64 w-full" />
        ) : events.length === 0 ? (
          <div className="cue-card rounded-[var(--radius-panel)]">
            <EmptyState
              icon={<CalendarDays className="h-4 w-4" />}
              title="No events to mark yet"
              body="Add a rehearsal or performance on the Calendar screen and the roll appears here."
              action={
                <Button variant="secondary" onClick={() => navigate("/calendar")}>
                  Open the calendar
                </Button>
              }
            />
          </div>
        ) : !selected ? null : (
          <>
          <section aria-label="The roll">
            <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
              {/* --- the figures, then the meter --- */}
              <MetricStrip columns={4}>
                <Metric label="Present" value={counts.present} tone="present" />
                <Metric label="Late" value={counts.late} tone={counts.late ? "late" : "muted"} />
                <Metric
                  label="Excused"
                  value={counts.excused}
                  tone={counts.excused ? "excused" : "muted"}
                />
                <Metric
                  label="Not marked"
                  value={counts.unmarked}
                  tone={counts.unmarked ? "absent" : "muted"}
                />
              </MetricStrip>

              {/* --- filters --- */}
              {students.length > 0 ? (
                <div className="hairline-t flex flex-wrap items-center gap-2 px-4 py-3">
                  <div className="relative min-w-[10rem] flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--cue-subtle)]"
                    />
                    <Input
                      className="pl-9"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find a student"
                      aria-label="Find a student"
                    />
                  </div>

                  {sectionOptions.length > 1 ? (
                    <Select
                      aria-label="Filter by section"
                      className="w-auto min-w-[9rem] flex-none"
                      value={section}
                      onChange={(e) => setSection(e.target.value)}
                    >
                      <option value="all">All sections ({students.length})</option>
                      {sectionOptions.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label} ({c.n})
                        </option>
                      ))}
                    </Select>
                  ) : null}

                  <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--cue-line)] px-3">
                    <Toggle
                      checked={onlyUnmarked}
                      onChange={setOnlyUnmarked}
                      label="Only students without a mark"
                    />
                    <span className="text-[0.8125rem] font-semibold">Unmarked only</span>
                  </div>
                </div>
              ) : null}

              {/* --- the names --- */}
              {roster === null ? (
                <div className="hairline-t space-y-2 p-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : students.length === 0 ? (
                <div className="hairline-t">
                  <EmptyState
                    icon={<Users className="h-4 w-4" />}
                    title="Nobody on the roster yet"
                    body="Once students join this program they show up here ready to be marked."
                    action={
                      <Button variant="secondary" onClick={() => navigate("/roster")}>
                        Open the roster
                      </Button>
                    }
                  />
                </div>
              ) : visible.length === 0 ? (
                <div className="hairline-t">
                  <EmptyState
                    icon={<Check className="h-4 w-4" />}
                    title="Nothing left here"
                    body="Everyone matching this filter already has a mark for this event."
                  />
                </div>
              ) : (
                <table className="hairline-t w-full text-left">
                  <thead className="hidden sm:table-header-group">
                    <tr className="border-b border-[var(--cue-line)]">
                      <th scope="col" className="type-label px-4 py-2 font-semibold">
                        Student
                      </th>
                      <th scope="col" className="type-label px-3 py-2 font-semibold">
                        Section
                      </th>
                      <th scope="col" className="type-label px-4 py-2 text-right font-semibold">
                        Mark
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((student) => {
                      const row = byStudent.get(student.user_id);
                      const name = student.profile.display_name || student.profile.full_name;
                      const note = row ? notes.get(row.id) : undefined;
                      return (
                        <tr
                          key={student.user_id}
                          className="border-t border-[var(--cue-line)] first:border-t-0 hover:bg-[var(--cue-raised)]"
                        >
                          <td className="px-2 py-1.5">
                            <button
                              type="button"
                              onClick={() => openEditor(student)}
                              className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-1 text-left"
                            >
                              <Avatar
                                name={name}
                                path={student.profile.avatar_path}
                                url={student.profile.avatar_url}
                                size={28}
                              />
                              <span className="min-w-0">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate font-semibold">{name}</span>
                                  {note ? (
                                    <StickyNote
                                      aria-hidden="true"
                                      className="h-3.5 w-3.5 shrink-0 text-[var(--cue-subtle)]"
                                    />
                                  ) : null}
                                </span>
                                <span className="type-meta block truncate sm:hidden">
                                  {student.section_name || "No section"}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td className="type-meta hidden px-3 py-2 sm:table-cell">
                            {student.section_name || "No section"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {row ? (
                              <button
                                type="button"
                                onClick={() => openEditor(student)}
                                aria-label={`Change ${name}'s mark — currently ${ATTENDANCE_STATUS_LABEL[row.status]}`}
                                className="motion-press rounded-[var(--radius-chip)]"
                              >
                                {/* Keyed by status so a corrected mark visibly lands. */}
                                <Badge
                                  key={row.status}
                                  className={cn(
                                    "cue-status-pop",
                                    ATTENDANCE_STATUS_CHIP[row.status],
                                    "px-2 py-1"
                                  )}
                                >
                                  {ATTENDANCE_STATUS_LABEL[row.status]}
                                </Badge>
                              </button>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={busyStudent === student.user_id}
                                icon={<Check className="h-4 w-4" />}
                                onClick={() => void quickPresent(student)}
                              >
                                Present
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <p className="type-meta mt-2 px-1">
              A student left unmarked counts as absent for the event. Tap anyone to mark them late,
              excused or absent, or to leave a staff note.
            </p>
          </section>

          {/* Staff of the program only. The server refuses everyone else, and
              re-checks the event's latest end time before a single send. */}
          {app.can("attendance.mark_present") ? <MakeupEmailPanel event={selected} /> : null}
          </>
        )}
      </div>

      {/* --- event picker --- */}
      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Which event?" size="tall">
        {events && events.length > 0 ? (
          <ul className="cue-card cue-list overflow-hidden rounded-[var(--radius-panel)]">
            {[...events]
              .sort((a, b) => rank(a) - rank(b))
              .map((e) => {
                const here = e.id === selectedId;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(e.id);
                        setPickerOpen(false);
                      }}
                      aria-current={here}
                      className={cn(
                        "flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left",
                        here ? "bg-[var(--cue-raised)]" : "hover:bg-[var(--cue-raised)]"
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate font-semibold">{e.name}</span>
                          <Badge className={eventTypeChip(e.event_type)}>
                            {eventTypeLabel(e.event_type)}
                          </Badge>
                        </span>
                        <span className="type-meta mt-0.5 block tabular">
                          {relativeDay(e.date)} · {e.all_day ? "All day" : fmtTime(e.date)}
                        </span>
                      </span>
                      {here ? (
                        <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--cue-green)]" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
          </ul>
        ) : (
          <EmptyState
            icon={<ClipboardList className="h-4 w-4" />}
            title="No events yet"
            body="Add one on the calendar first."
          />
        )}
      </Sheet>

      {/* --- one student --- */}
      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? editing.profile.display_name || editing.profile.full_name : "Student"}
        description={
          editing
            ? `${editing.section_name || "No section"} · ${
                byStudent.get(editing.user_id)
                  ? ATTENDANCE_STATUS_LABEL[byStudent.get(editing.user_id)!.status]
                  : "No mark yet"
              }`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" block onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button block loading={saving} onClick={() => void saveEditor()}>
              Save mark
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="space-y-4">
            <SegmentedControl
              value={draftStatus}
              onChange={setDraftStatus}
              options={STATUS_OPTIONS}
              className="flex-wrap"
            />

            {draftStatus === "excused" ? (
              <Field
                label="Why excused?"
                hint="Shown to the director; excused absences don't count against them."
              >
                <Textarea
                  value={draftExcuse}
                  onChange={(e) => setDraftExcuse(e.target.value)}
                  placeholder="Doctor's appointment"
                />
              </Field>
            ) : null}

            <Field
              label="Staff note"
              hint="Only directors, secretaries and section leaders can read this — students never see it."
            >
              <Textarea
                value={draftNote}
                onChange={(e) => setDraftNote(e.target.value)}
                placeholder="Talked to them about being late."
              />
            </Field>

            <p className="type-meta">
              Choosing Absent removes any mark for this event, so the event counts as a miss.
            </p>
          </div>
        ) : null}
      </Sheet>

      <ConfirmSheet
        open={bulkOpen}
        title="Mark everyone present?"
        body={`Every student who has no mark yet (${counts.unmarked}) will be marked present for this event. You can still change anyone afterwards.`}
        confirmLabel="Mark present"
        tone="accent"
        loading={bulking}
        onCancel={() => setBulkOpen(false)}
        onConfirm={() => void markAllRemaining()}
      />
    </div>
  );
}
