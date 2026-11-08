import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, ChevronRight, Layers, Plus } from "lucide-react";
import {
  Alert,
  Button,
  ConfirmSheet,
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
import type { EnsembleRow, ProgramGroupRow } from "../lib/types";
import {
  createProgramGroup,
  createProgramInGroup,
  moveProgramToGroup,
  setProgramActive,
} from "../lib/rpc";
import { fetchArchivedPrograms, fetchProgramArchiveImpact } from "../lib/queries";
import type { ProgramArchiveImpact } from "../lib/queries";

const byName = (a: SwitchableProgram, b: SwitchableProgram) =>
  a.ensemble.name.localeCompare(b.ensemble.name);

function archiveImpactWarning(impact: ProgramArchiveImpact): string | null {
  const parts: string[] = [];
  if (impact.activeMembers > 0) {
    parts.push(
      `${impact.activeMembers} active member${impact.activeMembers === 1 ? "" : "s"}`
    );
  }
  if (impact.upcomingEvents > 0) {
    parts.push(
      `${impact.upcomingEvents} upcoming event${impact.upcomingEvents === 1 ? "" : "s"}`
    );
  }
  if (parts.length === 0) return null;
  return `This program still has ${parts.join(" and ")}. Archiving keeps all rosters, events and attendance, but the program will no longer be active.`;
}

/**
 * Programs and sections — the system administrator's organizing screen.
 *
 * A section is a grouping row, not a program: RHS Band can hold Jazz, Concert
 * Band and Pit Band, and each of those is a full program with its own roster,
 * events and join code. The link lives in `ensembles.program_group_id` (migration
 * 20261108180000); a section itself has no roster, events or join code.
 *
 * Creating a section is administrator-only, and this screen is the client's half
 * of that: `create_program_group()`, `create_program_in_group()` and
 * `move_program_to_group()` refuse anybody without a `program_admins` row, so
 * hiding the route is presentation, not the boundary. A director keeps every
 * right they had inside their own program; none of those rights include
 * rearranging sections.
 *
 * Creating a program here does not put the administrator on its roster: those
 * RPCs write no membership for a `program_admins` account (migration
 * 20261108032109), because that account already holds every capability in every
 * program. The administrator stays invisible on the roster and keeps full access.
 */
export function ProgramsScreen() {
  const app = usePrograms();
  const { toast } = useToast();

  const groups = app.programGroups.filter((group) => group.active);
  const groupIds = new Set(groups.map((group) => group.id));

  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupShortName, setGroupShortName] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);

  const [addingTo, setAddingTo] = useState<ProgramGroupRow | null>(null);
  const [name, setName] = useState("");
  const [instruments, setInstruments] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [moving, setMoving] = useState<SwitchableProgram | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const [archived, setArchived] = useState<EnsembleRow[]>([]);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    id: string;
    name: string;
    active: boolean;
    impact: ProgramArchiveImpact | null;
  } | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [impactBusy, setImpactBusy] = useState(false);

  const loadArchived = useCallback(async () => {
    setArchivedError(null);
    try {
      setArchived(await fetchArchivedPrograms());
    } catch (error) {
      setArchivedError(
        error instanceof Error ? error.message : "Could not load archived programs."
      );
    }
  }, []);

  useEffect(() => {
    if (app.isSystemAdmin) void loadArchived();
  }, [app.isSystemAdmin, loadArchived]);

  const programsOf = (groupId: string) =>
    app.programs.filter((entry) => entry.groupId === groupId).sort(byName);
  const ungrouped = app.programs
    .filter((entry) => !entry.groupId || !groupIds.has(entry.groupId))
    .sort(byName);
  const archiveWarning =
    confirming?.active && confirming.impact ? archiveImpactWarning(confirming.impact) : null;

  function openCreateGroup() {
    setCreatingGroup(true);
    setGroupName("");
    setGroupShortName("");
    setGroupError(null);
  }

  function openAdd(group: ProgramGroupRow) {
    setAddingTo(group);
    setName("");
    setInstruments("");
    setAddError(null);
  }

  function openMove(program: SwitchableProgram) {
    setMoving(program);
    setMoveTo(program.groupId ?? "");
    setMoveError(null);
  }

  async function submitGroup() {
    if (groupName.trim().length < 2) {
      setGroupError("Give the section a name — at least two letters.");
      return;
    }

    setGroupBusy(true);
    setGroupError(null);
    const { result, error: rpcError } = await createProgramGroup(groupName, {
      shortName: groupShortName,
    });

    if (rpcError || !result?.ok) {
      setGroupBusy(false);
      setGroupError(rpcError?.message || result?.message || "Could not create the section.");
      return;
    }

    setGroupBusy(false);
    setCreatingGroup(false);
    toast.success(result.message ?? "The section was created.");
    await app.refresh();
  }

  async function addProgram() {
    if (!addingTo) return;
    if (name.trim().length < 2) {
      setAddError("Give the program a name — at least two letters.");
      return;
    }

    setAdding(true);
    setAddError(null);
    const { result, error: rpcError } = await createProgramInGroup(addingTo.id, name, {
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
    await app.refresh(result.program_id ?? undefined);
  }

  async function moveProgram() {
    if (!moving) return;
    setMoveBusy(true);
    setMoveError(null);
    const { result, error: rpcError } = await moveProgramToGroup(
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

  async function requestArchive() {
    if (!moving) return;
    const target = moving;
    setImpactBusy(true);
    setMoveError(null);
    try {
      const impact = await fetchProgramArchiveImpact(target.ensemble.id);
      setConfirming({
        id: target.ensemble.id,
        name: target.ensemble.name,
        active: true,
        impact,
      });
      setMoving(null);
    } catch (error) {
      setMoveError(
        error instanceof Error
          ? error.message
          : "Could not check this program's members and events. Nothing was archived."
      );
    } finally {
      setImpactBusy(false);
    }
  }

  async function updateProgramActive() {
    if (!confirming) return;
    const wasActive = confirming.active;
    setStatusBusy(true);
    const { result, error: rpcError } = await setProgramActive(confirming.id, !wasActive);
    setStatusBusy(false);

    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not update this program.");
      return;
    }

    setConfirming(null);
    toast.success(result.message ?? (wasActive ? "Program archived." : "Program restored."));
    await Promise.all([loadArchived(), app.refresh()]);
  }

  return (
    <main className="safe-b mx-auto w-full max-w-2xl px-4 py-6">
      <PageHeader
        title="Programs & sections"
        kicker="System administration"
        note="A section holds programs — Jazz, Concert Band and Pit Band inside RHS Band. Each program keeps its own roster, events, attendance and join code; a section is only the grouping."
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={openCreateGroup}>
            Create section
          </Button>
        }
      />

      {groups.length === 0 && app.programs.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" />}
          title="No sections yet"
          body="Start a section, then add the programs that belong inside it."
          action={<Button onClick={openCreateGroup}>Create section</Button>}
        />
      ) : null}

      {groups.map((group) => {
        const children = programsOf(group.id);
        return (
          <section key={group.id} className="mt-6">
            <SectionTitle className="mb-3">{group.name}</SectionTitle>
            <List>
              {children.map((child) => (
                <Row
                  key={child.id}
                  icon={<Layers className="h-4 w-4" />}
                  title={child.ensemble.name}
                  subtitle={`In ${group.name} — tap to move or delete`}
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
                title={`Add a program to ${group.name}`}
                subtitle="It gets its own roster, events and join code"
                onClick={() => openAdd(group)}
              />
            </List>
          </section>
        );
      })}

      {ungrouped.length > 0 ? (
        <section className="mt-6">
          <SectionTitle className="mb-3">No section</SectionTitle>
          <List>
            {ungrouped.map((program) => (
              <Row
                key={program.id}
                icon={<Layers className="h-4 w-4" />}
                title={program.ensemble.name}
                subtitle="Tap to place it, or delete it"
                trailing={
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                  />
                }
                onClick={() => openMove(program)}
              />
            ))}
          </List>
        </section>
      ) : null}

      {archived.length > 0 || archivedError ? (
        <section className="mt-6">
          <SectionTitle className="mb-3">Archived programs</SectionTitle>
          {archivedError ? <Alert tone="error">{archivedError}</Alert> : null}
          {archived.length > 0 ? (
            <List>
              {archived.map((program) => (
                <Row
                  key={`archived-${program.id}`}
                  icon={<ArchiveRestore className="h-4 w-4" />}
                  title={program.name}
                  subtitle="Archived — tap to restore"
                  trailing={
                    <ChevronRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                    />
                  }
                  onClick={() =>
                    setConfirming({
                      id: program.id,
                      name: program.name,
                      active: false,
                      impact: null,
                    })
                  }
                />
              ))}
            </List>
          ) : null}
        </section>
      ) : null}

      <Sheet
        open={creatingGroup}
        onClose={() => setCreatingGroup(false)}
        title="Create a section"
        description="A section holds programs, like RHS Band holding Jazz"
        footer={
          <Button block loading={groupBusy} onClick={() => void submitGroup()}>
            Create section
          </Button>
        }
      >
        <div className="space-y-4">
          {groupError ? <Alert tone="error">{groupError}</Alert> : null}
          <Field label="Section name" hint="For example: RHS Band, RHS Choir, RHS Drama, RHS Orchestra">
            <Input
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder="RHS Band"
              autoComplete="off"
            />
          </Field>
          <Field label="Short name" hint="Optional — shown where space is tight.">
            <Input
              value={groupShortName}
              onChange={(event) => setGroupShortName(event.target.value)}
              placeholder="Band"
              autoComplete="off"
            />
          </Field>
          <p className="type-meta">
            The section is only a grouping. It has no roster, events or join code; the programs
            inside it do.
          </p>
        </div>
      </Sheet>

      <Sheet
        open={addingTo !== null}
        onClose={() => setAddingTo(null)}
        title="Add a program"
        description={addingTo ? `Inside ${addingTo.name}` : undefined}
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
        title="Manage program"
        description={moving?.ensemble.name}
        footer={
          <Button
            block
            loading={moveBusy}
            disabled={impactBusy}
            onClick={() => void moveProgram()}
          >
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          {moveError ? <Alert tone="error">{moveError}</Alert> : null}
          <Field label="Section" hint="Where this program should sit">
            <Select value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
              <option value="">No section — unplaced</option>
              {groups
                .filter((group) => group.id !== moving?.groupId)
                .map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
            </Select>
          </Field>
          <p className="type-meta">
            Moving a program changes only where it sits. Its memberships, events and attendance
            history stay exactly as they are.
          </p>
          <div className="border-t border-[var(--cue-line)] pt-4">
            <Button
              variant="danger"
              block
              icon={<Archive className="h-4 w-4" />}
              loading={impactBusy}
              disabled={moveBusy}
              onClick={() => void requestArchive()}
            >
              Delete program
            </Button>
            <p className="type-meta mt-2">
              Deleting archives the program. Its roster, events and attendance history are kept.
            </p>
          </div>
        </div>
      </Sheet>

      <ConfirmSheet
        open={confirming !== null}
        title={
          confirming
            ? `${confirming.active ? "Archive" : "Restore"} ${confirming.name}?`
            : "Update program"
        }
        body={
          confirming?.active
            ? "It will disappear from the active program list and new members cannot join. Its roster, events and attendance history are kept, and you can restore it later."
            : "It will become active and available to join again. Existing members and history are unchanged."
        }
        warning={archiveWarning ? <Alert tone="warn">{archiveWarning}</Alert> : undefined}
        confirmLabel={confirming?.active ? "Archive program" : "Restore program"}
        tone={confirming?.active ? "danger" : "primary"}
        loading={statusBusy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void updateProgramActive()}
      />
    </main>
  );
}
