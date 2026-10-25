import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  MapPin,
  QrCode,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  List,
  Metric,
  MetricStrip,
  PageHeader,
  Poster,
  ProgressRing,
  Row,
  SectionTitle,
  Skeleton,
  Stage,
  TempoBars,
  cn,
} from "../components/ui";
import { fetchAttendance, fetchEvents } from "../lib/queries";
import type { EmbeddedMembership } from "../lib/queries";
import { getMyAttendancePct, getMyAttendanceTrend } from "../lib/rpc";
import type { EventRow, MyAttendanceRow } from "../lib/types";
import { PersonalizationPrompt } from "../components/PersonalizationPrompt";
import { usePrograms } from "../hooks/usePrograms";
import { usePreferences } from "../hooks/usePreferences";
import type { DashboardModuleId } from "../lib/types";
import {
  ATTENDANCE_REQUIREMENT_LABEL,
  ATTENDANCE_STATUS_CHIP,
  ATTENDANCE_STATUS_LABEL,
  CHECKIN_MODE_LABEL,
  eventTypeChip,
  eventTypeLabel,
  ROLE_LABEL,
} from "../lib/constants";
import { endOfDay, fmtTime, isSameDay, relativeDay, startOfDay, untilLabel } from "../lib/date";

/**
 * The dashboard.
 *
 * It has one focal point — the next event, on a deep-green stage with the
 * program's staff motif behind it — and one primary action. Everything else
 * (what is coming, how the record stands, which programs you are in) is
 * arranged around that in two uneven columns, because a page where every block
 * has the same weight is a page with no point of view.
 */

/** A date gutter: weekday, big condensed day number, month. */
function DayMark({ iso, className }: { iso: string; className?: string }) {
  const d = new Date(iso);
  return (
    <span
      className={cn(
        "flex w-14 shrink-0 flex-col items-center border-r border-[var(--cue-line)] pr-3",
        className
      )}
    >
      <span className="type-label text-[10px]">
        {d.toLocaleDateString("en-US", { weekday: "short" })}
      </span>
      <span className="type-poster-sm text-2xl leading-none">
        {d.getDate()}
      </span>
      <span className="type-label text-[10px]">
        {d.toLocaleDateString("en-US", { month: "short" })}
      </span>
    </span>
  );
}

export function HomeScreen() {
  const app = usePrograms();
  const navigate = useNavigate();
  const { preferences } = usePreferences();

  /**
   * The person's own dashboard, as a set of allowed blocks.
   *
   * The next-event panel above these is not part of the list: it is the page's
   * focal point and stays. Everything below is shown only if it is both chosen
   * *and* has something to say — a hidden block, an empty list and a student's
   * staff-only block all leave no gap behind. Order is `style.order` inside the
   * two flex columns, so the layout keeps its uneven pair of tracks while the
   * blocks inside each one follow the saved order.
   */
  const moduleOrder = preferences.dashboard_modules;
  const shows = (id: DashboardModuleId) => moduleOrder.includes(id);

  const programId = app.program?.id ?? null;
  const profileId = app.profile?.id ?? null;

  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [attendanceRows, setAttendanceRows] = useState<MyAttendanceRow[]>([]);
  const [checkedInEventId, setCheckedInEventId] = useState<string | null>(null);
  const [checkedInAt, setCheckedInAt] = useState<string | null>(null);
  const [percentage, setPercentage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!programId) return;
    try {
      setError(null);
      const [list, todayAttendance, myPct, myTrend] = await Promise.all([
        fetchEvents(programId),
        profileId
          ? fetchAttendance(programId, {
              from: startOfDay(new Date()).toISOString(),
              to: endOfDay(new Date()).toISOString(),
            })
          : Promise.resolve([]),
        getMyAttendancePct(programId),
        getMyAttendanceTrend(programId, 6),
      ]);
      setEvents(list);

      const mine = todayAttendance.find((r) => r.student_id === profileId) ?? null;
      setCheckedInEventId(mine?.event_id ?? null);
      setCheckedInAt(mine?.checked_in_at ?? null);

      setPercentage(
        myPct.result?.ok && typeof myPct.result.percentage === "number"
          ? myPct.result.percentage
          : null
      );
      setAttendanceRows(myTrend.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your dashboard.");
    } finally {
      setLoading(false);
    }
  }, [programId, profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  const now = Date.now();
  const firstName =
    (app.profile?.display_name || app.profile?.full_name || "there").split(/\s+/)[0] ?? "there";

  const todayEvent = useMemo(
    () => events?.find((e) => isSameDay(new Date(e.date), new Date())) ?? null,
    [events]
  );

  const upcoming = useMemo(
    () => (events ?? []).filter((e) => new Date(e.date).getTime() >= now).slice(0, 6),
    [events, now]
  );

  const nextEvent = todayEvent ?? upcoming[0] ?? null;
  const alsoUpcoming = upcoming.filter((e) => e.id !== nextEvent?.id).slice(0, 4);
  const missed = attendanceRows.filter((r) => r.status === "absent" || r.status === "late").length;
  const isNextToday = nextEvent?.id === todayEvent?.id;

  if (!programId) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-16 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 pb-10 sm:px-6 sm:py-7">
      {/* Offered once, to students, on the page they land on after joining. It
          renders nothing at all for staff or once answered. */}
      <PersonalizationPrompt />

      <div className="cue-stagger space-y-7">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <PageHeader
          kicker={[app.program?.short_name || app.program?.name, app.membership?.section?.name]
            .filter(Boolean)
            .join(" · ")}
          title={new Date().toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
          note={
            app.isStaff
              ? `${firstName} — you're on staff here. Take the roll, or open a code for the room.`
              : `Hello, ${firstName}. Here's what's next, and where your attendance stands.`
          }
          actions={
            app.isStaff ? (
              <>
                <Button
                  icon={<ClipboardCheck className="h-4 w-4" />}
                  onClick={() => navigate("/attendance", { viewTransition: true })}
                >
                  Take attendance
                </Button>
                <Button
                  variant="secondary"
                  icon={<QrCode className="h-4 w-4" />}
                  onClick={() =>
                    navigate(
                      nextEvent?.checkin_mode === "qr" || nextEvent?.checkin_mode === "both"
                        ? `/checkin?event=${nextEvent.id}`
                        : "/checkin",
                      { viewTransition: true }
                    )
                  }
                >
                  Start check-in
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                icon={<CalendarDays className="h-4 w-4" />}
                onClick={() => navigate("/calendar", { viewTransition: true })}
              >
                Calendar
              </Button>
            )
          }
        />

        {/* --- the focal point: what is next, and what to do about it --- */}
        {loading && !events ? (
          <Skeleton className="h-56 w-full" />
        ) : nextEvent ? (
          <Stage motif className="px-5 py-6 sm:px-7 sm:py-8">
            {/* `minmax(0, …)` and an explicit single column: a bare `fr` track is
                `minmax(auto, …)`, so its floor is the content's min-content, and a
                single `truncate`/`nowrap` descendant then takes the column past
                the panel it sits in. The audit measured no document scroll at any
                width, so this is hardening against a class of bug rather than a
                reproduced break — see docs/QA_REPORT.md (QA-08). */}
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-end">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="type-kicker text-[var(--cue-gold-on-brand)]">
                    {isNextToday ? "Today" : "Next up"}
                  </span>
                  <span className="text-[0.8125rem] text-[var(--cue-stage-ink)]/70">
                    {relativeDay(nextEvent.date)} ·{" "}
                    {nextEvent.all_day ? "All day" : fmtTime(nextEvent.date)}
                  </span>
                  <Badge className="border border-[var(--cue-stage-line)] bg-white/10 text-[var(--cue-stage-ink)]">
                    {eventTypeLabel(nextEvent.event_type)}
                  </Badge>
                </p>

                <h2 className="mt-3 text-[var(--cue-stage-ink)]">
                  <Poster rule tone="stage">{nextEvent.name}</Poster>
                </h2>

                <dl className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.8125rem] text-[var(--cue-stage-ink)]/80">
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">Time</dt>
                    <CalendarDays aria-hidden="true" className="h-4 w-4 opacity-70" />
                    <dd className="tabular">
                      {nextEvent.all_day ? "All day" : fmtTime(nextEvent.date)}
                    </dd>
                  </div>
                  {nextEvent.location ? (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <dt className="sr-only">Location</dt>
                      <MapPin aria-hidden="true" className="h-4 w-4 shrink-0 opacity-70" />
                      <dd className="truncate">{nextEvent.location}</dd>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">Attendance</dt>
                    <dd>
                      Attendance:{" "}
                      <span className="font-semibold text-[var(--cue-stage-ink)]">
                        {ATTENDANCE_REQUIREMENT_LABEL[nextEvent.attendance_requirement]}
                      </span>
                    </dd>
                  </div>
                </dl>
              </div>

              {/* The countdown: the one number this page cares about. */}
              <div className="flex flex-col gap-4 border-t border-[var(--cue-stage-line)] pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
                <div>
                  <p className="type-kicker text-[var(--cue-stage-ink)]/60">
                    {isNextToday ? "Call time" : "Starts"}
                  </p>
                  <p className="type-poster mt-1.5 text-[2rem] leading-none text-[var(--cue-stage-ink)] tabular sm:text-[2.5rem]">
                    {nextEvent.all_day ? relativeDay(nextEvent.date) : untilLabel(nextEvent.date)}
                  </p>
                  {isNextToday && !nextEvent.all_day ? (
                    <p className="mt-2 flex items-center gap-2 text-[0.8125rem] text-[var(--cue-stage-ink)]/70">
                      <TempoBars className="text-[var(--cue-gold-on-brand)]" />
                      <span className="tabular">call at {fmtTime(nextEvent.date)}</span>
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {nextEvent.checkin_mode === "none" ? (
                    <span className="text-[0.8125rem] text-[var(--cue-stage-ink)]/75">
                      No attendance is taken for this event.
                    </span>
                  ) : checkedInEventId === nextEvent.id ? (
                    <span className="inline-flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--cue-mint)] px-3 py-2.5 text-[0.8125rem] font-semibold text-[var(--cue-forest)]">
                      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                      Checked in
                      {checkedInAt ? <span className="tabular">· {fmtTime(checkedInAt)}</span> : null}
                    </span>
                  ) : nextEvent.checkin_mode === "toggle" ? (
                    <span className="text-[0.8125rem] text-[var(--cue-stage-ink)]/75">
                      {CHECKIN_MODE_LABEL[nextEvent.checkin_mode]} — your section leader marks this
                      one.
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        app.isStaff
                          ? navigate("/attendance", { viewTransition: true })
                          : navigate(`/checkin?event=${nextEvent.id}`, { viewTransition: true })
                      }
                      className="motion-press inline-flex min-h-12 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--cue-stage-ink)] px-5 text-sm font-semibold text-[var(--cue-forest)] shadow-[0_14px_28px_-18px_rgb(0_0_0/70%)] hover:-translate-y-px hover:bg-white"
                    >
                      {app.isStaff ? (
                        <ClipboardCheck aria-hidden="true" className="h-4 w-4" />
                      ) : (
                        <QrCode aria-hidden="true" className="h-4 w-4" />
                      )}
                      {app.isStaff ? "Mark the roll" : "Check in"}
                    </button>
                  )}
                </div>

                {nextEvent.checkin_mode === "qr" || nextEvent.checkin_mode === "both" ? (
                  <p className="text-[0.75rem] text-[var(--cue-stage-ink)]/60">
                    {app.isStaff
                      ? "Project the code and students scan it."
                      : "Scan the code on the screen, or type the eight characters."}
                  </p>
                ) : null}
              </div>
            </div>
          </Stage>
        ) : (
          /* An empty dashboard is still a designed page: the stage stays, with
             the program's motif and the one thing worth doing next. */
          <Stage motif className="px-5 py-10 text-center sm:px-8 sm:py-14">
            <p className="type-kicker text-[var(--cue-gold-on-brand)]">Call sheet empty</p>
            <h2 className="mt-3 flex justify-center text-[var(--cue-stage-ink)]">
              <Poster tone="stage">Nothing scheduled</Poster>
            </h2>
            <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-[var(--cue-stage-ink)]/75">
              No rehearsals, performances or meetings are on {app.program?.name ?? "this program"}
              &rsquo;s calendar yet. When a director adds one, it lands right here.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => navigate("/calendar", { viewTransition: true })}
                className="motion-press inline-flex min-h-12 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--cue-stage-ink)] px-5 text-sm font-semibold text-[var(--cue-forest)] hover:-translate-y-px hover:bg-white"
              >
                <CalendarDays aria-hidden="true" className="h-4 w-4" />
                Open the calendar
              </button>
              <button
                type="button"
                onClick={() => navigate("/me", { viewTransition: true })}
                className="motion-press inline-flex min-h-12 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--cue-stage-line)] px-5 text-sm font-semibold text-[var(--cue-stage-ink)] hover:-translate-y-px hover:bg-white/10"
              >
                See your record
              </button>
            </div>
          </Stage>
        )}

        {/* --- two uneven columns: what's coming, and who you are here --- */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-10">
          <div className="flex flex-col gap-8">
            {shows("coming_up") && alsoUpcoming.length > 0 ? (
              <section
                aria-labelledby="coming-up"
                style={{ order: moduleOrder.indexOf("coming_up") }}
              >
                <SectionTitle
                  className="mb-3"
                  action={
                    /* A word, but a destination: it carries the 44px target of
                       a control rather than the 20px line box of a sentence link
                       (docs/QA_REPORT.md QA-03). */
                    <button
                      className="inline-flex min-h-11 items-center text-[0.8125rem] font-semibold text-[var(--cue-leaf)] underline decoration-2 underline-offset-4"
                      onClick={() => navigate("/calendar", { viewTransition: true })}
                    >
                      Full calendar
                    </button>
                  }
                >
                  <span id="coming-up">Coming up</span>
                </SectionTitle>
                <List>
                  {alsoUpcoming.map((e) => (
                    <Row
                      key={e.id}
                      className="gap-4"
                      leading={<DayMark iso={e.date} />}
                      title={
                        <span className="flex items-baseline gap-2">
                          <span className="truncate">{e.name}</span>
                          <Badge className={eventTypeChip(e.event_type)}>
                            {eventTypeLabel(e.event_type)}
                          </Badge>
                        </span>
                      }
                      subtitle={
                        <span className="tabular">
                          {relativeDay(e.date)} · {e.all_day ? "All day" : fmtTime(e.date)}
                          {e.location ? ` · ${e.location}` : ""}
                        </span>
                      }
                      trailing={
                        <ArrowRight
                          aria-hidden="true"
                          className="cue-nudge h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                        />
                      }
                      onClick={() => navigate("/calendar", { viewTransition: true })}
                    />
                  ))}
                </List>
              </section>
            ) : null}

            {/* --- the record --- */}
            {shows("my_attendance") && percentage !== null ? (
              <section
                aria-labelledby="my-attendance"
                style={{ order: moduleOrder.indexOf("my_attendance") }}
              >
                <SectionTitle
                  className="mb-3"
                  action={<span className="type-meta">Required events only</span>}
                >
                  <span id="my-attendance">Your attendance</span>
                </SectionTitle>
                <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
                    <ProgressRing value={percentage} size={84} stroke={8} animateValue />
                    <div className="min-w-0">
                      <p className="type-heading">
                        {percentage >= 80
                          ? "In good standing"
                          : percentage >= 60
                            ? "Slipping below the line"
                            : "Needs attention"}
                      </p>
                      <p className="type-meta mt-1">
                        Across the last {attendanceRows.length}{" "}
                        {attendanceRows.length === 1 ? "recorded event" : "recorded events"}
                        {missed > 0 ? ` · ${missed} missed or late` : " · nothing missed"}
                      </p>
                    </div>
                  </div>

                  {attendanceRows.length > 0 ? (
                    <ul className="cue-list">
                      {attendanceRows.map((row) => (
                        <li key={row.id} className="flex items-center gap-4 px-4 py-2.5">
                          <DayMark iso={row.date} className="w-12 pr-2" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[0.9375rem] font-semibold">
                              {row.name}
                            </span>
                            <span className="type-meta">
                              {relativeDay(row.date)} · {eventTypeLabel(row.event_type)}
                            </span>
                          </span>
                          {/* Keyed by status so a corrected mark visibly lands. */}
                          <Badge
                            key={row.status}
                            className={cn("cue-status-pop", ATTENDANCE_STATUS_CHIP[row.status])}
                          >
                            {ATTENDANCE_STATUS_LABEL[row.status]}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState
                      icon={<ClipboardCheck className="h-4 w-4" />}
                      title="No attendance recorded yet"
                      body="Once a required event has been marked, the record — and this percentage — fills in."
                    />
                  )}
                </div>
              </section>
            ) : null}
          </div>

          {/* --- the narrow column: your standing in this program --- */}
          <aside className="flex flex-col gap-8">
            {shows("my_programs") ? (
            <section
              aria-labelledby="my-programs"
              style={{ order: moduleOrder.indexOf("my_programs") }}
            >
              <SectionTitle
                className="mb-3"
                action={
                  app.canCreateProgram ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => navigate("/new-program", { viewTransition: true })}
                    >
                      Start one
                    </Button>
                  ) : null
                }
              >
                <span id="my-programs">Your programs</span>
              </SectionTitle>
              <List>
                {app.memberships.map((m) => (
                  <ProgramRow
                    key={m.id}
                    membership={m}
                    current={m.ensemble.id === app.program?.id}
                    onOpen={() => {
                      if (m.ensemble.id !== app.program?.id) app.setProgram(m.ensemble.id);
                      navigate("/");
                    }}
                  />
                ))}
              </List>
            </section>
            ) : null}

            {app.isStaff && shows("program_facts") ? (
              <section
                aria-labelledby="today-work"
                style={{ order: moduleOrder.indexOf("program_facts") }}
              >
                <SectionTitle className="mb-3">
                  <span id="today-work">This program</span>
                </SectionTitle>
                <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
                  <MetricStrip columns={2}>
                    <Metric
                      label="Events ahead"
                      value={upcoming.length}
                      hint={nextEvent ? `next ${relativeDay(nextEvent.date).toLowerCase()}` : "none scheduled"}
                    />
                    <Metric
                      label="Sections"
                      value={app.sections.length || "—"}
                      hint="instruments on the roster"
                    />
                    <Metric label="Your role" value={ROLE_LABEL[app.primaryRole]} hint="in this program" />
                    <Metric
                      label="Your programs"
                      value={app.memberships.length}
                      hint={app.memberships.length === 1 ? "membership" : "memberships"}
                    />
                  </MetricStrip>
                </div>
              </section>
            ) : null}

            {!app.isStaff && shows("quick_links") ? (
              <section
                aria-labelledby="quick-links"
                style={{ order: moduleOrder.indexOf("quick_links") }}
              >
                <SectionTitle className="mb-3">
                  <span id="quick-links">Quick links</span>
                </SectionTitle>
                <List>
                  <Row
                    icon={<QrCode className="h-4 w-4" />}
                    title="Check in"
                    subtitle="Scan a code or type the eight characters"
                    onClick={() => navigate("/checkin", { viewTransition: true })}
                  />
                  <Row
                    icon={<CalendarDays className="h-4 w-4" />}
                    title="Calendar"
                    subtitle="Everything the program has scheduled"
                    onClick={() => navigate("/calendar", { viewTransition: true })}
                  />
                </List>
              </section>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

function ProgramRow({
  membership,
  current,
  onOpen,
}: {
  membership: EmbeddedMembership;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3",
        current && "border-l-[3px] border-l-[var(--cue-leaf)] pl-[13px]"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="type-heading block truncate">
          {membership.ensemble.short_name || membership.ensemble.name}
        </span>
        <span className="type-meta mt-0.5 block truncate">
          {membership.roles.map((r) => ROLE_LABEL[r]).join(" · ") || ROLE_LABEL.student}
          {membership.section?.name ? ` · ${membership.section.name}` : ""}
        </span>
      </span>
      {current ? (
        <Badge className="bg-[var(--cue-leaf-soft)] text-[var(--cue-leaf)]">Here</Badge>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          icon={<ArrowRight className="h-4 w-4" />}
          onClick={onOpen}
        >
          Switch
        </Button>
      )}
    </div>
  );
}
