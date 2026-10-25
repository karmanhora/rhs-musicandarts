import { useState } from "react";
import type { FormEvent } from "react";
import { BadgeCheck, Eye, EyeOff, GraduationCap, KeyRound, ShieldCheck } from "lucide-react";
import { Alert, Button, Card, Input, List, Row, useToast } from "./ui";
import { redeemTeacherInvitation } from "../lib/rpc";
import { usePrograms } from "../hooks/usePrograms";

/**
 * The teacher/director credential: enter an invitation code, get it verified.
 *
 * One component, used everywhere the code can be entered — the `/teacher` screen,
 * the start-a-program screen (which shows this instead of the form until the
 * account is verified), and an already signed-in account coming back to it
 * later. That is deliberate: "enter your code later" must be the *same* flow as
 * entering it the first time, or the two will drift.
 *
 * What this component does *not* do is decide anything. The code is sent to
 * `redeem_teacher_invitation()` (migration 035), which normalizes it, hashes it,
 * checks expiry and email binding, and consumes it atomically; the answer here is
 * only ever the server's. There is no code, hash or expected value anywhere in
 * the browser — the plaintext the person types is never stored, never logged and
 * never displayed back.
 *
 * Until the server says otherwise the account keeps its ordinary permissions, so
 * the copy says so plainly: access stays **pending** until a code is verified.
 */
export function TeacherVerification({
  onVerified,
  onStartProgram,
  showIntroCards = true,
}: {
  /** Called after the server confirms the redemption. */
  onVerified?: () => void;
  /**
   * Where "Start a program" goes once verified. Omitted on the screens that
   * already *are* the start-a-program flow — there, verifying simply reveals the
   * form in place instead of navigating.
   */
  onStartProgram?: () => void;
  showIntroCards?: boolean;
}) {
  const app = usePrograms();
  const { toast } = useToast();

  const [code, setCode] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** What this code also granted beyond the credential, when it named a roster. */
  const [granted, setGranted] = useState<{ program: string; role: string } | null>(null);

  const verified = app.verifiedTeacher || done;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    const entered = code.trim();
    if (!entered) {
      setError("Type the invitation code you were given.");
      return;
    }

    setBusy(true);
    setError(null);

    const { result, error: rpcError } = await redeemTeacherInvitation(entered);

    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }
    if (!result?.ok) {
      setBusy(false);
      setError(result?.message ?? "That invitation code didn't work.");
      return;
    }

    // Verified. Re-read the credential before saying so, so the screen cannot
    // claim success the database does not agree with.
    await app.refreshTeacherAccess();
    setBusy(false);
    setDone(true);
    // A staff invitation names the roster it joins; say so rather than leaving
    // somebody to discover the program by accident in the switcher.
    setGranted(
      result.joined && result.program_name
        ? { program: result.program_name, role: result.role_name ?? "Member" }
        : null
    );
    // Never echo the code back — only that it worked.
    setCode("");
    toast.success(result.message ?? "You're verified.");
    onVerified?.();
  }

  if (verified) {
    return (
      <div className="space-y-5">
        <Alert tone="success">
          <span className="font-semibold">Teacher access verified. </span>
          Your account can start a program of its own and become its director.
          {granted ? (
            <>
              {" "}
              You are also on the <strong>{granted.program}</strong> roster as {granted.role} —
              switch to that program from the menu at the top.
            </>
          ) : null}{" "}
          Your invitation code has been used up — one code works once.
        </Alert>

        {!app.mayStartProgram && onStartProgram ? (
          <Button block size="lg" onClick={onStartProgram}>
            Start a program
          </Button>
        ) : null}

        <Card className="flex items-start gap-3">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
          />
          <p className="type-meta">
            Teacher access is checked on the server for every request, so it applies to this account
            immediately — there is nothing to save or reload.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Pending, in one line, before any field — the brief's requirement that
          nobody is left thinking they are already a teacher. */}
      <Alert tone="info">
        <span className="font-semibold">Teacher access is pending. </span>
        Until your invitation code is verified, this account keeps its ordinary permissions: your
        own attendance, and any program you join with a join code. It cannot start or run a program
        yet.
      </Alert>

      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        {error ? <Alert tone="error">{error}</Alert> : null}

        {/* Not `Field`: the reveal button must sit beside the input rather than
            inside its label, or tapping it would also activate the field. */}
        <div>
          <label
            htmlFor="teacher-invitation-code"
            className="mb-1.5 block text-[0.8125rem] font-semibold text-[var(--cue-ink)]"
          >
            Invitation code
          </label>
          <div className="relative">
            <Input
              id="teacher-invitation-code"
              type={reveal ? "text" : "password"}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter your code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby="teacher-invitation-hint"
              className="pr-14 font-mono tracking-[0.12em]"
              // The code is a secret: never let a keyboard or a password manager
              // offer to remember it.
              data-1p-ignore
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
              aria-controls="teacher-invitation-code"
              aria-label={reveal ? "Hide the invitation code" : "Show the invitation code"}
              className="motion-press absolute inset-y-0 right-0.5 my-auto flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--cue-muted)] hover:text-[var(--cue-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--cue-focus)]"
            >
              {reveal ? (
                <EyeOff aria-hidden="true" className="h-4 w-4" />
              ) : (
                <Eye aria-hidden="true" className="h-4 w-4" />
              )}
            </button>
          </div>
          <p id="teacher-invitation-hint" className="type-meta mt-1">
            Your school issues one code per teacher. Capital letters, spaces and dashes do not
            matter.
          </p>
        </div>

        <Button block size="lg" type="submit" loading={busy} disabled={!code.trim()} icon={<KeyRound className="h-4 w-4" />}>
          Verify my invitation
        </Button>
      </form>

      {showIntroCards ? (
        <>
          <section>
            <List>
              <Row
                icon={<GraduationCap className="h-4 w-4" />}
                title="What this unlocks"
                subtitle="Starting a program of your own, as its director"
              />
              <Row
                icon={<BadgeCheck className="h-4 w-4" />}
                title={granted ? "What it gave you" : "What it does not do"}
                subtitle={
                  granted
                    ? `${granted.role} on the ${granted.program} roster`
                    : "It never adds you to anybody else's program unless the administrator issued the code for that program"
                }
              />
            </List>
          </section>

          <Card className="flex items-start gap-3">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
            />
            <p className="type-meta">
              The code is checked on the server, never in this browser, and it is stored only as a
              one-way hash. Only the person it was issued to can use it, and it works once — so
              nobody can retype it to become a teacher later.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
