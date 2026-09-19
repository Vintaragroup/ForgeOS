import Link from "next/link";
import { db } from "@/lib/db";
import { CATALOG_ITEM_TYPES, searchCatalogItems } from "@/lib/catalog-item-service";
import { Card, CollapsibleSection, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import type { CatalogItemType } from "@/generated/prisma/enums";
import { ITEM_TYPE_LABELS } from "./item-fields";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

// Same posture as the old Materials page: big groups (sheet goods, BeMatrix)
// start closed so the page doesn't open on a wall of rows -- unless the
// user is searching, when every hit should be visible immediately.
const DEFAULT_OPEN_THRESHOLD = 20;

function money(value: { toString(): string } | null) {
  return value == null ? null : `$${Number(value.toString()).toFixed(2)}`;
}

export default async function CatalogItemsPage(props: PageProps<"/catalog/items">) {
  const params = await props.searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const q = one(params.q).trim();
  const rawType = one(params.type);
  const itemType = CATALOG_ITEM_TYPES.includes(rawType as CatalogItemType) ? (rawType as CatalogItemType) : undefined;
  const categoryCode = one(params.category) || undefined;
  const tag = one(params.tag) || undefined;
  const isFiltered = Boolean(q || itemType || categoryCode || tag);

  const [items, categories, tags, totalCount] = await Promise.all([
    searchCatalogItems({ q, itemType, categoryCode, tag }),
    db.catalogCategory.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } }),
    db.catalogTag.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { items: true } } } }),
    db.catalogItem.count({ where: { deletedAt: null } }),
  ]);

  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.category.code} — ${item.category.name}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const newHref = itemType ? `/catalog/items/new?type=${itemType}` : "/catalog/items/new";
  const selectClass = "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm";

  return (
    <div>
      <PageHeader
        title="Catalog items"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href={newHref}>New item</LinkButton>}
      />

      <Card className="mb-6 p-4">
        {/* Plain GET form -- filters live in the URL, so a filtered view can be bookmarked or shared. */}
        <form className="flex flex-wrap items-end gap-3" action="/catalog/items">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Search</span>
            <input
              name="q"
              defaultValue={q}
              placeholder="Catalog #, name, alias, or tag -- e.g. R-FUR, sofa, fr-rated"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Type</span>
            <select name="type" defaultValue={itemType ?? ""} className={selectClass}>
              <option value="">All types</option>
              {CATALOG_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Category</span>
            <select name="category" defaultValue={categoryCode ?? ""} className={selectClass}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          {tags.length > 0 && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-neutral-700">Tag</span>
              <select name="tag" defaultValue={tag ?? ""} className={selectClass}>
                <option value="">Any tag</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name} ({t._count.items})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            className="rounded-md bg-brand-black px-4 py-2 text-sm font-medium text-white hover:bg-brand-navy"
          >
            Filter
          </button>
          {isFiltered && (
            <Link href="/catalog/items" className="py-2 text-sm text-neutral-500 hover:text-neutral-900">
              Clear
            </Link>
          )}
        </form>
      </Card>

      <p className="mb-3 text-sm text-neutral-500">
        {isFiltered ? `${items.length} of ${totalCount} items match.` : `${totalCount} items.`} Orlando&apos;s catalog is
        the company standard.
      </p>

      {items.length === 0 ? (
        <EmptyState message={isFiltered ? "Nothing matches those filters." : "No catalog items yet."} />
      ) : (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([label, groupItems]) => (
            <CollapsibleSection
              key={label}
              title={`${label} (${groupItems.length})`}
              defaultOpen={isFiltered || groupItems.length <= DEFAULT_OPEN_THRESHOLD}
            >
              <Card className="overflow-hidden">
                <ul className="divide-y divide-neutral-200">
                  {groupItems.map((item) => {
                    const price = item.itemType === "MATERIAL" ? item.unitCost ?? item.unitPrice : item.unitPrice ?? item.unitCost;
                    const priceLabel = item.itemType === "MATERIAL" && item.unitCost != null ? "cost" : "price";
                    return (
                      <li key={item.id}>
                        <Link
                          href={`/catalog/items/${item.id}`}
                          className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-neutral-50"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="shrink-0 font-mono text-xs text-neutral-500">{item.catalogNumber}</span>
                            <span className="truncate font-medium">{item.name}</span>
                            {item.tags.map(({ tag: t }) => (
                              <span
                                key={t.id}
                                className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600"
                              >
                                {t.name}
                              </span>
                            ))}
                          </div>
                          <div className="shrink-0 text-sm font-medium text-neutral-700">
                            {money(price) ?? "—"}
                            {item.unit ? ` / ${item.unit}` : ""}
                            <span className="ml-1 text-xs font-normal text-neutral-400">{priceLabel}</span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </CollapsibleSection>
          ))}
        </div>
      )}
    </div>
  );
}
