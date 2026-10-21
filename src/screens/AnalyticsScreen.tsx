import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarDays, ChevronRight, Users } from "lucide-react";
import {
  Alert,
  Avatar,
  Badge,
  Card,
  EmptyState,
  List,
  Metric,
  MetricStrip,
  PageHeader,
  ProgressRing,
  Row,
  SectionTitle,
  Sheet,
  Skeleton,
  cn,
} from "../components/ui";
import { fetchRoster } from "../lib/queries";
import {
  getAttendanceTrend,
  getEventAttendanceSummary,
  getEventRequirementStats,
  getSectionAttendanceStats,
  getStudentAttendancePct,
} from "../lib/rpc";
import type { RosterMember, RpcResult, SectionStatRow, TrendRow } from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import { eventTypeLabel } from "../lib/constants";
import { relativeDay } from "../lib/date";

/**
 * `/analytics` — the director's numbers.
 *
 * Every figure here comes from `attendance_pct_for()` or the RPCs built on it, so
 * a student's own ring and the director's table can never disagree. A refusal
 * (`{ ok: false }`) is shown as plain words, never as a zero.
 *
 * Charts appear only where they answer a question the tables cannot: the
 * distribution shows how many people sit in each band, and a section's bar shows
 * its standing next to the others. Nothing is plotted for decoration.
 */

function toneFor(pct: number): { chip: string; label: string } {
  if (pct >= 80) {
    return {
      chip: "bg-[var(--cue-present-bg)] text-[var(--cue-present)]",
      label: "Good standing",
    };
  }
  if (pct >= 60) {
    return { chip: "bg-[var(--cue-late-bg)] text-[var(--cue-late)]", label: "Slipping" };
  }
  return { chip: "bg-[var(--cue-absent-bg)] text-[var(--cue-absent)]", label: "Needs attention" };
}

function barTone(pct: number): string {
  return pct >= 80
    ? "bg-[var(--cue-present)]"
    : pct >= 60
      ? "bg-[var(--cue-late)]"
      : "bg-[var(--cue-absent)]";
}

const BANDS: { label: string; min: number; max: number }[] = [
  { label: "90–100%", min: 90, max: 101 },
  { label: "80–89%", min: 80, max: 90 },
  { label: "60–79%", min: 60, max: 80 },
  { label: "Below 60%", min: -1, max: 60 },
];

export function AnalyticsScreen() {
  const app = usePrograms();
  const programId = app.program?.id ?? null;

  const [roster, setRoster] = useState<RosterMember[] | null>(null);
  const [pcts, setPcts] = useState<Map<string, number | null>>(new Map());
  const [sections, setSections] = useState<SectionStatRow[]>([]);
  const [trend, setTrend] = useState<TrendRow[]>([]);
  /** `get_event_requirement_stats()` — required average vs optional turnout. */
  const [requirements, setRequirements] = useState<RpcResult | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [pick, setPick] = useState<TrendRow | null>(null);
  const [summary, setSummary] = useState<RpcResult | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const load = useCallback(async () => {
    if (!programId) return;
    setLoading(true);
    setError(null);
    try {
      const [people, sectionStats, recent, requirementStats] = await Promise.all([
        fetchRoster(programId),
        getSectionAttendanceStats(programId),
        getAttendanceTrend(programId, 10),
        getEventRequirementStats(programId),
      ]);

      setRoster(people);
      setSections(sectionStats.rows);
      setTrend(recent.rows);
      setRequirements(requirementStats.result);
      setRefusal(sectionStats.message ?? recent.message ?? null);

      const rosterStudents = people.filter((m) => m.active && !m.roles.includes("director"));
      const pairs: Array<[string, number | null]> = [];
      // One call per student, in small batches — a hundred-piece marching band
      // must not open a hundred requests at once from a phone in a hallway.
      const BATCH = 8;
      for (let i = 0; i < rosterStudents.length; i += BATCH) {
        const batch = rosterStudents.slice(i, i + BATCH);
        const got = await Promise.all(
          batch.map(async (s) => {
            const { result } = await getStudentAttendancePct(s.user_id, programId);
            const pct =
              result?.ok && typeof result.percentage === "number" ? result.percentage : null;
            return [s.user_id, pct] as [string, number | null];
          })
        );
        pairs.push(...got);
      }
      setPcts(new Map(pairs));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the numbers.");
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    void load();
  }, [load]);

  const students = useMemo(
    () => (roster ?? []).filter((m) => m.active && !m.roles.includes("director")),
    [roster]
  );

  const ranked = useMemo(
    () =>
      students
        .map((s) => ({ member: s, pct: pcts.get(s.user_id) ?? null }))
        .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101)),
    [students, pcts]
  );

  const overall = useMemo(() => {
    const known = ranked.map((r) => r.pct).filter((p): p is number => p !== null);
    if (known.length === 0) return null;
    return Math.round(known.reduce((sum, p) => sum + p, 0) / known.length);
  }, [ranked]);

  const struggling = useMemo(
    () => ranked.filter((r) => r.pct !== null && r.pct < 80).slice(0, 6),
    [ranked]
  );

  const bands = useMemo(() => {
    const known = ranked.filter((r) => r.pct !== null);
    const rows = BANDS.map((b) => ({
      label: b.label,
      count: known.filter((r) => (r.pct as number) >= b.min && (r.pct as number) < b.max).length,
    }));
    const max = Math.max(1, ...rows.map((r) => r.count));
    return { rows, max, unknown: ranked.length - known.length };
  }, [ranked]);

  async function openEvent(row: TrendRow) {
    setPick(row);
    setSummary(null);
    setSummaryLoading(true);
    const { result } = await getEventAttendanceSummary(row.id);
    setSummary(result);
    setSummaryLoading(false);
  }

  if (!programId) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-16 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (refusal && sections.length === 0 && trend.length === 0) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
        <div className="cue-card rounded-[var(--radius-panel)]">
          <EmptyState icon={<BarChart3 className="h-4 w-4" />} title="Directors only" body={refusal} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-7">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {refusal && !(sections.length === 0 && trend.length === 0) ? (
          <Alert tone="warn">{refusal}</Alert>
        ) : null}

        <PageHeader
          kicker={app.program?.short_name || app.program?.name || "Program"}
          title="Attendance"
          note={
            students.length === 0
              ? "No students on the roster yet."
              : `Average attendance across every required event, for ${students.length} ${
                  students.length === 1 ? "student" : "students"
                }.`
          }
        />

        {/* --- the headline, and how the program is spread across the bands --- */}
        <section aria-label="Program attendance" className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
          <div className="flex flex-wrap items-center gap-6 p-5">
            {loading && overall === null && students.length > 0 ? (
              <Skeleton className="h-[76px] w-[76px] rounded-full" />
            ) : overall === null ? (
              <ProgressRing value={0} size={76} stroke={7}>
                <span className="type-figure text-xl text-[var(--cue-subtle)]">—</span>
              </ProgressRing>
            ) : (
              <ProgressRing value={overall} size={76} stroke={7} />
            )}
            <div className="min-w-0">
              <p className="type-heading">Program average</p>
              <p className="type-meta mt-1">
                {overall === null
                  ? "No records yet — nothing can be averaged."
                  : `Weighted from each student's own required events.`}
              </p>
              {overall !== null ? (
                <Badge className={cn("mt-2", toneFor(overall).chip)}>{toneFor(overall).label}</Badge>
              ) : null}
            </div>
          </div>

          {bands.rows.some((r) => r.count > 0) ? (
            <div className="hairline-t p-5">
              <p className="type-label mb-3">How many students fall in each band</p>
              <dl className="space-y-2">
                {bands.rows.map((row) => (
                  <div key={row.label} className="flex items-center gap-3">
                    <dt className="type-meta w-20 shrink-0 tabular">{row.label}</dt>
                    <dd className="flex flex-1 items-center gap-3">
                      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--cue-raised)]">
                        <span
                          className={cn(
                            "cue-meter-fill block h-full rounded-full",
                            row.label === "90–100%" || row.label === "80–89%"
                              ? "bg-[var(--cue-present)]"
                              : row.label === "60–79%"
                                ? "bg-[var(--cue-late)]"
                                : "bg-[var(--cue-absent)]"
                          )}
                          style={{ transform: `scaleX(${row.count / bands.max})` }}
                        />
                      </span>
                      <span className="type-figure w-6 shrink-0 text-right text-base">
                        {row.count}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
              {bands.unknown > 0 ? (
                <p className="type-meta mt-3">
                  {bands.unknown} {bands.unknown === 1 ? "student has" : "students have"} no required
                  event recorded yet, so they are in no band.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* --- required vs optional, and what each figure includes --- */}
        {requirements?.ok ? (
          <section aria-label="Required and optional events">
            <SectionTitle className="mb-2">Required and optional</SectionTitle>
            <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
              <MetricStrip columns={4}>
                <Metric
                  label="Required events"
                  value={requirements.required_events ?? 0}
                  hint="Count toward the required-event rate"
                />
                <Metric
                  label="Required average"
                  value={
                    requirements.required_average_pct === null ||
                    requirements.required_average_pct === undefined
                      ? "—"
                      : `${requirements.required_average_pct}%`
                  }
                  tone="present"
                  hint={
                    requirements.measured_students
                      ? `${requirements.measured_students} students with a mark`
                      : "No marks yet"
                  }
                />
                <Metric
                  label="Optional turnout"
                  value={
                    requirements.optional_turnout_pct === null ||
                    requirements.optional_turnout_pct === undefined
                      ? "—"
                      : `${requirements.optional_turnout_pct}%`
                  }
                  tone="late"
                  hint={`${requirements.optional_attended ?? 0} of ${
                    requirements.optional_marks ?? 0
                  } marks across ${requirements.optional_events ?? 0} optional events`}
                />
                <Metric
                  label="No attendance"
                  value={requirements.excluded_events ?? 0}
                  tone="muted"
                  hint="Excluded from every percentage"
                />
              </MetricStrip>
              <div className="hairline-t px-4 py-3">
                <p className="type-meta">
                  {requirements.basis ??
                    "Optional events never reduce the required-event rate, and an event with no attendance is excluded from both."}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {students.length === 0 ? (
          <div className="cue-card rounded-[var(--radius-panel)]">
            <EmptyState
              icon={<Users className="h-4 w-4" />}
              title="Nothing to measure yet"
              body="Once students are on the roster and events have happened, their percentages appear here."
            />
          </div>
        ) : null}

        {/* --- who needs a nudge --- */}
        {struggling.length > 0 ? (
          <section>
            <SectionTitle
              className="mb-3"
              action={<span className="type-meta">Below 80% of required events</span>}
            >
              Needs a nudge
            </SectionTitle>
            <List>
              {struggling.map(({ member, pct }) => {
                const name = member.profile.display_name || member.profile.full_name;
                return (
                  <Row
                    key={member.user_id}
                    leading={
                      <Avatar
                        name={name}
                        path={member.profile.avatar_path}
                        url={member.profile.avatar_url}
                        size={32}
                      />
                    }
                    title={name}
                    subtitle={member.section_name || "No section"}
                    trailing={<Badge className={toneFor(pct ?? 0).chip}>{pct}%</Badge>}
                  />
                );
              })}
            </List>
          </section>
        ) : null}

        {/* --- by section --- */}
        <section>
          <SectionTitle className="mb-3">By section</SectionTitle>
          {loading && sections.length === 0 ? (
            <Skeleton className="h-40 w-full" />
          ) : sections.length === 0 ? (
            <div className="cue-card rounded-[var(--radius-panel)]">
              <EmptyState
                icon={<Users className="h-4 w-4" />}
                title="No section averages yet"
                body="Put students into sections on the Roster screen and their averages land here."
              />
            </div>
          ) : (
            <List>
              {sections.map((s) => (
                <div key={s.section} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate font-semibold">{s.section}</p>
                    <span className="shrink-0 whitespace-nowrap">
                      <span className="type-figure text-lg">
                        {Math.round(s.avg_attendance_pct)}%
                      </span>
                      <span className="type-meta ml-2 tabular">
                        {s.member_count} {s.member_count === 1 ? "student" : "students"}
                      </span>
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--cue-raised)]">
                    <div
                      className={cn("cue-meter-fill h-full rounded-full", barTone(s.avg_attendance_pct))}
                      style={{ transform: `scaleX(${Math.max(0, Math.min(100, s.avg_attendance_pct)) / 100})` }}
                    />
                  </div>
                </div>
              ))}
            </List>
          )}
        </section>

        {/* --- recent events --- */}
        <section>
          <SectionTitle
            className="mb-3"
            action={<span className="type-meta">Last {trend.length}</span>}
          >
            Recent events
          </SectionTitle>
          {loading && trend.length === 0 ? (
            <Skeleton className="h-40 w-full" />
          ) : trend.length === 0 ? (
            <div className="cue-card rounded-[var(--radius-panel)]">
              <EmptyState
                icon={<CalendarDays className="h-4 w-4" />}
                title="No past events yet"
                body="Attendance trends appear after your first required event."
              />
            </div>
          ) : (
            <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
              <table className="w-full text-left">
                <thead className="hidden sm:table-header-group">
                  <tr className="border-b border-[var(--cue-line)]">
                    <th scope="col" className="type-label px-4 py-2 font-semibold">
                      Event
                    </th>
                    <th scope="col" className="type-label px-3 py-2 font-semibold">
                      Turnout
                    </th>
                    <th scope="col" className="type-label px-4 py-2 text-right font-semibold">
                      Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((row) => {
                    const rate =
                      row.roster_size > 0
                        ? Math.round((row.present_count / row.roster_size) * 100)
                        : 0;
                    return (
                      <tr
                        key={row.id}
                        className="border-t border-[var(--cue-line)] first:border-t-0 hover:bg-[var(--cue-raised)]"
                      >
                        <td className="px-2 py-1.5">
                          <button
                            type="button"
                            onClick={() => void openEvent(row)}
                            className="group flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-1 text-left"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-semibold">{row.name}</span>
                              <span className="type-meta block tabular">
                                {relativeDay(row.date)} · {eventTypeLabel(row.event_type)}
                              </span>
                            </span>
                            <ChevronRight
                              aria-hidden="true"
                              className="cue-nudge ml-auto h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                            />
                          </button>
                        </td>
                        <td className="type-meta hidden px-3 py-2 tabular sm:table-cell">
                          {row.present_count} of {row.roster_size}
                          {row.excused_count > 0 ? ` · ${row.excused_count} excused` : ""}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Badge className={toneFor(rate).chip}>{rate}%</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* --- the whole roster, worst first --- */}
        <section>
          <SectionTitle
            className="mb-3"
            action={<span className="type-meta">Worst first</span>}
          >
            Every student
          </SectionTitle>
          {roster === null ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <List>
              {ranked.map(({ member, pct }) => {
                const name = member.profile.display_name || member.profile.full_name;
                return (
                  <Row
                    key={member.user_id}
                    leading={
                      <Avatar
                        name={name}
                        path={member.profile.avatar_path}
                        url={member.profile.avatar_url}
                        size={32}
                      />
                    }
                    title={name}
                    subtitle={member.section_name || "No section"}
                    trailing={
                      pct === null ? (
                        <Badge className="bg-[var(--cue-raised)] text-[var(--cue-muted)]">
                          No records
                        </Badge>
                      ) : (
                        <Badge className={toneFor(pct).chip}>{pct}%</Badge>
                      )
                    }
                  />
                );
              })}
            </List>
          )}
        </section>
      </div>

      {/* --- one event, broken down --- */}
      <Sheet
        open={pick !== null}
        onClose={() => setPick(null)}
        title={pick?.name ?? "Event"}
        description={pick ? `${relativeDay(pick.date)} · ${eventTypeLabel(pick.event_type)}` : undefined}
      >
        {summaryLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !summary?.ok ? (
          <Alert tone="error">{summary?.message ?? "Could not load this event."}</Alert>
        ) : (
          <div className="space-y-4">
            <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
              <MetricStrip columns={4}>
                <Metric label="Present" value={summary.present ?? 0} tone="present" />
                <Metric label="Late" value={summary.late ?? 0} tone="late" />
                <Metric label="Excused" value={summary.excused ?? 0} tone="excused" />
                <Metric label="Absent" value={summary.absent ?? 0} tone="absent" />
              </MetricStrip>
            </div>

            {typeof summary.total === "number" && typeof summary.present === "number" ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold">
                  {summary.present} of {summary.total} on the roster attended
                  {summary.late ? ` — ${summary.late} of them late` : ""}.
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--cue-raised)]">
                  <div
                    className="cue-meter-fill h-full rounded-full bg-[var(--cue-present)]"
                    style={{
                      transform: `scaleX(${
                        summary.total > 0 ? (summary.present ?? 0) / summary.total : 0
                      })`,
                    }}
                  />
                </div>
              </div>
            ) : null}

            <Card className="p-3">
              <p className="type-meta">
                Students with no mark count as absent. Staff can still fix a mark from the Attendance
                screen, and the change shows here immediately.
              </p>
            </Card>
          </div>
        )}
      </Sheet>
    </div>
  );
}
