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
 * A program that sits inside a section (RHS Band holding Jazz Ensemble, say) is
 * listed with it and indented, so the list reads as the structure an
 * administrator built rather than as a flat pile of names. Only the organizer
 * changes that structure — the *Programs & sections* row at the bottom, which is
 * shown to a system administrator alone.
 */
export function ProgramSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = usePrograms();
  const navigate = useNavigate();

  /** The section's name for a program, when that section is in the list. */
  const groupNameOf = (groupId: string | null): string | null =>
    groupId ? (app.programGroups.find((group) => group.id === groupId)?.name ?? null) : null;

  return (
    <Sheet open={open} onClose={onClose} title="Switch program" description={ORG_NAME} size="tall">
      <div className="space-y-4">
        <List>
          {app.programs.map((entry) => {
            const here = entry.ensemble.id === app.program?.id;
            const group = groupNameOf(entry.groupId);
            const bits = [
              entry.isMember ? roleLabelOf(entry.roles) : "System administrator — not on this roster",
              entry.section,
              group ? `in ${group}` : null,
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

            // A program inside a section is drawn under it, with a quiet rule
            // that says "this belongs to the section" without another heading.
            return group ? (
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
              title="Programs & sections"
              subtitle="Add a program inside a section, or move one between sections"
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
            ? "As a system administrator you can open any program here, including ones you are not on. Opening one does not join its roster, and its roles, sections and colours still come from the program you pick."
            : "Roles, sections and colours come from the program you pick, so a director of one program is a student in the next. Joining another program with a code adds you to its roster."}
        </p>
      </div>
    </Sheet>
  );
}
