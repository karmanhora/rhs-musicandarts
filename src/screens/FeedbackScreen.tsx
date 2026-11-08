import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bug,
  Check,
  CheckCircle2,
  Lightbulb,
  MessageCircle,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  Alert,
  Button,
  Field,
  Input,
  PageHeader,
  SectionTitle,
  Textarea,
  cn,
} from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { submitFeedback } from "../lib/rpc";
import { FEEDBACK_CATEGORIES } from "../lib/constants";
import type { FeedbackCategory } from "../lib/types";

/** Must agree with the table's own limits in migration 20261108150000. */
const MAX_MESSAGE = 4000;
const MAX_AFFECTED = 200;

const CATEGORY_ICON: Record<FeedbackCategory, typeof Bug> = {
  bug: Bug,
  feature: Sparkles,
  suggestion: Lightbulb,
  broken: TriangleAlert,
  other: MessageCircle,
};

/**
 * `/feedback` — the form every member can use to tell the site owner what is
 * working and what is not.
 *
 * It collects the least it can: a category, the message, an optional affected
 * page, and a contact address so the owner can reply. The address is offered
 * from the signed-in account but never filled in automatically.
 *
 * The screen does not read or write any table directly. `submitFeedback()`
 * calls the server, which decides everything that matters (who sent it, whether
 * it is a duplicate, whether the text is acceptable). The checks here exist to
 * answer quickly, not to be the boundary.
 */
export function FeedbackScreen() {
  const auth = useAuth();
  const navigate = useNavigate();

  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [message, setMessage] = useState("");
  const [affected, setAffected] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<{
    category?: string;
    message?: string;
    email?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const accountEmail = auth.email?.trim() ?? "";
  const usingAccountEmail =
    accountEmail.length > 0 && email.trim().toLowerCase() === accountEmail.toLowerCase();

  function validate(): boolean {
    const next: typeof errors = {};

    if (!category) next.category = "Choose the kind of feedback this is.";

    const body = message.trim();
    if (body.length === 0) {
      next.message = "Tell us what happened, or what you would like to see.";
    } else if (body.length < 10) {
      next.message = "Please add a little more detail — at least 10 characters.";
    }

    const address = email.trim();
    if (!address) {
      next.email = "Add an email address so the owner can reply.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      next.email = "That doesn't look like an email address.";
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The button is disabled while this is true; the guard also covers a second
    // submit event fired before React has re-rendered.
    if (submitting) return;
    if (!validate()) return;

    setSubmitting(true);
    setSubmitError(null);

    const { result, error } = await submitFeedback({
      category: category!,
      message: message.trim(),
      affectedFeature: affected.trim() || null,
      contactEmail: email.trim(),
    });

    setSubmitting(false);

    if (error || !result?.ok) {
      setSubmitError(
        error?.message ||
          result?.message ||
          "Your feedback could not be sent. Check your connection and try again."
      );
      return;
    }

    setSent(true);
    setCategory(null);
    setMessage("");
    setAffected("");
    setEmail("");
    setErrors({});
  }

  function sendAnother() {
    setSent(false);
    setSubmitError(null);
  }

  if (sent) {
    return (
      <main className="safe-b mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
        <PageHeader
          kicker="Feedback"
          title="Thank you"
          note="Your message is with the site owner."
        />
        <div className="cue-card mt-6 p-6 sm:p-8">
          <span className="cue-status-pop flex h-12 w-12 items-center justify-center rounded-full bg-[var(--cue-leaf-soft)] text-[var(--cue-leaf)]">
            <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
          </span>
          <h2 className="type-heading mt-4">We&rsquo;ve got it.</h2>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-[var(--cue-muted)]">
            Every message is read by the owner of the site. The address you
            provided may be used to ask a follow-up question — no reply is
            promised, and nothing is shared with anybody else.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button icon={<Send className="h-4 w-4" />} onClick={sendAnother}>
              Send more feedback
            </Button>
            <Button variant="secondary" onClick={() => navigate("/")}>
              Back to home
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="safe-b mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <PageHeader
        kicker="Feedback"
        title="Tell us what you think"
        note="Found a bug, want a feature, or have an idea? This goes straight to the site owner — not to your program's roster or your director."
      />

      <div className="mt-6">
        <form
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
          className="cue-card mx-auto w-full rounded-[var(--radius-panel)] p-4 sm:p-6"
        >
          {submitError ? (
            <Alert tone="error" className="mb-5">
              {submitError}
            </Alert>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.35fr)]">
            <fieldset className="min-w-0">
            <legend className="mb-1.5 block text-[0.8125rem] font-semibold text-[var(--cue-ink)]">
              What kind of feedback is this?
            </legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {FEEDBACK_CATEGORIES.map((option) => {
                const Icon = CATEGORY_ICON[option.value];
                const active = category === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setCategory(option.value);
                      setErrors((prev) => ({ ...prev, category: undefined }));
                    }}
                    className={cn(
                      "motion-press flex min-h-14 items-start gap-3 rounded-[var(--radius-control)] border p-3 text-left",
                      active
                        ? "border-[var(--cue-leaf)] bg-[var(--cue-leaf-soft)]"
                        : "border-[var(--cue-line)] bg-[var(--cue-panel)] hover:bg-[var(--cue-raised)]"
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0",
                        active ? "text-[var(--cue-leaf)]" : "text-[var(--cue-subtle)]"
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="type-meta mt-0.5 block">{option.hint}</span>
                    </span>
                    {active ? (
                      <Check
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cue-leaf)]"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {errors.category ? (
              <p className="mt-1.5 text-[0.8125rem] font-medium text-[var(--cue-absent)]">
                {errors.category}
              </p>
            ) : null}
            </fieldset>

            <div className="min-w-0 space-y-4">
              <div>
            <Field
              label="What would you like us to know?"
              error={errors.message}
              hint={`Be as specific as you can. ${MAX_MESSAGE.toLocaleString()} characters maximum.`}
            >
              <Textarea
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  setErrors((prev) => ({ ...prev, message: undefined }));
                }}
                maxLength={MAX_MESSAGE}
                rows={7}
                placeholder="For example: on the Calendar page, tapping an event shows the wrong date on my phone."
                className="min-h-40 resize-y"
              />
            </Field>
            <p
              aria-hidden="true"
              className={cn(
                "type-meta mt-1 text-right tabular",
                message.length > MAX_MESSAGE - 200 && "text-[var(--cue-late)]"
              )}
            >
              {message.length.toLocaleString()} / {MAX_MESSAGE.toLocaleString()}
              </p>
            </div>

            <div className="grid items-start gap-x-4 gap-y-3 sm:grid-cols-2">
            <Field
              label="Affected page or feature"
              hint="Optional. For example: Check in, the Calendar or the Roster."
            >
              <Input
                value={affected}
                onChange={(event) => setAffected(event.target.value)}
                maxLength={MAX_AFFECTED}
                placeholder="Check in"
                autoComplete="off"
              />
            </Field>

            <Field
              label="Contact email"
              error={errors.email}
              hint="Required so the owner can reply. Never shown to other members."
            >
              <Input
                type="email"
                inputMode="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setErrors((prev) => ({ ...prev, email: undefined }));
                }}
                maxLength={254}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </Field>
          </div>

          {accountEmail ? (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <span className="type-meta min-w-0">
                Signed in as <span className="break-all">{accountEmail}</span>
              </span>
              {usingAccountEmail ? null : (
                <Button size="sm" variant="secondary" onClick={() => setEmail(accountEmail)}>
                  Use my account email
                </Button>
              )}
            </div>
          ) : null}

              <div className="flex flex-wrap items-center gap-3 border-t border-[var(--cue-line)] pt-4">
            <Button
              type="submit"
              size="lg"
              loading={submitting}
              icon={<Send className="h-4 w-4" />}
            >
              Send feedback
            </Button>
            <p className="type-meta min-w-0 flex-1">
              Nothing here is visible to other students, teachers or program
              administrators.
                </p>
              </div>
            </div>
          </div>
        </form>

        <aside
          aria-label="What happens next"
          className="cue-card space-y-3 rounded-[var(--radius-panel)] p-4 sm:p-5"
        >
          <SectionTitle>What happens next</SectionTitle>
          <ul className="grid gap-3 sm:grid-cols-3">
            {[
              "The site owner reads every message. It is not posted anywhere, and it does not go to your director.",
              "Your contact email is required so the owner can reply. It is never shown to other students, teachers or program administrators.",
              "Bug reports and requests are triaged from a private inbox, so the same idea twice is easier to act on than a scattered note.",
            ].map((line) => (
              <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-[var(--cue-muted)]">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cue-gold)]"
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="type-meta border-t border-[var(--cue-line)] pt-3">
            This form is for feedback about the website itself. For something about
            a rehearsal, a performance or your attendance, talk to your director.
          </p>
        </aside>
      </div>
    </main>
  );
}
