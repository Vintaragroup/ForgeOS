import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { getGraphicsOrders } from "@/lib/artwork-hub";
import { STATUS_GROUPS, clientLabelOf } from "@/lib/graphics-breakdowns";

// A plain GET download, not a Server Action -- a Server Action's return
// value goes through the RSC protocol, not a raw Response, so it can't set
// Content-Disposition/Content-Type for a file download. Same pattern as
// proposals/[id]/pdf/route.ts. Reachable from the Production Log page's own
// "Export CSV" link and the Graphics dashboard's kebab menu, both of which
// just link here -- no separate action needed.
//
// Filters mirror the Production Log page's own query params exactly (same
// names, same semantics) so a link built from that page's current filter
// state exports exactly what's on screen, not the unfiltered full log.
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Not authenticated", { status: 401 });

  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  if (!isAdmin && !canAccessArtworkOrdersViaDepartment(user)) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const logClient = url.searchParams.get("logClient");
  const logStatus = url.searchParams.get("logStatus");
  const logStatusGroup = url.searchParams.get("logStatusGroup");
  const logVendor = url.searchParams.get("logVendor");
  const logMaterial = url.searchParams.get("logMaterial");
  const logShow = url.searchParams.get("logShow");
  // Mirrors the page exactly. An export that quietly covered a different
  // set than the screen showed would be worse than no export.
  const includeArchived = url.searchParams.get("logArchived") === "1";

  const orders = await getGraphicsOrders(user, { includeArchived });
  const filtered = orders.filter((o) => {
    if (logClient && clientLabelOf(o) !== logClient) return false;
    if (logStatus && o.status !== logStatus) return false;
    if (logStatusGroup && !(STATUS_GROUPS[logStatusGroup]?.statuses.includes(o.status) ?? false)) return false;
    if (logVendor && o.vendor?.name !== logVendor) return false;
    if (logMaterial && o.material !== logMaterial) return false;
    if (logShow && (o.show?.name ?? o.opportunity?.show?.name ?? null) !== logShow) return false;
    return true;
  });

  // RFC 4180: a field containing a comma, quote, or newline gets wrapped in
  // quotes with any embedded quote doubled -- everything else passes
  // through as-is rather than quoting every field, which is friendlier to
  // skim if someone opens the raw file in a text editor.
  function csvField(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  const header = ["Client", "Show", "Job code", "Piece", "Material", "Qty", "Vendor", "Status", "Existing/New", "Art due", "Designer"];
  const rows = filtered.map((o) =>
    [
      clientLabelOf(o),
      o.opportunity?.showName ?? o.show?.name ?? "",
      o.jobCode,
      o.graphicCode ?? "",
      o.material ?? "",
      String(o.qty),
      o.vendor?.name ?? "",
      o.status.replaceAll("_", " "),
      o.existingGraphicsStatus ?? "",
      o.artDueDate ? o.artDueDate.toISOString().slice(0, 10) : "",
      o.designer?.name ?? "",
    ]
      .map(csvField)
      .join(","),
  );

  const csv = [header.join(","), ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="graphics-production-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
