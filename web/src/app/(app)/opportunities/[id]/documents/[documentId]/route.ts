import { notFound } from "next/navigation";
import { getDocumentBytes } from "@/lib/document-service";

// ?inline=1 renders in the browser (used by the /view page's <iframe>/<img>
// for PDFs and images); omitted, it downloads -- same route, same bytes,
// just a different Content-Disposition.
export async function GET(
  request: Request,
  { params }: RouteContext<"/opportunities/[id]/documents/[documentId]">,
) {
  const { documentId } = await params;
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  let document, bytes;
  try {
    ({ document, bytes } = await getDocumentBytes(documentId));
  } catch {
    notFound();
  }

  const safeFilename = document.filename.replace(/"/g, "");

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": document.mimeType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeFilename}"`,
    },
  });
}
