import type { NavGroup } from "@/components/app-nav";

// Single source of truth for department-scoped routing -- both the root
// redirect (page.tsx) and the nav filter (layout.tsx) key off this same
// map, so they can't silently drift apart (a department landing here with
// no matching nav entries, or vice versa).
export const DEPARTMENT_HOME: Record<string, string> = {
  GR: "/departments/graphics",
  SL: "/sales",
};

// Display label for each department's dashboard -- keyed off the same
// department codes as DEPARTMENT_HOME so an admin's "Departments" nav group
// (RootLayout) can list every department dashboard without a third map to
// keep in sync.
export const DEPARTMENT_LABELS: Record<string, string> = {
  GR: "Graphics",
  SL: "Sales",
};

// Deliberately hand-built per department rather than derived from the main
// NAV_GROUPS -- a department-scoped user should see exactly the handful of
// pages relevant to them, not "everything except a blocklist," so a new
// item added to the main nav later doesn't silently leak into a
// department's filtered view without a deliberate decision here.
export const DEPARTMENT_NAV: Record<string, NavGroup[]> = {
  // Sales keeps a wide nav on purpose, unlike Graphics: a rep's job spans
  // the whole pipeline (their own book, the shows they sell into, the
  // estimate and proposal on each deal) plus the directory they live in.
  // What's left out is the shop floor -- projects, tasks, the catalog.
  SL: [
    {
      label: "Pipeline",
      items: [
        { href: "/sales", label: "My sales" },
        { href: "/shows", label: "Shows" },
        { href: "/opportunities", label: "Opportunities" },
        { href: "/estimates", label: "Estimates" },
        { href: "/proposals", label: "Proposals" },
      ],
    },
    {
      label: "Directory",
      items: [
        { href: "/companies", label: "Companies" },
        { href: "/contacts", label: "Contacts" },
      ],
    },
    {
      label: "Schedule",
      items: [
        { href: "/calendar", label: "Calendar" },
        { href: "/tasks", label: "Tasks" },
      ],
    },
  ],
  GR: [
    {
      label: "Production",
      items: [
        { href: "/artwork", label: "Artwork" },
        { href: "/departments/graphics/log", label: "Production Log" },
        { href: "/tasks", label: "Tasks" },
        { href: "/calendar", label: "Calendar" },
      ],
    },
    {
      label: "Catalog",
      items: [
        { href: "/catalog/vendors", label: "Vendors" },
        { href: "/catalog/artwork-size-tiers", label: "Artwork size tiers" },
      ],
    },
  ],
};
