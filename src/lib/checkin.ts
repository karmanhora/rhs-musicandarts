import { supabase } from "./supabase";
import type { RpcResponse } from "./rpc";
import type { RpcResult } from "./types";

/**
 * Whether this submit recorded a new check-in, or the server's idempotent
 * answer for somebody who was already marked present.
 *
 * `record_attendance` / `record_attendance_by_code` answer `{ ok: true }` for
 * both cases: the first check-in wins, and a repeat scan returns the row that
 * was already there. The responses differ only in `checked_in_at`, so the only
 * reliable way to tell them apart without changing the RPC is to know what was
 * recorded *before* the request left. `attendance_records` is readable for the
 * caller's own rows (policy `attendance_read_scoped`), which is exactly what
 * `loadRecordedCheckins` reads.
 */
export type CheckinKind = "new" | "repeat" | "unknown";

/** Long enough to cover any check-in window, short enough to stay a small read. */
const LOOKBACK_MS = 14 * 86_400_000;
const CACHE_MS = 60_000;

/**
 * The server's fallback for an event with no saved end time: check-in closes 24
 * hours after it starts (`record_checkin_for_session`). One constant, so the
 * screens and the database cannot disagree about when an event is over.
 */
export const CHECKIN_NO_END_MS = 24 * 60 * 60 * 1000;

export interface CheckinWindow {
  /** The instant check-in closes, or NaN when the event's date is unusable. */
  closesAt: number;
  /** False once that instant has passed. */
  open: boolean;
}

/**
 * When check-in for one event closes — the same rule the database enforces: the
 * saved end time, or 24 hours after the start when there is none. An event whose
 * date cannot be read is left open for the server to judge rather than blocked
 * here on a client-side guess.
 *
 * This is what keeps a refreshed page, an old QR code and a stale tab honest:
 * the screen stops offering a check-in at the same instant the server stops
 * accepting one.
 */
export function checkinWindow(
  event: { date: string; end_date: string | null },
  now = Date.now()
): CheckinWindow {
  const start = Date.parse(event.date);
  const end = event.end_date ? Date.parse(event.end_date) : NaN;
  const closesAt = Number.isFinite(end)
    ? end
    : Number.isFinite(start)
      ? start + CHECKIN_NO_END_MS
      : NaN;
  return { closesAt, open: !Number.isFinite(closesAt) || now < closesAt };
}

/**
 * Whether a refusal is the end-time gate rather than some other failure.
 *
 * `record_checkin_for_session` and `start_checkin_session` both answer "That
 * event has already ended — …" and `supabase/tests/security_verification*.sql`
 * pin those strings, so the phrase is part of the interface, not incidental
 * prose. The write path re-checks the same rule whatever this says.
 */
export function isCheckinClosedMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && /already ended/i.test(message);
}

let cached: { profileId: string; at: number; rows: Map<string, number> } | null = null;
let inFlight: { profileId: string; promise: Promise<Map<string, number>> } | null = null;

/**
 * Event id → the millisecond the caller's check-in was recorded, for the last
 * two weeks. Resolves before the check-in RPC is sent, so a row inserted by
 * that call can never appear in it. A read failure rejects — callers treat that
 * as "unknown" rather than guessing.
 */
export async function loadRecordedCheckins(profileId: string): Promise<Map<string, number>> {
  if (cached?.profileId === profileId && Date.now() - cached.at < CACHE_MS) return cached.rows;
  if (inFlight?.profileId === profileId) return inFlight.promise;

  const promise = (async () => {
    const { data, error } = await supabase
      .from("attendance_records")
      .select("event_id, checked_in_at")
      .eq("student_id", profileId)
      .gte("checked_in_at", new Date(Date.now() - LOOKBACK_MS).toISOString());
    if (error) throw new Error(error.message);

    const rows = new Map<string, number>();
    for (const row of (data ?? []) as { event_id: string; checked_in_at: string | null }[]) {
      if (!row.checked_in_at) continue;
      const at = Date.parse(row.checked_in_at);
      if (!Number.isNaN(at)) rows.set(row.event_id, at);
    }
    cached = { profileId, at: Date.now(), rows };
    return rows;
  })();

  inFlight = { profileId, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

/**
 * Snapshot, then submit. The snapshot has to finish first: if it were read
 * after the RPC, the row the RPC just inserted would look like it predated the
 * scan and every new check-in would read as a repeat.
 */
export async function submitCheckin(
  profileId: string | null,
  run: () => Promise<RpcResponse>
): Promise<{ response: RpcResponse; kind: CheckinKind }> {
  let before: Map<string, number> | null = null;
  if (profileId) {
    try {
      before = await loadRecordedCheckins(profileId);
    } catch {
      before = null;
    }
  }

  const response = await run();
  return { response, kind: classify(before, response.result) };
}

/**
 * A fresh insert stamps `checked_in_at = now()`, which cannot equal an older
 * row's timestamp. A repeat answers with the timestamp that was already stored,
 * so it matches the snapshot exactly. Anything this cannot prove is "unknown",
 * and the UI shows a calm confirmation instead of claiming a new check-in.
 */
export function classify(
  before: Map<string, number> | null,
  result: RpcResult | null
): CheckinKind {
  if (!before || !result?.ok || !result.event_id || !result.checked_in_at) return "unknown";
  const at = Date.parse(result.checked_in_at);
  if (Number.isNaN(at)) return "unknown";
  const prior = before.get(result.event_id);
  if (prior === undefined) return "new";
  return prior === at ? "repeat" : "new";
}
