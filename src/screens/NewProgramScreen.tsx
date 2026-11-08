import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Layers, LogOut, ShieldCheck } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  useToast,
} from "../components/ui";
import { InstrumentPicker } from "../components/InstrumentPicker";
import { TeacherVerification } from "../components/TeacherVerification";
import { createProgramInGroup } from "../lib/rpc";
import { usePrograms } from "../hooks/usePrograms";
import { useAuth } from "../hooks/useAuth";
import { APP_NAME, ORG_NAME } from "../lib/constants";

/**
 * Starting your own program — the teacher-only way to create a new roster.
 *
 * A program belongs to a section (RHS Band, RHS Choir, RHS Drama, RHS
 * Orchestra). The section is an organizing row; the program is what the teacher
 * runs, with its own roster, events, attendance and join code. The teacher
 * picks the section here and `create_program_in_group()` makes the caller its
 * director. A system administrator is the exception — they keep every capability
 * and are not added to the new roster (migration 20261108032109).
 *
 * Like the join screen, this is used twice: standalone (no app bar, no bottom
 * nav) when somebody is signed in with no roster at all, and as the
 * `/new-program` route inside the shell, reached from the join screen, Profile
 * and the program switcher.
 *
 * The name and section are all this screen collects that the database does not
 * already know. There is deliberately nothing here to pick an existing program —
 * the RPC can only ever create a new one, which keeps "start a program" from
 * becoming a way to promote yourself into somebody else's roster.
 *
 * Since migration 035 the server also requires a **redeemed invitation** before
 * it will create anything, so a declared-but-unverified teacher who lands here
 * is shown the invitation form instead of this one. That is the same gate the
 * database applies — `app.mayStartProgram` is the server's answer, not a guess —
 * and an existing director keeps the door 023 opened for them.
 */
export function NewProgramScreen({ standalone = false }: { standalone?: boolean }) {
  const app = usePrograms();
  const auth = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const groups = app.programGroups.filter((group) => group.active);

  const [groupId, setGroupId] = useState("");
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [instruments, setInstruments] = useState<string[]>([]);
  const [yourName, setYourName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One section is the common case; pick it so the form is one field shorter. */
  useEffect(() => {
    if (!groupId && groups.length === 1) setGroupId(groups[0].id);
  }, [groupId, groups]);

  /** No profile yet? This call creates it, so it needs a name to store. */
  const needsName = !app.profile;
  const canSubmit =
    name.trim().length >= 2 &&
    groupId.length > 0 &&
    (!needsName || yourName.trim().length > 0);

  async function submit() {
    if (!groupId) {
      setError("Choose the section this program belongs to.");
      return;
    }
    if (name.trim().length < 2) {
      setError("Give your program a name — at least two letters.");
      return;
    }
    if (needsName && !yourName.trim()) {
      setError("Type your name so your students know who runs the program.");
      return;
    }

    setBusy(true);
    setError(null);
    const { result, error: rpcError } = await createProgramInGroup(groupId, name, {
      shortName,
      displayName: yourName,
      instruments,
    });

    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }
    if (!result?.ok) {
      setBusy(false);
      setError(result?.message ?? "Could not create the program — try again.");
      return;
    }

    // Land in the program they just made (not the one they happened to be in),
    // then open the guided setup: the join code, the sections, and how their own
    // dashboard reads. It is skippable and changes nothing about access — a
    // director who leaves immediately keeps a working program.
    await app.refresh(result.program_id ?? undefined);
    setBusy(false);
    toast.success("Your program is ready — share its join code with your students.");
    navigate("/setup");
  }

  /*
   * Not verified, and not already a director somewhere: the server would refuse
   * this form, so it is not shown. The invitation form replaces it in place, and
   * verifying here reveals the real form without a navigation.
   */
  const needsVerification = !app.mayStartProgram;

  const form = (
    <div className="cue-stagger mx-auto max-w-2xl space-y-5 px-4 py-5 pb-10 sm:px-6 sm:py-6">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <PageHeader
        kicker="New program"
        title={needsVerification ? "Teacher access first" : "Start your own program"}
        note={
          needsVerification
            ? "Starting a program needs verified teacher access. Enter the invitation code your school issued you, and this form opens right up."
            : app.isSystemAdmin
              ? "Choose its section, name it, and list its instruments. You keep full access as a system administrator, without joining its roster."
              : "Choose its section, name it, and list its instruments. You're its director, and the roster, attendance and live check-in tools are ready as soon as it exists."
        }
      />

      {needsVerification ? (
        <TeacherVerification showIntroCards={false} />
      ) : groups.length === 0 ? (
        <Card className="flex items-start gap-3">
          <Layers aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-gold)]" />
          <div className="min-w-0">
            <p className="type-heading">No sections yet</p>
            <p className="type-meta mt-1">
              A system administrator creates the sections first — RHS Band, RHS Choir, RHS Drama,
              RHS Orchestra. Once yours exists, you can start a program inside it.
            </p>
          </div>
        </Card>
      ) : (
        <>
          <Field
            label="Section"
            hint="Which part of the music program runs this? RHS Band, RHS Choir, RHS Drama, RHS Orchestra."
          >
            <Select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">Choose a section</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Program name" hint="What everybody will call it — you can be specific.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jazz Ensemble"
              maxLength={80}
              autoComplete="off"
            />
          </Field>

          <Field
            label="Short name"
            hint="Optional — shown where space is tight, like the app bar. Blank uses the full name."
          >
            <Input
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              placeholder="Jazz"
              maxLength={40}
              autoComplete="off"
            />
          </Field>

          <Field
            label="Instruments"
            hint="What's in this program. Each one becomes a section your students can be put into."
          >
            <InstrumentPicker value={instruments} onChange={setInstruments} disabled={busy} />
          </Field>

          {needsName ? (
            <Field label="Your name" hint="Your students see this on the roster.">
              <Input
                value={yourName}
                onChange={(e) => setYourName(e.target.value)}
                placeholder="Alex Rivera"
                maxLength={80}
                autoComplete="name"
              />
            </Field>
          ) : null}

          <Button block size="lg" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            Create my program
          </Button>
        </>
      )}

      {!standalone ? (
        <Button block variant="ghost" onClick={() => navigate(-1)}>
          Not now
        </Button>
      ) : null}

      {needsVerification || groups.length === 0 ? null : (
        <Card className="flex items-start gap-3">
          <KeyRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-gold)]" />
          <p className="text-sm text-[var(--cue-muted)]">
            It starts closed. Your program gets its own join code, and only the people you give that
            code to can join it — you can replace the code whenever you like on the Roster screen.
          </p>
        </Card>
      )}

      <Card className="flex items-start gap-3">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
        <p className="type-meta">
          {app.isSystemAdmin
            ? "You keep every capability in every program without joining this one's roster. Nothing here changes anybody else's access."
            : "You become the director of this program only. Nothing here changes your access to somebody else's program — that is a director's decision, made on their roster."}
        </p>
      </Card>
    </div>
  );

  if (!standalone) return form;

  return (
    <div className="safe-t flex min-h-full flex-col bg-[var(--cue-page)]">
      <div className="bg-[var(--cue-brand-panel)] px-6 pt-8 pb-6 text-[var(--cue-brand-ink)]">
        <img src="/logo.svg" alt="" className="h-9 w-9" />
        <p className="type-label mt-3 text-[var(--cue-gold-on-brand)]">{ORG_NAME}</p>
        <p className="type-title mt-1.5">{APP_NAME}</p>
        <p className="mt-1 max-w-md text-sm text-[var(--cue-brand-ink)]/80">
          You&rsquo;re signed in. Verified teachers choose a section, name a program and become its
          director straight away — if you haven&rsquo;t entered your invitation code yet, you can do
          it here.
        </p>
      </div>

      <div className="flex-1">{form}</div>

      <div className="space-y-3 px-6 pb-6">
        {/* A verified teacher is here to start a program; offering the student
            join form would send them back into onboarding they have finished. */}
        {!app.mayStartProgram ? (
          <Button block variant="secondary" onClick={() => navigate("/join")}>
            Join a program with a code instead
          </Button>
        ) : null}
        <Button
          block
          variant="ghost"
          icon={<LogOut className="h-4 w-4" />}
          onClick={() => void auth.signOut()}
        >
          Sign out
        </Button>
        {auth.email ? (
          <p className="type-meta text-center">Signed in as {auth.email}</p>
        ) : null}
      </div>
    </div>
  );
}
