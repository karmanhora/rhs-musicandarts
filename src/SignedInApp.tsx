import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { AppShell } from "./components/AppShell";
import { Alert, Button } from "./components/ui";
import { LoadingQuote, MusicLoader } from "./components/Splash";
import { LegalScreen } from "./screens/LegalScreen";
import { ProgramsProvider, usePrograms } from "./hooks/usePrograms";
import { PreferencesProvider } from "./hooks/usePreferences";
import { AvatarUrlProvider } from "./hooks/useAvatars";
import type { PermissionCode } from "./lib/permissions";

const JoinProgramScreen = lazy(() =>
  import("./screens/JoinProgramScreen").then((module) => ({ default: module.JoinProgramScreen }))
);
const NewProgramScreen = lazy(() =>
  import("./screens/NewProgramScreen").then((module) => ({ default: module.NewProgramScreen }))
);
const HomeScreen = lazy(() =>
  import("./screens/HomeScreen").then((module) => ({ default: module.HomeScreen }))
);
const CalendarScreen = lazy(() =>
  import("./screens/CalendarScreen").then((module) => ({ default: module.CalendarScreen }))
);
const CheckInScreen = lazy(() =>
  import("./screens/CheckInScreen").then((module) => ({ default: module.CheckInScreen }))
);
const AttendanceScreen = lazy(() =>
  import("./screens/AttendanceScreen").then((module) => ({ default: module.AttendanceScreen }))
);
const RosterScreen = lazy(() =>
  import("./screens/RosterScreen").then((module) => ({ default: module.RosterScreen }))
);
const AnalyticsScreen = lazy(() =>
  import("./screens/AnalyticsScreen").then((module) => ({ default: module.AnalyticsScreen }))
);
const ProfileScreen = lazy(() =>
  import("./screens/ProfileScreen").then((module) => ({ default: module.ProfileScreen }))
);
const AccountSettingsScreen = lazy(() =>
  import("./screens/AccountSettingsScreen").then((module) => ({
    default: module.AccountSettingsScreen,
  }))
);
const RolesScreen = lazy(() =>
  import("./screens/RolesScreen").then((module) => ({ default: module.RolesScreen }))
);
const AbsenceScreen = lazy(() =>
  import("./screens/AbsenceScreen").then((module) => ({ default: module.AbsenceScreen }))
);
const RecordsScreen = lazy(() =>
  import("./screens/RecordsScreen").then((module) => ({ default: module.RecordsScreen }))
);
const TeacherVerifyScreen = lazy(() =>
  import("./screens/TeacherVerifyScreen").then((module) => ({
    default: module.TeacherVerifyScreen,
  }))
);
const SetupScreen = lazy(() =>
  import("./screens/SetupScreen").then((module) => ({ default: module.SetupScreen }))
);

function RouteSkeleton() {
  return (
    /* `h-full` matters: this renders at the root while a route chunk loads, so
     * the loader sat 192px above the middle of a phone screen on `min-h-64`
     * alone. It now centres in the viewport — or, when it renders inside the
     * shell instead, in the content area — and `min-h-64` keeps a floor for very
     * short panes. */
    <main
      aria-busy="true"
      aria-label="Loading screen"
      className="flex h-full min-h-64 flex-col items-center justify-center gap-5 p-6 text-[var(--cue-green)]"
    >
      <MusicLoader />
      {/* A line to read while the chunk arrives. It mounts fresh on every
          navigation, so each wait gets a different quote (src/lib/quotes.ts) —
          picked once per mount, never while somebody is reading it. */}
      <LoadingQuote tone="onPage" className="mt-0 text-center" />
    </main>
  );
}

/** Role gate: bounce a screen the current membership cannot open. */
function RoleGate({
  need,
  children,
}: {
  need: "staff" | "director" | "program-creator";
  children: ReactNode;
}) {
  const app = usePrograms();
  const allowed =
    need === "program-creator"
      ? app.canCreateProgram
      : need === "director"
        ? app.isDirector
        : app.isStaff;
  return allowed ? <>{children}</> : <Navigate to="/" replace />;
}

/**
 * Capability gate. `RoleGate` asks about a fixed role; this asks the server's
 * own question — the same codes `has_permission()` enforces — so a screen behind
 * it can never be opened by somebody whose capabilities do not cover it.
 */
function PermissionGate({
  permission,
  children,
}: {
  permission: PermissionCode;
  children: ReactNode;
}) {
  const app = usePrograms();
  return app.can(permission) ? <>{children}</> : <Navigate to="/" replace />;
}

/**
 * "Any one of these" capability gate. A screen with two audiences — a student
 * asking for an absence, a reviewer answering one — must open for either, while
 * the screen itself still decides which half to render.
 */
function AnyPermissionGate({
  anyOf,
  children,
}: {
  anyOf: PermissionCode[];
  children: ReactNode;
}) {
  const app = usePrograms();
  return anyOf.some((permission) => app.can(permission)) ? (
    <>{children}</>
  ) : (
    <Navigate to="/" replace />
  );
}

/** Everything that requires a resolved program membership. */
function ProgramRoutes() {
  const app = usePrograms();

  if (app.status === "loading") return <RouteSkeleton />;

  if (app.status === "error") {
    return (
      <div className="safe-t flex min-h-full items-center justify-center p-6">
        <div className="w-full max-w-md space-y-3">
          <Alert tone="error">{app.error ?? "Could not load your programs."}</Alert>
          <Button
            block
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void app.refresh()}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // Signed in, but on no roster yet. Two ways in, so both keep their own URL:
  // join somebody's program with a code, or start your own. (Returning the join
  // screen directly — as this used to — would swallow the `/new-program` link a
  // teacher was just sent to.)
  if (app.status === "no-roster") {
    return (
      <Routes>
        <Route
          path="/new-program"
          element={
            <RoleGate need="program-creator">
              <NewProgramScreen standalone />
            </RoleGate>
          }
        />
        {/* Teacher registration, reachable with no roster at all: it is the one
            thing an invited teacher can do before they belong anywhere. */}
        <Route path="/teacher" element={<TeacherVerifyScreen standalone />} />
        <Route path="*" element={<JoinProgramScreen standalone />} />
        <Route path="/privacy" element={<LegalScreen page="privacy" />} />
        <Route path="/terms" element={<LegalScreen page="terms" />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Legal pages render standalone (no app chrome) but stay reachable from
          the Profile screen once you are signed in. */}
      <Route path="/privacy" element={<LegalScreen page="privacy" />} />
      <Route path="/terms" element={<LegalScreen page="terms" />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/calendar" element={<CalendarScreen />} />
        <Route path="/checkin" element={<CheckInScreen />} />
        <Route path="/me" element={<ProfileScreen />} />
        <Route path="/join" element={<JoinProgramScreen />} />
        <Route path="/teacher" element={<TeacherVerifyScreen />} />
        <Route
          path="/new-program"
          element={
            <RoleGate need="program-creator">
              <NewProgramScreen />
            </RoleGate>
          }
        />
        <Route
          path="/attendance"
          element={
            <RoleGate need="staff">
              <AttendanceScreen />
            </RoleGate>
          }
        />
        <Route
          path="/roster"
          element={
            <RoleGate need="staff">
              <RosterScreen />
            </RoleGate>
          }
        />
        <Route
          path="/analytics"
          element={
            <PermissionGate permission="attendance.view_analytics">
              <AnalyticsScreen />
            </PermissionGate>
          }
        />
        <Route
          path="/absences"
          element={
            <AnyPermissionGate anyOf={["absence.request_self", "absence.review"]}>
              <AbsenceScreen />
            </AnyPermissionGate>
          }
        />
        <Route
          path="/records"
          element={
            <AnyPermissionGate
              anyOf={[
                "attendance.view_program",
                "attendance.view_section",
                "attendance.export_reports",
              ]}
            >
              <RecordsScreen />
            </AnyPermissionGate>
          }
        />
        <Route path="/settings" element={<AccountSettingsScreen />} />
        {/* The guided setup. Gated on the capability that actually manages this
            program, so a student or a section leader never reaches it even by
            typing the URL. It is skippable and never blocks the app. */}
        <Route
          path="/setup"
          element={
            <PermissionGate permission="program.manage_settings">
              <SetupScreen />
            </PermissionGate>
          }
        />
        <Route
          path="/roles"
          element={
            <PermissionGate permission="roles.view">
              <RolesScreen />
            </PermissionGate>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/**
 * The app behind the sign-in. There is no bridge component any more: the Supabase
 * client holds its own session, so the moment `useAuth` says "signed in" the same
 * client is already authenticating every query below it.
 */
export default function SignedInApp() {
  return (
    <ProgramsProvider>
      {/* Personal appearance and dashboard choices. Above the avatar provider
          because the shell paints from them and every screen may ask. */}
      <PreferencesProvider>
        {/* Private avatar paths are resolved to signed URLs once per screen, so
            the provider wraps everything that can render an `Avatar`. */}
        <AvatarUrlProvider>
          <Suspense fallback={<RouteSkeleton />}>
            <ProgramRoutes />
          </Suspense>
        </AvatarUrlProvider>
      </PreferencesProvider>
    </ProgramsProvider>
  );
}
