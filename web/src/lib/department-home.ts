import type { NavGroup } from "@/components/app-nav";

// Single source of truth for department-scoped routing -- both the root
// redirect (page.tsx) and the nav filter (layout.tsx) key off this same
// map, so they can't silently drift apart (a department landing here with
// no matching nav entries, or vice versa).
export const DEPARTMENT_HOME: Record<string, string> = {
  GR: "/departments/graphics",
};

// Deliberately hand-built per department rather than derived from the main
// NAV_GROUPS -- a department-scoped user should see exactly the handful of
// pages relevant to them, not "everything except a blocklist," so a new
// item added to the main nav later doesn't silently leak into a
// department's filtered view without a deliberate decision here.
export const DEPARTMENT_NAV: Record<string, NavGroup[]> = {
  GR: [
    { label: "Production", items: [{ href: "/artwork", label: "Artwork" }] },
    {
      label: "Catalog",
      items: [
        { href: "/catalog/vendors", label: "Vendors" },
        { href: "/catalog/artwork-size-tiers", label: "Artwork size tiers" },
      ],
    },
  ],
};
