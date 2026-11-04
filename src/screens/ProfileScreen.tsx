import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  KeyRound,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserCog,
  UserPlus,
  UserRound,
} from "lucide-react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  List,
  PageHeader,
  ProgressRing,
  Row,
  SectionTitle,
  Sheet,
  Skeleton,
  useToast,
} from "../components/ui";
import { ProfileForm } from "../components/ProfileForm";
import { CapabilityList, RoleBadges } from "../components/CapabilityList";
import {
  getMyAttendancePct,
  getMyAttendanceTrend,
  setMemberSection,
  setProgramActive,
} from "../lib/rpc";
import type { MyAttendanceRow } from "../lib/types";
import { usePrograms } from "../hooks/usePrograms";
import { useAuth } from "../hooks/useAuth";
import {
  APP_NAME,
  ATTENDANCE_STATUS_CHIP,
  ATTENDANCE_STATUS_LABEL,
  ORG_NAME,
  ROLE_LABEL,
} from "../lib/constants";
import { fmtDate, relativeDay } from "../lib/date";

/**
 * `/me` — who you are, what you are allowed to do here, how your own attendance
 * is doing, and the way into everything else that is yours to change.
 *
 * Attendance is read through `my_attendance_pct()` / `my_attendance_trend()`,
 * the same pair the home screen's ring uses, so the numbers can't drift. Nothing
 * here needs a staff role.
 *
 * Editing your own name, biography and picture is the one write this screen
 * makes, and it goes through `profiles` under RLS — roles, sections and program
 * membership are *not* editable here (see `CapabilityList`, which shows why).
 */
function verdict(pct: number): string {
  if (pct >= 80) return "In good standing.";
  if (pct >= 60) return "Slipping — a couple of missed rehearsals adds up fast.";
  return "At risk. If something is in the way, talk to your director.";
}

export function ProfileScreen() {
  const app = usePrograms();
  const auth = useAuth();
  const { toast } = useToast();

  const programId = app.program?.id ?? null;
  const profileId = app.profile?.id ?? null;
  const navigate = useNavigate();
  const name = app.profile?.display_name || app.profile?.full_name || "Member";
  const email = auth.email;

  const [pct, setPct] = useState<number | null>(null);
  const [trend, setTrend] = useState<MyAttendanceRow[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editOpen, setEditOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [busySection, setBusySection] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmProgramArchive, setConfirmProgramArchive] = useState(false);
  const [updatingProgramStatus, setUpdatingProgramStatus] = useState(false);

  const load = useCallback(async () => {
    if (!programId) return;
    setLoading(true);
    setError(null);
    const [pctResponse, trendResponse] = await Promise.all([
      getMyAttendancePct(programId),
      getMyAttendanceTrend(programId, 8),
    ]);

    if (pctResponse.error) {
      setError(pctResponse.error.message);
    } else if (pctResponse.result?.ok && typeof pctResponse.result.percentage === "number") {
      setPct(pctResponse.result.percentage);
    } else {
      setPct(null);
    }

    setRefusal(
      !pctResponse.result?.ok && pctResponse.result?.message
        ? pctResponse.result.message
        : trendResponse.message
    );
    setTrend(trendResponse.rows);
    setLoading(false);
  }, [programId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeProgramStatus() {
    if (!programId || !app.isDirector || !app.program) return;
    setUpdatingProgramStatus(true);
    const { result, error: rpcError } = await setProgramActive(programId, !app.program.active);
    setUpdatingProgramStatus(false);
    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not update this program.");
      return;
    }
    setConfirmProgramArchive(false);
    toast.success(result.message || (app.program.active ? "Program archived." : "Program restored."));
    await app.refresh(programId);
  }

  async function moveToSection(sectionId: string | null) {
    if (!programId || !profileId) return;
    setBusySection(sectionId ?? "none");
    const { result, error: rpcError } = await setMemberSection(programId, profileId, sectionId);
    setBusySection(null);
    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not change your section.");
      return;
    }
    setSectionOpen(false);
    toast.success("Section updated.");
    await app.refresh();
  }

  async function doSignOut() {
    setSigningOut(true);
    await auth.signOut();
    setSigningOut(false);
  }

  const facts: Array<[string, string]> = [
    ["Program", app.program?.name ?? APP_NAME],
    [
      "Section",
      app.membership ? app.membership.section?.name || "None yet" : "Not on this roster",
    ],
    ...(app.membership?.joined_at
      ? ([["On the roster since", fmtDate(new Date(app.membership.joined_at))]] as Array<
          [string, string]
        >)
      : []),
    ...(app.profile?.created_at
      ? ([["Account created", fmtDate(new Date(app.profile.created_at))]] as Array<
          [string, string]
        >)
      : []),
    ...(email ? ([["Signed in as", email]] as Array<[string, string]>) : []),
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-7">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <PageHeader
          kicker={app.program?.short_name || app.program?.name || "Program"}
          title={name}
          note={[
            app.roleLabel,
            app.membership?.section?.name,
            app.membership?.joined_at
              ? `on the roster since ${fmtDate(new Date(app.membership.joined_at))}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          actions={
            <Button
              variant="secondary"
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => setEditOpen(true)}
            >
              Edit profile
            </Button>
          }
        />

        {/* --- who you are --- */}
        <section aria-label="Your details">
          <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
            <div className="flex items-start gap-4 p-4">
              <Avatar
                name={name}
                path={app.profile?.avatar_path}
                url={app.profile?.avatar_url}
                size={64}
              />
              <div className="min-w-0 flex-1">
                <RoleBadges roles={app.roles} />
                {app.isSystemAdmin && !app.membership ? (
                  <p className="type-meta mt-1.5">
                    System administrator for every program. You are not a member of this one, so it
                    gives you no section and no membership role — only administrator access.
                  </p>
                ) : null}
                {app.profile?.bio ? (
                  <p className="mt-2 text-sm leading-relaxed text-[var(--cue-muted)]">
                    {app.profile.bio}
                  </p>
                ) : (
                  <p className="type-meta mt-2">
                    No biography yet — add a line or two so your section knows who you are.
                  </p>
                )}
              </div>
            </div>
            <dl className="cue-list">
              {facts.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                  <dt className="type-label shrink-0">{label}</dt>
                  <dd className="min-w-0 truncate text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {app.profile?.must_change_password ? (
          <Alert tone="info">
            Your director set a temporary password for this account.{" "}
            <button className="font-semibold underline" onClick={() => navigate("/settings")}>
              Choose your own
            </button>{" "}
            and this note clears.
          </Alert>
        ) : null}

        {/* --- how my record stands --- */}
        <section>
          <SectionTitle className="mb-3">My attendance</SectionTitle>
          {refusal ? (
            <div className="cue-card rounded-[var(--radius-panel)]">
              <EmptyState
                icon={<UserRound className="h-4 w-4" />}
                title="Not available"
                body={refusal}
              />
            </div>
          ) : loading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="cue-card overflow-hidden rounded-[var(--radius-panel)]">
              <div className="flex items-center gap-5 p-4">
                <ProgressRing value={pct ?? 0} size={76} stroke={7} />
                <div className="min-w-0">
                  {pct === null ? (
                    <>
                      <p className="type-heading">No required events yet</p>
                      <p className="type-meta mt-1">
                        Your percentage appears after your first required rehearsal or performance.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="type-heading">{verdict(pct)}</p>
                      <p className="type-meta mt-1">
                        Share of required events you attended. Excused absences are left out.
                      </p>
                    </>
                  )}
                </div>
              </div>

              {trend.length > 0 ? (
                <ul className="cue-list">
                  {trend.map((row) => (
                    <li key={row.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{row.name}</span>
                        <span className="type-meta block tabular">{relativeDay(row.date)}</span>
                      </span>
                      <Badge className={ATTENDANCE_STATUS_CHIP[row.status]}>
                        {ATTENDANCE_STATUS_LABEL[row.status]}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </section>

        {/* --- what I may do here --- */}
        <section>
          <SectionTitle
            className="mb-3"
            action={
              <span className="type-meta">
                {app.membership
                  ? `from your roles in ${app.program?.name ?? "this program"}`
                  : "as a system administrator"}
              </span>
            }
          >
            What you can do here
          </SectionTitle>
          <Card>
            <CapabilityList permissions={app.permissions} />
            <p className="type-meta mt-3 border-t border-[var(--cue-line)] pt-3">
              Every one of these is checked again on the server for each action. A padlocked item can
              only come with a role, never from a custom one.
            </p>
          </Card>
        </section>

        {/* --- my section ---
             Hidden for an administrator who is not on this roster: there is no
             membership to change, and offering the picker would promise a write
             the server correctly refuses. */}
        {app.membership ? (
        <section>
          <SectionTitle className="mb-3">My section</SectionTitle>
          <List>
            <Row
              icon={<UserRound className="h-4 w-4" />}
              title={app.membership?.section?.name || "No section yet"}
              subtitle="Where you sit in this program — change it or ask a director"
              trailing={
                <ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />
              }
              onClick={() => setSectionOpen(true)}
            />
          </List>
        </section>
        ) : null}

        {/* --- the programs I belong to --- */}
        <section>
          <SectionTitle className="mb-3">My programs</SectionTitle>
          <List>
            {app.memberships.map((m) => {
              const here = m.ensemble.id === app.program?.id;
              return (
                <Row
                  key={m.id}
                  title={m.ensemble.name}
                  subtitle={
                    !m.ensemble.active
                      ? "Archived"
                      : here
                        ? "You're looking at this one"
                        : `${m.roles.map((r) => ROLE_LABEL[r]).join(" · ") || ROLE_LABEL.student} — switch to it`
                  }
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
                  onClick={here ? undefined : () => app.setProgram(m.ensemble.id)}
                />
              );
            })}
            {app.isDirector && app.program ? (
              <Row
                icon={
                  app.program.active ? (
                    <Archive className="h-4 w-4" />
                  ) : (
                    <ArchiveRestore className="h-4 w-4" />
                  )
                }
                title={app.program.active ? "Archive this program" : "Restore this program"}
                subtitle={
                  app.program.active
                    ? "Hide it from new members; keep existing members and attendance"
                    : "Let new members join it again"
                }
                onClick={() => setConfirmProgramArchive(true)}
              />
            ) : null}
            <Row
              icon={<UserPlus className="h-4 w-4" />}
              title="Join another program"
              subtitle="Use the join code from that program's director"
              onClick={() => navigate("/join")}
            />
            {app.canCreateProgram ? (
              <Row
                icon={<Plus className="h-4 w-4" />}
                title="Start a new program"
                subtitle="Name it and you're its director"
                onClick={() => navigate("/new-program")}
              />
            ) : null}
            {app.isSystemAdmin ? (
              <Row
                icon={<ShieldCheck className="h-4 w-4" />}
                title="Programs & teams"
                subtitle="Put a program inside a team, or move one between teams"
                trailing={
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
                  />
                }
                onClick={() => navigate("/programs")}
              />
            ) : null}
          </List>
        </section>

        {/* --- account, roles and the notices --- */}
        <section>
          <SectionTitle className="mb-3">Your account</SectionTitle>
          <List>
            <Row
              icon={<KeyRound className="h-4 w-4" />}
              title="Account settings"
              subtitle="Name, picture, password, email, appearance, privacy"
              trailing={
                <ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />
              }
              onClick={() => navigate("/settings")}
            />
            {app.can("roles.view") ? (
              <Row
                icon={<UserCog className="h-4 w-4" />}
                title="Roles & permissions"
                subtitle="Who can do what, and the custom roles in this program"
                trailing={
                  <ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />
                }
                onClick={() => navigate("/roles")}
              />
            ) : null}
            <Row
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Privacy policy"
              subtitle="What is collected, who can see it, how to request deletion"
              trailing={
                <ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />
              }
              onClick={() => navigate("/privacy")}
            />
          </List>
          <p className="type-meta mt-2">
            {ORG_NAME}. Deleting your account, and what is kept afterwards, lives in Account settings
            → Privacy.
          </p>
        </section>

        <Button
          variant="secondary"
          icon={<LogOut className="h-4 w-4" />}
          onClick={() => setConfirmSignOut(true)}
        >
          Sign out
        </Button>
      </div>

      {/* --- edit profile --- */}
      <Sheet
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit your profile"
        description="Your director and your program see your name and picture."
        size="tall"
      >
        {app.profile ? (
          <ProfileForm
            profile={app.profile}
            authUserId={auth.userId ?? ""}
            onSaved={() => app.refresh()}
          />
        ) : null}
      </Sheet>

      {/* --- pick my section --- */}
      <Sheet
        open={sectionOpen}
        onClose={() => setSectionOpen(false)}
        title="My section"
        description="Your director can move you too."
        size="tall"
      >
        <List>
          {app.sections.length === 0 ? (
            <EmptyState
              title="No sections set up yet"
              body="Your director has not created any instruments or sections for this program."
            />
          ) : (
            app.sections.map((s) => (
              <Row
                key={s.id}
                title={s.name}
                trailing={
                  app.membership?.section_id === s.id ? (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-green)]" />
                  ) : busySection === s.id ? (
                    <RefreshCw
                      aria-hidden="true"
                      className="h-4 w-4 animate-spin text-[var(--cue-subtle)]"
                    />
                  ) : null
                }
                onClick={
                  busySection !== null || app.membership?.section_id === s.id
                    ? undefined
                    : () => void moveToSection(s.id)
                }
              />
            ))
          )}
          <Row
            title="No section"
            subtitle="You'll show up under everyone else"
            trailing={
              app.membership?.section_id === null ? (
                <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--cue-green)]" />
              ) : busySection === "none" ? (
                <RefreshCw
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin text-[var(--cue-subtle)]"
                />
              ) : null
            }
            onClick={
              busySection !== null || app.membership?.section_id === null
                ? undefined
                : () => void moveToSection(null)
            }
          />
        </List>
      </Sheet>

      <ConfirmSheet
        open={confirmProgramArchive}
        title={app.program?.active ? "Archive this program?" : "Restore this program?"}
        body={
          app.program?.active
            ? "New members will no longer be able to join. Current members, events, and attendance history will be kept. You can restore the program later."
            : "This will make the program available for new members to join again. Existing members and attendance history are unchanged."
        }
        confirmLabel={app.program?.active ? "Archive program" : "Restore program"}
        tone={app.program?.active ? "danger" : "primary"}
        loading={updatingProgramStatus}
        onCancel={() => setConfirmProgramArchive(false)}
        onConfirm={() => void changeProgramStatus()}
      />
      <ConfirmSheet
        open={confirmSignOut}
        title="Sign out?"
        body="You'll need your login again to check in. Nothing on the roster changes."
        confirmLabel="Sign out"
        loading={signingOut}
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => void doSignOut()}
      />
    </div>
  );
}
