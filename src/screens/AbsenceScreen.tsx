import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, Check, Clock, RefreshCw, Undo2, X } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  List,
  PageHeader,
  Row,
  SectionTitle,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  Textarea,
  cn,
  useToast,
} from "../components/ui";
import { fetchEvents } from "../lib/queries";
import {
  allowAbsenceResubmission,
  createAbsenceRequest,
  decideAbsenceRequest,
  listAbsenceRequests,
  listMyAbsenceRequests,
  withdrawAbsenceRequest,
} from "../lib/rpc";
import type { AbsenceRequestRow, AbsenceStatus, EventRow, MyAbsenceRequestRow } from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import {
  ABSENCE_STATUS_CHIP,
  ABSENCE_STATUS_LABEL,
  ATTENDANCE_REQUIREMENT_LABEL,
  eventTypeLabel,
} from "../lib/constants";
import { fmtTime, relativeDay } from "../lib/date";

/**
 * `/absences` — the two halves of one workflow.
 *
 * A student asks to miss a future event and reads the answer; a reviewer sees
 * the queue and decides. Both halves are rendered only when the server says the
 * person holds the capability (`absence.request_self` / `absence.review`), and
 * every RPC re-checks it. Approval never writes attendance: the roll is still
 * where an excused mark is made, and this screen says so.
 */

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "all", label: "All" },
];

function StatusBadge({ status }: { status: AbsenceStatus }) {
  return (
    <Badge className={cn(ABSENCE_STATUS_CHIP[status], "px-2 py-1")}>
      {ABSENCE_STATUS_LABEL[status]}
    </Badge>
  );
}

/**
 * A request blocks a new one while it is pending or decided — unless a reviewer
 * has deliberately reopened the event (`resubmission_allowed`). The database
 * enforces the same rule with a partial unique index; this only keeps the form
 * offering the right events.
 */
function blocksNewRequest(row: MyAbsenceRequestRow): boolean {
  return (
    !row.resubmission_allowed &&
    (row.status === "pending" || row.status === "approved" || row.status === "denied")
  );
}

export function AbsenceScreen() {
  const app = usePrograms();
  const { toast } = useToast();
  const programId = app.program?.id ?? null;
  const [params, setParams] = useSearchParams();

  // Two independent capabilities, not roles: a director who also performs can
  // hold both, and the server decides either way. Holding one never implies the
  // other, which is what stops a request being approved by its author.
  const canRequest = app.can("absence.request_self");
  const canReview = app.can("absence.review");

  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [mine, setMine] = useState<MyAbsenceRequestRow[] | null>(null);
  const [queue, setQueue] = useState<AbsenceRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueMessage, setQueueMessage] = useState<string | null>(null);

  const [eventId, setEventId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState("pending");
  const [eventFilter, setEventFilter] = useState("all");
  const [sectionFilter, setSectionFilter] = useState("all");
  const [queueLoading, setQueueLoading] = useState(false);

  const [deciding, setDeciding] = useState<AbsenceRequestRow | null>(null);
  const [decision, setDecision] = useState<"approved" | "denied">("approved");
  const [decisionNote, setDecisionNote] = useState("");
  const [savingDecision, setSavingDecision] = useState(false);
  const [resubmitting, setResubmitting] = useState<string | null>(null);

  const loadBase = useCallback(async () => {
    if (!programId) return;
    setError(null);
    try {
      const list = await fetchEvents(programId);
      setEvents(list);

      if (canRequest) {
        const response = await listMyAbsenceRequests(programId);
        setMine(response.rows);
        if (response.message) setError(response.message);
      } else {
        setMine([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load absence requests.");
      setEvents([]);
      setMine([]);
    }
  }, [programId, canRequest]);

  const loadQueue = useCallback(async () => {
    if (!programId || !canReview) {
      setQueue([]);
      return;
    }
    setQueueLoading(true);
    try {
      const response = await listAbsenceRequests(programId, {
        status: statusFilter,
        event: eventFilter === "all" ? null : eventFilter,
        section: sectionFilter === "all" ? null : sectionFilter,
      });
      setQueue(response.rows);
      setQueueMessage(response.message);
    } catch (e) {
      setQueueMessage(e instanceof Error ? e.message : "Could not load the review queue.");
      setQueue([]);
    } finally {
      setQueueLoading(false);
    }
  }, [programId, canReview, statusFilter, eventFilter, sectionFilter]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Deep link from the calendar or home screen: preselect that event.
  useEffect(() => {
    const wanted = params.get("event");
    if (wanted && events?.some((e) => e.id === wanted)) setEventId(wanted);
  }, [params, events]);

  const eligible = useMemo(() => {
    if (!events || !mine) return [];
    const blocked = new Set(mine.filter(blocksNewRequest).map((r) => r.event_id));
    return events
      .filter(
        (e) =>
          !e.archived &&
          e.attendance_requirement !== "none" &&
          new Date(e.date).getTime() > Date.now() &&
          !blocked.has(e.id)
      )
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [events, mine]);

  const selectedEvent = useMemo(
    () => eligible.find((e) => e.id === eventId) ?? null,
    [eligible, eventId]
  );

  const pendingQueueCount = useMemo(
    () => (queue ?? []).filter((r) => r.status === "pending").length,
    [queue]
  );

  const sectionOptions = useMemo(
    () => app.sections.map((s) => ({ value: s.id, label: s.name })),
    [app.sections]
  );

  async function submit() {
    if (!selectedEvent) {
      setFormError("Choose the event you will miss.");
      return;
    }
    if (reason.trim().length < 1) {
      setFormError("Say briefly why you will be away.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const { result, error: rpcError } = await createAbsenceRequest(selectedEvent.id, reason);
    setSubmitting(false);
    if (rpcError || !result?.ok) {
      setFormError(rpcError?.message || result?.message || "Could not send that request.");
      return;
    }
    setReason("");
    setEventId("");
    setParams({}, { replace: true });
    toast.success("Absence request sent.");
    await loadBase();
    await loadQueue();
  }

  async function withdraw(row: MyAbsenceRequestRow) {
    setWithdrawing(row.id);
    const { result, error: rpcError } = await withdrawAbsenceRequest(row.id);
    setWithdrawing(null);
    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not withdraw that request.");
      return;
    }
    toast.success("Request withdrawn.");
    await loadBase();
  }

  function openDecision(row: AbsenceRequestRow, choice: "approved" | "denied") {
    setDeciding(row);
    setDecision(choice);
    setDecisionNote("");
  }

  async function saveDecision() {
    if (!deciding) return;
    setSavingDecision(true);
    const { result, error: rpcError } = await decideAbsenceRequest(
      deciding.id,
      decision,
      decisionNote
    );
    setSavingDecision(false);
    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not save that decision.");
      return;
    }
    toast.success(result.message ?? "Decision saved.");
    setDeciding(null);
    await loadBase();
    await loadQueue();
  }

  async function allowAgain(row: AbsenceRequestRow) {
    setResubmitting(row.id);
    const { result, error: rpcError } = await allowAbsenceResubmission(row.id);
    setResubmitting(null);
    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not reopen that request.");
      return;
    }
    toast.success("That student can ask again.");
    await loadQueue();
  }

  if (!programId) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-16 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-8">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <PageHeader
          kicker={app.program?.short_name || app.program?.name || "Program"}
          title="Absences"
          note={
            canReview && canRequest
              ? "Ask to miss an event, and answer the requests your students send."
              : canReview
                ? "Requests from your students, and the decisions you have made."
                : "Ask to miss an event, and read the answer here."
          }
        />

        {/* --- the student half --- */}
        {canRequest ? (
          <section aria-labelledby="ask-absence">
            <SectionTitle className="mb-3">
              <span id="ask-absence">Ask to miss an event</span>
            </SectionTitle>

            {events === null || mine === null ? (
              <Skeleton className="h-52 w-full" />
            ) : eligible.length === 0 ? (
              <div className="cue-card rounded-[var(--radius-panel)]">
                <EmptyState
                  icon={<CalendarDays className="h-4 w-4" />}
                  title="Nothing to ask about"
                  body="Every upcoming event either takes no attendance or already has a request from you. Withdraw a pending one to change it."
                />
              </div>
            ) : (
              <div className="cue-card space-y-4 rounded-[var(--radius-panel)] p-4 sm:p-5">
                {formError ? <Alert tone="error">{formError}</Alert> : null}

                <Field label="Which event?">
                  <Select
                    value={eventId}
                    onChange={(e) => setEventId(e.target.value)}
                    aria-label="Event you will miss"
                  >
                    <option value="">Choose an event</option>
                    {eligible.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} — {relativeDay(e.date)}
                        {e.all_day ? "" : `, ${fmtTime(e.date)}`}
                      </option>
                    ))}
                  </Select>
                </Field>

                {selectedEvent ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-[var(--cue-raised)] text-[var(--cue-muted)]">
                      {eventTypeLabel(selectedEvent.event_type)}
                    </Badge>
                    <Badge
                      className={
                        selectedEvent.attendance_requirement === "required"
                          ? "bg-[var(--cue-present-bg)] text-[var(--cue-present)]"
                          : "bg-[var(--cue-raised)] text-[var(--cue-muted)]"
                      }
                    >
                      {ATTENDANCE_REQUIREMENT_LABEL[selectedEvent.attendance_requirement]}
                    </Badge>
                    <span className="type-meta tabular">
                      {relativeDay(selectedEvent.date)}
                      {selectedEvent.all_day ? " · All day" : ` · ${fmtTime(selectedEvent.date)}`}
                    </span>
                  </div>
                ) : null}

                <Field
                  label="Why will you be away?"
                  hint="Your reviewers can read this. Other students cannot. Keep it short — no medical detail is needed."
                >
                  <Textarea
                    value={reason}
                    maxLength={1000}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Family trip; I'll practise the set list beforehand."
                    aria-label="Reason for the absence"
                  />
                </Field>
                <div className="flex items-center justify-between gap-3">
                  <span className="type-meta tabular">{reason.length} / 1,000</span>
                  <Button
                    loading={submitting}
                    disabled={!selectedEvent || reason.trim().length === 0}
                    icon={<Check className="h-4 w-4" />}
                    onClick={() => void submit()}
                  >
                    Send request
                  </Button>
                </div>
                <p className="type-meta">
                  An approved absence is a decision, not a mark. Your attendance is still recorded on
                  the day — bring the approval up if you are marked absent.
                </p>
              </div>
            )}

            <SectionTitle className="mt-6 mb-3">Your requests</SectionTitle>
            {mine === null ? (
              <Skeleton className="h-32 w-full" />
            ) : mine.length === 0 ? (
              <div className="cue-card rounded-[var(--radius-panel)]">
                <EmptyState
                  icon={<Clock className="h-4 w-4" />}
                  title="No requests yet"
                  body="Ask about an event above and it will appear here with the answer."
                />
              </div>
            ) : (
              <List>
                {mine.map((row) => (
                  <Row
                    key={row.id}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate">{row.event_name}</span>
                        <StatusBadge status={row.status} />
                      </span>
                    }
                    subtitle={
                      <span className="block">
                        <span className="tabular">
                          {relativeDay(row.event_date)}
                          {row.decided_by_name ? ` · decided by ${row.decided_by_name}` : ""}
                        </span>
                        {row.decision_note ? (
                          <span className="mt-1 block">“{row.decision_note}”</span>
                        ) : null}
                      </span>
                    }
                    trailing={
                      row.status === "pending" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={withdrawing === row.id}
                          icon={<Undo2 className="h-4 w-4" />}
                          onClick={() => void withdraw(row)}
                        >
                          Withdraw
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </List>
            )}
          </section>
        ) : null}

        {/* --- the reviewer half --- */}
        {canReview ? (
          <section aria-labelledby="review-queue">
            <SectionTitle
              className="mb-3"
              action={
                <span className="type-meta">
                  {statusFilter === "pending"
                    ? `${pendingQueueCount} waiting`
                    : `${queue?.length ?? 0} shown`}
                </span>
              }
            >
              <span id="review-queue">Review queue</span>
            </SectionTitle>

            <div className="mb-3 space-y-2">
              <SegmentedControl
                value={statusFilter}
                onChange={setStatusFilter}
                options={STATUS_OPTIONS}
                className="flex-wrap"
              />
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label="Filter requests by event"
                  className="w-auto min-w-[12rem] flex-1"
                  value={eventFilter}
                  onChange={(e) => setEventFilter(e.target.value)}
                >
                  <option value="all">All events</option>
                  {(events ?? []).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} — {relativeDay(e.date)}
                    </option>
                  ))}
                </Select>
                {sectionOptions.length > 0 ? (
                  <Select
                    aria-label="Filter requests by section"
                    className="w-auto min-w-[10rem] flex-1"
                    value={sectionFilter}
                    onChange={(e) => setSectionFilter(e.target.value)}
                  >
                    <option value="all">All sections</option>
                    {sectionOptions.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </div>
            </div>

            {queueMessage ? <Alert tone="error">{queueMessage}</Alert> : null}

            {queue === null || queueLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : queue.length === 0 ? (
              <div className="cue-card rounded-[var(--radius-panel)]">
                <EmptyState
                  icon={<Check className="h-4 w-4" />}
                  title="Nothing here"
                  body={
                    statusFilter === "pending"
                      ? "No requests are waiting on you in this view."
                      : "No requests match these filters."
                  }
                />
              </div>
            ) : (
              <List>
                {queue.map((row) => (
                  <div key={row.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="flex min-w-0 flex-wrap items-baseline gap-2">
                        <span className="truncate font-semibold">{row.student_name}</span>
                        <span className="type-meta">{row.section || "No section"}</span>
                      </p>
                      <StatusBadge status={row.status} />
                    </div>
                    <p className="type-meta mt-0.5">
                      {row.event_name} · {relativeDay(row.event_date)} ·{" "}
                      {ATTENDANCE_REQUIREMENT_LABEL[row.attendance_requirement]}
                    </p>
                    <p className="mt-2 text-sm whitespace-pre-wrap">“{row.reason}”</p>

                    {row.decision_note ? (
                      <p className="type-meta mt-2">
                        {row.decided_by_name ? `${row.decided_by_name} wrote: ` : "Response: "}
                        “{row.decision_note}”
                      </p>
                    ) : null}

                    {row.status === "pending" ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          icon={<Check className="h-4 w-4" />}
                          onClick={() => openDecision(row, "approved")}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<X className="h-4 w-4" />}
                          onClick={() => openDecision(row, "denied")}
                        >
                          Deny
                        </Button>
                      </div>
                    ) : row.status === "denied" && !row.resubmission_allowed ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="mt-3"
                        loading={resubmitting === row.id}
                        onClick={() => void allowAgain(row)}
                      >
                        Allow a new request
                      </Button>
                    ) : null}
                  </div>
                ))}
              </List>
            )}
          </section>
        ) : null}

        {!canRequest && !canReview ? (
          <div className="cue-card rounded-[var(--radius-panel)]">
            <EmptyState
              icon={<CalendarDays className="h-4 w-4" />}
              title="No absence tools here"
              body="Your role in this program does not include requesting or reviewing absences."
            />
          </div>
        ) : null}
      </div>

      {/* --- the decision --- */}
      <Sheet
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding ? `${deciding.student_name}'s request` : "Request"}
        description={
          deciding
            ? `${deciding.event_name} · ${relativeDay(deciding.event_date)}`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" block onClick={() => setDeciding(null)} disabled={savingDecision}>
              Cancel
            </Button>
            <Button block loading={savingDecision} onClick={() => void saveDecision()}>
              Save decision
            </Button>
          </>
        }
      >
        {deciding ? (
          <div className="space-y-4">
            <div className="cue-card rounded-[var(--radius-panel)] p-3">
              <p className="type-label">Why</p>
              <p className="mt-1 text-sm whitespace-pre-wrap">{deciding.reason}</p>
            </div>

            <Field label="Decision">
              <SegmentedControl
                value={decision}
                onChange={(value) => setDecision(value as "approved" | "denied")}
                options={[
                  { value: "approved", label: "Approve" },
                  { value: "denied", label: "Deny" },
                ]}
              />
            </Field>

            <Field
              label="Response (optional)"
              hint="The student sees this. It is not a staff note."
            >
              <Textarea
                value={decisionNote}
                maxLength={1000}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="Approved — send your part recording before Friday."
              />
            </Field>

            <p className="type-meta">
              Saving this does not change anyone's attendance. Mark the student excused on the roll
              after the event if they miss it.
            </p>
          </div>
        ) : null}
      </Sheet>

      <Button
        variant="ghost"
        block
        className="mt-4"
        icon={<RefreshCw className="h-4 w-4" />}
        onClick={() => {
          void loadBase();
          void loadQueue();
        }}
      >
        Refresh
      </Button>
    </div>
  );
}
