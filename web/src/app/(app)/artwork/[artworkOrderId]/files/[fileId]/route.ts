import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { db } from "@/lib/db";

// Mirrors documents/[documentId]/route.ts's own posture exactly: a directly
// URL-reachable route must independently check that fileId belongs to the
// URL's artworkOrderId AND that the requesting user can access the
// underlying opportunity -- never trust the detail page's own gating alone.
export async function GET(
  request: Request,
  { params }: RouteContext<"/artwork/[artworkOrderId]/files/[fileId]">,
) {
  const { artworkOrderId, fileId } = await params;
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  let file, bytes;
  try {
    ({ file, bytes } = await getArtworkFileBytes(fileId));
  } catch {
    notFound();
  }
  if (file.artworkOrderId !== artworkOrderId) notFound();

  const order = await db.artworkOrder.findUnique({ where: { id: artworkOrderId }, select: { opportunityId: true } });
  if (!order) notFound();

  const user = await getCurrentUser();
  if (!user || !(await canAccessOpportunity(user, order.opportunityId))) notFound();

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${file.filename}"`,
    },
  });
}
