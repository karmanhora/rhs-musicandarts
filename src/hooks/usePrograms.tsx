import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "./useAuth";
import { applyThemeTokens } from "../lib/theme";
import {
  fetchActivePrograms,
  fetchMyMemberships,
  fetchProfileByAuthId,
  fetchSections,
  fetchThemeTokens,
} from "../lib/queries";
import { getIsProgramAdmin, getMyPermissions, getTeacherAccessStatus } from "../lib/rpc";
import { ALL_PERMISSION_CODES, permissionsForRoles } from "../lib/permissions";
import type { PermissionCode } from "../lib/permissions";
import type { EmbeddedMembership } from "../lib/queries";
import type { EnsembleRow, Profile, Role, SectionRow } from "../lib/types";

/**
 * Who am I, which programs am I in, and which one am I looking at?
 *
 * The site is the Music and Arts Program; each tracker inside it is a *program*
 * (the database's word for that row is `ensemble` — it never reaches a user).
 * Roles, sections and colours belong to a program, not to a person, so every
 * flag below describes the **current** program: a student who directs one
 * program and plays in another sees each one with its own rights.
 *
 * The chosen program is remembered per person, so opening the app tomorrow shows
 * the one they last used.
 *
 * A **system administrator** (`program_admins`, migrations 009/013) is the one
 * exception to "roles belong to a membership". The server gives that account
 * every capability in every program — `has_permission()` answers `true` before
 * it looks at a roster — so this provider lets it open a program it is not on,
 * with `membership = null`. Nothing here grants anything: `my_permissions()`
 * and the policies behind it remain the boundary, and a non-administrator gets
 * only the programs their own rosters contain.
 */

/**
 * One row in the program switcher.
 *
 * `isMember` is false only for a program a system administrator is not on: there
 * is no `memberships` row to read a role or a section from, and the subtitle
 * says so rather than inventing "Student".
 */
export interface SwitchableProgram {
  /** The membership id, or the program id when there is no roster row. */
  id: string;
  ensemble: EnsembleRow;
  roles: Role[];
  section: string | null;
  isMember: boolean;
}

export type ProgramsStatus = "loading" | "ready" | "no-roster" | "error";

export interface ProgramsState {
  status: ProgramsStatus;
  error: string | null;
  /** The signed-in person's row in `profiles`. */
  profile: Profile | null;
  /** Every program this person is active in — the roster half of the switcher. */
  memberships: EmbeddedMembership[];
  /** The one currently on screen. Null only for an administrator off-roster. */
  membership: EmbeddedMembership | null;
  /** The current tracker's own row. */
  program: EnsembleRow | null;
  sections: SectionRow[];
  roles: Role[];
  isDirector: boolean;
  isSecretary: boolean;
  isSectionLeader: boolean;
  /** Director, secretary or section leader *in the current program*. */
  isStaff: boolean;
  /** Staff somewhere, even if not here. */
  isStaffAnywhere: boolean;
  /** A teacher account or an existing director may start another program. */
  canCreateProgram: boolean;
  /**
   * Director of a program somewhere. Reported by the server's roster, and the
   * one legacy allowance `create_program()` still makes for an account that was
   * never issued an invitation (migration 023, kept by 035). A system
   * administrator counts too: `create_program()`'s gate is a capability check,
   * and they hold every capability.
   */
  isDirectorAnywhere: boolean;
  /**
   * Holds a *redeemed* teacher invitation (migration 035) — the credential
   * `create_program()` now asks for. This is the server's answer, not a local
   * flag: it is false until `teacher_access_status()` says otherwise.
   */
  verifiedTeacher: boolean;
  /**
   * Whether the server will actually let this account start a program: a
   * verified teacher, or an existing director. `NewProgramScreen` reads this to
   * choose between the form and the invitation-code form, so it mirrors
   * `create_program()`'s gate rather than approximating it.
   */
  mayStartProgram: boolean;
  /**
   * Re-read just the teacher credential, after a code is redeemed. Light on
   * purpose — unlike `refresh()` it does not tear the session down to a splash.
   */
  refreshTeacherAccess: () => Promise<boolean>;
  /** Highest role held in the current program, for the chip beside the name. */
  primaryRole: Role;
  /**
   * The signed-in person's effective capabilities in the current program
   * (migration 029). Stored as plain codes so a screen can ask `can("…")`
   * without knowing about roles at all. This is a *rendering* input — the
   * database re-checks every read and write with `has_permission()`.
   */
  permissions: PermissionCode[];
  /** True when the current member's capabilities include `code`. */
  can: (code: PermissionCode) => boolean;
  /**
   * A system administrator: every capability in every program, present and
   * future (`program_admins`). Used for copy and for the switcher's reach, never
   * as an authority — the server does not consult a client flag.
   */
  isSystemAdmin: boolean;
  /**
   * Every program this person can open: their own rosters, plus — for a system
   * administrator — the programs they are not on. The switcher and the "several
   * programs" test read this, not `memberships`.
   */
  programs: SwitchableProgram[];
  /**
   * Re-read just the current program's sections. Used after a director adds,
   * renames or removes one, so the roster updates in place instead of the whole
   * session falling back to a splash via `refresh()`.
   */
  reloadSections: () => Promise<void>;
  setProgram: (ensembleId: string) => void;
  /**
   * Re-read the session. Pass a program id to land in *that* one instead of the
   * remembered choice — what the join and start-a-program screens use, so the
   * program somebody just added is the one on screen.
   */
  refresh: (preferEnsembleId?: string) => Promise<void>;
}

const EMPTY: Omit<
  ProgramsState,
  | "refresh"
  | "setProgram"
  | "can"
  | "reloadSections"
  | "refreshTeacherAccess"
  | "status"
  | "error"
> = {
  profile: null,
  memberships: [],
  membership: null,
  program: null,
  sections: [],
  roles: [],
  isDirector: false,
  isSecretary: false,
  isSectionLeader: false,
  isStaff: false,
  isStaffAnywhere: false,
  canCreateProgram: false,
  isDirectorAnywhere: false,
  verifiedTeacher: false,
  mayStartProgram: false,
  primaryRole: "student",
  permissions: [],
  isSystemAdmin: false,
  programs: [],
};

/** Remembered per person, so a switch survives a reload. */
const STORAGE_PREFIX = "rhs:current-program:";

function readRemembered(profileId: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + profileId);
  } catch {
    return null;
  }
}

function remember(profileId: string, ensembleId: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + profileId, ensembleId);
  } catch {
    /* private mode — the choice just doesn't survive a reload */
  }
}

const ProgramsContext = createContext<ProgramsState | null>(null);

function primaryRoleOf(roles: Role[]): Role {
  if (roles.includes("director")) return "director";
  if (roles.includes("secretary")) return "secretary";
  if (roles.includes("section_leader")) return "section_leader";
  return "student";
}

function isStaffRole(roles: Role[]): boolean {
  return (
    roles.includes("director") || roles.includes("secretary") || roles.includes("section_leader")
  );
}

/**
 * The switcher's rows: this person's rosters first, then any program only a
 * system administrator can reach. A program they *are* on keeps its real roles
 * and section, so the administrator view never hides a directorship.
 */
function switchablePrograms(
  memberships: EmbeddedMembership[],
  everyProgram: EnsembleRow[]
): SwitchableProgram[] {
  const seen = new Set<string>();
  const out: SwitchableProgram[] = [];
  for (const m of memberships) {
    seen.add(m.ensemble.id);
    out.push({
      id: m.id,
      ensemble: m.ensemble,
      roles: m.roles ?? [],
      section: m.section?.name ?? null,
      isMember: true,
    });
  }
  for (const program of everyProgram) {
    if (seen.has(program.id)) continue;
    out.push({ id: program.id, ensemble: program, roles: [], section: null, isMember: false });
  }
  return out;
}

export function ProgramsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [state, setState] = useState<
    Omit<ProgramsState, "refresh" | "setProgram" | "can" | "reloadSections" | "refreshTeacherAccess">
  >({
    ...EMPTY,
    status: "loading",
    error: null,
  });

  const authUserId = auth.userId;
  const accountType = auth.accountType;
  const signedIn = auth.status === "signed-in";

  /** Load one program's sections and colours, then make it the current one. */
  const loadProgram = useCallback(
    async (
      profile: Profile,
      memberships: EmbeddedMembership[],
      everyProgram: EnsembleRow[],
      isSystemAdmin: boolean,
      wanted: string | null,
      verifiedTeacher: boolean
    ) => {
      const membership =
        memberships.find((m) => m.ensemble.id === wanted) ?? memberships[0] ?? null;
      // An administrator may open a program they are not on; anybody else only
      // ever sees the programs their own roster rows point at.
      const program =
        membership?.ensemble ??
        (isSystemAdmin
          ? (everyProgram.find((p) => p.id === wanted) ?? everyProgram[0] ?? null)
          : null);

      if (!program) {
        // Signed in, but on no roster at all: they need a join code.
        setState({
          ...EMPTY,
          profile,
          canCreateProgram: accountType === "teacher" || verifiedTeacher,
          verifiedTeacher,
          // No roster, so no directorship anywhere — a verified teacher is the
          // only thing that can open the start-a-program door here.
          mayStartProgram: verifiedTeacher,
          isSystemAdmin,
          programs: switchablePrograms(memberships, everyProgram),
          status: "no-roster",
          error: null,
        });
        return;
      }

      const [sections, tokens] = await Promise.all([
        fetchSections(program.id),
        fetchThemeTokens(program.id),
      ]);
      applyThemeTokens(tokens);

      // Remember whichever program we settled on, whatever brought us here, so a
      // reload shows the same one (setProgram used to be the only path that did).
      remember(profile.id, program.id);

      const roles = membership?.roles ?? [];
      // Directorship anywhere, from the roster itself — the one allowance the
      // server still makes for an account with no invitation (035 keeps 023's).
      const isDirectorAnywhere =
        isSystemAdmin ||
        memberships.some((m) => m.active && (m.roles ?? []).includes("director"));
      setState({
        status: "ready",
        error: null,
        profile,
        memberships,
        membership,
        program,
        sections,
        roles,
        isDirector: isSystemAdmin || roles.includes("director"),
        isSecretary: roles.includes("secretary"),
        isSectionLeader: roles.includes("section_leader"),
        isStaff: isSystemAdmin || isStaffRole(roles),
        isStaffAnywhere: isSystemAdmin || memberships.some((m) => isStaffRole(m.roles ?? [])),
        canCreateProgram: accountType === "teacher" || isDirectorAnywhere || verifiedTeacher,
        isDirectorAnywhere,
        verifiedTeacher,
        // The client-side mirror of `create_program()`'s gate — not a boundary,
        // just what decides whether we show the form or ask for the code.
        mayStartProgram: isSystemAdmin || verifiedTeacher || isDirectorAnywhere,
        primaryRole: primaryRoleOf(roles),
        // Painted from the roles we already hold, so the right controls exist on
        // the first frame; replaced below by the server's authoritative list.
        // An administrator short-circuits to the whole catalogue because that is
        // what `has_permission()` actually answers for them — otherwise the
        // route gates would bounce them home before `my_permissions()` replied.
        permissions: isSystemAdmin ? ALL_PERMISSION_CODES : permissionsForRoles(roles),
        isSystemAdmin,
        programs: switchablePrograms(memberships, everyProgram),
      });

      // The authoritative capabilities. A failure here leaves the role-derived
      // set in place — the UI stays usable and the server still decides.
      const permissionResponse = await getMyPermissions(program.id);
      if (permissionResponse.result?.ok && Array.isArray(permissionResponse.result.permissions)) {
        const serverPermissions = permissionResponse.result.permissions as PermissionCode[];
        setState((prev) =>
          prev.program?.id === program.id
            ? { ...prev, permissions: serverPermissions }
            : prev
        );
      }
    },
    [accountType]
  );

  const refresh = useCallback(async (preferEnsembleId?: string) => {
    // The session is still being restored: stay on the splash rather than
    // deciding "no roster" from an answer we don't have yet.
    if (auth.status === "loading" || auth.accountTypeLoading) return;
    if (!signedIn || !authUserId) {
      setState({ ...EMPTY, status: "loading", error: null });
      return;
    }

    setState((prev) => ({ ...prev, status: "loading", error: null }));

    try {
      // The credential is per-account, so it is read beside the profile rather
      // than per program. A failure reads as "not verified" (fail closed) and
      // leaves the server to refuse anything that needs it.
      const [profile, teacher] = await Promise.all([
        fetchProfileByAuthId(authUserId),
        getTeacherAccessStatus(),
      ]);
      const verifiedTeacher = teacher.verified;

      if (!profile) {
        // Signed in, but never joined a program → no profile row yet.
        setState({
          ...EMPTY,
          canCreateProgram: accountType === "teacher" || verifiedTeacher,
          verifiedTeacher,
          mayStartProgram: verifiedTeacher,
          status: "no-roster",
          error: null,
        });
        return;
      }

      // The roster and the administrator answer are independent reads, so ask
      // for both at once; the program list is only fetched for an administrator
      // (RLS would answer with their own programs anyway).
      const [memberships, isSystemAdmin] = await Promise.all([
        fetchMyMemberships(profile.id),
        getIsProgramAdmin(),
      ]);
      const activeMemberships = memberships.filter((m) => m.active);
      const everyProgram = isSystemAdmin ? await fetchActivePrograms() : [];

      await loadProgram(
        profile,
        activeMemberships,
        everyProgram,
        isSystemAdmin,
        preferEnsembleId ?? readRemembered(profile.id),
        verifiedTeacher
      );
    } catch (e) {
      setState({
        ...EMPTY,
        status: "error",
        error: e instanceof Error ? e.message : "Could not load your programs.",
      });
    }
  }, [
    auth.status,
    auth.accountTypeLoading,
    signedIn,
    authUserId,
    accountType,
    loadProgram,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Move to another program this person can open: one of their rosters, or — for
   * a system administrator — any program at all. Whatever is on screen stays put
   * while the next one loads, so switching never flashes a splash screen.
   */
  const setProgram = useCallback(
    (ensembleId: string) => {
      const { profile, memberships, program, isSystemAdmin, programs, verifiedTeacher } = state;
      if (!profile || ensembleId === program?.id) return;
      remember(profile.id, ensembleId);
      void loadProgram(
        profile,
        memberships,
        programs.map((entry) => entry.ensemble),
        isSystemAdmin,
        ensembleId,
        verifiedTeacher
      ).catch((e: unknown) => {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: e instanceof Error ? e.message : "Could not switch programs.",
        }));
      });
    },
    [state, loadProgram]
  );

  /**
   * Re-read the teacher credential on its own, after a code was redeemed. It
   * deliberately does not run the whole `refresh()`: redeeming happens from a
   * screen somebody is looking at, and `refresh()` replaces it with a splash.
   * Returns the new answer so the caller can confirm before it moves on.
   */
  const refreshTeacherAccess = useCallback(async () => {
    const status = await getTeacherAccessStatus();
    setState((prev) => ({
      ...prev,
      verifiedTeacher: status.verified,
      // Verifying opens the start-a-program door, so the coarse entry gate has
      // to move with it — otherwise `/new-program` would still bounce somebody
      // back to the join screen until a full reload.
      canCreateProgram: prev.canCreateProgram || status.verified,
      mayStartProgram: status.verified || prev.isDirectorAnywhere,
    }));
    return status.verified;
  }, []);

  const can = useCallback(
    (code: PermissionCode) => state.permissions.includes(code),
    [state.permissions]
  );

  /** Reload only the sections of the program on screen (no splash). */
  const reloadSections = useCallback(async () => {
    const program = state.program;
    if (!program) return;
    try {
      const sections = await fetchSections(program.id);
      setState((prev) => (prev.program?.id === program.id ? { ...prev, sections } : prev));
    } catch {
      /* leave what is on screen; the server remains the source of truth */
    }
  }, [state.program]);

  const value = useMemo<ProgramsState>(
    () => ({ ...state, can, reloadSections, setProgram, refresh, refreshTeacherAccess }),
    [state, can, reloadSections, setProgram, refresh, refreshTeacherAccess]
  );

  return <ProgramsContext.Provider value={value}>{children}</ProgramsContext.Provider>;
}

/**
 * The signed-in session. Only valid inside `<ProgramsProvider>` — screens render
 * below it, and it throws early if that ever stops being true.
 */
export function usePrograms(): ProgramsState {
  const ctx = useContext(ProgramsContext);
  if (!ctx) throw new Error("usePrograms must be used inside <ProgramsProvider>");
  return ctx;
}
