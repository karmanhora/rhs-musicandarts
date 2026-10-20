import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mail, Send, Users } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmSheet,
  Field,
  Input,
  SectionTitle,
  Sheet,
  Skeleton,
  Textarea,
  useToast,
} from "./ui";
import { fmtDateTime } from "../lib/date";
import { useEventEnded } from "../hooks/useEventEnded";
import { getMakeupEmailContext, sendMakeupEmailChunk } from "../lib/rpc";
import {
  DEFAULT_MAKEUP_BODY,
  MAKEUP_PLACEHOLDERS,
  defaultMakeupSubject,
  fillMakeupTemplate,
  makeupValuesFor,
  unresolvedPlaceholders,
} from "../lib/makeupEmail";
import type {
  EventRow,
  MakeupEmailContext,
  MakeupEmailRecipient,
  MakeupEmailSendResult,
} from "../lib/types";

/** Send in small chunks so the composer can show real progress and keep each
 * request well inside the function's time budget. */
const CHUNK_SIZE = 10;

function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for a browser without randomUUID. This is an operation id, not a
  // secret; the database still enforces uniqueness per teacher.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const digit = char === "x" ? value : (value & 0x3) | 0x8;
    return digit.toString(16);
  });
}

/**
 * The completed event's make-up email control.
 *
 * The button is enabled by `useEventEnded()` — a client timer that exists only
 * to redraw the page. Everything that decides whether a message may actually be
 * sent is re-checked by the Edge Function and migration 036 against the latest
 * saved end time, so a wrong clock here cannot authorise a premature email.
 */
export function MakeupEmailPanel({ event }: { event: EventRow }) {
  const [open, setOpen] = useState(false);
  const { ended, valid } = useEventEnded(event.end_date, event.date);

  const reason = event.archived
    ? "This event is archived, so make-up emails are off."
    : !event.end_date
      ? "This event has no end time. Add one to enable make-up emails."
      : !valid
        ? "This event's end time is not after its start, so make-up emails stay off."
        : !ended
          ? "Available after this event ends."
          : null;

  return (
    <section className="cue-card rounded-[var(--radius-panel)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionTitle className="mb-1">After the event</SectionTitle>
          <p className="text-sm font-semibold">
            Email students who were marked absent and give them make-up instructions.
          </p>
          <p className="type-meta mt-1">
            Individual emails — no student sees another&rsquo;s address. Attendance is never changed
            by sending.
          </p>
          {reason ? (
            <p className="type-meta mt-1.5 font-medium">
              {reason}
              {!ended && valid && event.end_date ? ` Unlocks ${fmtDateTime(event.end_date)}.` : ""}
            </p>
          ) : null}
        </div>

        <Button
          variant="secondary"
          block
          className="sm:w-auto"
          icon={<Mail className="h-4 w-4" />}
          disabled={reason !== null}
          onClick={() => setOpen(true)}
        >
          Email Students Who Missed This Event
        </Button>
      </div>

      <MakeupEmailComposer event={event} open={open} onClose={() => setOpen(false)} />
    </section>
  );
}

function MakeupEmailComposer({
  event,
  open,
  onClose,
}: {
  event: EventRow;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();

  const [context, setContext] = useState<MakeupEmailContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState("");
  const [instructions, setInstructions] = useState("");
  const [body, setBody] = useState(DEFAULT_MAKEUP_BODY);

  const operationId = useRef<string>(newOperationId());
  /** Which event the current draft belongs to, so closing the sheet keeps it. */
  const loadedFor = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Record<string, MakeupEmailSendResult>>({});
  const [fatal, setFatal] = useState<string | null>(null);

  const load = useCallback(async () => {
    // A draft belongs to one event. A new event gets a new operation id; the
    // same event keeps the id, the edits and the delivery results when the
    // sheet is closed and reopened.
    operationId.current = newOperationId();
    loadedFor.current = event.id;
    setLoading(true);
    setLoadError(null);
    setFatal(null);
    setResults({});
    setProgress(null);
    setContext(null);
    setSelected(new Set());
    setSubject(defaultMakeupSubject(event.name));
    setInstructions("");
    setBody(DEFAULT_MAKEUP_BODY);

    const { context: loaded, error } = await getMakeupEmailContext(event.id);
    setLoading(false);
    if (error) {
      setLoadError(error);
      return;
    }
    if (!loaded?.ok) {
      setLoadError(loaded?.message ?? "Could not open the make-up email composer.");
      return;
    }
    setContext(loaded);
    loadedFor.current = event.id;
    setSubject(defaultMakeupSubject(loaded.event?.name ?? event.name));
    setSelected(new Set((loaded.recipients ?? []).map((row) => row.user_id)));
  }, [event.id, event.name]);

  useEffect(() => {
    if (!open || loading) return;
    // Deliberately NOT a reload on every open. Closing and reopening resumes
    // the same campaign, so students Resend already accepted are not mailed
    // twice and the teacher's edits stay. `startNewOperation()` is the explicit
    // follow-up path; choosing a different event loads a fresh draft. A failed
    // load is not retried in a loop — the error offers its own Try again.
    if (loadedFor.current === event.id) return;
    void load();
  }, [open, loading, event.id, load]);

  const recipients = context?.recipients ?? [];
  const selectedRecipients = useMemo(
    () => recipients.filter((row) => selected.has(row.user_id)),
    [recipients, selected]
  );

  const unresolved = useMemo(
    () => [...new Set([...unresolvedPlaceholders(subject), ...unresolvedPlaceholders(body)])],
    [subject, body]
  );

  const bodyIncludesInstructions = body.includes("{makeup_instructions}");
  const warnings = useMemo(() => {
    const list: string[] = [];
    if (unresolved.length > 0) {
      list.push(
        `${unresolved.join(", ")} ${unresolved.length === 1 ? "is" : "are"} not a placeholder the app replaces.`
      );
    }
    if (!instructions.trim() && bodyIncludesInstructions) {
      list.push("The make-up instructions are empty, so that section will send blank.");
    }
    if (instructions.trim() && !bodyIncludesInstructions) {
      list.push(
        "Your message does not include {makeup_instructions}, so the instructions above will not be sent."
      );
    }
    if (selectedRecipients.length === 0) {
      list.push("No recipients are selected.");
    }
    return list;
  }, [unresolved, instructions, bodyIncludesInstructions, selectedRecipients.length]);

  const previewRecipient: MakeupEmailRecipient | null =
    selectedRecipients[0] ?? recipients[0] ?? null;

  const preview = useMemo(() => {
    if (!context) return { subject: "", body: "" };
    const values = makeupValuesFor(
      context.event ?? event,
      context.program_name ?? "Program",
      context.teacher_name ?? "",
      previewRecipient?.name ?? "Student",
      instructions
    );
    return {
      subject: fillMakeupTemplate(subject, values),
      body: fillMakeupTemplate(body, values),
    };
  }, [context, event, previewRecipient, instructions, subject, body]);

  const accepted = Object.values(results).filter((row) => row.status === "accepted");
  const failed = Object.values(results).filter((row) => row.status === "failed");

  function toggleRecipient(userId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function send(ids: string[]): Promise<{ accepted: number; failed: number; stopped: boolean }> {
    if (!context?.ok || sending || ids.length === 0) {
      return { accepted: 0, failed: 0, stopped: false };
    }
    setSending(true);
    setFatal(null);
    setProgress({ done: 0, total: ids.length });

    let acceptedCount = 0;
    let failedCount = 0;
    let stopped = false;

    for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
      const chunk = ids.slice(index, index + CHUNK_SIZE);
      const { result, error } = await sendMakeupEmailChunk({
        eventId: event.id,
        operationId: operationId.current,
        subject,
        instructions,
        bodyTemplate: body,
        recipientIds: chunk,
      });

      if (error || !result?.ok) {
        stopped = true;
        setFatal(
          error ??
            result?.message ??
            "Sending stopped. Check the event schedule and try the remaining recipients again."
        );
        break;
      }

      if (result.results?.length) {
        for (const row of result.results) {
          if (row.status === "accepted") acceptedCount += 1;
          else failedCount += 1;
        }
        setResults((current) => {
          const next = { ...current };
          for (const row of result.results!) next[row.user_id] = row;
          return next;
        });
      }
      setProgress({
        done: Math.min(index + chunk.length, ids.length),
        total: ids.length,
      });
    }

    setSending(false);
    setProgress(null);
    return { accepted: acceptedCount, failed: failedCount, stopped };
  }

  function reviewAndSend() {
    if (!context?.can_send) return;
    if (!subject.trim() || !body.trim() || selectedRecipients.length === 0) return;
    setConfirming(true);
  }

  async function confirmedSend() {
    setConfirming(false);
    const outcome = await send(selectedRecipients.map((row) => row.user_id));
    if (outcome.accepted > 0) {
      toast.success(
        `${outcome.accepted} ${outcome.accepted === 1 ? "email was" : "emails were"} accepted for delivery.`
      );
    }
    if (outcome.failed > 0) {
      toast.warn(
        `${outcome.failed} ${outcome.failed === 1 ? "email needs" : "emails need"} attention — retry only those below.`
      );
    }
  }

  async function retryFailed() {
    const outcome = await send(failed.map((row) => row.user_id));
    if (outcome.accepted > 0) toast.success("The retried recipients were accepted for delivery.");
    if (outcome.failed > 0) toast.warn("Some recipients still failed. You can retry them again.");
  }

  /** A deliberate follow-up: a new operation, so everyone is eligible again. */
  function startNewOperation() {
    operationId.current = newOperationId();
    setResults({});
    setFatal(null);
    toast.success("Ready to send a new email. The earlier delivery history is kept.");
  }

  const totalRecipients = recipients.length;
  const canSubmit =
    Boolean(context?.can_send) &&
    !sending &&
    selectedRecipients.length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Email students who missed this event"
        description={context?.event?.name ?? event.name}
        size="tall"
        footer={
          <>
            <Button
              variant="secondary"
              block
              onClick={onClose}
              disabled={sending}
            >
              Close
            </Button>
            <Button
              block
              icon={<Send className="h-4 w-4" />}
              loading={sending}
              disabled={!canSubmit}
              onClick={reviewAndSend}
            >
              Review and send
            </Button>
          </>
        }
      >
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : loadError ? (
          <div className="space-y-3">
            <Alert tone="error">{loadError}</Alert>
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !context?.ok ? (
          <Alert tone="error">{context?.message ?? "Could not open this composer."}</Alert>
        ) : (
          <div className="space-y-5">
            {!context.can_send ? (
              <Alert tone="warn">
                {context.reason ?? "Make-up emails are not available for this event yet."}
              </Alert>
            ) : null}

            {fatal ? <Alert tone="error">{fatal}</Alert> : null}

            {progress ? (
              <div role="status" aria-live="polite" className="space-y-1.5">
                <p className="text-sm font-semibold">
                  Sending {progress.done} of {progress.total}&hellip;
                </p>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--cue-raised)]">
                  <div
                    className="cue-meter-fill h-full rounded-full bg-[var(--cue-green)]"
                    style={{
                      transform: `scaleX(${progress.total ? progress.done / progress.total : 0})`,
                    }}
                  />
                </div>
              </div>
            ) : null}

            {accepted.length + failed.length > 0 ? (
              <Card className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="type-heading">Delivery results</p>
                  <button
                    type="button"
                    className="text-sm font-semibold text-[var(--cue-green)] underline-offset-2 hover:underline"
                    onClick={startNewOperation}
                    disabled={sending}
                  >
                    Start a new email
                  </button>
                </div>
                <p className="text-sm">
                  <strong>{accepted.length}</strong> accepted for delivery
                  {failed.length > 0 ? (
                    <>
                      {" · "}
                      <strong>{failed.length}</strong> failed
                    </>
                  ) : null}
                </p>
                <p className="type-meta">
                  &ldquo;Accepted&rdquo; means Resend queued the message. It is not a guarantee that
                  it reached an inbox.
                </p>
                {failed.length > 0 ? (
                  <>
                    <ul className="cue-list overflow-hidden rounded-[var(--radius-control)]">
                      {failed.map((row) => (
                        <li
                          key={row.user_id}
                          className="flex items-baseline justify-between gap-3 border-t border-[var(--cue-line)] px-3 py-2 first:border-t-0"
                        >
                          <span className="truncate text-sm font-semibold">{row.name}</span>
                          <span className="type-meta min-w-0 truncate text-right">
                            {row.error ?? "Failed"}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Button
                      variant="secondary"
                      block
                      loading={sending}
                      disabled={sending}
                      onClick={() => void retryFailed()}
                    >
                      Retry failed recipients
                    </Button>
                    <p className="type-meta">
                      Only the failed recipients are retried. Anyone Resend already accepted is not
                      sent again.
                    </p>
                  </>
                ) : null}
              </Card>
            ) : null}

            {/* --- recipients ------------------------------------------------ */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="type-heading">
                  Recipients <span className="tabular">({selectedRecipients.length} selected)</span>
                </p>
                <button
                  type="button"
                  className="text-sm font-semibold text-[var(--cue-green)] underline-offset-2 hover:underline"
                  onClick={() =>
                    setSelected(
                      selectedRecipients.length === recipients.length
                        ? new Set()
                        : new Set(recipients.map((row) => row.user_id))
                    )
                  }
                >
                  {selectedRecipients.length === recipients.length ? "Clear all" : "Select all"}
                </button>
              </div>
              <p className="type-meta">
                Only students with a confirmed <strong>absent</strong> mark. Present, late and
                excused records are not included.
              </p>

              {totalRecipients === 0 ? (
                <Alert tone="info">
                  No one is marked absent for this event, so there is no one to email.
                </Alert>
              ) : (
                <ul className="cue-card cue-list max-h-72 overflow-y-auto rounded-[var(--radius-panel)]">
                  {recipients.map((row) => {
                    const checked = selected.has(row.user_id);
                    return (
                      <li key={row.user_id} className="border-t border-[var(--cue-line)] first:border-t-0">
                        <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRecipient(row.user_id)}
                            className="h-4 w-4 shrink-0 accent-[var(--cue-green)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">{row.name}</span>
                            <span className="type-meta block truncate">
                              {row.section || "No section"}
                            </span>
                          </span>
                          <Badge className="bg-[var(--cue-absent-bg)] text-[var(--cue-absent)]">
                            Absent
                          </Badge>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              {(context.unmarked ?? []).length > 0 ? (
                <div className="rounded-[var(--radius-control)] bg-[var(--cue-raised)] p-3">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Users aria-hidden="true" className="h-4 w-4" />
                    {(context.unmarked ?? []).length} with no attendance record — not included
                  </p>
                  <p className="type-meta mt-1">
                    No record is not an absence. Mark the roll first if any of them missed the
                    event.
                  </p>
                  <p className="type-meta mt-1.5">
                    {(context.unmarked ?? []).map((row) => row.name).join(", ")}
                  </p>
                </div>
              ) : null}
            </section>

            {/* --- the message ------------------------------------------------ */}
            <section className="space-y-3">
              <p className="type-heading">The email</p>

              <Field
                label="Subject"
                hint="Placeholders work here too."
              >
                <Input
                  value={subject}
                  maxLength={200}
                  onChange={(e) => setSubject(e.target.value)}
                  aria-label="Email subject"
                />
              </Field>

              <Field
                label="Make-up instructions"
                hint="Inserted wherever {makeup_instructions} appears in the message."
              >
                <Textarea
                  value={instructions}
                  maxLength={4000}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Attend Thursday's make-up rehearsal, or complete the worksheet on the class page."
                  aria-label="Make-up instructions"
                />
              </Field>

              <Field
                label="Message"
                hint="Each student gets their own copy with their name filled in."
              >
                <Textarea
                  className="min-h-56 font-mono text-[0.8125rem]"
                  value={body}
                  maxLength={8000}
                  onChange={(e) => setBody(e.target.value)}
                  aria-label="Email message"
                />
              </Field>

              <p className="type-meta">
                Placeholders:{" "}
                {MAKEUP_PLACEHOLDERS.map((item) => item.token).join(", ")}
              </p>

              {warnings.length > 0 ? (
                <Alert tone="warn">
                  <ul className="list-disc space-y-1 pl-4">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </section>

            {/* --- preview ---------------------------------------------------- */}
            <section className="space-y-2">
              <p className="type-heading">Preview</p>
              <Card className="space-y-2">
                <p className="text-sm">
                  <span className="type-label">Subject </span>
                  <span className="font-semibold">{preview.subject || "(no subject)"}</span>
                </p>
                <div className="whitespace-pre-wrap border-t border-[var(--cue-line)] pt-3 text-sm">
                  {preview.body || "(no message)"}
                </div>
              </Card>
              <p className="type-meta">
                Preview for {previewRecipient?.name ?? "a student"}. Editing the preview never changes
                your message.
              </p>
            </section>

            <p className="type-meta">
              Each message is sent separately. Sending email never changes an attendance record.
            </p>
          </div>
        )}
      </Sheet>

      <ConfirmSheet
        open={confirming}
        title="Send make-up emails?"
        body={`Send ${selectedRecipients.length} individualized ${
          selectedRecipients.length === 1 ? "email" : "emails"
        } about “${context?.event?.name ?? event.name}”?${
          warnings.length > 0 ? ` Before you continue: ${warnings.join(" ")}` : ""
        }`}
        confirmLabel={`Send ${selectedRecipients.length} ${
          selectedRecipients.length === 1 ? "email" : "emails"
        }`}
        tone="accent"
        loading={sending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirmedSend()}
      />
    </>
  );
}
