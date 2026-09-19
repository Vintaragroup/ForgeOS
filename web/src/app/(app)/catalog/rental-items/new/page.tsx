// Catalog redesign push 2: Materials and Rental Items merged into one
// numbered catalog at /catalog/items. These old URLs stay alive only as
// redirects, so bookmarks and links in old emails still land somewhere
// sensible. Removed with the legacy tables in push 3.
import { redirect } from "next/navigation";

export default function LegacyNewRedirect() {
  redirect("/catalog/items/new?type=RENTAL");
}
