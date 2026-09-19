import Link from "next/link";
import { db } from "@/lib/db";
import { CATALOG_ITEM_TYPES } from "@/lib/catalog-item-service";
import { Button, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import type { CatalogItemType } from "@/generated/prisma/enums";
import { createCatalogItemAction } from "../actions";
import { CatalogItemFields, ITEM_TYPE_LABELS } from "../item-fields";

const TYPE_HELP: Record<CatalogItemType, string> = {
  RENTAL: "Something we own and rent out -- furniture, structure, A/V, flooring. Numbered R-…",
  MATERIAL: "Something we buy to build with -- sheet goods, lumber, hardware, substrates. Numbered M-…",
  SERVICE: "Time or a service we sell -- design time, shipping. Numbered S-…",
};

// Two steps on purpose: type first (it decides the number's prefix and is
// fixed forever after -- see catalog-item-service.ts), then the fields for
// that type (the cut-list stock section only shows for materials).
export default async function NewCatalogItemPage(props: PageProps<"/catalog/items/new">) {
  const params = await props.searchParams;
  const rawType = Array.isArray(params.type) ? params.type[0] : params.type;
  const itemType = CATALOG_ITEM_TYPES.includes(rawType as CatalogItemType) ? (rawType as CatalogItemType) : null;

  if (!itemType) {
    return (
      <div>
        <PageHeader title="New catalog item" backHref="/catalog/items" backLabel="Catalog items" />
        <p className="mb-4 text-sm text-neutral-600">
          What kind of item is it? This sets the first letter of its catalog number and can&apos;t be changed later.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {CATALOG_ITEM_TYPES.map((t) => (
            <Link key={t} href={`/catalog/items/new?type=${t}`} className="block">
              <Card className="h-full p-5 hover:border-neutral-400">
                <div className="font-medium">{ITEM_TYPE_LABELS[t]}</div>
                <p className="mt-1 text-sm text-neutral-500">{TYPE_HELP[t]}</p>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const categories = await db.catalogCategory.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });

  return (
    <div>
      <PageHeader title={`New ${ITEM_TYPE_LABELS[itemType].toLowerCase()}`} backHref="/catalog/items" backLabel="Catalog items" />
      <Card className="p-6">
        <p className="mb-4 text-sm text-neutral-500">
          The catalog number is assigned when you save.{" "}
          <Link href="/catalog/items/new" className="underline">
            Change type
          </Link>
        </p>
        <ActionForm action={createCatalogItemAction} className="flex flex-col gap-4">
          <input type="hidden" name="itemType" value={itemType} />
          <CatalogItemFields itemType={itemType} categories={categories} />
          <div>
            <Button>Create item</Button>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
