import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Mail, RefreshCw, Trash2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmSheet,
  EmptyState,
  Field,
  List,
  Metric,
  MetricStrip,
  PageHeader,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  useToast,
} from "../components/ui";
import { fetchFeedbackSubmissions } from "../lib/queries";
import { deleteFeedback, setFeedbackStatus } from "../lib/rpc";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_STATUS_CHIP,
  FEEDBACK_STATUS_HINT,
  FEEDBACK_STATUS_LABEL,
  feedbackCategoryLabel,
} from "../lib/constants";
import type { FeedbackCategory, FeedbackStatus, FeedbackSubmission } from "../lib/types";

type StatusFilter = "all" | FeedbackStatus;
type CategoryFilter = "all" | FeedbackCategory;
type SortOrder = "newest" | "oldest";

function when(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * `/feedback/inbox` — the site owner's private queue.
 *
 * The rows come from one RLS-scoped select: the table's only SELECT policy asks
 * `is_feedback_owner()`, which resolves the caller through Supabase Auth and
 * requires the confirmed owner address. The route gate below this screen and the
 * account-sheet entry are presentation; a student who types the URL gets the
 * dashboard's "not the owner" answer and an empty list from the database if they
 * try to read around the interface.
 *
 * Filters and counts run on the fetched rows. The inbox is small by nature —
 * a message is a paragraph, and the owner deletes what has been dealt with — so
 * a client-side filter is honest rather than a paging scheme that pretends to
 * scale.
 */
export function FeedbackInboxScreen() {
  const { toast } = useToast();

  const [rows, setRows] = useState<FeedbackSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [order, setOrder] = useState<SortOrder>("newest");

  const [selected, setSelected] = useState<FeedbackSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<FeedbackSubmission | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { rows: next, error: readError } = await fetchFeedbackSubmissions();
    setRows(next);
    setError(readError);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(
    () => ({
      total: rows.length,
      fresh: rows.filter((row) => row.status === "new").length,
      reviewing: rows.filter((row) => row.status === "reviewing").length,
      resolved: rows.filter((row) => row.status === "resolved").length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    const filtered = rows.filter(
      (row) =>
        (statusFilter === "all" || row.status === statusFilter) &&
        (categoryFilter === "all" || row.category === categoryFilter)
    );
    return [...filtered].sort((a, b) => {
      const delta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return order === "newest" ? -delta : delta;
    });
  }, [rows, statusFilter, categoryFilter, order]);

  async function changeStatus(item: FeedbackSubmission, next: FeedbackStatus) {
    if (busy) return;
    setBusy(true);
    const { result, error: rpcError } = await setFeedbackStatus(item.id, next);
    setBusy(false);

    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not update that submission.");
      return;
    }

    const updatedAt = new Date().toISOString();
    setRows((prev) =>
      prev.map((row) => (row.id === item.id ? { ...row, status: next, updated_at: updatedAt } : row))
    );
    setSelected((prev) => (prev && prev.id === item.id ? { ...prev, status: next } : prev));
    toast.success(result.message ?? "Feedback updated.");
  }

  async function doDelete() {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    const { result, error: rpcError } = await deleteFeedback(confirmDelete.id);
    setDeleting(false);

    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not delete that submission.");
      return;
    }

    setRows((prev) => prev.filter((row) => row.id !== confirmDelete.id));
    setSelected(null);
    setConfirmDelete(null);
    toast.success("Feedback deleted.");
  }

  return (
    <main className="safe-b mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <PageHeader
        kicker="Site owner"
        title="Feedback inbox"
        note="Everything students and teachers have sent through the feedback form. Only this account can read it."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />}
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh
          </Button>
        }
      />

      <MetricStrip columns={4} className="cue-card mt-5 rounded-[var(--radius-panel)]">
        <Metric label="Total" value={stats.total} />
        <Metric label="New" value={stats.fresh} tone="late" hint={stats.fresh > 0 ? "Needs a look" : undefined} />
        <Metric label="Reviewing" value={stats.reviewing} tone="excused" />
        <Metric label="Resolved" value={stats.resolved} tone="present" />
      </MetricStrip>

      <div className="mt-6">
        <SegmentedControl<StatusFilter>
          options={[
            { value: "all", label: "All" },
            { value: "new", label: "New" },
            { value: "reviewing", label: "Reviewing" },
            { value: "resolved", label: "Resolved" },
          ]}
          value={statusFilter}
          onChange={setStatusFilter}
        />

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Category" className="w-full sm:w-56">
            <Select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}
            >
              <option value="all">Every category</option>
              {FEEDBACK_CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Order" className="w-full sm:w-44">
            <Select value={order} onChange={(event) => setOrder(event.target.value as SortOrder)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </Select>
          </Field>
          <p className="type-meta ml-auto pb-2.5 tabular">
            {visible.length} of {rows.length}
          </p>
        </div>
      </div>

      <section aria-label="Feedback submissions" className="mt-4">
        {error ? (
          <div className="space-y-3">
            <Alert tone="error">{error}</Alert>
            <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading feedback">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-20 w-full" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="cue-card rounded-[var(--radius-panel)]">
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title={rows.length === 0 ? "No feedback yet" : "Nothing matches those filters"}
              body={
                rows.length === 0
                  ? "When somebody sends feedback from the form, it appears here."
                  : "Try every category, or clear the status filter."
              }
              action={
                rows.length > 0 ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStatusFilter("all");
                      setCategoryFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <List>
            {visible.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelected(item)}
                className="motion-press group block w-full px-4 py-3 text-left transition-colors hover:bg-[var(--cue-raised)]"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.8125rem] font-semibold">
                    {feedbackCategoryLabel(item.category)}
                  </span>
                  <Badge key={item.status} className={FEEDBACK_STATUS_CHIP[item.status]}>
                    {FEEDBACK_STATUS_LABEL[item.status]}
                  </Badge>
                  <span className="type-meta ml-auto shrink-0 tabular">
                    {when(item.created_at)}
                  </span>
                </span>
                <span className="mt-1 block line-clamp-2 text-sm leading-relaxed text-[var(--cue-muted)]">
                  {item.message}
                </span>
                {item.affected_feature ? (
                  <span className="type-meta mt-1 block truncate">
                    Affected: {item.affected_feature}
                  </span>
                ) : null}
              </button>
            ))}
          </List>
        )}
      </section>

      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? feedbackCategoryLabel(selected.category) : "Feedback"}
        description={selected ? `Sent ${when(selected.created_at)}` : undefined}
        size="tall"
        footer={
          selected ? (
            <>
              {selected.status === "new" ? (
                <Button
                  variant="secondary"
                  block
                  disabled={busy}
                  onClick={() => void changeStatus(selected, "reviewing")}
                >
                  Start reviewing
                </Button>
              ) : null}
              {selected.status === "resolved" ? (
                <Button
                  variant="secondary"
                  block
                  disabled={busy}
                  onClick={() => void changeStatus(selected, "reviewing")}
                >
                  Reopen
                </Button>
              ) : (
                <Button
                  block
                  disabled={busy}
                  loading={busy}
                  onClick={() => void changeStatus(selected, "resolved")}
                >
                  Mark resolved
                </Button>
              )}
              {selected.status !== "new" ? (
                <Button
                  variant="ghost"
                  block
                  disabled={busy}
                  onClick={() => void changeStatus(selected, "new")}
                >
                  Back to new
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected ? (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <Badge key={selected.status} className={FEEDBACK_STATUS_CHIP[selected.status]}>
                {FEEDBACK_STATUS_LABEL[selected.status]}
              </Badge>
              <span className="type-meta">{FEEDBACK_STATUS_HINT[selected.status]}</span>
            </div>

            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--cue-ink)]">
              {selected.message}
            </p>

            <dl className="cue-list border-t border-[var(--cue-line)]">
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="type-label shrink-0">Affected</dt>
                <dd className="min-w-0 text-right text-sm font-medium">
                  {selected.affected_feature || "Not specified"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="type-label shrink-0">Contact</dt>
                <dd className="min-w-0 text-right text-sm font-medium">
                  {selected.contact_email ? (
                    <a
                      href={`mailto:${selected.contact_email}`}
                      className="inline-flex min-h-11 items-center gap-1.5 break-all text-[var(--cue-leaf)] underline decoration-[var(--cue-gold)] decoration-2 underline-offset-4"
                    >
                      <Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      {selected.contact_email}
                    </a>
                  ) : (
                    "No address given"
                  )}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="type-label shrink-0">Sent</dt>
                <dd className="tabular min-w-0 text-right text-sm font-medium">
                  {when(selected.created_at)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="type-label shrink-0">Last updated</dt>
                <dd className="tabular min-w-0 text-right text-sm font-medium">
                  {when(selected.updated_at)}
                </dd>
              </div>
            </dl>

            <div className="border-t border-[var(--cue-line)] pt-4">
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => setConfirmDelete(selected)}
              >
                Delete this submission
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>

      <ConfirmSheet
        open={confirmDelete !== null}
        title="Delete this feedback?"
        body={
          confirmDelete
            ? `“${confirmDelete.message.length > 140 ? `${confirmDelete.message.slice(0, 140)}…` : confirmDelete.message}” will be permanently removed. This cannot be undone.`
            : "This submission will be permanently removed."
        }
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void doDelete()}
      />
    </main>
  );
}
