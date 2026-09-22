import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

// The dashboard look (globals.css's .dash-* rules) as reusable pieces, so
// every department's landing page is the same page with different content:
// the hero greeting and quick actions on top, then sections of rows.
//
// Deliberately a thin wrapper over the existing markup rather than a new
// design -- the main dashboard (app/(app)/page.tsx) is the reference, and
// these components reproduce its structure so the two can't drift apart
// visually. What varies per department is the quick actions, the sections,
// and what's in the rows -- never the shape.

export type DashTone = "teal" | "tangerine" | "navy" | "gray" | "tan" | "red";

export interface QuickAction {
  href: string;
  label: string;
  tone: DashTone;
}

export function greetingWord(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export interface DashTab {
  key: string;
  label: string;
  // Shown next to the label; omit for tabs that aren't a work queue.
  count?: number;
  href: string;
  active: boolean;
}

export function DashboardShell({
  id,
  today,
  firstName,
  subgreeting,
  quickActions,
  tabs,
  search,
  children,
}: {
  id: string;
  today: Date;
  firstName: string;
  // The one line under the greeting -- each department says what this page
  // is for ("9 things need you today").
  subgreeting: ReactNode;
  quickActions: QuickAction[];
  // Splits the page so the landing view is only what needs doing -- the
  // rest is one click away instead of several screens down.
  tabs?: DashTab[];
  // Optional search/ask box (the main dashboard's command bar).
  search?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="dash dash-full-bleed -my-8">
      <div className="dash-hero">
        <div className="dash-hero-top">
          <span className="dash-clock">
            {today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </span>
          <ThemeToggle targetId={id} />
        </div>

        <div className="dash-hero-content">
          <h1 className="dash-greeting">
            {greetingWord(today.getHours())}, <span className="dash-accent">{firstName}.</span>
          </h1>
          <p className="dash-subgreeting">{subgreeting}</p>
          {search}
          <div className="dash-quick-actions">
            {quickActions.map((action) => (
              <Link key={action.href + action.label} className={`dash-qa dash-c-${action.tone}`} href={action.href}>
                <span className="dash-dot" />
                {action.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="dash-wrap">
        {tabs && tabs.length > 0 && (
          <nav className="dash-tabs" aria-label="Sections">
            {tabs.map((tab) => (
              <Link key={tab.key} href={tab.href} className={`dash-tab${tab.active ? " is-active" : ""}`} aria-current={tab.active ? "page" : undefined}>
                {tab.label}
                {tab.count != null && tab.count > 0 && <span className="dash-tab-count">{tab.count}</span>}
              </Link>
            ))}
          </nav>
        )}
        {children}
      </div>
    </div>
  );
}

export function DashSection({
  title,
  link,
  children,
}: {
  title: string;
  link?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="dash-section">
      <div className="dash-section-head">
        <h2 className="dash-section-title">{title}</h2>
        {link && (
          <Link href={link.href} className="dash-section-link">
            {link.label} →
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

export function DashCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`dash-card ${className}`}>{children}</div>;
}

// A row is the unit of work on these pages: what it is, why it's here, and
// what you can do about it. `href` makes the row navigate; `actions` puts
// buttons on the right, for things you do without leaving the page.
//
// With BOTH, only the identity half is the link and the buttons sit outside
// it -- a <button> nested inside an <a> is invalid HTML, and every click on
// one would also navigate. Rows that only navigate stay a single <a>, so
// the whole row remains one big target.
export function DashRow({
  title,
  sub,
  right,
  actions,
  href,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  actions?: ReactNode;
  href?: string;
}) {
  const identity = (
    <div className="min-w-0">
      <div className="dash-row-title truncate">{title}</div>
      {sub && <div className="dash-row-sub">{sub}</div>}
    </div>
  );
  const trailing = (
    <div className="flex shrink-0 items-center gap-2">
      {right}
      {actions}
    </div>
  );

  if (href && !actions) {
    return (
      <Link href={href} className="dash-row">
        {identity}
        {trailing}
      </Link>
    );
  }
  return (
    <div className="dash-row">
      {href ? (
        <Link href={href} className="dash-row-link">
          {identity}
        </Link>
      ) : (
        identity
      )}
      {trailing}
    </div>
  );
}

// The small outlined button that sits at the right end of a DashRow. Lives
// here rather than in one department's page so the second department to
// need one gets the same button, not a near-copy of it.
export function DashRowAction({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  const className =
    "rounded-md border border-[color:var(--dash-border)] px-2.5 py-1 text-xs font-medium text-[color:var(--dash-text-soft)] hover:border-[color:var(--dash-navy)] hover:text-[color:var(--dash-navy)]";
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

export function DashChip({ tone = "neutral", children }: { tone?: "neutral" | "good" | "info" | "critical"; children: ReactNode }) {
  return <span className={`dash-chip dash-${tone}`}>{children}</span>;
}

// The strip of numbers the main dashboard uses for its pipeline stages --
// each one optionally links somewhere that shows what it counts.
export function DashStatStrip({ stats }: { stats: { value: string; label: string; href?: string }[] }) {
  return (
    <div className="dash-card dash-pipeline-card">
      {stats.map((stat) =>
        stat.href ? (
          <Link key={stat.label} href={stat.href} className="dash-strip-stat">
            <span className="n">{stat.value}</span>
            <span className="l">{stat.label}</span>
          </Link>
        ) : (
          <div key={stat.label} className="dash-strip-stat">
            <span className="n">{stat.value}</span>
            <span className="l">{stat.label}</span>
          </div>
        ),
      )}
    </div>
  );
}

// An empty queue should read as done, not broken.
export function DashEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="dash-card">
      <div className="dash-row">
        <div className="dash-row-sub">{children}</div>
      </div>
    </div>
  );
}
