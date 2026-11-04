import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Layers, ShieldCheck, UserPlus } from "lucide-react";
import { List, Row, Sheet } from "./ui";
import { usePrograms } from "../hooks/usePrograms";
import { ORG_NAME, ROLE_LABEL } from "../lib/constants";
import type { Role } from "../lib/types";

/** The highest role somebody holds in one program, for the row's subtitle. */
function roleLabelOf(roles: Role[]): string {
  if (roles.includes("director")) return ROLE_LABEL.director;
  if (roles.includes("secretary")) return ROLE_LABEL.secretary;
  if (roles.includes("section_leader")) return ROLE_LABEL.section_leader;
  return ROLE_LABEL.student;
}

/**
 * Which program am I looking at?
 *
 * Only worth opening when there is more than one, so the app bar hides the
 * control until then — but joining a second program lives here too, so somebody
 * with a single program can still get to it from Profile.
 *
 * A system administrator sees every program, including the ones they are not
 * on; those rows say "System administrator" instead of inventing a role. The
 * database decides what they can do there, exactly as for everybody else.
 *
 * A program that sits inside a team (RHS Band holding Jazz Ensemble, say) is
 * listed under it and indented, so the list reads as the structure an
 * administrator built rather than as a flat pile of names. Only the organizer
 * changes that structure — the *Programs & teams* row at the bottom, which is
 * shown to a system administrator alone.
 */
export function ProgramSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = usePrograms();
  const navigate = useNavigate();

  /** The team's name for a nested program, when that team is in the list. */
  const teamNameOf = (parentId: string | null): string | null =>
    parentId
      ? (app.programs.find((entry) => entry.ensemble.id === parentId)?.ensemble.name ?? null)
      : null;

  return (
    <Sheet open={open} onClose={onClose} title="Switch program" description={ORG_NAME} size="tall">
      <div className="space-y-4">
        <List>
          {app.programs.map((entry) => {
            const here = entry.ensemble.id === app.program?.id;
            const team = teamNameOf(entry.parentId);
            const bits = [
              entry.isMember ? roleLabelOf(entry.roles) : "System administrator",
              entry.section,
              team ? `in ${team}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            const row = (
              <Row
                icon={entry.isMember ? undefined : <ShieldCheck className="h-4 w-4" />}
                title={entry.ensemble.name}
                subtitle={here ? `You're here · ${bits}` : bits}
                trailing={
                  here ? (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-green)]" />
                  ) : (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                    />
                  )
                }
                onClick={
                  here
                    ? undefined
                    : () => {
                        app.setProgram(entry.ensemble.id);
                        onClose();
                      }
                }
              />
            );

            // A program inside a team is drawn under it, with a quiet rule that
            // says "this belongs to the row above" without another heading.
            return entry.parentId ? (
              <div key={entry.id} className="border-l border-[var(--cue-line)] pl-3">
                {row}
              </div>
            ) : (
              <Row
                key={entry.id}
                icon={entry.isMember ? undefined : <ShieldCheck className="h-4 w-4" />}
                title={entry.ensemble.name}
                subtitle={here ? `You're here · ${bits}` : bits}
                trailing={
                  here ? (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-green)]" />
                  ) : (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                    />
                  )
                }
                onClick={
                  here
                    ? undefined
                    : () => {
                        app.setProgram(entry.ensemble.id);
                        onClose();
                      }
                }
              />
            );
          })}

          <Row
            icon={<UserPlus className="h-4 w-4" />}
            title="Join another program"
            subtitle="Use the join code from that program's director"
            trailing={
              <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
            }
            onClick={() => {
              onClose();
              navigate("/join");
            }}
          />

          {app.isSystemAdmin ? (
            <Row
              icon={<Layers className="h-4 w-4" />}
              title="Programs & teams"
              subtitle="Add a program inside a team, or move one between teams"
              trailing={
                <ChevronRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                />
              }
              onClick={() => {
                onClose();
                navigate("/programs");
              }}
            />
          ) : null}
        </List>

        <p className="type-meta">
          {app.isSystemAdmin
            ? "As a system administrator you can open any program here, including ones you are not on. Roles, sections and colours still come from the program you pick."
            : "Roles, sections and colours come from the program you pick, so a director of one program is a student in the next."}
        </p>
      </div>
    </Sheet>
  );
}
