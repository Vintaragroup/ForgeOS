import { notFound } from "next/navigation";
import { getDocumentBytes } from "@/lib/document-service";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/opportunities/[id]/documents/[documentId]">,
) {
  const { documentId } = await params;

  let document, bytes;
  try {
    ({ document, bytes } = await getDocumentBytes(documentId));
  } catch {
    notFound();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": document.mimeType,
      "Content-Disposition": `attachment; filename="${document.filename}"`,
    },
  });
}
