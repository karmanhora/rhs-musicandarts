import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  Clock,
  FileText,
  KeyRound,
  LogOut,
  Mail,
  MailWarning,
  MonitorSmartphone,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
  Wand2,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmSheet,
  Field,
  Input,
  List,
  PageHeader,
  Row,
  SectionTitle,
  SegmentedControl,
  Skeleton,
  Toggle,
  useToast,
} from "../components/ui";
import { ProfileForm } from "../components/ProfileForm";
import { CapabilityList, RoleBadges } from "../components/CapabilityList";
import { updateMyProfile } from "../lib/queries";
import type { EmbeddedMembership } from "../lib/queries";
import { setEmailUpcomingEvents } from "../lib/rpc";
import { fmtDate } from "../lib/date";
import { APP_NAME, ORG_NAME, ROLE_LABEL } from "../lib/constants";
import { useAuth } from "../hooks/useAuth";
import { useDark } from "../hooks/useDark";
import { usePrograms } from "../hooks/usePrograms";
import { useReducedMotion } from "../hooks/useReducedMotion";

type Tab = "profile" | "security" | "preferences" | "privacy";

/**
 * `/settings` — everything about your own account, in one place.
 *
 * Split by what it actually affects: who you are (profile), how you sign in
 * (security), how the app behaves for you (preferences), and what happens to
 * your records (privacy). Nothing here is decorative. There is still no toggle for
 * the in-app bell — it is fed by the `notifications` table and is always on — but
 * the *email* digest (migration 032) is a channel that leaves the app, so
 * Preferences carries one switch per program for it.
 *
 * Credentials are never touched by this app's database. Passwords, the email
 * address and session revocation all go straight to Supabase Auth.
 */
export function AccountSettingsScreen() {
  const app = usePrograms();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("profile");

  if (!app.profile) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-5 sm:px-6">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-5">
        <PageHeader
          kicker={app.program?.short_name || app.program?.name || ORG_NAME}
          title="Account settings"
          note="Who you are, how you sign in, how the app behaves for you, and what happens to your records."
        />

        <div className="sticky top-0 z-10 bg-[var(--cue-page)] pt-1">
          <SegmentedControl
            value={tab}
            onChange={setTab}
            options={[
              { value: "profile", label: "Profile" },
              { value: "security", label: "Security" },
              { value: "preferences", label: "Preferences" },
              { value: "privacy", label: "Privacy" },
            ]}
          />
        </div>

        {tab === "profile" ? <ProfileTab /> : null}
        {tab === "security" ? <SecurityTab /> : null}
        {tab === "preferences" ? <PreferencesTab /> : null}
        {tab === "privacy" ? <PrivacyTab /> : null}

        <section>
          <SectionTitle className="mb-3">Legal</SectionTitle>
          <List>
            <Row
              icon={<FileText className="h-4 w-4" />}
              title="Privacy policy"
              subtitle="What is collected, who can see it, and how to request deletion"
              onClick={() => navigate("/privacy")}
            />
            <Row
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Terms of use"
              subtitle="The rules for using the app"
              onClick={() => navigate("/terms")}
            />
          </List>
          <p className="type-meta mt-2">
            {APP_NAME} is part of {ORG_NAME}.
          </p>
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

function ProfileTab() {
  const app = usePrograms();
  const auth = useAuth();
  const navigate = useNavigate();
  if (!app.profile) return null;

  return (
    <div className="space-y-7">
      <Card>
        <ProfileForm
          profile={app.profile}
          authUserId={auth.userId ?? ""}
          onSaved={() => app.refresh()}
        />
      </Card>

      <section>
        <SectionTitle className="mb-3">Roles &amp; programs</SectionTitle>
        <Card>
          <p className="type-label">In {app.program?.name}</p>
          <RoleBadges roles={app.roles} className="mt-2" />
          <ul className="mt-3 border-t border-[var(--cue-line)]">
            {app.memberships.map((membership) => (
              <li
                key={membership.id}
                className="flex items-center justify-between gap-3 border-b border-[var(--cue-line)] py-2 text-sm last:border-b-0"
              >
                <span className="truncate font-medium">{membership.ensemble.name}</span>
                <span className="type-meta shrink-0">
                  {membership.roles?.map((r) => ROLE_LABEL[r]).join(" · ") || ROLE_LABEL.student}
                  {membership.section?.name ? ` · ${membership.section.name}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {app.membership?.joined_at ? (
            <p className="type-meta mt-3 border-t border-[var(--cue-line)] pt-3">
              On this roster since {fmtDate(new Date(app.membership.joined_at))}.
            </p>
          ) : null}
        </Card>
      </section>

      {auth.accountType === "teacher" ? (
      <section>
        <SectionTitle className="mb-3">Teacher access</SectionTitle>
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="type-heading">
                {app.verifiedTeacher ? "Verified teacher" : "Not verified yet"}
              </p>
              <p className="type-meta mt-1">
                {app.verifiedTeacher
                  ? "Your invitation code has been redeemed, so you can start a program of your own. Teacher access is set by the server and cannot be changed from this screen."
                  : "Starting a program of your own needs an invitation code issued by the school. Until it is verified this account keeps its ordinary permissions."}
              </p>
            </div>
            <Badge
              className={
                app.verifiedTeacher
                  ? "bg-[var(--cue-present-bg)] text-[var(--cue-present)]"
                  : "bg-[var(--cue-late-bg)] text-[var(--cue-late)]"
              }
            >
              {app.verifiedTeacher ? "Verified" : "Pending"}
            </Badge>
          </div>
          {!app.verifiedTeacher ? (
            <Button
              block
              variant="secondary"
              className="mt-3"
              icon={<KeyRound className="h-4 w-4" />}
              onClick={() => navigate("/teacher")}
            >
              Enter my invitation code
            </Button>
          ) : null}
        </Card>
      </section>
      ) : null}

      <section>
        <SectionTitle className="mb-3">What this account may do</SectionTitle>
        <Card>
          <CapabilityList permissions={app.permissions} />
          <p className="type-meta mt-3 border-t border-[var(--cue-line)] pt-3">
            Your roles and program membership are set by your program&rsquo;s staff, not here — a
            profile change can never grant a role or move you between programs. Ask your director if
            something looks wrong.
          </p>
        </Card>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Security                                                                   */
/* -------------------------------------------------------------------------- */

function SecurityTab() {
  const app = usePrograms();
  const auth = useAuth();
  const { toast } = useToast();

  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmOthers, setConfirmOthers] = useState(false);

  async function changeEmail() {
    const value = newEmail.trim();
    if (!value) {
      setEmailError("Type the new email address.");
      return;
    }
    setSavingEmail(true);
    setEmailError(null);
    const { error } = await auth.updateEmail(value);
    setSavingEmail(false);
    if (error) {
      setEmailError(error);
      return;
    }
    setNewEmail("");
    toast.success("Check both inboxes to confirm the change.");
  }

  async function changePassword() {
    if (!password) {
      setPasswordError("Type your new password.");
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError("Those two passwords don't match.");
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    const { error } = await auth.updatePassword(password);
    if (error) {
      setSavingPassword(false);
      setPasswordError(error);
      return;
    }

    // `must_change_password` is our own flag on `profiles`, not an Auth one:
    // a director who issues a temporary password sets it, and setting your own
    // password clears it.
    if (app.profile?.must_change_password) {
      await updateMyProfile(app.profile.id, { must_change_password: false });
      await app.refresh();
    }

    setSavingPassword(false);
    setPassword("");
    setConfirmPassword("");
    toast.success("Password updated.");
  }

  async function resend() {
    if (!auth.email) return;
    setBusy("resend");
    const { error } = await auth.resendConfirmation(auth.email);
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Confirmation email sent.");
  }

  async function emailReset() {
    if (!auth.email) return;
    setBusy("reset");
    const { error } = await auth.sendPasswordReset(auth.email);
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Reset link sent — it lands on the “set a new password” screen.");
  }

  async function signOutOthers() {
    setBusy("others");
    const { error } = await auth.signOutOthers();
    setBusy(null);
    setConfirmOthers(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Every other session was signed out.");
  }

  return (
    <div className="space-y-7">
      {/* --- email --- */}
      <section>
        <SectionTitle className="mb-3">Email</SectionTitle>
        <Card className="space-y-4">
          <div className="flex items-start gap-3">
            <Mail aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{auth.email ?? "No address on file"}</p>
              <div className="mt-1.5">
                {auth.emailVerified ? (
                  <Badge className="bg-[var(--cue-present-bg)] text-[var(--cue-present)]">
                    <BadgeCheck aria-hidden="true" className="h-3 w-3" /> Verified
                  </Badge>
                ) : (
                  <Badge className="bg-[var(--cue-late-bg)] text-[var(--cue-late)]">
                    <MailWarning aria-hidden="true" className="h-3 w-3" /> Not verified yet
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {!auth.emailVerified ? (
            <Alert tone="warn">
              Confirm this address so you can reset your password if you forget it.
            </Alert>
          ) : null}
          {!auth.emailVerified ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "resend"}
              onClick={() => void resend()}
            >
              Resend confirmation email
            </Button>
          ) : null}

          <div className="space-y-3 border-t border-[var(--cue-line)] pt-4">
            {emailError ? <Alert tone="error">{emailError}</Alert> : null}
            <Field
              label="Change email address"
              hint="We email both the old and new address; the change applies once both are confirmed."
            >
              <Input
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="new.address@example.com"
                autoComplete="email"
              />
            </Field>
            <Button
              size="sm"
              variant="secondary"
              loading={savingEmail}
              onClick={() => void changeEmail()}
            >
              Send confirmation links
            </Button>
          </div>
        </Card>
      </section>

      {/* --- password --- */}
      <section>
        <SectionTitle className="mb-3">Password</SectionTitle>
        <Card className="space-y-4">
          <p className="type-meta">
            This is the password you sign in with. It is held by the sign-in service (Supabase Auth),
            never by this app&rsquo;s database.
          </p>
          {app.profile?.must_change_password ? (
            <Alert tone="info">
              Your director issued you a temporary password. Setting your own clears this note.
            </Alert>
          ) : null}
          {passwordError ? <Alert tone="error">{passwordError}</Alert> : null}
          <Field label="New password">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={savingPassword}
              icon={<KeyRound className="h-4 w-4" />}
              onClick={() => void changePassword()}
            >
              Change password
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "reset"}
              icon={<Wand2 className="h-4 w-4" />}
              onClick={() => void emailReset()}
            >
              Email me a reset link
            </Button>
          </div>
        </Card>
      </section>

      {/* --- sessions --- */}
      <section>
        <SectionTitle className="mb-3">Sessions</SectionTitle>
        <List>
          <Row
            icon={<MonitorSmartphone className="h-4 w-4" />}
            title="Sign out of other devices"
            subtitle="Keeps this device signed in; ends every other session"
            onClick={() => setConfirmOthers(true)}
          />
          <Row
            icon={<LogOut className="h-4 w-4" />}
            title="Sign out"
            subtitle="You'll need your password again on this device"
            onClick={() => setConfirmSignOut(true)}
          />
        </List>
      </section>

      <ConfirmSheet
        open={confirmOthers}
        title="Sign out of other devices?"
        body="Any other phone, tablet or computer signed in as you is signed out. This device stays signed in."
        confirmLabel="Sign out other devices"
        tone="primary"
        loading={busy === "others"}
        onCancel={() => setConfirmOthers(false)}
        onConfirm={() => void signOutOthers()}
      />
      <ConfirmSheet
        open={confirmSignOut}
        title="Sign out?"
        body="You'll need your login again to check in. Nothing on the roster changes."
        confirmLabel="Sign out"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => void auth.signOut()}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

function PreferencesTab() {
  const { dark, toggle } = useDark();
  const { preference, setPreference, reduced } = useReducedMotion();
  const app = usePrograms();
  const { toast } = useToast();
  /** Program id → the value the switch should show while the server catches up. */
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const enabledFor = (membership: EmbeddedMembership) =>
    pending[membership.ensemble_id] ?? membership.email_upcoming_events;

  /**
   * Saved on the spot rather than behind a Save button: the choice *is* the whole
   * interaction. The switch moves first and the server writes only the caller's
   * own membership for the program named here; if it refuses, the switch goes
   * back where it was and says why.
   */
  async function setEmail(membership: EmbeddedMembership, next: boolean) {
    const previous = pending[membership.ensemble_id];
    setPending((current) => ({ ...current, [membership.ensemble_id]: next }));

    const { result, error } = await setEmailUpcomingEvents(membership.ensemble_id, next);

    if (error || !result?.ok) {
      setPending((current) => {
        const reverted = { ...current };
        if (previous === undefined) delete reverted[membership.ensemble_id];
        else reverted[membership.ensemble_id] = previous;
        return reverted;
      });
      toast.error(error?.message ?? result?.message ?? "That could not be saved. Try again.");
      return;
    }

    toast.success(
      next
        ? `You'll get event emails for ${membership.ensemble.name}.`
        : `${membership.ensemble.name} event emails are off.`
    );
  }

  return (
    <div className="space-y-7">
      <section>
        <SectionTitle className="mb-3">Appearance</SectionTitle>
        <List>
          <Row
            icon={dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            title="Dark mode"
            subtitle={dark ? "On — easier at night" : "Off — follows your device"}
            trailing={<Toggle checked={dark} onChange={toggle} label="Dark mode" />}
          />
        </List>
      </section>

      <section>
        <SectionTitle className="mb-3">Motion</SectionTitle>
        <Card className="space-y-3">
          <SegmentedControl
            value={preference}
            onChange={setPreference}
            options={[
              { value: "system", label: "Follow device" },
              { value: "reduced", label: "Reduce motion" },
              { value: "full", label: "Full motion" },
            ]}
          />
          <p className="type-meta">
            {reduced
              ? "Screen transitions and movement are reduced on this device."
              : "Screen transitions play normally. Choose “Reduce motion” to turn them off."}
          </p>
        </Card>
      </section>

      <section>
        <SectionTitle className="mb-3">Upcoming events by email</SectionTitle>
        {app.memberships.length === 0 ? (
          <Card>
            <p className="type-meta">
              Join a program and you can choose whether its upcoming events reach you by email.
            </p>
          </Card>
        ) : (
          <List>
            {app.memberships.map((membership) => {
              const on = enabledFor(membership);
              return (
                <Row
                  key={membership.id}
                  icon={<Mail aria-hidden="true" className="h-4 w-4" />}
                  title={membership.ensemble.name}
                  subtitle={on ? "On — digests, new events and reminders" : "Off — no event emails"}
                  trailing={
                    <Toggle
                      checked={on}
                      onChange={(next) => void setEmail(membership, next)}
                      label={`Upcoming event emails for ${membership.ensemble.name}`}
                    />
                  }
                />
              );
            })}
          </List>
        )}
        <p className="type-meta mt-3">
          One setting covers every event email: the daily digest of the next week across your
          programs (together, so two programs are still one email), a short note when a new event is
          added, and a reminder two days before it starts. A quiet week sends nothing. The bell in
          the header is separate and always on.
        </p>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Privacy & data                                                             */
/* -------------------------------------------------------------------------- */

function PrivacyTab() {
  const app = usePrograms();
  const auth = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setDeleting(true);
    setError(null);
    const { error: failure } = await auth.deleteAccount().catch((thrown: unknown) => ({
      error: thrown instanceof Error ? thrown.message : "Account deletion failed unexpectedly.",
    }));
    setDeleting(false);
    if (failure) {
      setError(failure);
      return;
    }
    setConfirmDelete(false);
    toast.success("Your account has been deleted.");
  }

  return (
    <div className="space-y-7">
      <section>
        <SectionTitle className="mb-3">Your records</SectionTitle>
        <Card className="space-y-3">
          <p className="text-sm text-[var(--cue-muted)]">
            Your name, picture and biography belong to your account and can be changed at any time
            from the Profile tab. Your attendance record is a school record.
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <UserRound
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
              />
              <span>
                <strong className="font-semibold">Deleted when you ask:</strong> your sign-in
                account, and your profile details (name, picture, biography).
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]" />
              <span>
                <strong className="font-semibold">Kept, de-identified:</strong> attendance already
                recorded is retained under &ldquo;Deleted account&rdquo; so the program&rsquo;s
                records stay accurate. No name or picture remains attached.
              </span>
            </li>
          </ul>
          <p className="type-meta">
            Retention follows the school district&rsquo;s records policy. To inspect, correct or
            delete a record before then, contact your school&rsquo;s records office (LWSD Policy
            3231).
          </p>
        </Card>
      </section>

      <section>
        <SectionTitle className="mb-3">Request help</SectionTitle>
        <Card className="space-y-3">
          <p className="text-sm text-[var(--cue-muted)]">
            If something is wrong with your account — a name misspelled, the wrong program, a record
            that should be corrected — ask your director first. They can fix rosters and attendance
            directly.
          </p>
          <Button
            variant="secondary"
            icon={<ShieldCheck className="h-4 w-4" />}
            onClick={() => navigate("/privacy")}
          >
            Read the privacy notice
          </Button>
        </Card>
      </section>

      <section>
        <SectionTitle className="mb-3">Delete your account</SectionTitle>
        <Card className="space-y-3">
          <Alert tone="warn">
            This is permanent. It removes your sign-in account and profile details. Attendance
            history is kept, de-identified, and any program where you are the only director is
            archived rather than deleted.
          </Alert>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button
            variant="danger"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => setConfirmDelete(true)}
          >
            Delete my account
          </Button>
          <p className="type-meta">
            Prefer to keep everything and just be removed from the roster? Ask your director to pause
            your membership instead — your attendance stays attributed to you.
          </p>
        </Card>
      </section>

      <ConfirmSheet
        open={confirmDelete}
        title="Delete your account?"
        body="This permanently deletes your sign-in account, removes you from all program rosters, and erases your profile details. Your past attendance stays in the records under “Deleted account.” Programs where you are the only director will be archived. This cannot be undone."
        confirmLabel="Delete account"
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      />

      <p className="type-meta">
        Signed in to {app.program?.name ?? "this program"} as {auth.email ?? "—"}.
      </p>
    </div>
  );
}
