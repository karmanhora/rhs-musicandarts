import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  LayoutDashboard,
  Palette,
  Users,
} from "lucide-react";
import {
  Alert,
  Button,
  Card,
  IconButton,
  List,
  Metric,
  MetricStrip,
  PageHeader,
  Row,
  Skeleton,
  useToast,
  cn,
} from "../components/ui";
import { SectionManager } from "../components/SectionManager";
import { AppearanceSettings } from "../components/AppearanceSettings";
import { DashboardLayoutEditor } from "../components/DashboardLayoutEditor";
import { getJoinCode } from "../lib/rpc";
import { ROLE_LABEL } from "../lib/constants";
import { usePrograms } from "../hooks/usePrograms";
import { usePreferences } from "../hooks/usePreferences";

/**
 * `/setup` — the guided setup a program's director finishes once.
 *
 * What it deliberately is **not**:
 *
 *   * Not a gate. Nothing here blocks attendance, the roster or check-in, and
 *     every step can be skipped. `onboarding_completed_at` records that it was
 *     finished; it never decides what somebody may open.
 *   * Not a second program editor. The database has no RPC to rename a program,
 *     so step 2 *shows* what was created rather than pretending to edit it; the
 *     join code and the sections come from the same calls the Roster screen uses
 *     (`get_join_code`, `SectionManager`), so there is no parallel system to
 *     drift out of step.
 *   * Not a student flow. It is behind `program.manage_settings`, and it is only
 *     ever offered to somebody the server says can manage this program.
 *
 * Step 4 is where the personal part lives: the dashboard blocks and appearance
 * components are the same ones in Account settings → Preferences, so a choice
 * made here is not a different kind of choice.
 */

const STEP_TITLES = ["Welcome", "Your program", "Sections", "Your workspace"] as const;

export function SetupScreen() {
  const app = usePrograms();
  const prefs = usePreferences();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [finishing, setFinishing] = useState(false);

  const [code, setCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  const programId = app.program?.id ?? null;

  // The join code is director-only, and asking as anybody else is refused — the
  // screen shows the refusal rather than an empty code that looks like a bug.
  useEffect(() => {
    if (step !== 2 || !programId || code !== null) return;
    let active = true;
    void getJoinCode(programId).then(({ result, error }) => {
      if (!active) return;
      if (error || !result?.ok) {
        setCodeError(error?.message || result?.message || "Could not read the join code.");
        return;
      }
      setCode(result.code ?? "");
    });
    return () => {
      active = false;
    };
  }, [step, programId, code]);

  if (!app.program) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-11 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  async function copyCode() {
    if (!code) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Join code copied.");
    } catch {
      // Never claim a copy that did not happen; the code is on screen anyway.
      toast.warn("Copying didn't work — write the code down instead.");
    } finally {
      setCopying(false);
    }
  }

  async function finish() {
    setFinishing(true);
    const message = await prefs.save({ onboarding_completed: true });
    setFinishing(false);
    if (message) {
      toast.error(message);
      return;
    }
    toast.success("Setup saved — you can change any of it in Account settings.");
    navigate("/", { viewTransition: true });
  }

  const last = step === STEP_TITLES.length;

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-5">
        <div>
          {/* Progress: four bars for the eye, and the count in text for anybody
              who cannot see them. The bars are decorative and say so. */}
          <ol aria-hidden="true" className="flex items-center gap-1.5">
            {STEP_TITLES.map((title, index) => (
              <li
                key={title}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  index + 1 <= step ? "bg-[var(--cue-leaf)]" : "bg-[var(--cue-line)]"
                )}
              />
            ))}
          </ol>
          <p className="type-meta mt-2">
            Step {step} of {STEP_TITLES.length} · {STEP_TITLES[step - 1]}
          </p>
        </div>

        {step === 1 ? (
          <>
            <PageHeader
              kicker={app.program.short_name || app.program.name}
              title={`Welcome, ${(app.profile?.display_name || app.profile?.full_name || "there").split(/\s+/)[0]}`}
              note="A minute of setup so this program is yours before the first rehearsal — and none of it is required to take attendance."
            />

            <Card className="space-y-4">
              <List>
                <Row
                  icon={<KeyRound aria-hidden="true" className="h-4 w-4" />}
                  title="The code your students join with"
                  subtitle="Every program has its own. Share it, or replace it later."
                />
                <Row
                  icon={<Users aria-hidden="true" className="h-4 w-4" />}
                  title="Your sections"
                  subtitle="Trumpets, sopranos, tech crew — whatever this program calls its groups."
                />
                <Row
                  icon={<LayoutDashboard aria-hidden="true" className="h-4 w-4" />}
                  title="How your dashboard reads"
                  subtitle="Which blocks you see, and in what order. Only yours."
                />
                <Row
                  icon={<Palette aria-hidden="true" className="h-4 w-4" />}
                  title="How the app looks to you"
                  subtitle="Light or dark, and the page behind your panels."
                />
              </List>
              <p className="type-meta border-t border-[var(--cue-line)] pt-3">
                You are the director of {app.program.name} only. Nothing here changes anybody
                else&rsquo;s view, and nothing here changes what you are allowed to open.
              </p>
            </Card>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <PageHeader
              kicker="Step 2"
              title="Your program"
              note="What exists today. The join code and the roster are the two things students meet first."
            />

            <Card className="space-y-4">
              <MetricStrip columns={2}>
                <Metric label="Program" value={app.program.short_name || app.program.name} />
                <Metric
                  label="Your role"
                  value={app.isSystemAdmin ? "System administrator" : ROLE_LABEL[app.primaryRole]}
                />
                <Metric
                  label="Sections"
                  value={app.sections.length || "—"}
                  hint="groups on the roster"
                />
                <Metric
                  label="Members"
                  value={app.memberships.length}
                  hint={app.memberships.length === 1 ? "person so far" : "people so far"}
                />
              </MetricStrip>

              <div className="border-t border-[var(--cue-line)] pt-4">
                <p className="type-label">Join code</p>
                {codeError ? (
                  <Alert tone="error" className="mt-2">
                    {codeError}
                  </Alert>
                ) : code === null ? (
                  <Skeleton className="mt-2 h-12 w-full" />
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] border border-[var(--cue-line-strong)] bg-[var(--cue-raised)] px-3 py-3 text-center font-mono text-xl font-semibold tracking-[0.25em]">
                      {code || "—"}
                    </code>
                    <IconButton
                      label={copying ? "Copying the join code" : "Copy the join code"}
                      icon={<Copy className="h-4 w-4" />}
                      variant="secondary"
                      disabled={copying || !code}
                      onClick={() => void copyCode()}
                    />
                  </div>
                )}
                <p className="type-meta mt-2">
                  Without this code, somebody can sign in and still see nothing — it is what puts a
                  person on this program&rsquo;s roster.
                </p>
              </div>

              <div className="border-t border-[var(--cue-line)] pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  iconAfter={<ArrowRight className="h-4 w-4" />}
                  onClick={() => navigate("/roster", { viewTransition: true })}
                >
                  Open the roster
                </Button>
              </div>
            </Card>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <PageHeader
              kicker="Step 3"
              title="Your sections"
              note="A section is whatever this program groups people by. Add the ones you have; the roster and every roll group by them."
            />

            <SectionManager />

            <p className="type-meta">
              Adding and naming happen here and on the Roster screen; removing one never removes a
              person — they fall under &ldquo;No section&rdquo; until you move them.
            </p>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <PageHeader
              kicker="Step 4"
              title="Your workspace"
              note="These choices are yours alone, on this account, and can be changed any time in Account settings."
            />

            <DashboardLayoutEditor />
            <AppearanceSettings />
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--cue-line)] pt-4">
          {step > 1 ? (
            <Button
              variant="secondary"
              icon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => setStep((current) => Math.max(1, current - 1))}
            >
              Back
            </Button>
          ) : null}

          <Button
            className="ml-auto"
            loading={last ? finishing : false}
            icon={last ? <Check className="h-4 w-4" /> : undefined}
            iconAfter={last ? undefined : <ArrowRight className="h-4 w-4" />}
            onClick={() => (last ? void finish() : setStep((current) => current + 1))}
          >
            {last ? "Finish setup" : "Continue"}
          </Button>
        </div>

        {!last ? (
          <button
            type="button"
            onClick={() => navigate("/", { viewTransition: true })}
            className="inline-flex min-h-11 items-center text-[0.8125rem] font-semibold text-[var(--cue-leaf)] underline decoration-2 underline-offset-4"
          >
            Finish this later
          </button>
        ) : (
          <p className="type-meta">
            Finishing records that setup is done. It does not lock anything: sections, the join
            code, your dashboard and your appearance all stay editable.
          </p>
        )}

        {prefs.preferences.onboarding_completed_at ? (
          <p className="type-meta">
            You finished setup once before. Running through it again will not clear anything.
          </p>
        ) : null}
      </div>
    </div>
  );
}
