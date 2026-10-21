import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Download, FileClock, Printer, RefreshCw, Search } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  PageHeader,
  SectionTitle,
  SegmentedControl,
  Select,
  Skeleton,
  cn,
  useToast,
} from "../components/ui";
import { fetchEvents, fetchRoster } from "../lib/queries";
import { getAttendanceReport, listAttendanceHistory } from "../lib/rpc";
import type {
  AttendanceAuditEntry,
  AttendanceReportRow,
  AttendanceStatus,
  EventRow,
  RosterMember,
} from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import {
  ATTENDANCE_REQUIREMENT_LABEL,
  HISTORY_SOURCE_LABEL,
  HISTORY_STATUS_LABEL,
  eventTypeLabel,
} from "../lib/constants";
import { fmtDate, fmtTime, relativeDay } from "../lib/date";
import { csvFilename, downloadCsv, toCsv } from "../lib/csv";

/**
 * `/records` — two related views over the same data.
 *
 * **History** answers "who changed what, when and why", from the append-only
 * audit trail. It is a staff screen: the server refuses a student, and a section
 * leader's rows are filtered to their own section by the RPC.
 *
 * **Export** builds the report on the server (`attendance_report_rows`), so the
 * filters and the permission are applied before a single row reaches the
 * browser. The CSV is written here, with RFC 4180 quoting and formula-injection
 * protection; nothing sensitive is fetched in the first place.
 */

type Tab = "history" | "export";

const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "excused", label: "Excused" },
  { value: "none", label: "No record" },
  { value: "absent", label: "Absent (stored)" },
];

const REPORT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "excused", label: "Excused" },
  { value: "not_recorded", label: "Not recorded" },
  { value: "absent", label: "Absent (stored)" },
];

/** Local `YYYY-MM-DD` → the ISO instant at the start of that local day. */
function localDayStart(value: string): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

/** Exclusive upper bound: the start of the day after the one picked. */
function localDayAfter(value: string): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).toISOString();
}

function statusName(status: AttendanceStatus | "none" | null): string {
  return status ? HISTORY_STATUS_LABEL[status] : "No record";
}

function statusChip(status: AttendanceStatus | "none" | null): string {
  switch (status) {
    case "present":
      return "bg-[var(--cue-present-bg)] text-[var(--cue-present)]";
    case "late":
      return "bg-[var(--cue-late-bg)] text-[var(--cue-late)]";
    case "excused":
      return "bg-[var(--cue-excused-bg)] text-[var(--cue-excused)]";
    case "absent":
      return "bg-[var(--cue-absent-bg)] text-[var(--cue-absent)]";
    default:
      return "bg-[var(--cue-raised)] text-[var(--cue-muted)]";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function RecordsScreen() {
  const app = usePrograms();
  const { toast } = useToast();
  const programId = app.program?.id ?? null;

  const canHistory =
    app.can("attendance.view_program") || app.can("attendance.view_section");
  const canExport = app.can("attendance.export_reports");

  const [tab, setTab] = useState<Tab>(canHistory ? "history" : "export");
  const [roster, setRoster] = useState<RosterMember[] | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- history -------------------------------------------------------------
  const [draftEvent, setDraftEvent] = useState("");
  const [draftStudent, setDraftStudent] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftOld, setDraftOld] = useState("");
  const [draftNew, setDraftNew] = useState("");
  const [draftActor, setDraftActor] = useState("");
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<AttendanceAuditEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // --- export --------------------------------------------------------------
  const [reportEvent, setReportEvent] = useState("");
  const [reportStudent, setReportStudent] = useState("");
  const [reportSection, setReportSection] = useState("");
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportStatus, setReportStatus] = useState("");
  const [reportRequirement, setReportRequirement] = useState("");
  const [reportRows, setReportRows] = useState<AttendanceReportRow[] | null>(null);
  const [reportMeta, setReportMeta] = useState<{ total: number; truncated: boolean } | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const loadBase = useCallback(async () => {
    if (!programId) return;
    try {
      setError(null);
      const [people, list] = await Promise.all([
        fetchRoster(programId),
        fetchEvents(programId, { includeArchived: true }),
      ]);
      setRoster(people);
      setEvents(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the roster and events.");
      setRoster([]);
      setEvents([]);
    }
  }, [programId]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  const students = useMemo(
    () =>
      (roster ?? [])
        .filter((m) => m.active)
        .map((m) => ({
          id: m.user_id,
          name: m.profile.display_name || m.profile.full_name,
          section: m.section_name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [roster]
  );

  const staff = useMemo(
    () =>
      (roster ?? [])
        .filter((m) => m.active && m.roles.some((r) => r !== "student"))
        .map((m) => ({ id: m.user_id, name: m.profile.display_name || m.profile.full_name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [roster]
  );

  const loadHistory = useCallback(async () => {
    if (!programId || !canHistory) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const { result, error: rpcError } = await listAttendanceHistory(programId, {
        event: applied.event || null,
        student: applied.student || null,
        from: localDayStart(applied.from ?? ""),
        to: localDayAfter(applied.to ?? ""),
        oldStatus: applied.old || null,
        newStatus: applied.new || null,
        actor: applied.actor || null,
        limit: 200,
      });
      if (rpcError || !result?.ok) {
        setHistoryError(
          rpcError?.message || result?.message || "Could not load the attendance history."
        );
        setEntries([]);
        return;
      }
      setEntries((result.entries ?? []) as AttendanceAuditEntry[]);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : "Could not load the attendance history.");
      setEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [programId, canHistory, applied]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function runReport() {
    if (!programId || !canExport) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const { report, error: rpcError } = await getAttendanceReport({
        programId,
        event: reportEvent || null,
        student: reportStudent || null,
        section: reportSection || null,
        from: localDayStart(reportFrom),
        to: localDayAfter(reportTo),
        status: reportStatus || null,
        requirement: reportRequirement || null,
      });
      if (rpcError || !report?.ok) {
        setReportRows(null);
        setReportMeta(null);
        setReportError(rpcError || report?.message || "Could not build the report.");
        return;
      }
      setReportRows(report.rows ?? []);
      setReportMeta({ total: report.total ?? 0, truncated: report.truncated === true });
    } catch (e) {
      setReportRows(null);
      setReportMeta(null);
      setReportError(e instanceof Error ? e.message : "Could not build the report.");
    } finally {
      setReportLoading(false);
    }
  }

  function exportCsv() {
    if (!reportRows || reportRows.length === 0) return;
    const headers = [
      "Event",
      "Date",
      "Start",
      "Type",
      "Requirement",
      "Student",
      "Student ref",
      "Section",
      "Status",
      "Checked in",
    ];
    const rows = reportRows.map((r) => [
      r.event_name,
      fmtDate(new Date(r.event_date)),
      r.all_day ? "All day" : fmtTime(r.event_date),
      eventTypeLabel(r.event_type),
      ATTENDANCE_REQUIREMENT_LABEL[r.attendance_requirement],
      r.student_name,
      r.student_ref,
      r.section || "No section",
      r.status === "not_recorded" ? "Not recorded" : HISTORY_STATUS_LABEL[r.status],
      r.checked_in_at ? `${fmtDate(new Date(r.checked_in_at))} ${fmtTime(r.checked_in_at)}` : "",
    ]);

    const csv = toCsv(headers, rows);
    downloadCsv(
      csvFilename({
        program: app.program?.short_name || app.program?.name || null,
        from: localDayStart(reportFrom),
        to: localDayAfter(reportTo),
      }),
      csv
    );
    toast.success(`Exported ${reportRows.length} row${reportRows.length === 1 ? "" : "s"}.`);
  }

  function printReport() {
    if (!reportRows || reportRows.length === 0) return;
    const win = window.open("", "_blank");
    if (!win) {
      toast.warn("Your browser blocked the print window — allow pop-ups for this site.");
      return;
    }
    const body = reportRows
      .slice(0, 500)
      .map((r) => {
        const status =
          r.status === "not_recorded" ? "Not recorded" : HISTORY_STATUS_LABEL[r.status];
        return `<tr>
          <td>${escapeHtml(r.event_name)}</td>
          <td>${escapeHtml(fmtDate(new Date(r.event_date)))}</td>
          <td>${escapeHtml(r.student_name)}</td>
          <td>${escapeHtml(r.section || "No section")}</td>
          <td>${escapeHtml(r.status === "not_recorded" ? "Not recorded" : status)}</td>
          <td>${escapeHtml(r.checked_in_at ? fmtTime(r.checked_in_at) : "")}</td>
        </tr>`;
      })
      .join("");

    win.document.write(`<!doctype html><html><head><meta charset="utf-8">
      <title>${escapeHtml(app.program?.name ?? "Attendance")} — attendance</title>
      <style>
        body { font: 12px/1.4 -apple-system, "Segoe UI", sans-serif; margin: 24px; color: #111; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        p { margin: 0 0 16px; color: #555; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; }
        th { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
        tr { page-break-inside: avoid; }
      </style></head><body>
      <h1>${escapeHtml(app.program?.name ?? "Program")} — attendance report</h1>
      <p>${reportRows.length} row${reportRows.length === 1 ? "" : "s"} · printed ${escapeHtml(
        new Date().toLocaleString("en-US")
      )}</p>
      <table><thead><tr><th>Event</th><th>Date</th><th>Student</th><th>Section</th><th>Status</th><th>Checked in</th></tr></thead>
      <tbody>${body}</tbody></table>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  if (!programId) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-16 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!canHistory && !canExport) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <div className="cue-card rounded-[var(--radius-panel)]">
          <EmptyState
            icon={<FileClock className="h-4 w-4" />}
            title="Staff only"
            body="Attendance history and exports are available to the program's staff."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-6">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <PageHeader
          kicker={app.program?.short_name || app.program?.name || "Program"}
          title="Records"
          note="Every attendance change, and a report you can take with you."
        />

        <SegmentedControl
          value={tab}
          onChange={(value) => setTab(value as Tab)}
          options={[
            ...(canHistory ? [{ value: "history", label: "Change history" }] : []),
            ...(canExport ? [{ value: "export", label: "Export report" }] : []),
          ]}
          className="flex-wrap"
        />

        {/* --- history ---------------------------------------------------- */}
        {tab === "history" ? (
          <section aria-label="Attendance change history" className="space-y-4">
            <div className="cue-card space-y-3 rounded-[var(--radius-panel)] p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Event">
                  <Select
                    aria-label="Filter history by event"
                    value={draftEvent}
                    onChange={(e) => setDraftEvent(e.target.value)}
                  >
                    <option value="">Any event</option>
                    {(events ?? []).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} — {relativeDay(e.date)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Student">
                  <Select
                    aria-label="Filter history by student"
                    value={draftStudent}
                    onChange={(e) => setDraftStudent(e.target.value)}
                  >
                    <option value="">Anyone</option>
                    {students.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Changed by">
                  <Select
                    aria-label="Filter history by who changed it"
                    value={draftActor}
                    onChange={(e) => setDraftActor(e.target.value)}
                  >
                    <option value="">Anyone</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From">
                  <Input
                    aria-label="History changed on or after"
                    type="date"
                    value={draftFrom}
                    onChange={(e) => setDraftFrom(e.target.value)}
                  />
                </Field>
                <Field label="To">
                  <Input
                    aria-label="History changed on or before"
                    type="date"
                    value={draftTo}
                    onChange={(e) => setDraftTo(e.target.value)}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Was">
                    <Select
                      aria-label="Filter history by previous status"
                      value={draftOld}
                      onChange={(e) => setDraftOld(e.target.value)}
                    >
                      {STATUS_FILTER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Became">
                    <Select
                      aria-label="Filter history by new status"
                      value={draftNew}
                      onChange={(e) => setDraftNew(e.target.value)}
                    >
                      {STATUS_FILTER_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  icon={<Search className="h-4 w-4" />}
                  loading={historyLoading}
                  onClick={() =>
                    setApplied({
                      event: draftEvent,
                      student: draftStudent,
                      from: draftFrom,
                      to: draftTo,
                      old: draftOld,
                      new: draftNew,
                      actor: draftActor,
                    })
                  }
                >
                  Show history
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraftEvent("");
                    setDraftStudent("");
                    setDraftFrom("");
                    setDraftTo("");
                    setDraftOld("");
                    setDraftNew("");
                    setDraftActor("");
                    setApplied({});
                  }}
                >
                  Reset
                </Button>
                <Button
                  variant="ghost"
                  icon={<RefreshCw className="h-4 w-4" />}
                  onClick={() => void loadHistory()}
                >
                  Refresh
                </Button>
              </div>
            </div>

            {historyError ? <Alert tone="error">{historyError}</Alert> : null}

            {entries === null || historyLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : entries.length === 0 ? (
              <div className="cue-card rounded-[var(--radius-panel)]">
                <EmptyState
                  icon={<FileClock className="h-4 w-4" />}
                  title="No changes match"
                  body="Nothing has been corrected with these filters. A brand-new mark appears here as soon as it is saved."
                />
              </div>
            ) : (
              <List>
                {entries.map((entry) => (
                  <div key={entry.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="flex min-w-0 flex-wrap items-baseline gap-2">
                        <span className="truncate font-semibold">{entry.student_name}</span>
                        <span className="type-meta">{entry.section || "No section"}</span>
                      </p>
                      <span className="type-meta shrink-0 tabular">
                        {relativeDay(entry.created_at)} · {fmtTime(entry.created_at)}
                      </span>
                    </div>

                    <p className="type-meta mt-0.5 truncate">
                      {entry.event_name} · {relativeDay(entry.event_date)}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                      <Badge className={cn(statusChip(entry.old_status), "px-2 py-0.5")}>
                        {statusName(entry.old_status)}
                      </Badge>
                      <ArrowRight
                        aria-hidden="true"
                        className="h-3.5 w-3.5 text-[var(--cue-subtle)]"
                      />
                      <Badge className={cn(statusChip(entry.new_status), "px-2 py-0.5")}>
                        {statusName(entry.new_status)}
                      </Badge>
                      <span className="type-meta ml-1">
                        {HISTORY_SOURCE_LABEL[entry.source]}
                        {entry.actor_name ? ` · ${entry.actor_name}` : ""}
                      </span>
                    </div>

                    {entry.reason ? (
                      <p className="mt-2 text-sm whitespace-pre-wrap">“{entry.reason}”</p>
                    ) : null}
                  </div>
                ))}
              </List>
            )}
          </section>
        ) : null}

        {/* --- export ----------------------------------------------------- */}
        {tab === "export" ? (
          <section aria-label="Attendance export" className="space-y-4">
            <div className="cue-card space-y-3 rounded-[var(--radius-panel)] p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Event">
                  <Select
                    aria-label="Filter report by event"
                    value={reportEvent}
                    onChange={(e) => setReportEvent(e.target.value)}
                  >
                    <option value="">All past events</option>
                    {(events ?? []).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} — {relativeDay(e.date)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Student">
                  <Select
                    aria-label="Filter report by student"
                    value={reportStudent}
                    onChange={(e) => setReportStudent(e.target.value)}
                  >
                    <option value="">Everyone</option>
                    {students.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Section">
                  <Select
                    aria-label="Filter report by section"
                    value={reportSection}
                    onChange={(e) => setReportSection(e.target.value)}
                  >
                    <option value="">All sections</option>
                    {app.sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From">
                  <Input
                    aria-label="Report events on or after"
                    type="date"
                    value={reportFrom}
                    onChange={(e) => setReportFrom(e.target.value)}
                  />
                </Field>
                <Field label="To">
                  <Input
                    aria-label="Report events on or before"
                    type="date"
                    value={reportTo}
                    onChange={(e) => setReportTo(e.target.value)}
                  />
                </Field>
                <Field label="Requirement">
                  <Select
                    aria-label="Filter report by requirement"
                    value={reportRequirement}
                    onChange={(e) => setReportRequirement(e.target.value)}
                  >
                    <option value="">Any requirement</option>
                    <option value="required">Required</option>
                    <option value="optional">Optional</option>
                    <option value="none">No attendance</option>
                  </Select>
                </Field>
                <Field label="Status">
                  <Select
                    aria-label="Filter report by status"
                    value={reportStatus}
                    onChange={(e) => setReportStatus(e.target.value)}
                  >
                    {REPORT_STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button loading={reportLoading} icon={<Search className="h-4 w-4" />} onClick={() => void runReport()}>
                  Build report
                </Button>
                <Button
                  variant="secondary"
                  icon={<Download className="h-4 w-4" />}
                  disabled={!reportRows || reportRows.length === 0}
                  onClick={exportCsv}
                >
                  Download CSV
                </Button>
                <Button
                  variant="ghost"
                  icon={<Printer className="h-4 w-4" />}
                  disabled={!reportRows || reportRows.length === 0}
                  onClick={printReport}
                >
                  Print
                </Button>
              </div>

              <p className="type-meta">
                A report covers events that have already happened, one row per student and event.
                “Not recorded” means no mark was saved — it is not the same claim as “absent”.
                Addresses and absence reasons are never included.
              </p>
            </div>

            {reportError ? <Alert tone="error">{reportError}</Alert> : null}

            {reportRows === null ? null : reportRows.length === 0 ? (
              <div className="cue-card rounded-[var(--radius-panel)]">
                <EmptyState
                  icon={<Search className="h-4 w-4" />}
                  title="Nothing matches"
                  body="No attendance rows fit these filters. Try a wider date range."
                />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <SectionTitle>Report</SectionTitle>
                  <span className="type-meta tabular">
                    {reportRows.length} row{reportRows.length === 1 ? "" : "s"}
                    {reportMeta?.truncated ? " · truncated at the row limit" : ""}
                  </span>
                </div>

                <div className="cue-card overflow-x-auto rounded-[var(--radius-panel)]">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--cue-line)]">
                        <th scope="col" className="type-label px-3 py-2 font-semibold">Event</th>
                        <th scope="col" className="type-label px-3 py-2 font-semibold">Student</th>
                        <th scope="col" className="type-label hidden px-3 py-2 font-semibold sm:table-cell">Section</th>
                        <th scope="col" className="type-label px-3 py-2 text-right font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportRows.slice(0, 50).map((row) => (
                        <tr
                          key={`${row.event_id}-${row.student_id}`}
                          className="border-t border-[var(--cue-line)] first:border-t-0"
                        >
                          <td className="px-3 py-2">
                            <span className="block truncate font-medium">{row.event_name}</span>
                            <span className="type-meta tabular">{relativeDay(row.event_date)}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="block truncate">{row.student_name}</span>
                            <span className="type-meta tabular">{row.student_ref}</span>
                          </td>
                          <td className="type-meta hidden px-3 py-2 sm:table-cell">
                            {row.section || "No section"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Badge
                              className={cn(
                                statusChip(
                                  row.status === "not_recorded" ? "none" : row.status
                                ),
                                "px-2 py-0.5"
                              )}
                            >
                              {row.status === "not_recorded"
                                ? "Not recorded"
                                : HISTORY_STATUS_LABEL[row.status]}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {reportRows.length > 50 ? (
                  <p className="type-meta">
                    Showing the first 50 rows here; the download and print contain all{" "}
                    {reportRows.length}.
                  </p>
                ) : null}
              </>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
