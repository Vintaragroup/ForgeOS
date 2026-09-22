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
  // Graphics stays narrow -- no pipeline, no directory, no shop floor --
  // but it has to reach every page the department actually works in.
  // It previously reached four of them and missed four: its own dashboard,
  // post-show, analytics, and shows. That last one mattered most: skids
  // and floor sections are managed on the show page, so the sign shop
  // could not open the page that creates the skids it packs.
  GR: [
    {
      label: "Graphics",
      items: [
        { href: "/departments/graphics", label: "Dashboard" },
        { href: "/departments/graphics/log", label: "Production Log" },
        { href: "/departments/graphics/post-show", label: "Post-show" },
        { href: "/departments/graphics/analytics", label: "Analytics" },
      ],
    },
    {
      label: "Production",
      items: [
        { href: "/artwork", label: "Artwork" },
        // Skids and floor sections live on a show.
        { href: "/shows", label: "Shows" },
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
