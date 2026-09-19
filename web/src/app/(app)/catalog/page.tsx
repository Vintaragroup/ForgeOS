import { db } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";
import Link from "next/link";

// Counts must reflect live data -- see opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const [
    laborRateCount,
    catalogItemCount,
    taxRateCount,
    categoryCount,
    proposalTemplateCount,
    vendorCount,
    artworkSizeTierCount,
  ] = await Promise.all([
    db.laborRate.count({ where: { deletedAt: null } }),
    db.catalogItem.count({ where: { deletedAt: null } }),
    db.taxRate.count({ where: { deletedAt: null } }),
    db.category.count({ where: { deletedAt: null } }),
    db.proposalTemplate.count({ where: { deletedAt: null } }),
    db.vendor.count({ where: { deletedAt: null } }),
    db.artworkSizeTier.count({ where: { deletedAt: null } }),
  ]);

  const sections = [
    { href: "/catalog/labor-rates", label: "Labor rates", count: laborRateCount },
    // Rentals, materials, and services -- one numbered catalog since the
    // catalog redesign (was separate Materials / Rental items lists).
    { href: "/catalog/items", label: "Catalog items", count: catalogItemCount },
    { href: "/catalog/tax-rates", label: "Tax rates", count: taxRateCount },
    { href: "/catalog/categories", label: "Categories", count: categoryCount },
    { href: "/catalog/proposal-templates", label: "Proposal templates", count: proposalTemplateCount },
    { href: "/catalog/vendors", label: "Vendors", count: vendorCount },
    { href: "/catalog/artwork-size-tiers", label: "Artwork size tiers", count: artworkSizeTierCount },
  ];

  return (
    <div>
      <PageHeader title="Catalog" />
      <Card>
        <ul className="divide-y divide-neutral-200">
          {sections.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
              >
                <span className="font-medium">{section.label}</span>
                <span className="text-sm text-neutral-500">
                  {section.count} item{section.count === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
