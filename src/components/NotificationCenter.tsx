import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCheck, ChevronRight, RefreshCw } from "lucide-react";
import { Alert, Button, EmptyState, List, Sheet, Skeleton, cn } from "./ui";
import { fetchNotifications, markNotificationsRead } from "../lib/queries";
import { markAllNotificationsRead } from "../lib/rpc";
import type { NotificationRow } from "../lib/types";
import { relativeDay } from "../lib/date";

/**
 * Where a notification goes when it is opened.
 *
 * The server decides what a person may see; this only chooses a destination.
 * Absence rows and decisions live on `/absences`, an event change or a new
 * event on the calendar, and a failed staff workflow back to the roll where the
 * retry lives. A notification with no known destination still marks itself read
 * rather than pretending to link somewhere useful.
 */
export function notificationTarget(n: NotificationRow): string {
  if (n.type === "absence_request" || n.type === "absence_decision") return "/absences";
  if (n.type === "workflow_failed") return "/attendance";
  if (n.payload?.event_id) return "/calendar";
  return "/";
}

/** A single dot, carrying an accessible label rather than colour alone. */
function UnreadDot() {
  return (
    <span
      aria-label="Unread"
      className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--cue-leaf)]"
    />
  );
}

export function NotificationCenter({
  open,
  onClose,
  unreadCount,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  unreadCount: number;
  /** Re-read the badge count after a read action, in the shell. */
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const next = await fetchNotifications(40);
      setRows(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your notifications.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  async function openRow(n: NotificationRow) {
    const target = notificationTarget(n);
    // Read state is a courtesy, not a requirement for navigation: if the update
    // fails the person still gets to where they were going.
    if (!n.read) {
      try {
        await markNotificationsRead([n.id]);
        setRows((prev) =>
          prev ? prev.map((row) => (row.id === n.id ? { ...row, read: true } : row)) : prev
        );
        onChanged();
      } catch {
        /* leave the dot in place */
      }
    }
    onClose();
    navigate(target);
  }

  async function markAll() {
    setMarking(true);
    const { result, error: rpcError } = await markAllNotificationsRead();
    setMarking(false);
    if (rpcError || !result?.ok) {
      setError(rpcError?.message || result?.message || "Could not mark them read.");
      return;
    }
    setRows((prev) => (prev ? prev.map((row) => ({ ...row, read: true })) : prev));
    onChanged();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Notifications"
      description={
        unreadCount > 0
          ? `${unreadCount} unread`
          : "Event changes, absence decisions and anything that needs your attention."
      }
      size="tall"
      footer={
        rows && rows.length > 0 ? (
          <Button
            block
            variant="secondary"
            loading={marking}
            disabled={unreadCount === 0}
            icon={<CheckCheck className="h-4 w-4" />}
            onClick={() => void markAll()}
          >
            Mark all as read
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <div className="space-y-3">
          <Alert tone="error">{error}</Alert>
          <Button
            variant="secondary"
            block
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      ) : rows === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading notifications">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CheckCheck className="h-4 w-4" />}
          title="Nothing new"
          body="Event changes, absence decisions and requests that need a reviewer will appear here."
        />
      ) : (
        <List>
          {rows.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => void openRow(n)}
              className={cn(
                "flex min-h-14 w-full items-start gap-3 px-3 py-3 text-left",
                n.read ? "hover:bg-[var(--cue-raised)]" : "bg-[var(--cue-raised)]/60 hover:bg-[var(--cue-raised)]"
              )}
            >
              {n.read ? <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0" /> : <UnreadDot />}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className={cn("truncate", n.read ? "font-medium" : "font-semibold")}>
                    {n.title}
                  </span>
                  <span className="type-meta shrink-0 tabular">{relativeDay(n.created_at)}</span>
                </span>
                {n.body ? <span className="type-meta mt-1 block">{n.body}</span> : null}
              </span>
              <ChevronRight
                aria-hidden="true"
                className="mt-1 h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
              />
            </button>
          ))}
        </List>
      )}
    </Sheet>
  );
}
