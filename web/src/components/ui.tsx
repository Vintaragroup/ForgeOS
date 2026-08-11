import { type CSSProperties, type ReactNode } from "react";
import Link from "next/link";

// Every page gets a breadcrumb back to Dashboard by default -- before this,
// the only way back from any page was clicking the logo. backHref/backLabel
// add a second crumb for the page's immediate parent list (e.g. "Dashboard
// / Materials"), so a detail page offers both "up one level" and "home" in
// one place. Pass noBack only on the dashboard page itself.
export function PageHeader({
  title,
  action,
  backHref,
  backLabel,
  noBack = false,
}: {
  title: ReactNode;
  action?: ReactNode;
  backHref?: string;
  backLabel?: string;
  noBack?: boolean;
}) {
  const crumbs = noBack
    ? []
    : [
        { href: "/", label: "Dashboard" },
        ...(backHref && backHref !== "/" ? [{ href: backHref, label: backLabel ?? "Back" }] : []),
      ];

  return (
    <div className="mb-6">
      {crumbs.length > 0 && (
        <nav className="mb-3 flex items-center gap-2">
          {crumbs.map((crumb, i) => (
            <Link
              key={crumb.href}
              href={crumb.href}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50 hover:text-neutral-900"
            >
              {i === 0 && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M3 10.5 12 3l9 7.5M5.5 9.5V20a1 1 0 0 0 1 1H9.5v-6h5v6H17.5a1 1 0 0 0 1-1V9.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              {crumb.label}
            </Link>
          ))}
        </nav>
      )}
      <div className="flex items-center justify-between">
        <h1 className="font-display flex items-center gap-3 text-3xl tracking-wide">{title}</h1>
        {action}
      </div>
    </div>
  );
}

export function Card({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`rounded-lg border border-neutral-200 bg-white ${className}`} style={style}>
      {children}
    </div>
  );
}

// Zero-JS accordion for the long detail pages (Opportunity, Estimate) --
// native <details>/<summary> rather than a client component with useState,
// consistent with how little client JS the rest of this app reaches for
// (ConfirmForm is one of the only other client components). Server-rendered
// `open` is uncontrolled from then on, same as defaultChecked on a
// checkbox -- the browser's own disclosure toggle needs no React round trip.
export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
  className = "",
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      open={defaultOpen}
      className={`group rounded-lg border border-neutral-200 bg-white ${className}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 py-4 marker:content-none [&::-webkit-details-marker]:hidden">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="shrink-0 text-neutral-400 transition-transform group-open:rotate-90"
        >
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="px-6 pb-6">{children}</div>
    </details>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-neutral-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        step={type === "number" ? "any" : undefined}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
      />
    </div>
  );
}

export function TextareaField({
  label,
  name,
  defaultValue,
  required,
  placeholder,
  rows = 5,
  hint,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-neutral-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
      <textarea
        id={name}
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        rows={rows}
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
      />
    </div>
  );
}

export function SelectField({
  label,
  name,
  defaultValue,
  required,
  options,
  onChange,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  options: { value: string; label: string }[];
  // Optional -- every existing caller renders this as an uncontrolled
  // select (defaultValue only), so adding this doesn't change their
  // behavior. Lets a client component (e.g. project-type-fields.tsx)
  // react to a selection without needing its own raw <select>.
  onChange?: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-neutral-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        required={required}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  type = "submit",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "submit" | "button";
}) {
  const styles = {
    primary: "bg-brand-black text-white hover:bg-brand-navy",
    secondary: "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50",
    danger: "bg-red-600 text-white hover:bg-red-700",
  }[variant];
  return (
    <button
      type={type}
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${styles}`}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  const styles = {
    primary: "bg-brand-black text-white hover:bg-brand-navy",
    secondary: "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50",
  }[variant];
  return (
    <Link
      href={href}
      className={`inline-block rounded-md px-4 py-2 text-sm font-medium transition-colors ${styles}`}
    >
      {children}
    </Link>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500">
      {message}
    </div>
  );
}

// B21: catalog list pages loaded every row unbounded -- fine at seed-data
// scale, not once a category has hundreds of rows. Renders nothing when
// everything fits on one page, so it's invisible today and only kicks in
// once a list actually grows past PAGE_SIZE.
export function Pagination({
  page,
  totalPages,
  basePath,
}: {
  page: number;
  totalPages: number;
  basePath: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      {page > 1 ? (
        <Link href={`${basePath}?page=${page - 1}`} className="font-medium text-neutral-600 hover:text-neutral-900">
          ← Previous
        </Link>
      ) : (
        <span />
      )}
      <span className="text-neutral-400">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={`${basePath}?page=${page + 1}`} className="font-medium text-neutral-600 hover:text-neutral-900">
          Next →
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

// A blocker notice with a direct fix action -- for stopping points in a workflow
// (e.g. "approving needs a user, none exist yet") where a plain sentence leaves
// the user to figure out where to go on their own.
export function Notice({
  message,
  actionHref,
  actionLabel,
}: {
  message: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="text-sm text-amber-900">{message}</p>
      <LinkButton href={actionHref} variant="secondary">
        {actionLabel}
      </LinkButton>
    </div>
  );
}

// A single-number stat tile, used throughout the dashboard so every metric
// reads consistently. className lets callers add hover/link affordances
// (see the dashboard's Pipeline tiles, which link into a filtered list).
export function Stat({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-sm text-neutral-500">{label}</div>
    </Card>
  );
}

// A small colored status pill -- for list rows where status was previously
// plain text (estimate/proposal/project status, opportunity stage). Tone is
// the semantic slot (what it means), not the literal status string, so
// callers map their own domain's statuses to a tone rather than this
// component knowing about every status enum in the app.
export function StatusChip({
  tone,
  children,
}: {
  tone: "neutral" | "info" | "warning" | "good" | "critical";
  children: ReactNode;
}) {
  const styles = {
    neutral: "bg-neutral-100 text-neutral-600",
    info: "bg-brand-navy/10 text-brand-navy",
    warning: "bg-brand-tan text-amber-900",
    good: "bg-brand-teal-pale text-teal-800",
    critical: "bg-red-50 text-red-700",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {children}
    </span>
  );
}
