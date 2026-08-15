// Cut-list phase 9: downloadable example CSV for the bulk-import form
// right above it on the page -- content is generic (header row + one
// example row), not specific to this estimate/version, so this only
// needs an auth check (not the full estimate-access + opportunity check
// every other route under cut-list/ does), same posture as any other
// signed-in-only static download.
import { getCurrentUser } from "@/lib/auth";
import { buildCsvTemplate } from "@/lib/cut-list-import-service";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  return new Response(buildCsvTemplate(), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="cut-list-import-template.csv"`,
    },
  });
}
