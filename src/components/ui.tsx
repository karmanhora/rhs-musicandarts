/**
 * The app's UI kit.
 *
 * Two rules keep the interface from drifting into a template:
 *
 * 1. **A panel is not the unit of layout.** A group of rows, a list of events
 *    and a form are all built from the *inside* out — headings, alignment,
 *    rules and spacing do the grouping, and `Card`/`List` are only used when
 *    something is genuinely a distinct object on the page.
 * 2. **Type carries the hierarchy, not decoration.** Four roles exist
 *    (`.type-title`, `.type-heading`, `.type-label`, `.type-meta`) and colour is
 *    reserved for state: green means the product's own ink, gold means
 *    attention, and the four attendance statuses mean only themselves.
 *
 * Everything is still built for a phone first: 44px minimum tap targets, a
 * bottom sheet instead of a desktop modal, no `window.confirm`, and visible
 * focus rings plus aria labels on every control. Screens compose these
 * primitives rather than hand-rolling markup.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";

import { initials } from "../lib/date";
import { useSignedAvatarUrl } from "../hooks/useAvatars";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* Motif                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The program's motif: five staff lines with a little notation drifting along
 * them. Drawn as SVG rather than a background so it can sit under real content
 * and scale with it, and used in two places only — the dashboard's focal panel
 * and the sign-in aside — so it reads as the program's mark rather than as
 * pattern fill.
 */
export function StaffMotif({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 720 320"
      preserveAspectRatio="xMidYMid slice"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    >
      <g stroke="currentColor" strokeWidth="1" opacity="0.45">
        <path d="M-10 62H730" />
        <path d="M-10 112H730" />
        <path d="M-10 162H730" />
        <path d="M-10 212H730" />
        <path d="M-10 262H730" />
      </g>
      <g className="cue-drift" fill="currentColor">
        <g transform="translate(150 162)">
          <ellipse cx="0" cy="0" rx="11" ry="8" transform="rotate(-18)" />
          <rect x="8" y="-86" width="3" height="86" />
          <path d="M11-86c18 5 26 14 18 30" fill="none" stroke="currentColor" strokeWidth="4" />
        </g>
        <g transform="translate(392 112)" opacity="0.9">
          <ellipse cx="0" cy="0" rx="11" ry="8" transform="rotate(-18)" />
          <rect x="8" y="-86" width="3" height="86" />
          <path d="M11-86c18 5 26 14 18 30" fill="none" stroke="currentColor" strokeWidth="4" />
        </g>
        <g transform="translate(600 212)" opacity="0.75">
          <circle cx="0" cy="0" r="9" />
          <rect x="7" y="-60" width="3" height="60" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Five bars on a slow loop — the app's way of saying "this is live and counting".
 * Used in the live check-in count and the dashboard's countdown, nowhere else.
 */
export function TempoBars({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("cue-tempo", className)}>
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

/** A heading that arrives as a masked line, with an accent rule trailing it. */
export function Poster({
  children,
  className,
  rule = false,
  tone = "ink",
}: {
  children: ReactNode;
  className?: string;
  /** Draw the short leaf rule under the line. */
  rule?: boolean;
  tone?: "ink" | "stage";
}) {
  return (
    <span className={cn("block", className)}>
      <span className="cue-line">
        <span className={cn("cue-line-inner type-poster", tone === "stage" && "text-[var(--cue-stage-ink)]")}>
          {children}
        </span>
      </span>
      {rule ? (
        <span
          aria-hidden="true"
          className={cn(
            "cue-rule-draw mt-3 block h-[3px] w-16",
            tone === "stage" ? "bg-[var(--cue-gold-on-brand)]" : "bg-[var(--cue-leaf)]"
          )}
        />
      ) : null}
    </span>
  );
}

/**
 * A deep-green stage. One per screen at most: it is where the thing you came to
 * do lives, so spending it twice would spend it on nothing.
 */
export function Stage({
  children,
  className,
  motif = false,
  ...rest
}: { children: ReactNode; className?: string; motif?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn("cue-stage rounded-[var(--radius-panel)]", className)}
    >
      {motif ? (
        <StaffMotif className="text-[var(--cue-stage-ink)] opacity-[0.13]" />
      ) : null}
      <div className="relative z-10">{children}</div>
    </div>
  );
}

/** True when the caller already decided the padding — so we don't fight it. */
function hasPadding(className?: string): boolean {
  return !!className && /(?:^|\s)(?:p|px|py|pt|pb|pl|pr)-/.test(className);
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent" | "link";
type Size = "sm" | "md" | "lg";

/*
 * One interaction spec per variant.
 *
 * Every variant answers the same four states the same way, because a control
 * that lifts under the pointer is a control that claims it will take you
 * somewhere, and an action in this app does not take you anywhere — it fires.
 * The rules, in order:
 *
 *   hover          colour and surface only. Nothing moves. No variant lifts,
 *                  slides or grows.
 *   active/press   `motion-press` scales to 0.99 and the surface deepens. This
 *                  is the only movement any button makes.
 *   focus-visible  the shared 2px ring, offset 2px (`:focus-visible` in
 *                  index.css). Never removed.
 *   disabled       `disabled:opacity-45`, no hover surface, no press, and the
 *                  pointer says so. `loading` is the same state with a
 *                  spinner — it does not get its own animation.
 *
 * `data-press="none"` opts a variant out of the scale (used by `link`, which is
 * a word, not a button).
 */
const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    "bg-[var(--cue-action)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/14%)] " +
    "hover:bg-[var(--cue-action-hover)] active:bg-[var(--cue-action-hover)] " +
    "disabled:hover:bg-[var(--cue-action)] disabled:active:bg-[var(--cue-action)]",
  accent:
    "bg-[var(--cue-gold)] text-[var(--cue-gold-ink)] shadow-[inset_0_1px_0_rgb(255_255_255/30%)] " +
    "hover:brightness-95 active:brightness-90 " +
    "disabled:hover:brightness-100 disabled:active:brightness-100",
  secondary:
    "border border-[var(--cue-line-strong)] bg-[var(--cue-panel)] text-[var(--cue-ink)] " +
    "hover:bg-[var(--cue-raised)] active:bg-[var(--cue-raised)] " +
    "disabled:hover:bg-[var(--cue-panel)] disabled:active:bg-[var(--cue-panel)]",
  ghost:
    "bg-transparent text-[var(--cue-ink)] " +
    "hover:bg-[var(--cue-raised)] active:bg-[var(--cue-raised)] " +
    "disabled:hover:bg-transparent disabled:active:bg-transparent",
  danger:
    "bg-[var(--cue-absent)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/14%)] " +
    "hover:brightness-95 active:brightness-90 " +
    "disabled:hover:brightness-100 disabled:active:brightness-100",
  /**
   * A link that happens to be a button: an outbound destination where the
   * affordance is the underline and the trailing arrow, not a surface. Its
   * arrow leans toward the destination on hover and focus (`cue-nudge`).
   */
  link:
    "bg-transparent text-[var(--cue-leaf)] underline decoration-[var(--cue-gold)] decoration-2 " +
    "underline-offset-4 hover:text-[var(--cue-ink)] disabled:hover:text-[var(--cue-leaf)]",
};

const SIZE_CLASS: Record<Size, string> = {
  sm: "min-h-11 px-3 text-[0.8125rem]",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-5 text-[0.9375rem]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  /** A trailing mark — a chevron, an arrow — after the label. */
  iconAfter?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  block,
  loading,
  icon,
  iconAfter,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const inert = Boolean(disabled || loading);
  return (
    <button
      {...rest}
      disabled={inert}
      data-loading={loading ? "" : undefined}
      className={cn(
        // `group` is what lets the trailing arrow nudge on hover and focus.
        "group motion-press inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] font-semibold",
        // One disabled look for both states, and the press scale is dropped
        // with the same rule that drops the hover surface, so a loading button
        // is visibly inert rather than merely unresponsive.
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        block && "w-full",
        // A label that swaps to a spinner keeps the button's height and its
        // width is allowed to shrink; `aria-busy` says what is happening for
        // anybody who cannot see the spinner.
        loading && "cursor-wait",
        className
      )}
      aria-busy={loading ? true : undefined}
    >
      {loading ? <Spinner className="h-4 w-4" /> : icon}
      {children}
      {/* The trailing arrow leans toward where it goes, but only while the
          control is live — never on a busy or disabled button. */}
      {iconAfter ? (
        <span className={cn("inline-flex", !inert && "cue-nudge")}>{iconAfter}</span>
      ) : null}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  className,
  variant = "ghost",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
  /** Same names as `Button` — one vocabulary for both controls. */
  variant?: Variant;
}) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn(
        "motion-press inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
        VARIANT_CLASS[variant],
        className
      )}
    >
      {icon}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Page furniture                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every screen opens with one of these: what this page is, what it is about,
 * and what you can do on it. Before this existed, each screen began with a card
 * and the page had no name — which is most of why the screens were
 * interchangeable.
 */
export function PageHeader({
  title,
  kicker,
  note,
  actions,
  className,
}: {
  title: ReactNode;
  /** Which program / which event this page is scoped to. */
  kicker?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-[var(--cue-line)] pb-3",
        className
      )}
    >
      <div className="min-w-0">
        {kicker ? <p className="type-kicker mb-1.5">{kicker}</p> : null}
        <h1 className="type-title text-[var(--cue-ink)]">{title}</h1>
        {note ? <p className="type-meta mt-1 max-w-xl">{note}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * A section inside a page: a quiet small-caps label and a rule. Use this rather
 * than a card wherever a heading already says where one group ends.
 */
export function SectionTitle({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("section-rule", className)}>
      <h2 className="type-label">{children}</h2>
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

export function Card({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        "cue-card rounded-[var(--radius-panel)]",
        !hasPadding(className) && "p-4",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * Rows that belong together: one panel, one hairline between neighbours. This
 * is the standard container for anything that is a list — roster, roll, events,
 * settings — so a screen of forty names is one object rather than forty cards.
 */
export function List({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        "cue-list cue-card overflow-hidden rounded-[var(--radius-panel)]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Row({
  icon,
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  className,
}: {
  icon?: ReactNode;
  /** Content before the title — a date gutter, an avatar, a checkbox. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const content = (
    <>
      {leading}
      {icon ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--cue-subtle)]">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem] font-semibold">{title}</span>
        {subtitle ? (
          <span className="type-meta block truncate">{subtitle}</span>
        ) : null}
      </span>
      {trailing}
    </>
  );

  if (!onClick) {
    return (
      <div className={cn("flex min-h-14 items-center gap-3 px-3 py-2.5", className)}>{content}</div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group motion-press flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--cue-raised)]",
        className
      )}
    >
      {content}
    </button>
  );
}

/**
 * A status marker. Deliberately squarer and smaller than a button: a badge here
 * is a fact about a row, never something to press.
 */
export function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        className
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "success" | "warn" | "error";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "bg-[var(--cue-raised)] text-[var(--cue-ink)] [&_.alert-rule]:bg-[var(--cue-line-strong)]",
    success:
      "bg-[var(--cue-present-bg)] text-[var(--cue-present)] [&_.alert-rule]:bg-[var(--cue-present)]",
    warn: "bg-[var(--cue-late-bg)] text-[var(--cue-late)] [&_.alert-rule]:bg-[var(--cue-late)]",
    error: "bg-[var(--cue-absent-bg)] text-[var(--cue-absent)] [&_.alert-rule]:bg-[var(--cue-absent)]",
  } as const;
  const Icon = { info: Info, success: CheckCircle2, warn: TriangleAlert, error: XCircle }[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "relative flex items-start gap-2.5 overflow-hidden rounded-[var(--radius-control)] py-2.5 pr-3 pl-4 text-sm",
        tones[tone],
        className
      )}
    >
      <span aria-hidden="true" className="alert-rule absolute inset-y-0 left-0 w-[3px]" />
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Figures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One number with its label. Used in a `MetricStrip` — the honest replacement
 * for the fake stat cards ("on the roster / active / sections") that filled
 * space without telling anyone anything.
 */
export function Metric({
  label,
  value,
  hint,
  tone = "ink",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "ink" | "present" | "late" | "excused" | "absent" | "muted";
  className?: string;
}) {
  const tones = {
    ink: "text-[var(--cue-ink)]",
    present: "text-[var(--cue-present)]",
    late: "text-[var(--cue-late)]",
    excused: "text-[var(--cue-excused)]",
    absent: "text-[var(--cue-absent)]",
    muted: "text-[var(--cue-subtle)]",
  } as const;
  return (
    <div className={cn("px-3 py-3", className)}>
      <dt className="type-label">{label}</dt>
      <dd className={cn("type-figure mt-1.5 text-3xl", tones[tone])}>{value}</dd>
      {hint ? <p className="type-meta mt-1">{hint}</p> : null}
    </div>
  );
}

/**
 * Figures side by side, separated by rules rather than boxed individually.
 * `columns` is the count at the `sm` breakpoint and up; below it they pair up.
 */
export function MetricStrip({
  children,
  columns = 3,
  className,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  const cols = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[columns];
  return (
    <dl
      className={cn(
        "grid grid-cols-2 divide-x divide-[var(--cue-line)] [&>div:nth-child(n+3)]:border-t [&>div:nth-child(n+3)]:border-[var(--cue-line)] sm:border-t-0 sm:[&>div:nth-child(n+3)]:border-t-0",
        cols,
        className
      )}
    >
      {children}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                              */
/* -------------------------------------------------------------------------- */

/*
 * `1rem` and not `0.9375rem`: iOS Safari zooms the whole page when a control
 * smaller than 16px takes focus, which then leaves the field magnified with its
 * label off-screen. 16px is the floor that keeps the layout still on a phone
 * (docs/QA_REPORT.md QA-03).
 */
const CONTROL_CLASS =
  "min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--cue-line-strong)] bg-[var(--cue-panel)] px-3 py-2.5 text-base text-[var(--cue-ink)] " +
  "placeholder:text-[var(--cue-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--cue-focus)]";

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      {label ? (
        <span className="mb-1.5 block text-[0.8125rem] font-semibold text-[var(--cue-ink)]">
          {label}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="mt-1 block text-[0.8125rem] font-medium text-[var(--cue-absent)]">
          {error}
        </span>
      ) : hint ? (
        <span className="type-meta mt-1 block">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(CONTROL_CLASS, className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(CONTROL_CLASS, "min-h-24", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(CONTROL_CLASS, "appearance-none pr-9", className)}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "motion-press relative h-11 w-12 shrink-0",
        // The switch is the one control that is legitimately a pill.
        ""
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-3 left-0.5 block h-5 w-11 rounded-full border transition-colors",
          checked
            ? "border-[var(--cue-action)] bg-[var(--cue-action)]"
            : "border-[var(--cue-line-strong)] bg-[var(--cue-raised)]"
        )}
      >
        <span
          className={cn(
            // The knob is centred by `top-1/2` + `-translate-y-1/2` and offset
            // horizontally by an explicit `left`: `left: auto` is not "zero",
            // its used value is the knob's *static* position, which landed
            // 21.4px into this 42px track and pushed the knob past the pill
            // entirely — on top of the first letter of the label beside it.
            // Both are computed from the box, so the knob stays centred if the
            // pill or the knob is ever resized. Only the travel between the two
            // stops is animated; the resting inset is layout.
            "absolute top-1/2 left-0.5 h-4 w-4 -translate-y-1/2 rounded-full bg-white transition-transform duration-150",
            checked ? "translate-x-[1.375rem]" : "translate-x-0"
          )}
        />
      </span>
    </button>
  );
}

/**
 * A row of choices that changes what you are looking at — attendance status,
 * the roster's scope, the calendar's view. Underlined tabs rather than a pill
 * track, so a form control and a filter look like the same idea.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      // 8px between adjacent tabs: at 2px two neighbouring labels read as one
      // control and a thumb lands between them (docs/QA_REPORT.md QA-06).
      className={cn(
        "flex gap-2 overflow-x-auto border-b border-[var(--cue-line)]",
        className
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "motion-press relative min-h-11 px-3 text-[0.8125rem] font-semibold whitespace-nowrap uppercase tracking-[0.06em]",
              active
                ? "text-[var(--cue-ink)]"
                : "text-[var(--cue-muted)] hover:text-[var(--cue-ink)]"
            )}
          >
            {o.label}
            <span aria-hidden="true" className={cn("cue-tab-rule", active && "cue-tab-rule--on")} />
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                   */
/* -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className
      )}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("skeleton-shimmer rounded-[var(--radius-control)]", className)} />
  );
}

/**
 * An empty state is information, not a decoration: what is missing, why, and
 * the one thing to do about it — left-aligned with the rest of the page so it
 * reads as part of the layout rather than a billboard in the middle of it.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-6">
      {icon ? (
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-[var(--cue-subtle)]">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0">
        <p className="type-heading">{title}</p>
        {body ? <p className="type-meta mt-1 max-w-md">{body}</p> : null}
        {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

export function ProgressRing({
  value,
  size = 72,
  stroke = 8,
  children,
  className,
  animateValue = false,
}: {
  /** 0–100. */
  value: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
  className?: string;
  animateValue?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  const tone =
    clamped >= 80
      ? "var(--cue-present)"
      : clamped >= 60
        ? "var(--cue-late)"
        : "var(--cue-absent)";
  return (
    <div
      role="img"
      aria-label={`${Math.round(clamped)}%`}
      className={cn("relative inline-flex items-center justify-center", className)}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke="var(--cue-line)"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="butt"
          strokeDasharray={`${dash} ${c}`}
          stroke={tone}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children ?? (
          <span className="type-figure text-2xl">
            {animateValue ? <AnimatedPercent value={Math.round(clamped)} /> : `${Math.round(clamped)}%`}
          </span>
        )}
      </div>
    </div>
  );
}

function AnimatedPercent({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const previousValue = useRef(0);

  useEffect(() => {
    const startValue = previousValue.current;
    previousValue.current = value;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setDisplayValue(value);
      return;
    }

    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 420);
      const eased = 1 - (1 - progress) ** 3;
      setDisplayValue(Math.round(startValue + (value - startValue) * eased));
      if (progress < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return <>{displayValue}%</>;
}

/**
 * A person's picture, or their initials.
 *
 * `path` is the object path in the **private** avatars bucket (030) and is
 * preferred: it is resolved to a short-lived signed URL by the provider. `url`
 * is the legacy external address, used only when no upload exists. If the image
 * fails to load — a lapsed link, an offline phone, a deleted object — the
 * component retries a signed link once before falling back to initials.
 */
export function Avatar({
  name,
  url,
  path,
  size = 40,
  className,
}: {
  name: string;
  url?: string | null;
  path?: string | null;
  size?: number;
  className?: string;
}) {
  const { url: signed, refresh } = useSignedAvatarUrl(path);
  const [failed, setFailed] = useState(false);
  const retriedPath = useRef<string | null>(null);

  useEffect(() => {
    setFailed(false);
    retriedPath.current = null;
  }, [path, url]);

  const source = failed ? null : path ? signed : url || null;

  if (source) {
    return (
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onLoad={() => {
          retriedPath.current = null;
          setFailed(false);
        }}
        onError={() => {
          if (path && retriedPath.current !== path) {
            retriedPath.current = path;
            refresh();
            return;
          }
          setFailed(true);
        }}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-[var(--cue-green-soft)] font-semibold text-[var(--cue-green)]",
        className
      )}
    >
      {initials(name) || "?"}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

type ToastTone = "info" | "success" | "warn" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const ToastContext = createContext<{ push: (tone: ToastTone, message: string) => void } | null>(
  null
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, tone, message }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto w-full max-w-sm animate-sheet">
            <Alert tone={t.tone}>{t.message}</Alert>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export interface ToastApi {
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * `const { toast } = useToast();` then `toast.success("Saved.")` — one handle
 * with four tones. Every screen uses that shape, so the hook returns exactly it.
 */
export function useToast(): { toast: ToastApi } {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  const toast = useMemo<ToastApi>(
    () => ({
      info: (m) => ctx.push("info", m),
      success: (m) => ctx.push("success", m),
      warn: (m) => ctx.push("warn", m),
      error: (m) => ctx.push("error", m),
    }),
    [ctx]
  );
  return { toast };
}

/* -------------------------------------------------------------------------- */
/* Sheets                                                                     */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "auto",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** "tall" for full-height content (the roster picker, event form). */
  size?: "auto" | "tall";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dragStart = useRef<{ y: number; at: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [sheetEntering, setSheetEntering] = useState(false);

  useEffect(() => {
    if (!open) {
      setSheetEntering(false);
      setDragY(0);
      return;
    }
    setSheetEntering(true);
    const timeout = window.setTimeout(() => setSheetEntering(false), 260);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const t = window.setTimeout(() => {
      const target = panel.current?.querySelector<HTMLElement>(
        "[data-autofocus],input,select,textarea,button"
      );
      target?.focus();
    }, 30);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(t);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "cue-card relative flex w-full max-w-lg flex-col rounded-t-[var(--radius-sheet)] shadow-[var(--cue-shadow-sheet)]",
          sheetEntering && "animate-sheet",
          "sheet-drag max-h-[92dvh] sm:rounded-[var(--radius-sheet)]",
          size === "tall" ? "h-[92dvh]" : ""
        )}
        style={dragY ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
      >
        <div className="flex items-start gap-3 border-b border-[var(--cue-line)] px-4 py-3">
          <div
            aria-hidden="true"
            className="absolute top-2 left-1/2 h-1 w-10 -translate-x-1/2 touch-none rounded-full bg-[var(--cue-line-strong)] sm:hidden"
            onPointerDown={(event) => {
              dragStart.current = { y: event.clientY, at: performance.now() };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!dragStart.current) return;
              setDragY(Math.max(0, event.clientY - dragStart.current.y));
            }}
            onPointerUp={(event) => {
              const start = dragStart.current;
              if (start) {
                const distance = event.clientY - start.y;
                const velocity = distance / Math.max(1, performance.now() - start.at);
                dragStart.current = null;
                if (distance > 120 || velocity > 0.65) onClose();
              }
              setDragY(0);
            }}
            onPointerCancel={() => {
              dragStart.current = null;
              setDragY(0);
            }}
          />
          <div className="min-w-0 flex-1 pt-1">
            <h3 className="type-heading">{title}</h3>
            {description ? <p className="type-meta mt-0.5">{description}</p> : null}
          </div>
          <IconButton label="Close" icon={<X className="h-5 w-5" />} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
        {footer ? (
          // Equal tracks rather than a flex row. `Button` is `shrink-0` — that is
          // what keeps a button from being squashed in a tight row — so two
          // `block` (`w-full`) buttons in a *flex* row cannot be shrunk, and the
          // second one landed 470px outside the panel, off the side of the
          // screen. `auto-fit` + `minmax(0,1fr)` gives one equal, shrinkable
          // track per child, so a two- and a three-button footer both divide the
          // width, and a single-button footer still fills it.
          <div className="safe-b grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-2 border-t border-[var(--cue-line)] px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmSheet({
  open,
  title,
  body,
  warning,
  confirmLabel = "Confirm",
  tone = "danger",
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  /** An extra consequence to see before confirming, such as affected records. */
  warning?: ReactNode;
  confirmLabel?: string;
  tone?: Variant;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" block onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={tone} block onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {warning ? <div className="mb-3">{warning}</div> : null}
      <p className="text-sm text-[var(--cue-muted)]">{body}</p>
    </Sheet>
  );
}
