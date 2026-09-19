// Catalog redesign push 2: Materials and Rental Items merged into one
// numbered catalog at /catalog/items. These old URLs stay alive only as
// redirects, so bookmarks and links in old emails still land somewhere
// sensible. Removed with the legacy tables in push 3.
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";

// The id in the old URL is the legacy row's id -- scripts/migrate-catalog-
// to-unified.ts recorded which catalog item each one became.
export default async function LegacyDetailRedirect(props: PageProps<"/catalog/rental-items/[id]">) {
  const { id } = await props.params;
  const item = await db.catalogItem.findUnique({ where: { legacyRentalItemId: id }, select: { id: true } });
  if (!item) notFound();
  redirect(`/catalog/items/${item.id}`);
}
