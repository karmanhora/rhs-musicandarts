import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, LogOut, Music, ShieldCheck, Users } from "lucide-react";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  useToast,
} from "../components/ui";
import { joinProgramByCode } from "../lib/rpc";
import { usePrograms } from "../hooks/usePrograms";
import { useAuth } from "../hooks/useAuth";
import { APP_NAME, ORG_NAME, ROLE_LABEL } from "../lib/constants";

/**
 * Joining a program — the first one and every one after it.
 *
 * There is deliberately ONE implementation of this flow, used twice:
 *
 *   * standalone (no app bar, no bottom nav) when somebody is signed in but on
 *     no roster at all, and
 *   * as the `/join` route inside the shell, reached from the program switcher,
 *     from Profile, and from the roster screen's empty state.
 *
 * The code is checked by `join_program_by_code()` on the server — rate-limited;
 * this screen only collects it. The code also names the program, so there is no
 * picker: typing the code is the whole choice. When the person has no profile
 * yet that same call creates one, which is why their name is asked for here
 * rather than guessed from the account.
 *
 * Joining somebody else's program is not the only way in: a teacher with nobody
 * to ask can start their own from here (`/new-program`). That option is shown
 * only to teacher accounts and is independently checked by the server.
 */
export function JoinProgramScreen({ standalone = false }: { standalone?: boolean }) {
  const app = usePrograms();
  const auth = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** No profile yet? This call creates it, so it needs a name to store. */
  const needsName = !app.profile;

  const canSubmit = code.trim().length > 0 && (!needsName || name.trim().length > 0);

  async function submit() {
    if (!code.trim()) {
      setError("Type the join code your director gave you.");
      return;
    }
    if (needsName && !name.trim()) {
      setError("Type your name so your director knows who joined.");
      return;
    }

    setBusy(true);
    setError(null);
    const { result, error: rpcError } = await joinProgramByCode(code.trim(), name.trim());

    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }
    if (!result?.ok) {
      setBusy(false);
      setError(result?.message ?? "That join code didn't work.");
      return;
    }

    // Landed: re-read the session so the whole app re-themes to that program —
    // and land in *that* one, so joining a second program actually switches to it.
    await app.refresh(result.program_id ?? undefined);
    setBusy(false);
    toast.success(result.message ?? `You're in ${result.program_name ?? "your program"}.`);
    if (!standalone) navigate("/");
  }

  const form = (
    <div className="cue-stagger mx-auto max-w-2xl space-y-5 px-4 py-5 pb-10 sm:px-6 sm:py-6">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {auth.accountTypeSetupError ? (
        <Alert tone="error">
          We couldn&rsquo;t save your student or teacher account choice. Sign out and try again.{" "}
          {auth.accountTypeSetupError}
        </Alert>
      ) : null}

      <PageHeader
        kicker={[ROLE_LABEL.student, auth.email].filter(Boolean).join(" · ")}
        title="Join a program"
        note="Type the code your director gave you. It lands you on that program's roster — its rehearsals, its calendar and your own attendance. There is nothing to pick first."
      />

      {/* Point teachers at the teacher door — which, since migration 035, needs
          the school's invitation code rather than a self-declared account type. */}
      {standalone && auth.accountType === "teacher" && !app.mayStartProgram ? (
        <Card className="flex items-start gap-3">
          <Users aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-gold)]" />
          <p className="text-sm text-[var(--cue-muted)]">
            <span className="font-semibold text-[var(--cue-ink)]">Teaching here?</span>{" "}
            Teacher access is verified with an invitation code from the school. Until yours is
            verified this account stays an ordinary one — use the code below only if you&rsquo;re
            joining a program somebody else already runs, which puts you on it as a student.
          </p>
        </Card>
      ) : null}

      <Field
        label="Join code"
        hint="Ask your director — each program has its own code, and the code picks the program for you."
      >
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 12))}
          placeholder="ABCD2345"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="text-center font-mono text-xl tracking-[0.25em]"
        />
      </Field>

      {needsName ? (
        <Field label="Your name" hint="Your director sees this on the roster.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex Rivera"
            autoComplete="name"
          />
        </Field>
      ) : null}

      <Button block size="lg" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
        Join
      </Button>

      {!standalone ? (
        <Button block variant="ghost" onClick={() => navigate(-1)}>
          Not now
        </Button>
      ) : null}

      {app.mayStartProgram ? (
        <Card className="space-y-3">
          <div className="flex items-start gap-3">
            <Music aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
            <div className="min-w-0">
              <p className="type-heading">Running a program of your own?</p>
              <p className="type-meta mt-1">
                Name it and you&rsquo;re its director — the roster, attendance and live check-in
                tools come with it, and it starts closed with a join code for you to hand out.
              </p>
            </div>
          </div>
          <Button variant="secondary" onClick={() => navigate("/new-program")}>
            Start a new program
          </Button>
        </Card>
      ) : auth.accountType === "teacher" ? (
        /* The teacher/director registration entry point, on the screen somebody
           with no roster actually lands on. */
        <Card className="space-y-3">
          <div className="flex items-start gap-3">
            <KeyRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-gold)]" />
            <div className="min-w-0">
              <p className="type-heading">Teaching here?</p>
              <p className="type-meta mt-1">
                Starting a program of your own needs an invitation code from the school. Enter it and
                your teacher access is verified — until then this account keeps its ordinary
                permissions.
              </p>
            </div>
          </div>
          <Button variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => navigate("/teacher")}>
            Teacher / director registration
          </Button>
        </Card>
      ) : null}

      <Card className="flex items-start gap-3">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
        <p className="type-meta">
          The code is checked on the server, never in this browser. If a director removed you from a
          program, only a director can put you back.
        </p>
      </Card>

      {standalone ? (
        <Button
          block
          variant="secondary"
          icon={<LogOut className="h-4 w-4" />}
          onClick={() => void auth.signOut()}
        >
          Sign out
        </Button>
      ) : null}
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
          You&rsquo;re signed in — join your program to see its calendar, its rehearsals and your own
          attendance.
        </p>
      </div>

      <div className="flex-1">{form}</div>

      {auth.email ? (
        <p className="type-meta px-6 pb-6 text-center">Signed in as {auth.email}</p>
      ) : null}
    </div>
  );
}
