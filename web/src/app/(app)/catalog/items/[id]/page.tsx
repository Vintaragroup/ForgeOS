import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { Button, Card, Field, PageHeader, SelectField, StatusChip } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { ConfirmForm } from "@/components/confirm-form";
import { addAliasAction, removeAliasAction, retireCatalogItemAction, updateCatalogItemAction } from "../actions";
import { CatalogItemFields, ITEM_TYPE_LABELS } from "../item-fields";

export default async function CatalogItemPage(props: PageProps<"/catalog/items/[id]">) {
  const { id } = await props.params;
  const [item, categories, offices, user] = await Promise.all([
    db.catalogItem.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: true,
        tags: { include: { tag: true }, orderBy: { tag: { name: "asc" } } },
        aliases: { include: { office: true }, orderBy: { createdAt: "asc" } },
        _count: { select: { cutListParts: { where: { deletedAt: null } } } },
      },
    }),
    db.catalogCategory.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } }),
    db.office.findMany({ where: { deletedAt: null }, orderBy: [{ isStandard: "desc" }, { name: "asc" }] }),
    getCurrentUser(),
  ]);
  if (!item) notFound();
  const isAdmin = user?.systemRole === "ADMIN" || user?.systemRole === "SUPER_ADMIN";

  const updateWithId = updateCatalogItemAction.bind(null, item.id);
  const addAliasWithId = addAliasAction.bind(null, item.id);
  const retireWithId = retireCatalogItemAction.bind(null, item.id);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-lg text-neutral-500">{item.catalogNumber}</span>
            <span>{item.name}</span>
          </span>
        }
        backHref="/catalog/items"
        backLabel="Catalog items"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
        <StatusChip tone="neutral">{ITEM_TYPE_LABELS[item.itemType]}</StatusChip>
        <span>
          {item.category.code} — {item.category.name}
        </span>
        {item._count.cutListParts > 0 && <span>· used by {item._count.cutListParts} cut-list part(s)</span>}
      </div>

      <Card className="mb-6 p-6">
        <p className="mb-4 text-xs text-neutral-500">
          The catalog number and type never change -- not on rename, not when the category changes -- so
          anything that quotes {item.catalogNumber} stays valid.
        </p>
        <ActionForm action={updateWithId} className="flex flex-col gap-4">
          <CatalogItemFields
            itemType={item.itemType}
            categories={categories}
            item={item}
            tagNames={item.tags.map((t) => t.tag.name)}
          />
          <div>
            <Button>Save changes</Button>
          </div>
        </ActionForm>
      </Card>

      <Card className="mb-6 p-6">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Also known as</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Other names this item goes by -- another office&apos;s name for it, or how it tends to be written on
          estimates. Automatic price matching on imports checks these too.
        </p>
        {item.aliases.length > 0 && (
          <ul className="mb-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {item.aliases.map((alias) => (
              <li key={alias.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <div>
                  <span className="font-medium">{alias.alias}</span>
                  {(alias.office || alias.source) && (
                    <span className="ml-2 text-xs text-neutral-500">
                      {[alias.office?.name, alias.source].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </div>
                <form action={removeAliasAction.bind(null, item.id, alias.id)}>
                  <button type="submit" className="text-xs text-neutral-500 hover:text-red-700">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={addAliasWithId} resetOnSuccess className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label="Other name" name="alias" required placeholder="e.g. FR Carpet" />
          </div>
          <div className="min-w-40">
            <SelectField
              label="Office"
              name="officeCode"
              options={[{ value: "", label: "— any —" }, ...offices.map((o) => ({ value: o.code, label: o.name }))]}
            />
          </div>
          <div className="min-w-48">
            <Field label="Source" name="source" placeholder="e.g. MIA inventory sheet" />
          </div>
          <Button variant="secondary">Add alias</Button>
        </ActionForm>
      </Card>

      {isAdmin && (
        <ConfirmForm
          action={retireWithId}
          confirmMessage={`Retire ${item.catalogNumber}? It disappears from the catalog, and its number is never reused.`}
        >
          <Button variant="danger">Retire item</Button>
        </ConfirmForm>
      )}
    </div>
  );
}
