import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Ticket, Trash2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  Field,
  Input,
  List,
  PageHeader,
  Row,
  Select,
  Sheet,
  Skeleton,
  cn,
  useToast,
} from "../components/ui";
import { usePrograms } from "../hooks/usePrograms";
import {
  configureTeacherInvitation,
  listProgramRoles,
  listTeacherInvitations,
  revokeTeacherInvitation,
} from "../lib/rpc";
import { fmtDate } from "../lib/date";
import type { InvitationRow, RoleDefinition } from "../lib/types";

/**
 * `/invitations` — the system administrator's staff-invitation desk.
 *
 * A system administrator (a `program_admins` row, not a program director) hands
 * out one-time codes. A code can be a plain teacher credential — the account can
 * start its own program — or a *staff* invitation that also names a program and
 * a role, so redeeming it both verifies the person and puts them on that roster.
 *
 * Two facts shape the whole screen:
 *
 *   * **The code exists once.** The database stores only its SHA-256 digest, so
 *     this screen shows the plaintext exactly once, in the sheet that appears
 *     after it is issued, and can never read it back. That is why the list shows
 *     who a code is for rather than the code itself.
 *   * **A used code is spent.** `redeemed_at is null` is part of the one atomic
 *     UPDATE that consumes it, so nothing here can "un-use" one. Used codes move
 *     to their own list with the name and address of whoever redeemed them —
 *     which is the audit trail, not a second chance.
 *
 * The server owns every decision: `configure_teacher_invitation()`,
 * `list_teacher_invitations()` and `revoke_teacher_invitation()` all refuse a
 * caller who is not a system administrator, whatever this screen renders.
 */

/** Unambiguous characters: no O/0, I/1, or S/5 to misread off a card. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Four and four from a CSPRNG, e.g. `RHS-K7QF-M2XR`. Normalised: 11 characters. */
function generateInvitationCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `RHS-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** What a row grants, in one line: a roster place, or the credential alone. */
function grantsLabel(row: InvitationRow): string {
  if (!row.program_name) return "Teacher access only";
  return `${row.program_name} · ${row.role_name ?? "Member"}`;
}

export function InvitationsScreen() {
  const app = usePrograms();
  const { toast } = useToast();

  const [rows, setRows] = useState<InvitationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<InvitationRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  async function load() {
    setLoading(true);
    const { result, error: rpcError } = await listTeacherInvitations();
    setLoading(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    if (!result?.ok) {
      setError(result?.message ?? "Could not read the invitation list.");
      return;
    }
    setError(null);
    setRows(result.invitations ?? []);
  }

  useEffect(() => {
    void load();
    // Every program an administrator can reach, and the list, are independent of
    // the current program — this screen is cross-program by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => {
    const all = rows ?? [];
    return {
      available: all.filter((row) => row.status === "available"),
      used: all.filter((row) => row.status === "redeemed"),
      ended: all.filter((row) => row.status === "expired" || row.status === "revoked"),
    };
  }, [rows]);

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    const { result, error: rpcError } = await revokeTeacherInvitation(revoking.id);
    setRevokeBusy(false);

    if (rpcError || !result?.ok) {
      toast.error(rpcError?.message || result?.message || "Could not cancel that invitation.");
      return;
    }
    toast.success(result.message ?? "Invitation cancelled.");
    setRevoking(null);
    await load();
  }

  const programs = app.programs.map((entry) => entry.ensemble);

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 pb-10 sm:px-6 sm:py-6">
      <div className="cue-stagger space-y-7">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <PageHeader
          kicker="System administration"
          title="Invitation codes"
          note="One code, one use. A code can verify a teacher, or also put them on a program's roster with a role. The code is shown once, when you issue it."
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw className="h-4 w-4" />}
                loading={loading}
                onClick={() => void load()}
              >
                Refresh
              </Button>
              <Button
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setComposerOpen(true)}
              >
                New invitation
              </Button>
            </>
          }
        />

        {rows === null ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <>
            {/* --- ready to hand out --- */}
            <section>
              <h2 className="type-label section-rule mb-3">Ready to use</h2>
              {groups.available.length === 0 ? (
                <div className="cue-card rounded-[var(--radius-panel)]">
                  <EmptyState
                    icon={<Ticket className="h-4 w-4" />}
                    title="No codes waiting"
                    body="Issue one for a new director or teacher. It stops being usable the moment somebody redeems it."
                    action={
                      <Button
                        variant="secondary"
                        icon={<Plus className="h-4 w-4" />}
                        onClick={() => setComposerOpen(true)}
                      >
                        New invitation
                      </Button>
                    }
                  />
                </div>
              ) : (
                <List>
                  {groups.available.map((row) => (
                    <Row
                      key={row.id}
                      icon={<KeyRound className="h-4 w-4" />}
                      title={row.label || grantsLabel(row)}
                      subtitle={[
                        row.label ? grantsLabel(row) : null,
                        row.intended_email ? `Bound to ${row.intended_email}` : null,
                        row.expires_at ? `Expires ${fmtDate(new Date(row.expires_at))}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      trailing={
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Cancel ${row.label || "this invitation"}`}
                          onClick={() => setRevoking(row)}
                          icon={<Trash2 className="h-4 w-4" />}
                        >
                          Cancel
                        </Button>
                      }
                    />
                  ))}
                </List>
              )}
            </section>

            {/* --- spent codes: the record of who used them --- */}
            <section>
              <h2 className="type-label section-rule mb-3">Used</h2>
              {groups.used.length === 0 ? (
                <Card>
                  <p className="type-meta">
                    Nothing has been redeemed yet. When someone uses a code it moves here with their
                    name and the account they signed in with.
                  </p>
                </Card>
              ) : (
                <List>
                  {groups.used.map((row) => {
                    // The name is the friendly half, the address is the audit
                    // half: two people can share a name, not an account.
                    const who = row.redeemed_by_name
                      ? row.redeemed_email
                        ? `${row.redeemed_by_name} (${row.redeemed_email})`
                        : row.redeemed_by_name
                      : row.redeemed_email || "an account that no longer exists";
                    const when = row.redeemed_at ? fmtDate(new Date(row.redeemed_at)) : "";
                    return (
                      <Row
                        key={row.id}
                        icon={<Check className="h-4 w-4" />}
                        title={row.label || grantsLabel(row)}
                        subtitle={[who, when, grantsLabel(row)].filter(Boolean).join(" · ")}
                        trailing={
                          <Badge className="bg-[var(--cue-present-bg)] text-[var(--cue-present)]">
                            Used
                          </Badge>
                        }
                      />
                    );
                  })}
                </List>
              )}
            </section>

            {/* --- expired and cancelled, kept for the record --- */}
            {groups.ended.length > 0 ? (
              <section>
                <h2 className="type-label section-rule mb-3">Expired or cancelled</h2>
                <List>
                  {groups.ended.map((row) => (
                    <Row
                      key={row.id}
                      className="opacity-70"
                      icon={<ShieldCheck className="h-4 w-4" />}
                      title={row.label || grantsLabel(row)}
                      subtitle={[
                        row.revoked_at ? "Cancelled" : "Expired before it was used",
                        grantsLabel(row),
                        row.intended_email ? `was bound to ${row.intended_email}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      trailing={
                        <Badge
                          className={cn(
                            row.revoked_at
                              ? "bg-[var(--cue-absent-bg)] text-[var(--cue-absent)]"
                              : "bg-[var(--cue-late-bg)] text-[var(--cue-late)]"
                          )}
                        >
                          {row.revoked_at ? "Cancelled" : "Expired"}
                        </Badge>
                      }
                    />
                  ))}
                </List>
              </section>
            ) : null}
          </>
        )}

        <Card className="flex items-start gap-3">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-subtle)]"
          />
          <p className="type-meta">
            Codes are stored only as a one-way hash, so nobody — including this screen — can read one
            back. Keep the copy you make when you issue it. A code bound to an email address only
            works for that account, and cancelling a code that has already been used also withdraws
            the teacher access it granted.
          </p>
        </Card>
      </div>

      {composerOpen ? (
        <InvitationComposer
          programs={programs}
          onClose={() => setComposerOpen(false)}
          onIssued={(code) => {
            setComposerOpen(false);
            setIssuedCode(code);
            void load();
          }}
        />
      ) : null}

      <Sheet
        open={issuedCode !== null}
        onClose={() => setIssuedCode(null)}
        title="Write this code down"
        description="It is shown once. The database keeps only a hash, so it cannot be recovered later."
      >
        <div className="space-y-4">
          <div className="cue-card flex items-center justify-between gap-3 rounded-[var(--radius-panel)] px-4 py-3">
            <code className="font-mono text-lg font-semibold tracking-[0.12em] break-all select-all">
              {issuedCode}
            </code>
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy className="h-4 w-4" />}
              onClick={() => {
                if (!issuedCode) return;
                void navigator.clipboard
                  .writeText(issuedCode)
                  .then(() => toast.success("Code copied."))
                  .catch(() => toast.error("Could not copy — select the code and copy it yourself."));
              }}
            >
              Copy
            </Button>
          </div>

          <p className="type-meta">
            Send it to the person you invited. They redeem it under{" "}
            <strong>Teacher access</strong> after signing in, and it works once.
          </p>

          <Button block onClick={() => setIssuedCode(null)}>
            Done
          </Button>
        </div>
      </Sheet>

      <ConfirmSheet
        open={revoking !== null}
        title="Cancel this invitation?"
        body={
          revoking?.status === "redeemed"
            ? "This code has already been used. Cancelling it withdraws the teacher access it granted on the holder's next request. Any roster place it created stays — remove that role from the roster instead."
            : "The code stops working immediately. Nothing else changes."
        }
        confirmLabel="Cancel invitation"
        loading={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevoking(null)}
      />
    </div>
  );
}

/**
 * The issue form. It generates a code rather than asking for one, because a code
 * somebody invents is the one thing here worth guessing; the generated value is
 * still visible and editable so an administrator can line it up with a card.
 */
function InvitationComposer({
  programs,
  onIssued,
  onClose,
}: {
  programs: { id: string; name: string }[];
  onIssued: (code: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState(generateInvitationCode);
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [programId, setProgramId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [roles, setRoles] = useState<RoleDefinition[] | null>(null);
  const [expiryDays, setExpiryDays] = useState("14");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Roles belong to a program (plus the system roles), so they are read when a
  // program is chosen rather than up front for every program at once.
  useEffect(() => {
    if (!programId) {
      setRoles(null);
      setRoleId("");
      return;
    }
    let alive = true;
    setRoles(null);
    void listProgramRoles(programId).then(({ result, error: rpcError }) => {
      if (!alive) return;
      if (rpcError || !result?.ok) {
        setRoles([]);
        setError(rpcError?.message || result?.message || "Could not read this program's roles.");
        return;
      }
      setRoles(
        (result.roles ?? []).filter((role) => role.active && role.key !== "system_admin")
      );
    });
    return () => {
      alive = false;
    };
  }, [programId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    if (programId && !roleId) {
      setError("Choose the role this person should get, or clear the program for a teacher-only code.");
      return;
    }

    setBusy(true);
    setError(null);

    const expiresAt =
      expiryDays === "never"
        ? null
        : new Date(Date.now() + Number(expiryDays) * 24 * 60 * 60 * 1000).toISOString();

    const { result, error: rpcError } = await configureTeacherInvitation({
      code,
      label,
      intendedEmail: email,
      expiresAt,
      programId: programId || null,
      roleId: programId ? roleId : null,
    });

    setBusy(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    if (!result?.ok) {
      setError(result?.message ?? "Could not save that invitation.");
      return;
    }

    // The plaintext only exists here: hand it back so the screen can show it once.
    onIssued(code.trim());
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="New invitation"
      description="One use. Redeeming it verifies the account — and, if you name one here, adds them to a program with a role."
      size="tall"
      footer={
        <>
          <Button variant="secondary" block onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button block type="submit" form="new-invitation" loading={busy}>
            Create code
          </Button>
        </>
      }
    >
      <form id="new-invitation" className="space-y-4" onSubmit={(event) => void submit(event)}>
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field
          label="Who is it for?"
          hint="Optional. A name only you see, so the list is readable later."
        >
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Alex Rivera — new director"
            maxLength={120}
          />
        </Field>

        <Field
          label="Program"
          hint="Leave this blank for a teacher code: the account can start its own program but joins nobody else's."
        >
          <Select value={programId} onChange={(event) => setProgramId(event.target.value)}>
            <option value="">No program — teacher access only</option>
            {programs.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name}
              </option>
            ))}
          </Select>
        </Field>

        {programId ? (
          <Field
            label="Role on that roster"
            hint="The role is granted the moment the code is redeemed — the person never assigns it themselves."
          >
            <Select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              disabled={roles === null}
              required
            >
              <option value="">
                {roles === null ? "Reading the roles…" : "Choose a role"}
              </option>
              {(roles ?? []).map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                  {role.is_system ? "" : " (custom)"}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field
          label="Bind it to an email"
          hint="Optional, and recommended: then only that account can redeem it. Use the address they sign in with."
        >
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teacher@example.edu"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>

        <Field label="Expires">
          <Select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}>
            <option value="7">After 7 days</option>
            <option value="14">After 14 days</option>
            <option value="30">After 30 days</option>
            <option value="never">Never</option>
          </Select>
        </Field>

        <Field
          label="Code"
          hint="Generated for you. Letters and digits only matter — spaces, case and dashes are ignored."
        >
          <Input
            aria-label="Invitation code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            className="font-mono tracking-[0.12em]"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            minLength={8}
          />
        </Field>

        <p className="type-meta">
          This is the only time the code is readable. Copy it before you close the next screen.
        </p>
      </form>
    </Sheet>
  );
}
