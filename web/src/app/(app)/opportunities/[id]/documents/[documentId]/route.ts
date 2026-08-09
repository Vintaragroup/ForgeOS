import { notFound } from "next/navigation";
import { getDocumentBytes } from "@/lib/document-service";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";

// ?inline=1 renders in the browser (used by the /view page's <iframe>/<img>
// for PDFs and images); omitted, it downloads -- same route, same bytes,
// just a different Content-Disposition.
//
// This is the raw byte-serving route, independently reachable by URL --
// it must check both that documentId actually belongs to the URL's
// opportunity id AND that the requesting user can access that
// opportunity, the same two checks the /view page makes for itself.
// Previously this route checked neither, making it the single most
// exposed endpoint in the app: any authenticated user who obtained a
// documentId (e.g. one shown to them earlier, or guessed) could fetch
// the raw file regardless of which opportunity it belonged to.
export async function GET(
  request: Request,
  { params }: RouteContext<"/opportunities/[id]/documents/[documentId]">,
) {
  const { id, documentId } = await params;
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  let document, bytes;
  try {
    ({ document, bytes } = await getDocumentBytes(documentId));
  } catch {
    notFound();
  }
  if (document.opportunityId !== id) notFound();

  const user = await getCurrentUser();
  if (!user || !(await canAccessOpportunity(user, document.opportunityId))) notFound();

  const safeFilename = document.filename.replace(/"/g, "");

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": document.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeFilename}"`,
    },
  });
}
