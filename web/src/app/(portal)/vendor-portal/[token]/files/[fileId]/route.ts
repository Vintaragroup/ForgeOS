import { notFound } from "next/navigation";
import { requirePortalAccess } from "@/lib/artwork-portal-auth";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";

// Mirrors client-portal's own file route exactly, scoped to VENDOR --
// the two are deliberately separate route files (not a shared parameterized
// one) so the vendor-anonymity boundary is a structural fact of the file
// layout, not something a shared function could accidentally blur later.
export async function GET(
  request: Request,
  { params }: RouteContext<"/vendor-portal/[token]/files/[fileId]">,
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
    await requirePortalAccess(token, { artworkOrderId: file.artworkOrderId, role: "VENDOR" });
  } catch {
    notFound();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": file.mimeType,
      // filename is already system-assigned (never the client's own
      // filename) -- see ArtworkFile's schema comment.
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${file.filename}"`,
    },
  });
}
