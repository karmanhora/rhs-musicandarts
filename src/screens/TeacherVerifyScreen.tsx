import { useNavigate } from "react-router-dom";
import { LogOut, ShieldCheck } from "lucide-react";
import { Badge, Button, PageHeader } from "../components/ui";
import { TeacherVerification } from "../components/TeacherVerification";
import { usePrograms } from "../hooks/usePrograms";
import { useAuth } from "../hooks/useAuth";
import { APP_NAME, ORG_NAME } from "../lib/constants";

/**
 * `/teacher` — the teacher/director registration entry point.
 *
 * Joining a program needs a director's join code, so a teacher with nobody to ask
 * had no way in. This is the other door, and since migration 035 it is a *closed*
 * one: the account must hold a redeemed invitation before it can start a program.
 *
 * The screen is reachable from the join screen, from Account settings, and from
 * the account sheet — and it works the same whether somebody arrives straight
 * after signing up or comes back weeks later with the code, because "enter it
 * later" reuses one flow rather than a second one that could drift.
 *
 * Like the join and start-a-program screens it renders twice: standalone (no app
 * bar) when the person is signed in with no roster at all, and inside the shell
 * at `/teacher` afterwards.
 */
export function TeacherVerifyScreen({ standalone = false }: { standalone?: boolean }) {
  const app = usePrograms();
  const auth = useAuth();
  const navigate = useNavigate();

  const form = (
    <div className="cue-stagger mx-auto max-w-2xl space-y-5 px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <PageHeader
        kicker={["Teacher access", auth.email].filter(Boolean).join(" · ")}
        title="Teacher / director registration"
        note={
          app.verifiedTeacher
            ? "Your invitation is verified. Start a program of your own and run it as its director."
            : "One code per teacher, issued by the school. Verifying it lets you start a program of your own and run it as its director."
        }
        actions={
          <Badge
            className={
              app.verifiedTeacher
                ? "bg-[var(--cue-present-bg)] text-[var(--cue-present)]"
                : "bg-[var(--cue-late-bg)] text-[var(--cue-late)]"
            }
          >
            {app.verifiedTeacher ? "Verified" : "Pending"}
          </Badge>
        }
      />

      <TeacherVerification onStartProgram={() => navigate("/new-program")} />

      {!standalone ? (
        <Button block variant="ghost" onClick={() => navigate(-1)}>
          Not now
        </Button>
      ) : (
        <Button
          block
          variant="secondary"
          icon={<LogOut className="h-4 w-4" />}
          onClick={() => void auth.signOut()}
        >
          Sign out
        </Button>
      )}
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
          {app.verifiedTeacher
            ? "You're verified. Start your own program — the roster, attendance and live check-in tools come with it."
            : "You're signed in. Enter your teacher invitation code to unlock starting a program — until then your account stays an ordinary one."}
        </p>
      </div>

      <div className="flex-1">{form}</div>

      <div className="space-y-3 px-6 pb-6">
        <p className="type-meta flex items-center justify-center gap-2 text-center">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
          Checked on the server. Your code is stored only as a hash, and it works once.
        </p>
      </div>
    </div>
  );
}
