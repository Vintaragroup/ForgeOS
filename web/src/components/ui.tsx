import { type CSSProperties, type ReactNode } from "react";
import Link from "next/link";

export function PageHeader({
  title,
  action,
}: {
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="font-display flex items-center gap-3 text-3xl tracking-wide">{title}</h1>
      {action}
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

export function SelectField({
  label,
  name,
  defaultValue,
  required,
  options,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  options: { value: string; label: string }[];
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

// A single-number stat tile -- shared by the admin dashboard and the
// landing dashboard so both read consistently as "the same kind of page."
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Card className="p-5">
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
