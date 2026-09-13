import type { Metadata } from "next";
import { Geist, Geist_Mono, Bebas_Neue } from "next/font/google";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "./logout/actions";
import { AppNav, type NavGroup } from "@/components/app-nav";
import { DEPARTMENT_NAV, DEPARTMENT_HOME, DEPARTMENT_LABELS } from "@/lib/department-home";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Substitute for the brand guide's licensed "Bebas Neue Pro SemiExpanded" --
// we don't have that font file, so we use the free single-weight Bebas Neue
// from Google Fonts, which is visually very close.
const bebasNeue = Bebas_Neue({
  variable: "--font-bebas-neue",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ForgeOS",
  description: "ForgeOS — CRM & opportunity shell",
};

// Four clusters instead of nine flat peer tabs -- see the UX field report
// (Aug 2026): Pipeline groups the linear sales workflow (a lead becomes an
// estimate becomes a proposal), Directory groups "who" lookups, Catalog
// mirrors its own existing hub page. Groups with a single item render as a
// plain link in AppNav rather than a one-item dropdown.
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Calendar",
    items: [{ href: "/calendar", label: "Calendar" }],
  },
  {
    label: "Pipeline",
    items: [
      { href: "/shows", label: "Shows" },
      { href: "/opportunities", label: "Opportunities" },
      { href: "/estimates", label: "Estimates" },
      { href: "/proposals", label: "Proposals" },
      { href: "/reports", label: "Reports" },
    ],
  },
  {
    label: "Production",
    items: [
      { href: "/projects", label: "Projects" },
      { href: "/artwork", label: "Artwork" },
    ],
  },
  {
    label: "Directory",
    items: [
      { href: "/companies", label: "Companies" },
      { href: "/contacts", label: "Contacts" },
      { href: "/users", label: "Users" },
    ],
  },
  {
    label: "Catalog",
    items: [
      { href: "/catalog", label: "All catalog" },
      { href: "/catalog/labor-rates", label: "Labor rates" },
      { href: "/catalog/materials", label: "Materials" },
      { href: "/catalog/rental-items", label: "Rental items" },
      { href: "/catalog/proposal-templates", label: "Proposal templates" },
      { href: "/catalog/vendors", label: "Vendors" },
      { href: "/catalog/artwork-size-tiers", label: "Artwork size tiers" },
      { href: "/catalog/cut-list-settings", label: "Cut list settings" },
    ],
  },
];

// An admin's own department (if any) never scopes their nav down -- see the
// isAdmin short-circuit below -- but admins still need a way to actually
// reach a department's dashboard, since department pages themselves have no
// admin-specific link anywhere else. Built from DEPARTMENT_HOME so a new
// department shows up here automatically, with no second place to remember
// to update.
const DEPARTMENTS_NAV_GROUP: NavGroup = {
  label: "Departments",
  items: Object.entries(DEPARTMENT_HOME).map(([code, href]) => ({
    href,
    label: DEPARTMENT_LABELS[code] ?? code,
  })),
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const isAdmin = user?.systemRole === "ADMIN" || user?.systemRole === "SUPER_ADMIN";
  // A department-scoped user sees only their department's handful of pages
  // -- an admin always sees the full nav regardless of their own department
  // (matches the same isAdmin short-circuit the / redirect uses), plus a
  // "Departments" group so they can actually get to any department's
  // dashboard rather than only being able to reach it by typing the URL.
  const navGroups =
    !isAdmin && user?.departmentCode && DEPARTMENT_NAV[user.departmentCode]
      ? DEPARTMENT_NAV[user.departmentCode]
      : isAdmin
        ? [...NAV_GROUPS, DEPARTMENTS_NAV_GROUP]
        : NAV_GROUPS;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bebasNeue.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900">
        <header className="bg-brand-black text-white">
          <AppNav
            groups={navGroups}
            adminLink={isAdmin ? { href: "/admin/users", label: "Admin" } : null}
            userName={user?.name ?? null}
            logoutAction={logoutAction}
          />
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
