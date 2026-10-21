import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bell,
  CalendarDays,
  ChevronRight,
  ChevronsUpDown,
  ClipboardCheck,
  Home,
  KeyRound,
  LogOut,
  Moon,
  QrCode,
  Settings,
  Sun,
  User,
  UserCog,
  Users,
} from "lucide-react";
import { fetchUnreadNotificationCount } from "../lib/queries";
import { APP_NAME, ORG_NAME, ROLE_LABEL } from "../lib/constants";
import { usePrograms } from "../hooks/usePrograms";
import { useAuth } from "../hooks/useAuth";
import { useDark } from "../hooks/useDark";
import { ProgramSwitcher } from "./ProgramSwitcher";
import { NotificationCenter } from "./NotificationCenter";
import {
  Alert,
  Avatar,
  Button,
  IconButton,
  List,
  Row,
  Sheet,
  cn,
} from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Home;
  need?: "staff" | "director";
}

/**
 * The bottom bar. 44px+ targets, at most five items; "Me" lives on the avatar
 * for directors so Analytics fits without a sixth tab.
 */
function navItems(opts: { isStaff: boolean; isDirector: boolean }): NavItem[] {
  const base: NavItem[] = [
    { to: "/", label: "Home", icon: Home },
    { to: "/calendar", label: "Calendar", icon: CalendarDays },
  ];
  if (opts.isStaff) {
    base.push({ to: "/attendance", label: "Attendance", icon: ClipboardCheck });
    base.push({ to: "/roster", label: "Roster", icon: Users });
    base.push(
      opts.isDirector
        ? { to: "/analytics", label: "Analytics", icon: BarChart3, need: "director" }
        : { to: "/me", label: "Me", icon: User }
    );
    return base;
  }
  base.push({ to: "/checkin", label: "Check in", icon: QrCode });
  base.push({ to: "/me", label: "Me", icon: User });
  return base;
}

export function AppShell() {
  const app = usePrograms();
  const auth = useAuth();
  const { dark, toggle } = useDark();
  const navigate = useNavigate();
  const [bellOpen, setBellOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [unread, setUnread] = useState(0);

  /**
   * The badge count. Realtime would be nicer, but this app already survives on
   * a request-per-page model and there is no realtime channel to reuse — so a
   * cheap `head` count on mount, on focus, when the program changes and once a
   * minute keeps it honest without a new dependency.
   */
  const refreshUnread = useCallback(() => {
    void fetchUnreadNotificationCount()
      .then(setUnread)
      .catch(() => {
        /* leave the last known count; the sheet still works */
      });
  }, []);

  useEffect(() => {
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 60_000);
    window.addEventListener("focus", refreshUnread);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshUnread);
    };
  }, [refreshUnread, app.program?.id]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const items = navItems({ isStaff: app.isStaff, isDirector: app.isDirector });
  const name = app.profile?.display_name || app.profile?.full_name || "Member";
  const programName = app.program?.name ?? APP_NAME;
  const inSeveral = app.memberships.length > 1;
  const under = [ROLE_LABEL[app.primaryRole], app.membership?.section?.name]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="app-shell flex h-full flex-col bg-[var(--cue-page)]">
      {/* --- masthead: the umbrella, then the program you are actually in --- */}
      <header className="safe-t sticky top-0 z-30 shrink-0 border-b border-[var(--cue-line)] bg-[var(--cue-page)]">
        {/* `safe-t` owns the top padding, so this sets the other three edges. */}
        <div className="mx-auto flex min-h-14 max-w-6xl items-center gap-2 px-3 pb-2 sm:px-5">
          <div className="min-w-0 flex-1">
            {inSeveral ? (
              /* The switcher is the whole brand block, wordmark and all, rather
                 than the program name alone. That is what keeps the target 44px
                 tall on a phone without making the masthead taller: the block is
                 two lines it already had, and `min-h-11` only fills out the box
                 the row (`min-h-14`) was already spending on it. One line of
                 text as the target measured 32px — CSS `min-h-8` — which is
                 under the floor every other control in the app clears. */
              <button
                type="button"
                onClick={() => setSwitcherOpen(true)}
                aria-label={`Switch program — currently ${programName}`}
                className="motion-press -ml-1.5 flex min-h-11 max-w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-[var(--radius-control)] px-1.5 py-1 text-left hover:bg-[var(--cue-raised)]"
              >
                <span className="type-wordmark max-w-full truncate text-[0.6875rem] leading-tight text-[var(--cue-subtle)]">
                  {ORG_NAME}
                </span>
                <span className="flex max-w-full min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[0.9375rem] leading-tight font-semibold">
                    {programName}
                  </span>
                  <span className="type-meta hidden truncate sm:inline">{under}</span>
                  <ChevronsUpDown
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 self-center text-[var(--cue-subtle)]"
                  />
                </span>
              </button>
            ) : (
              <>
                <p className="type-wordmark truncate text-[0.6875rem] leading-tight text-[var(--cue-subtle)]">
                  {ORG_NAME}
                </p>
                <p className="flex items-baseline gap-1.5 truncate leading-tight">
                  <span className="truncate text-[0.9375rem] font-semibold">{programName}</span>
                  <span className="type-meta truncate">{under}</span>
                </p>
              </>
            )}
          </div>

          {/* Desktop: the same underline tabs the rest of the app uses. */}
          <nav aria-label="Main navigation" className="hidden items-stretch self-stretch lg:flex">
            {items.map((item) => (
              <NavLink
                key={item.to}
                viewTransition
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "motion-press relative inline-flex min-h-14 items-center gap-2 px-3 text-[0.8125rem] font-semibold tracking-[0.06em] uppercase",
                    isActive
                      ? "text-[var(--cue-ink)]"
                      : "text-[var(--cue-muted)] hover:text-[var(--cue-ink)]"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon aria-hidden="true" className="h-4 w-4" />
                    {item.label}
                    <span
                      aria-hidden="true"
                      className={cn("cue-tab-rule", isActive && "cue-tab-rule--on")}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <span aria-hidden="true" className="hidden h-6 w-px bg-[var(--cue-line)] lg:block" />

          <span className="relative inline-flex shrink-0">
            <IconButton
              label={unread > 0 ? `Notifications — ${unread} unread` : "Notifications"}
              onClick={() => setBellOpen(true)}
              variant="ghost"
              /* 44px, not 36: the same floor the avatar beside it documents. */
              className="h-11 w-11"
              icon={<Bell className="h-5 w-5" />}
            />
            {unread > 0 ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--cue-gold)] px-1 text-[10px] font-bold text-[var(--cue-forest)] tabular"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </span>
          <IconButton
            label={dark ? "Use light mode" : "Use dark mode"}
            onClick={toggle}
            variant="ghost"
            className="h-11 w-11"
            icon={dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          />
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            aria-label={`Your account — ${name}`}
            aria-haspopup="dialog"
            /* The avatar is 32px; the target is 44px. A picture is not a tap
               target, and the masthead row is already 56px tall. */
            className="motion-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cue-focus)]"
          >
            <Avatar
              name={name}
              path={app.profile?.avatar_path}
              url={app.profile?.avatar_url}
              size={32}
            />
          </button>
        </div>
      </header>

      {!online ? (
        <div className="mx-auto w-full max-w-6xl px-3 pt-3 sm:px-5">
          <Alert tone="warn">
            You&rsquo;re offline. Anything you see may be out of date — check-in needs a
            connection.
          </Alert>
        </div>
      ) : null}

      {auth.accountTypeSetupError ? (
        <div className="mx-auto w-full max-w-6xl px-3 pt-3 sm:px-5">
          <Alert tone="error">
            We couldn&rsquo;t save your student or teacher account choice. Sign out and try again.{" "}
            {auth.accountTypeSetupError}
          </Alert>
        </div>
      ) : null}

      {app.profile?.must_change_password ? (
        <div className="mx-auto w-full max-w-6xl px-3 pt-3 sm:px-5">
          <Alert tone="info">
            Your director issued you a temporary password.{" "}
            <button className="font-semibold underline" onClick={() => navigate("/me")}>
              Set your own
            </button>
            .
          </Alert>
        </div>
      ) : null}

      {/* --- content --- */}
      <main className="app-content min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Outlet />
      </main>

      {/* --- bottom nav: the same five destinations, a rule above the one you're on --- */}
      <nav
        aria-label="Main navigation"
        className="safe-b z-30 shrink-0 border-t border-[var(--cue-line)] bg-[var(--cue-page)] lg:hidden"
      >
        <ul className="flex items-stretch">
          {items.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                viewTransition
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "motion-press relative mx-auto flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 pt-1.5 text-[10px] font-semibold tracking-wide uppercase",
                    isActive ? "text-[var(--cue-ink)]" : "text-[var(--cue-muted)]"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={cn("h-5 w-5", isActive && "stroke-[2.25]")} />
                    <span>{item.label}</span>
                    {isActive ? <span aria-hidden="true" className="cue-tab-indicator" /> : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <NotificationCenter
        open={bellOpen}
        onClose={() => setBellOpen(false)}
        unreadCount={unread}
        onChanged={refreshUnread}
      />
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} />
      <ProgramSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  );
}

/**
 * The avatar menu: the one place every account-ish destination is reachable,
 * including from a phone where the bottom bar has no room for a sixth tab.
 * Role management only appears when the server says the person may see roles.
 */
function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = usePrograms();
  const auth = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const name = app.profile?.display_name || app.profile?.full_name || "Member";

  function go(to: string) {
    onClose();
    navigate(to);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Your account" size="tall">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Avatar name={name} path={app.profile?.avatar_path} url={app.profile?.avatar_url} size={48} />
          <div className="min-w-0">
            <p className="type-heading truncate">{name}</p>
            <p className="type-meta truncate">
              {ROLE_LABEL[app.primaryRole]}
              {app.program?.name ? ` · ${app.program.name}` : ""}
            </p>
          </div>
        </div>

        <List>
          <Row
            icon={<User className="h-4 w-4" />}
            title="Profile"
            subtitle="Your picture, name, roles and attendance"
            trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
            onClick={() => go("/me")}
          />
          <Row
            icon={<Settings className="h-4 w-4" />}
            title="Account settings"
            subtitle="Password, email, appearance, privacy"
            trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
            onClick={() => go("/settings")}
          />
          {app.can("absence.request_self") || app.can("absence.review") ? (
            <Row
              icon={<CalendarDays className="h-4 w-4" />}
              title="Absences"
              subtitle={
                app.can("absence.review")
                  ? "Review requests and ask for your own"
                  : "Ask to miss an event and follow the answer"
              }
              trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
              onClick={() => go("/absences")}
            />
          ) : null}
          {app.can("attendance.view_program") ||
          app.can("attendance.view_section") ||
          app.can("attendance.export_reports") ? (
            <Row
              icon={<BarChart3 className="h-4 w-4" />}
              title="Reports & history"
              subtitle={
                app.can("attendance.export_reports")
                  ? "Download a report, or read every attendance change"
                  : "Read the attendance change history"
              }
              trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
              onClick={() => go("/records")}
            />
          ) : null}
          {/* The way back to the invitation form for a teacher who signed in
              before they had their code. Students never see it: the invitation
              code is a teacher credential, not something a student can use. */}
          {auth.accountType === "teacher" && !app.mayStartProgram ? (
            <Row
              icon={<KeyRound className="h-4 w-4" />}
              title="Teacher access"
              subtitle="Enter your invitation code to start a program"
              trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
              onClick={() => go("/teacher")}
            />
          ) : null}
          {app.can("roles.view") ? (
            <Row
              icon={<UserCog className="h-4 w-4" />}
              title="Roles & permissions"
              subtitle={`Who can do what in ${app.program?.name ?? "this program"}`}
              trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
              onClick={() => go("/roles")}
            />
          ) : null}
          {app.memberships.length > 1 ? (
            <Row
              icon={<ChevronsUpDown className="h-4 w-4" />}
              title="Switch program"
              subtitle={`${app.memberships.length} programs`}
              trailing={<ChevronRight aria-hidden="true" className="h-4 w-4 text-[var(--cue-subtle)]" />}
              onClick={() => {
                onClose();
                navigate("/");
              }}
            />
          ) : null}
        </List>

        <Button
          block
          variant="secondary"
          loading={signingOut}
          icon={<LogOut className="h-4 w-4" />}
          onClick={() => {
            setSigningOut(true);
            void auth.signOut().finally(() => setSigningOut(false));
          }}
        >
          Sign out
        </Button>
      </div>
    </Sheet>
  );
}
