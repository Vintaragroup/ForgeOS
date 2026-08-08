import { db } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";
import Link from "next/link";

export default async function CatalogPage() {
  const [laborRateCount, materialCount, rentalItemCount, proposalTemplateCount, vendorCount] = await Promise.all([
    db.laborRate.count({ where: { deletedAt: null } }),
    db.material.count({ where: { deletedAt: null } }),
    db.rentalItem.count({ where: { deletedAt: null } }),
    db.proposalTemplate.count({ where: { deletedAt: null } }),
    db.vendor.count({ where: { deletedAt: null } }),
  ]);

  const sections = [
    { href: "/catalog/labor-rates", label: "Labor rates", count: laborRateCount },
    { href: "/catalog/materials", label: "Materials", count: materialCount },
    { href: "/catalog/rental-items", label: "Rental items", count: rentalItemCount },
    { href: "/catalog/proposal-templates", label: "Proposal templates", count: proposalTemplateCount },
    { href: "/catalog/vendors", label: "Vendors", count: vendorCount },
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
