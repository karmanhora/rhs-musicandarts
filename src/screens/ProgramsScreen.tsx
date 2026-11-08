import { useMemo, useState } from "react";
import { ChevronRight, Layers, Plus } from "lucide-react";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  PageHeader,
  Row,
  SectionTitle,
  Select,
  Sheet,
  useToast,
} from "../components/ui";
import { usePrograms } from "../hooks/usePrograms";
import type { SwitchableProgram } from "../hooks/usePrograms";
import { createProgramInTeam, createTeam, moveProgramToTeam } from "../lib/rpc";

const byName = (a: SwitchableProgram, b: SwitchableProgram) =>
  a.ensemble.name.localeCompare(b.ensemble.name);

/**
 * Programs and teams — the system administrator's organizing screen.
 *
 * A team is a program that holds programs: RHS Band can hold Jazz Ensemble, Jazz
 * Band and Pit Band, each a full program with its own roster, events and join
 * code. The link lives in `ensembles.parent_ensemble_id` (migration
 * 20261104013553) and is one level deep. A team can also be started empty
 * (`create_team()`), which is what makes the first program in a new subject
 * possible.
 *
 * Both actions here are administrator-only, and this screen is the client's
 * half of that: `create_team()`, `create_program_in_team()` and
 * `move_program_to_team()` refuse anybody without a `program_admins` row, so
 * hiding the route is presentation, not the boundary. A director keeps every
 * right they had inside their own program; none of those rights include
 * rearranging programs.
 *
 * Creating one does not put the administrator on its roster: those RPCs write
 * no membership for a `program_admins` account (migration 20261108120000),
 * because that account already holds every capability in every program. The
 * administrator stays invisible on the roster and keeps full access.
 */
export function ProgramsScreen() {
  const app = usePrograms();
  const { toast } = useToast();

  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamInstruments, setTeamInstruments] = useState("");
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [addingTo, setAddingTo] = useState<SwitchableProgram | null>(null);
  const [name, setName] = useState("");
  const [instruments, setInstruments] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [moving, setMoving] = useState<SwitchableProgram | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  /** Every top-level program, read as a team: it can hold programs. */
  const teams = useMemo(
    () => app.programs.filter((entry) => !entry.parentId).sort(byName),
    [app.programs]
  );

  const programsOf = (teamId: string) =>
    app.programs.filter((entry) => entry.parentId === teamId).sort(byName);

  function openCreateTeam() {
    setCreatingTeam(true);
    setTeamName("");
    setTeamInstruments("");
    setTeamError(null);
  }

  function openAdd(team: SwitchableProgram) {
    setAddingTo(team);
    setName("");
    setInstruments("");
    setAddError(null);
  }

  function openMove(program: SwitchableProgram) {
    setMoving(program);
    setMoveTo(program.parentId ?? "");
    setMoveError(null);
  }

  async function submitTeam() {
    if (teamName.trim().length < 2) {
      setTeamError("Give the team a name — at least two letters.");
      return;
    }

    setTeamBusy(true);
    setTeamError(null);
    const { result, error: rpcError } = await createTeam(teamName, {
      instruments: teamInstruments.split(",").map((value) => value.trim()).filter(Boolean),
    });

    if (rpcError || !result?.ok) {
      setTeamBusy(false);
      setTeamError(rpcError?.message || result?.message || "Could not create the team.");
      return;
    }

    setTeamBusy(false);
    setCreatingTeam(false);
    toast.success(result.message ?? "The team was created.");
    await app.refresh(result.program_id ?? undefined);
  }

  async function addProgram() {
    if (!addingTo) return;
    if (name.trim().length < 2) {
      setAddError("Give the program a name — at least two letters.");
      return;
    }

    setAdding(true);
    setAddError(null);
    const { result, error: rpcError } = await createProgramInTeam(addingTo.ensemble.id, name, {
      instruments: instruments.split(",").map((value) => value.trim()).filter(Boolean),
    });

    if (rpcError || !result?.ok) {
      setAdding(false);
      setAddError(rpcError?.message || result?.message || "Could not create the program.");
      return;
    }

    setAdding(false);
    setAddingTo(null);
    toast.success(result.message ?? "The program was created.");
    await app.refresh();
  }

  async function moveProgram() {
    if (!moving) return;
    setMoveBusy(true);
    setMoveError(null);
    const { result, error: rpcError } = await moveProgramToTeam(
      moving.ensemble.id,
      moveTo || null
    );

    if (rpcError || !result?.ok) {
      setMoveBusy(false);
      setMoveError(rpcError?.message || result?.message || "Could not move the program.");
      return;
    }

    setMoveBusy(false);
    setMoving(null);
    toast.success(result.message ?? "The program was moved.");
    await app.refresh();
  }

  return (
    <main className="safe-b mx-auto w-full max-w-2xl px-4 py-6">
      <PageHeader
        title="Programs & teams"
        kicker="System administration"
        note="A team holds programs — Jazz Ensemble, Jazz Band and Pit Band inside RHS Band. Each program keeps its own roster, events, attendance and join code, and you can move one between teams at any time."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={openCreateTeam}>
            Create team
          </Button>
        }
      />

      {app.programs.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" />}
          title="No programs yet"
          body="Start a team, then add the programs that belong inside it."
          action={<Button onClick={openCreateTeam}>Create team</Button>}
        />
      ) : null}

      {teams.map((team) => {
        const children = programsOf(team.ensemble.id);
        return (
          <section key={team.ensemble.id} className="mt-6">
            <SectionTitle className="mb-3">{team.ensemble.name}</SectionTitle>
            <List>
              {children.map((child) => (
                <Row
                  key={child.id}
                  icon={<Layers className="h-4 w-4" />}
                  title={child.ensemble.name}
                  subtitle={`In ${team.ensemble.name} — tap to move it`}
                  trailing={
                    <ChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                    />
                  }
                  onClick={() => openMove(child)}
                />
              ))}

              <Row
                icon={<Plus className="h-4 w-4" />}
                title={`Add a program to ${team.ensemble.name}`}
                subtitle="It gets its own roster, events and join code"
                onClick={() => openAdd(team)}
              />

              {/* A team with nothing in it can still be moved into another one;
                  once it holds programs the server refuses that. */}
              {children.length === 0 ? (
                <Row
                  title={`Move ${team.ensemble.name} into a team`}
                  subtitle="It holds no programs of its own"
                  trailing={
                    <ChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                    />
                  }
                  onClick={() => openMove(team)}
                />
              ) : null}
            </List>
          </section>
        );
      })}

      <Sheet
        open={creatingTeam}
        onClose={() => setCreatingTeam(false)}
        title="Create a team"
        description="A team holds programs, like RHS Band holding Jazz Ensemble"
        footer={
          <Button block loading={teamBusy} onClick={() => void submitTeam()}>
            Create team
          </Button>
        }
      >
        <div className="space-y-4">
          {teamError ? <Alert tone="error">{teamError}</Alert> : null}
          <Field label="Team name" hint="For example: RHS Band, Orchestra, Drama">
            <Input
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="RHS Band"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Sections (optional)"
            hint="Comma separated — you can change these later, and each program can have its own."
          >
            <Input
              value={teamInstruments}
              onChange={(event) => setTeamInstruments(event.target.value)}
              placeholder="Trumpet, Saxophone, Rhythm"
              autoComplete="off"
            />
          </Field>
          <p className="type-meta">
            The team starts empty and closed, with its own join code. Your administrator access
            needs no roster row, so you are not added to it. Add its programs next.
          </p>
        </div>
      </Sheet>

      <Sheet
        open={addingTo !== null}
        onClose={() => setAddingTo(null)}
        title="Add a program"
        description={addingTo ? `Inside ${addingTo.ensemble.name}` : undefined}
        footer={
          <Button block loading={adding} onClick={() => void addProgram()}>
            Create program
          </Button>
        }
      >
        <div className="space-y-4">
          {addError ? <Alert tone="error">{addError}</Alert> : null}
          <Field label="Program name" hint="For example: Jazz Ensemble, Jazz Band, Pit Band">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Jazz Ensemble"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Sections (optional)"
            hint="Comma separated — Trumpet, Saxophone, Rhythm. You can change these later."
          >
            <Input
              value={instruments}
              onChange={(event) => setInstruments(event.target.value)}
              placeholder="Trumpet, Saxophone, Rhythm"
              autoComplete="off"
            />
          </Field>
          <p className="type-meta">
            The new program starts closed, with its own join code. You are not added to its roster.
          </p>
        </div>
      </Sheet>

      <Sheet
        open={moving !== null}
        onClose={() => setMoving(null)}
        title="Move program"
        description={moving?.ensemble.name}
        footer={
          <Button block loading={moveBusy} onClick={() => void moveProgram()}>
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          {moveError ? <Alert tone="error">{moveError}</Alert> : null}
          <Field label="Team" hint="Where this program should sit">
            <Select value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
              <option value="">No team — on its own</option>
              {teams
                .filter((team) => team.ensemble.id !== moving?.ensemble.id)
                .map((team) => (
                  <option key={team.ensemble.id} value={team.ensemble.id}>
                    {team.ensemble.name}
                  </option>
                ))}
            </Select>
          </Field>
          <p className="type-meta">
            Moving a program changes only where it sits. Its memberships, events and attendance
            history stay exactly as they are.
          </p>
        </div>
      </Sheet>
    </main>
  );
}
