import { notFound } from "next/navigation";
import { requirePortalAccess } from "@/lib/artwork-portal-auth";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";

// Mirrors documents/[documentId]/route.ts's posture: independently verify
// fileId belongs to the token's own artworkOrderId, never trust the page's
// gating alone. requirePortalAccess here is doing real work, unlike the
// simpler token-only actions.ts helper -- fileId is a SEPARATE identifier
// from the token, so it must be proven to belong to the same order.
export async function GET(
  request: Request,
  { params }: RouteContext<"/client-portal/[token]/files/[fileId]">,
) {
  const { token, fileId } = await params;
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  let file, bytes;
  try {
    ({ file, bytes } = await getArtworkFileBytes(fileId));
  } catch {
    notFound();
  }

  try {
    await requirePortalAccess(token, { artworkOrderId: file.artworkOrderId, role: "CLIENT" });
  } catch {
    notFound();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${file.filename}"`,
    },
  });
}
