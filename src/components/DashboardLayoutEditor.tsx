import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  IconButton,
  List,
  Row,
  SectionTitle,
  Toggle,
  useToast,
} from "./ui";
import {
  DASHBOARD_MODULES,
  DEFAULT_DASHBOARD_MODULES,
  moduleApplies,
} from "../lib/personalization";
import type { DashboardModuleId } from "../lib/types";
import { usePreferences } from "../hooks/usePreferences";
import { usePrograms } from "../hooks/usePrograms";

/**
 * Which dashboard blocks appear, and in what order.
 *
 * Two honest restrictions, both visible in the copy rather than silently
 * enforced:
 *
 *   * The next-event panel is not on this list. It is the page's focal point and
 *     the one thing the dashboard is for, so it cannot be hidden.
 *   * Order is *within* the dashboard's two columns. The page is an uneven pair
 *     of columns by design (`docs/DESIGN_SYSTEM.md`); moving "Your programs" into
 *     the wide column would only move it back on the next render. The arrows
 *     therefore swap with the nearest block in the same column, and the control
 *     says which column each block lives in.
 *
 * Nothing here changes access. A hidden block is not a closed door: every screen
 * it links to is still reachable from the bottom bar and the account sheet, and
 * every read is still decided by the server.
 */
export function DashboardLayoutEditor() {
  const app = usePrograms();
  const { preferences, save } = usePreferences();
  const { toast } = useToast();
  const isStaff = app.isStaff;

  const applicable = DASHBOARD_MODULES.filter((option) => moduleApplies(option, { isStaff }));
  const order = preferences.dashboard_modules;

  // Visible blocks in their saved order, then everything applicable that is
  // currently hidden — so a block that was turned off can always be turned back
  // on, even though it is no longer in the saved list.
  const shown = order
    .map((id) => applicable.find((option) => option.id === id))
    .filter((option): option is (typeof applicable)[number] => Boolean(option));
  const hidden = applicable.filter((option) => !order.includes(option.id));
  const rows = [...shown, ...hidden];

  async function write(next: DashboardModuleId[]) {
    const message = await save({ dashboard_modules: next });
    if (message) toast.error(message);
  }

  async function setVisible(id: DashboardModuleId, visible: boolean) {
    const next = visible
      ? order.includes(id)
        ? order
        : [...order, id]
      : order.filter((entry) => entry !== id);
    await write(next);
  }

  /** Swap with the neighbouring *visible* block in the same column. */
  async function move(id: DashboardModuleId, direction: "up" | "down") {
    const option = applicable.find((entry) => entry.id === id);
    if (!option) return;

    const sameColumn = order.filter(
      (entry) => applicable.find((candidate) => candidate.id === entry)?.column === option.column
    );
    const position = sameColumn.indexOf(id);
    const neighbour = sameColumn[position + (direction === "up" ? -1 : 1)];
    if (position < 0 || !neighbour) return;

    const next = [...order];
    const from = next.indexOf(id);
    const to = next.indexOf(neighbour);
    if (from < 0 || to < 0) return;
    [next[from], next[to]] = [next[to], next[from]];
    await write(next);
  }

  return (
    <section aria-labelledby="dashboard-blocks">
      <SectionTitle
        className="mb-3"
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void write([...DEFAULT_DASHBOARD_MODULES])}
          >
            Show all
          </Button>
        }
      >
        <span id="dashboard-blocks">Dashboard</span>
      </SectionTitle>

      <Card className="space-y-3">
        <List>
          {rows.map((option) => {
            const visible = order.includes(option.id);
            const sameColumn = order.filter(
              (entry) =>
                applicable.find((candidate) => candidate.id === entry)?.column === option.column
            );
            const position = sameColumn.indexOf(option.id);
            const canUp = visible && position > 0;
            const canDown = visible && position >= 0 && position < sameColumn.length - 1;

            return (
              <Row
                key={option.id}
                title={
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    {option.label}
                    <span className="type-meta">
                      {option.column === "main" ? "Main column" : "Side column"}
                    </span>
                  </span>
                }
                subtitle={option.description}
                /* 8px, not 4px: three 44px controls in a row with a hairline
                   between their touch areas is how the wrong one gets pressed
                   (docs/QA_REPORT.md QA-06). */
                trailing={
                  <span className="flex shrink-0 items-center gap-2">
                    {visible ? (
                      <>
                        <IconButton
                          label={`Move ${option.label} up`}
                          variant="ghost"
                          disabled={!canUp}
                          icon={<ArrowUp className="h-4 w-4" />}
                          onClick={() => void move(option.id, "up")}
                        />
                        <IconButton
                          label={`Move ${option.label} down`}
                          variant="ghost"
                          disabled={!canDown}
                          icon={<ArrowDown className="h-4 w-4" />}
                          onClick={() => void move(option.id, "down")}
                        />
                      </>
                    ) : null}
                    <Toggle
                      checked={visible}
                      onChange={(next) => void setVisible(option.id, next)}
                      label={`Show ${option.label} on the dashboard`}
                    />
                  </span>
                }
              />
            );
          })}
        </List>

        <Alert tone="info">
          Hiding a block only changes your dashboard. Every screen stays reachable from the bar at
          the bottom, and your permissions decide what is on them — not this list.
        </Alert>
      </Card>
    </section>
  );
}
