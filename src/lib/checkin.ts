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
