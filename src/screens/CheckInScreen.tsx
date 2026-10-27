import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  QrCode,
  ScanLine,
  Timer,
} from "lucide-react";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SegmentedControl,
  Sheet,
  Skeleton,
  Spinner,
  cn,
} from "../components/ui";
import { QrScanner } from "../components/QrScanner";
import { LiveCheckIn } from "../components/LiveCheckIn";
import { CheckInConfirmation } from "../components/CheckInSuccess";
import { fetchEvents, fetchSessionForEvent } from "../lib/queries";
import { recordAttendance, recordAttendanceByCode } from "../lib/rpc";
import type { RpcResponse } from "../lib/rpc";
import {
  checkinWindow,
  isCheckinClosedMessage,
  loadRecordedCheckins,
  submitCheckin,
} from "../lib/checkin";
import type { CheckinKind } from "../lib/checkin";
import { useNow } from "../hooks/useNow";
import type { EventRow, RpcResult } from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import { CHECKIN_CODE_LENGTH, CHECKIN_MODE_LABEL, eventTypeLabel } from "../lib/constants";
import { fmtTime, parseTokenFromString, relativeDay } from "../lib/date";
import { hapticCheckIn, hapticCheckInError } from "../lib/motion";

/**
 * `/checkin` — one route, two jobs.
 *
 *  * a `?token=…` deep link (or an unknown-code failure in the bucket) is
 *    accepted even when the bucket appears in the logs once;
 *  * students scan the projected QR code or type the 8 characters;
 *  * staff get the projector view (see LiveCheckIn) and can still check
 *    themselves in with the code, exactly like a student.
 */

/** A token is submitted once per page load; refresh shows the same outcome. */
const submittedTokens = new Set<string>();
const tokenOutcomes = new Map<string, { result: RpcResult; kind: CheckinKind }>();

export function CheckInScreen() {
  const app = usePrograms();
  const [params] = useSearchParams();
  const token = params.get("token");
  const eventParam = params.get("event");

  // A scanned code always wins — staff scan the wall too.
  if (token) return <StudentCheckIn token={token} />;
  if (app.isStaff) return <StaffCheckIn initialEventId={eventParam} />;
  return <StudentCheckIn token={null} />;
}

/* -------------------------------------------------------------------------- */
/* Student flow                                                               */
/* -------------------------------------------------------------------------- */

function StudentCheckIn({ token }: { token: string | null }) {
  const app = usePrograms();
  return (
    <div className="cue-stagger mx-auto max-w-xl space-y-5 px-4 py-5 pb-8 sm:px-6 sm:py-6">
      {token ? (
        <TokenResult token={token} />
      ) : (
        <>
          <PageHeader
            kicker={app.program?.short_name || app.program?.name || "Your program"}
            title="Check in"
            note="Scan the code on the rehearsal-room screen, or type the 8 characters."
          />
          <CheckInForm />
        </>
      )}
    </div>
  );
}

/** Submits a token from the URL exactly once and renders the outcome. */
function TokenResult({ token }: { token: string }) {
  const app = usePrograms();
  const profileId = app.profile?.id ?? null;
  const [state, setState] = useState<"working" | "done">(() =>
    tokenOutcomes.has(token) || submittedTokens.has(token) ? "done" : "working"
  );
  const [outcome, setOutcome] = useState<{ result: RpcResult; kind: CheckinKind } | null>(
    () => tokenOutcomes.get(token) ?? null
  );
  const [failure, setFailure] = useState<string | null>(null);

  // The first mount owns the request and always applies its result, even if
  // React re-invokes the effect (StrictMode) — otherwise the second invocation
  // would see the token already submitted and nobody would ever answer.
  useEffect(() => {
    if (submittedTokens.has(token)) {
      const cached = tokenOutcomes.get(token);
      if (cached) setOutcome(cached);
      return;
    }
    submittedTokens.add(token);
    void (async () => {
      try {
        const { response, kind } = await submitCheckin(profileId, () => recordAttendance(token));
        const { result, error } = response;
        if (error) {
          setFailure(error.message);
          hapticCheckInError();
        } else if (result?.ok) {
          tokenOutcomes.set(token, { result, kind });
          setOutcome({ result, kind });
          if (kind === "new") hapticCheckIn(Boolean(result.is_late));
        } else {
          if (result) tokenOutcomes.set(token, { result, kind });
          setFailure(result?.message ?? "That code didn't work.");
          hapticCheckInError();
        }
      } catch (e) {
        setFailure(e instanceof Error ? e.message : "Could not check you in. Try again.");
        hapticCheckInError();
      } finally {
        setState("done");
      }
    })();
  }, [token, profileId]);

  if (state === "working") {
    return (
      <Card className="flex items-center gap-3 py-8">
        <Spinner className="text-[var(--cue-green)]" />
        <div>
          <p className="font-semibold">Checking you in…</p>
          <p className="type-meta">Hold on a second.</p>
        </div>
      </Card>
    );
  }

  if (outcome?.result.ok) return <CheckInOutcome outcome={outcome.result} kind={outcome.kind} />;

  // The server refused because the event's window has closed: that is an answer,
  // not an error. Offering the form again would only produce the same refusal.
  if (isCheckinClosedMessage(failure ?? outcome?.result.message)) return <CheckInClosed />;

  return (
    <div className="space-y-4">
      <Alert tone="error" className="checkin-error">
        {failure ?? outcome?.result.message ?? "That check-in code didn't work."}
      </Alert>
      <p className="type-meta">
        If the code on screen has changed, ask your director or section leader for the current one.
      </p>
      <CheckInForm />
    </div>
  );
}

/**
 * What a student is shown when the event's check-in window has closed.
 *
 * The rule is the database's, not this screen's: `record_checkin_for_session`
 * refuses a scan past the event's saved end time, so a refreshed page, an old QR
 * code or a check-in screen left open all end here — there is no client path
 * that can accept one. `onRetry` exists only so a student who scanned the wrong
 * project's code is not stuck.
 */
function CheckInClosed({ onRetry }: { onRetry?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="cue-stagger space-y-3">
      <Card className="space-y-2">
        <div className="flex items-center gap-2">
          <Timer aria-hidden="true" className="h-4 w-4 text-[var(--cue-muted)]" />
          <p className="type-heading">Check-in has closed</p>
        </div>
        <p className="text-sm">
          This event stopped taking check-ins at its scheduled end time, so nothing you scan or
          type now can record you.
        </p>
        <p className="type-meta">
          If you were there, ask your director or section leader to mark the roll for you.
        </p>
      </Card>
      {onRetry ? (
        <Button block variant="secondary" onClick={onRetry}>
          Try another code
        </Button>
      ) : null}
      <Button block variant="secondary" onClick={() => navigate("/")}>
        Done
      </Button>
    </div>
  );
}

/**
 * The one confirmation both flows end on: a mark, the outcome in words, and the
 * event it belongs to. Only a check-in the server confirmed as new animates; a
 * repeat and an unclassifiable success use the same card without it.
 */
function CheckInOutcome({ outcome, kind }: { outcome: RpcResult; kind: CheckinKind }) {
  const navigate = useNavigate();
  return (
    <div className="cue-stagger space-y-3">
      <CheckInConfirmation outcome={outcome} kind={kind} />
      <Button block variant="secondary" onClick={() => navigate("/")}>
        Done
      </Button>
    </div>
  );
}

/** Scan-or-type check-in. Shared by students and by staff checking themselves in. */
function CheckInForm() {
  const app = usePrograms();
  const profileId = app.profile?.id ?? null;
  const [tab, setTab] = useState<"scan" | "code">("scan");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ result: RpcResult; kind: CheckinKind } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The camera can hand over two frames before `busy` repaints; this refuses
  // the second one synchronously, so one scan is one submission.
  const inFlight = useRef(false);

  // Read what is already recorded while the camera opens, so the submit itself
  // does not wait on a second round trip.
  useEffect(() => {
    if (profileId) void loadRecordedCheckins(profileId).catch(() => undefined);
  }, [profileId]);

  const submit = useCallback(
    async (run: () => Promise<RpcResponse>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setFailure(null);
      try {
        const { response, kind } = await submitCheckin(profileId, run);
        const { result, error } = response;
        if (error) {
          setFailure(error.message);
          hapticCheckInError();
          return;
        }
        if (result?.ok) {
          setOutcome({ result, kind });
          if (kind === "new") hapticCheckIn(Boolean(result.is_late));
        } else {
          setFailure(result?.message ?? "That didn't work — ask for a fresh code.");
          hapticCheckInError();
        }
      } catch (e) {
        setFailure(e instanceof Error ? e.message : "Could not check you in. Try again.");
        hapticCheckInError();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [profileId]
  );

  const onDecode = useCallback(
    (text: string) => {
      const parsed = parseTokenFromString(text);
      if (!parsed) {
        setFailure("That QR code isn't a check-in code for this program.");
        hapticCheckInError();
        return;
      }
      void submit(() => recordAttendance(parsed));
    },
    [submit]
  );

  const onScannerError = useCallback((message: string) => setFailure(message), []);

  if (outcome?.result.ok) return <CheckInOutcome outcome={outcome.result} kind={outcome.kind} />;

  // A closed event stops the scan and the typed code here as well as on the
  // server. "Try another code" clears it for the rare student who is in two
  // programs and scanned the one that has ended.
  if (isCheckinClosedMessage(failure)) {
    return <CheckInClosed onRetry={() => setFailure(null)} />;
  }

  return (
    <div className="cue-stagger space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <QrCode aria-hidden="true" className="h-4 w-4 text-[var(--cue-muted)]" />
          <p className="type-heading">Scan or enter your code</p>
        </div>

        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: "scan", label: "Scan QR" },
            { value: "code", label: "Enter code" },
          ]}
        />

        {/* Keyed by tab so the incoming pane always plays one short,
            directional reveal; the tab itself never waits on it. */}
        <div
          key={tab}
          className={cn("cue-pane", tab === "scan" && "cue-pane-from-left")}
        >
          {tab === "scan" ? (
            <div className="space-y-2">
              <QrScanner active={!busy} onDecode={onDecode} onError={onScannerError} />
              <p className="type-meta text-center">
                Point your camera at the QR code on the screen.
              </p>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim().length < CHECKIN_CODE_LENGTH) return;
                void submit(() => recordAttendanceByCode(code.trim()));
              }}
            >
              <Field label="Check-in code" hint={`${CHECKIN_CODE_LENGTH} characters, on the screen`}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, CHECKIN_CODE_LENGTH))}
                  placeholder="ABCD2345"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="text-center font-mono text-2xl tracking-[0.3em]"
                  autoFocus
                />
                {/* Progress toward a complete code: a transform-only meter,
                    so typing never triggers a reflow. */}
                <span
                  aria-hidden="true"
                  className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-[var(--cue-raised)]"
                >
                  <span
                    className="cue-meter-fill block h-full rounded-full bg-[var(--cue-green)]"
                    style={{
                      transform: `scaleX(${code.trim().length / CHECKIN_CODE_LENGTH})`,
                    }}
                  />
                </span>
              </Field>
              <Button
                block
                size="lg"
                type="submit"
                loading={busy}
                disabled={code.trim().length < CHECKIN_CODE_LENGTH}
                icon={<ScanLine className="h-5 w-5" />}
              >
                Check in
              </Button>
            </form>
          )}
        </div>
      </Card>

      {failure ? <Alert tone="error" className="checkin-error">{failure}</Alert> : null}

      <TodayHint programId={app.program?.id ?? null} />
    </div>
  );
}

/** Small context card: is there something to check in for right now? */
function TodayHint({ programId }: { programId: string | null }) {
  const [event, setEvent] = useState<EventRow | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const navigate = useNavigate();
  const now = useNow(30_000);

  useEffect(() => {
    if (!programId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchEvents(programId, {
          from: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
          to: new Date(new Date().setHours(23, 59, 59, 999)).toISOString(),
        });
        // Today's event that matters: one still taking check-ins, else the next
        // one to start, else the last of the day — never an earlier one that is
        // already over, which is what used to make this card point at the wrong
        // rehearsal all afternoon.
        const ms = Date.now();
        const chosen =
          list.find((e) => checkinWindow(e, ms).open && new Date(e.date).getTime() > ms) ??
          list.find((e) => checkinWindow(e, ms).open) ??
          list[list.length - 1] ??
          null;
        const session = chosen ? await fetchSessionForEvent(chosen.id) : null;
        if (cancelled) return;
        setEvent(chosen);
        setHasSession(Boolean(session && new Date(session.expires_at) > new Date()));
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load today’s event.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [programId, retry]);

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (error) {
    return (
      <Card className="space-y-3">
        <Alert tone="error">{error}</Alert>
        <Button
          variant="secondary"
          onClick={() => {
            setLoading(true);
            setRetry((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </Card>
    );
  }
  if (!event) {
    return (
      <Card className="space-y-3">
        <p className="type-heading">Nothing on today&rsquo;s call sheet</p>
        <p className="type-meta">See when the next rehearsal or event is scheduled.</p>
        <Button variant="secondary" onClick={() => navigate("/calendar", { viewTransition: true })}>
          Open calendar
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <p className="type-label">Today</p>
      <p className="type-heading mt-1.5">{event.name}</p>
      <p className="type-meta mt-0.5 tabular">
        {relativeDay(event.date)} · {event.all_day ? "All day" : fmtTime(event.date)} ·{" "}
        {eventTypeLabel(event.event_type)}
      </p>
      <p className="type-meta mt-1.5">
        {!checkinWindow(event, now).open ? (
          <span className="font-medium">
            Check-in closed
            {event.end_date ? ` at ${fmtTime(event.end_date)}` : " 24 hours after it began"}.
          </span>
        ) : hasSession ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--cue-green)]">
            <Timer aria-hidden="true" className="h-4 w-4" /> A code is live right now
          </span>
        ) : (
          "No live code yet — ask your director or section leader."
        )}
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Staff flow                                                                 */
/* -------------------------------------------------------------------------- */

function StaffCheckIn({ initialEventId }: { initialEventId: string | null }) {
  const app = usePrograms();
  const programId = app.program?.id ?? null;

  const [mode, setMode] = useState<"run" | "self">("run");
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsRetry, setEventsRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(initialEventId);
  const [pickerOpen, setPickerOpen] = useState(false);
  // "Stop" must actually stop: without this the default-selection effect would
  // immediately reopen the live view it just closed.
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (!programId) return;
    let cancelled = false;
    setEvents(null);
    setEventsError(null);
    void (async () => {
      try {
        const list = await fetchEvents(programId);
        if (cancelled) return;
        setEvents(list);
        setEventsError(null);
      } catch (e) {
        if (cancelled) return;
        setEventsError(e instanceof Error ? e.message : "Could not load events.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [programId, eventsRetry]);

  /** Events that can host a QR/code session, closest to now first. */
  const selectable = useMemo(() => {
    const list = (events ?? []).filter(
      (e) => e.checkin_mode === "qr" || e.checkin_mode === "both"
    );
    const now = Date.now();
    return [...list].sort(
      (a, b) => Math.abs(new Date(a.date).getTime() - now) - Math.abs(new Date(b.date).getTime() - now)
    );
  }, [events]);

  const selected = useMemo(
    () => selectable.find((e) => e.id === selectedId) ?? null,
    [selectable, selectedId]
  );

  // Pick a sensible default once the list arrives: today's session-friendly
  // event, else the nearest one.
  useEffect(() => {
    if (stopped || selectedId || selectable.length === 0) return;
    const today = selectable.find(
      (e) => new Date(e.date).toDateString() === new Date().toDateString()
    );
    setSelectedId((today ?? selectable[0]!).id);
  }, [selectable, selectedId, stopped]);

  return (
    <div className="cue-stagger mx-auto max-w-3xl space-y-5 px-4 py-5 pb-8 sm:px-6 sm:py-6">
      <PageHeader
        kicker={app.program?.short_name || app.program?.name || "Program"}
        title="Check-in"
        note="Run a live code for the room, or check yourself in the same way a student does."
      />

      <SegmentedControl
        value={mode}
        onChange={setMode}
        options={[
          { value: "run", label: "Run a check-in" },
          { value: "self", label: "Check in myself" },
        ]}
      />

      {mode === "self" ? (
        <CheckInForm />
      ) : eventsError ? (
        <Card className="space-y-3">
          <Alert tone="error">{eventsError}</Alert>
          <Button
            variant="secondary"
            onClick={() => setEventsRetry((value) => value + 1)}
          >
            Try again
          </Button>
        </Card>
      ) : events === null ? (
        <Skeleton className="h-40 w-full" />
      ) : selectable.length === 0 ? (
        <div className="cue-card rounded-[var(--radius-panel)]">
          <EmptyState
            icon={<ClipboardCheck className="h-4 w-4" />}
            title="No event takes a check-in code"
            body="Add an event with QR or both check-in, or mark the roll from the Attendance screen."
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="cue-card motion-press flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-panel)] p-3 text-left hover:bg-[var(--cue-raised)]"
          >
            <span className="min-w-0 flex-1">
              <span className="type-label block">Event</span>
              <span className="block truncate font-semibold">
                {selected?.name ?? "Choose an event"}
              </span>
              <span className="type-meta block truncate tabular">
                {selected
                  ? `${relativeDay(selected.date)} · ${
                      selected.all_day ? "All day" : fmtTime(selected.date)
                    } · ${CHECKIN_MODE_LABEL[selected.checkin_mode]}`
                  : "Pick which event you're running"}
              </span>
            </span>
            <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
          </button>

          {selected ? (
            <LiveCheckIn
              event={selected}
              onExit={() => {
                setStopped(true);
                setSelectedId(null);
              }}
            />
          ) : (
            <EmptyState
              icon={<QrCode className="h-4 w-4" />}
              title="Pick an event"
              body="Choose the rehearsal or performance you're taking attendance for."
            />
          )}

          <Sheet
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            title="Which event?"
            size="tall"
          >
            <ul className="cue-card cue-list overflow-hidden rounded-[var(--radius-panel)]">
              {selectable.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setStopped(false);
                      setSelectedId(e.id);
                      setPickerOpen(false);
                    }}
                    aria-current={e.id === selectedId}
                    className={cn(
                      "flex min-h-14 w-full items-center gap-2 px-3 py-2.5 text-left",
                      e.id === selectedId ? "bg-[var(--cue-raised)]" : "hover:bg-[var(--cue-raised)]"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{e.name}</span>
                      <span className="type-meta block truncate tabular">
                        {relativeDay(e.date)} ·{" "}
                        {e.all_day ? "All day" : fmtTime(e.date)} ·{" "}
                        {eventTypeLabel(e.event_type)}
                      </span>
                    </span>
                    {e.id === selectedId ? (
                      <CheckCircle2
                        aria-hidden="true"
                        className="h-5 w-5 shrink-0 text-[var(--cue-green)]"
                      />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>
        </>
      )}
    </div>
  );
}
