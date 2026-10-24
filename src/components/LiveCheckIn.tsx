import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, Maximize2, RefreshCw, Timer, Users, X } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Metric,
  MetricStrip,
  ProgressRing,
  SectionTitle,
  Spinner,
  cn,
} from "./ui";
import { fetchAttendance, fetchRoster, fetchSessionForEvent } from "../lib/queries";
import { startCheckinSession } from "../lib/rpc";
import type { AttendanceRow, EventRow, RosterMember, RpcResult } from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import { eventTypeChip, eventTypeLabel } from "../lib/constants";
import { endOfDay, fmtTime, mmss, relativeDay, startOfDay } from "../lib/date";
import { FullScreenCheckIn } from "./FullScreenCheckIn";

/** Sessions live for five minutes (see `start_checkin_session`). */
const SESSION_MS = 5 * 60 * 1000;
const POLL_MS = 5000;

/**
 * The projector view: a wall-mounted code plus a live count of who is still
 * missing. Legible from the back of the band hall, and it never keeps showing a
 * code that has expired.
 */
export function LiveCheckIn({ event, onExit }: { event: EventRow; onExit: () => void }) {
  const app = usePrograms();
  const programId = app.program?.id ?? null;

  const [session, setSession] = useState<RpcResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  // The smartboard view reuses this component's session and polling; it is a
  // presentation of the same live code, never a second one.
  const [display, setDisplay] = useState(false);
  const openDisplay = useCallback(() => {
    setDisplay(true);
    // Ask here, synchronously inside the click: Chrome and Safari reject a
    // `requestFullscreen()` issued from an effect, after the gesture is spent.
    // A refusal is not an error the staff can act on — the display overlay
    // covers the viewport either way.
    try {
      if (typeof document.documentElement.requestFullscreen === "function") {
        void document.documentElement.requestFullscreen().catch(() => undefined);
      }
    } catch {
      /* the overlay alone is the display */
    }
  }, []);
  const closeDisplay = useCallback(() => {
    setDisplay(false);
    // Leaving the overlay leaves the browser's fullscreen mode with it.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  const canRunCode = event.checkin_mode === "qr" || event.checkin_mode === "both";

  const refreshLive = useCallback(async () => {
    if (!programId) return;
    try {
      const [att, people] = await Promise.all([
        fetchAttendance(programId, {
          from: startOfDay(event.date).toISOString(),
          to: endOfDay(event.date).toISOString(),
        }),
        fetchRoster(programId),
      ]);
      setAttendance(att.filter((a) => a.event_id === event.id));
      setRoster(people);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh the live roster.");
    }
  }, [programId, event.id, event.date]);

  // Adopt a session that is already running (e.g. the projector page reloaded).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await fetchSessionForEvent(event.id);
        if (cancelled || !existing) return;
        if (new Date(existing.expires_at).getTime() > Date.now()) {
          setSession({
            ok: true,
            token: existing.token,
            entry_code: existing.entry_code,
            expires_at: existing.expires_at,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not check for an active session.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  useEffect(() => {
    void refreshLive();
    const id = window.setInterval(() => void refreshLive(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshLive]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { result, error: rpcError } = await startCheckinSession(event.id);
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      if (!result?.ok) {
        setError(result?.message ?? "Could not start a check-in.");
        return;
      }
      setSession(result);
      void refreshLive();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start a check-in.");
    } finally {
      setBusy(false);
    }
  }, [event.id, refreshLive]);

  const expiresMs = session?.expires_at ? new Date(session.expires_at).getTime() : null;
  const remainingMs = expiresMs ? Math.max(0, expiresMs - nowMs) : 0;
  const expired = expiresMs !== null && remainingMs <= 0;
  const ringPct = expiresMs ? (remainingMs / SESSION_MS) * 100 : 0;
  const expiringSoon = remainingMs > 0 && remainingMs <= 60_000;

  const students = useMemo(
    () => roster.filter((m) => m.active && !m.roles.includes("director")),
    [roster]
  );

  const checkedIn = useMemo(
    () => attendance.filter((a) => a.attended && a.status !== "excused"),
    [attendance]
  );

  const missingBySection = useMemo(() => {
    const done = new Set(checkedIn.map((a) => a.student_id));
    const groups = new Map<string, RosterMember[]>();
    for (const member of students) {
      if (done.has(member.user_id)) continue;
      const key = member.section_name || "No section";
      const list = groups.get(key) ?? [];
      list.push(member);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [checkedIn, students]);

  const recent = useMemo(
    () =>
      [...checkedIn]
        .filter((a) => a.checked_in_at)
        .sort(
          (a, b) =>
            new Date(b.checked_in_at as string).getTime() -
            new Date(a.checked_in_at as string).getTime()
        )
        .slice(0, 6),
    [checkedIn]
  );

  const nameOf = useCallback(
    (userId: string) => {
      const member = roster.find((m) => m.user_id === userId);
      return member ? member.profile.display_name || member.profile.full_name : "Someone";
    },
    [roster]
  );

  const pctCheckedIn = students.length
    ? Math.round((checkedIn.length / students.length) * 100)
    : 0;

  const missingCount = students.length - checkedIn.length;
  const waitingForFirstScan = attendance.length === 0 && checkedIn.length === 0;

  const checkinUrl = session?.token
    ? `${window.location.origin}/checkin?token=${session.token}`
    : null;

  return (
    <div className="space-y-5">
      {/* --- what this screen is running --- */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-[var(--cue-line)] pb-3">
        <div className="min-w-0">
          <p className="type-label mb-1">Live check-in</p>
          <h2 className="type-title truncate">{event.name}</h2>
          <p className="type-meta mt-1 flex flex-wrap items-center gap-x-2 tabular">
            <Badge className={eventTypeChip(event.event_type)}>
              {eventTypeLabel(event.event_type)}
            </Badge>
            <span>
              {relativeDay(event.date)} · {event.all_day ? "All day" : fmtTime(event.date)}
            </span>
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onExit}
          icon={<X className="h-4 w-4" />}
        >
          Stop
        </Button>
      </header>

      {error ? <Alert tone="warn">{error}</Alert> : null}

      {!canRunCode ? (
        <Alert tone="info">
          This event uses {event.checkin_mode === "none" ? "no check-in" : "staff marking the roll"}
          {" — "}mark it from the Attendance screen instead.
        </Alert>
      ) : !session || session.ok !== true || !checkinUrl ? (
        <Card className="space-y-4 p-5">
          <div>
            <p className="type-title">Ready when you are</p>
            <p className="type-meta mt-1">
              A code runs for five minutes and students scan it or type the eight characters. Start
              a new one whenever you need to.
            </p>
          </div>
          <Button size="lg" loading={busy} onClick={() => void start()} icon={<Timer className="h-4 w-4" />}>
            Start check-in
          </Button>
        </Card>
      ) : (
        <div className="cue-stagger grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* --- the code itself --- */}
          {/* Keyed to the session: a refreshed code lands as a fresh arrival
              instead of silently swapping pixels. */}
          <Card key={session.token} className="flex flex-col items-center gap-5 py-5 sm:py-6">
            <div
              className={cn(
                "rounded-[var(--radius-control)] bg-white p-3 ring-1 ring-[var(--cue-line-strong)] transition-opacity",
                expired && "opacity-25"
              )}
            >
              <QRCodeSVG value={checkinUrl} size={240} level="M" fgColor="#173b28" bgColor="#ffffff" />
            </div>

            {/* The code is one unbreakable token, so its size is the only thing
                that keeps it inside the card. Eight characters at 3rem measure
                ~288px, which fits the ~370px two-column card; the old 3.75rem
                measured 408px and the neighbouring column covered its last
                character. Keep the sizes in step with the test in
                `e2e/qa-guard.spec.ts` that measures this box. */}
            <div className="w-full min-w-0 text-center">
              <p className="type-label">Or type this code</p>
              <p
                className={cn(
                  "mt-1.5 max-w-full font-mono text-[2.25rem] leading-none font-semibold tracking-[0.2em] sm:text-5xl lg:text-[3rem]",
                  expired && "text-[var(--cue-subtle)] line-through"
                )}
              >
                {session.entry_code}
              </p>
            </div>

            {expired ? (
              <div className="flex flex-col items-center gap-2">
                <Alert tone="warn">Code expired — get a fresh one.</Alert>
                <Button loading={busy} onClick={() => void start()} icon={<RefreshCw className="h-4 w-4" />}>
                  New code
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <ProgressRing value={ringPct} size={64} stroke={7}>
                  <span className="font-mono text-xs font-bold">{mmss(session.expires_at!, nowMs)}</span>
                </ProgressRing>
                <div className="text-left">
                  <p className={cn("text-sm font-semibold", expiringSoon && "text-[var(--cue-late)]")}>
                    {expiringSoon ? "Refresh soon" : "Live for"} {mmss(session.expires_at!, nowMs)}
                  </p>
                  <p className="type-meta">
                    {checkedIn.length} of {students.length} checked in
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 -ml-3"
                    loading={busy}
                    onClick={() => void start()}
                    icon={<RefreshCw className="h-4 w-4" />}
                  >
                    New code
                  </Button>
                </div>
              </div>
            )}

            {!expired ? (
              <Button
                block
                variant="secondary"
                size="lg"
                onClick={openDisplay}
                icon={<Maximize2 className="h-4 w-4" />}
              >
                Full-screen display
              </Button>
            ) : null}
          </Card>

          <div className="space-y-4">
            <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
              <div className="flex items-center justify-between gap-3 px-4 pt-3">
                <p className="type-label">Checked in</p>
                <span
                  key={waitingForFirstScan ? "waiting" : "live"}
                  className="type-meta flex items-center gap-1.5"
                >
                  {waitingForFirstScan ? (
                    <>
                      <Spinner className="h-3.5 w-3.5" /> waiting for the first scan
                    </>
                  ) : (
                    <>
                      <CheckCircle2
                        aria-hidden="true"
                        className="cue-live-breathe h-4 w-4 text-[var(--cue-present)]"
                      />
                      live
                    </>
                  )}
                </span>
              </div>
              <MetricStrip columns={2} className="mt-1">
                <Metric
                  label="Present"
                  value={
                    <span key={checkedIn.length} className="cue-odometer">
                      {checkedIn.length}
                    </span>
                  }
                  hint={`of ${students.length} on the roster`}
                  tone="present"
                />
                <Metric
                  label="Still missing"
                  value={
                    <span key={missingCount} className="cue-odometer">
                      {missingCount}
                    </span>
                  }
                  hint={`${pctCheckedIn}% checked in`}
                  tone={missingCount > 0 ? "late" : "muted"}
                />
              </MetricStrip>
              <div className="px-4 pt-1 pb-4">
                <div
                  role="progressbar"
                  aria-valuenow={pctCheckedIn}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${checkedIn.length} of ${students.length} checked in`}
                  className="h-1.5 overflow-hidden rounded-full bg-[var(--cue-raised)]"
                >
                  <div
                    className="cue-meter-fill h-full w-full rounded-full bg-[var(--cue-present)]"
                    style={{ transform: `scaleX(${pctCheckedIn / 100})` }}
                  />
                </div>
              </div>
            </div>

          {recent.length > 0 ? (
            <Card className="p-0">
              <SectionTitle className="px-4 pt-4 pb-2">Just checked in</SectionTitle>
              <ul>
                {recent.map((a) => (
                  <li
                    key={a.id}
                    className="roster-arrive flex min-h-12 items-center justify-between gap-3 border-t border-[var(--cue-line)] px-4 py-2 text-sm"
                  >
                    <span className="truncate font-medium">{nameOf(a.student_id)}</span>
                    <span className="type-meta shrink-0 tabular">
                      {a.checked_in_at ? fmtTime(a.checked_in_at) : ""}
                      {a.is_late ? " · late" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="p-0">
            <SectionTitle className="px-4 pt-4 pb-2"
              action={
                <span className="flex items-center gap-1.5 text-xs text-[var(--cue-muted)]">
                  <Users className="h-4 w-4" />
                  <span>
                    <span key={missingCount} className="cue-odometer">{missingCount}</span> missing
                  </span>
                </span>
              }
            >
              Still missing
            </SectionTitle>
            {/* The empty-roster label carries `roster-arrive`, the documented
                "settles in" entrance. It used to carry `animate-in`, which no
                rule in the stylesheet matches — so it never moved at all.
                docs/QA_REPORT.md QA-05. */}
            {missingBySection.length === 0 ? (
              <p className="roster-arrive px-4 py-5 text-sm font-semibold text-[var(--cue-present)]">
                Everyone&rsquo;s here.
              </p>
            ) : (
              <div className="divide-y divide-[var(--cue-line)] border-t border-[var(--cue-line)]">
                {missingBySection.map(([section, members]) => (
                  <div key={section} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold">{section}</p>
                      <span className="type-meta tabular">{members.length}</span>
                    </div>
                    <p className="type-meta mt-1 leading-relaxed">
                      {members
                        .map((m) => m.profile.display_name || m.profile.full_name)
                        .join(" · ")}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
          </div>
        </div>
      )}

      {students.length === 0 && roster.length > 0 ? (
        <EmptyState
          title="No students on the roster yet"
          body="Add members from the Roster screen and they'll show up here."
        />
      ) : null}

      {display && session?.token && session.entry_code && checkinUrl ? (
        <FullScreenCheckIn
          event={event}
          checkinUrl={checkinUrl}
          entryCode={session.entry_code}
          expiresAt={session.expires_at ?? null}
          nowMs={nowMs}
          checkedIn={checkedIn.length}
          total={students.length}
          expired={expired}
          onExit={closeDisplay}
        />
      ) : null}
    </div>
  );
}
