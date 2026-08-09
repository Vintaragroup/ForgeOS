import { notFound } from "next/navigation";
import { getDocument, getDocumentBytes } from "@/lib/document-service";
import { renderDocx, renderSpreadsheet } from "@/lib/document-view-service";
import { Card, LinkButton, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const PDF_MIME = "application/pdf";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg"];

export default async function DocumentViewPage(
  props: PageProps<"/opportunities/[id]/documents/[documentId]/view">,
) {
  const { id, documentId } = await props.params;

  let document;
  try {
    document = await getDocument(documentId);
  } catch {
    notFound();
  }
  if (document.opportunityId !== id) notFound();

  const rawUrl = `/opportunities/${id}/documents/${documentId}`;
  const inlineUrl = `${rawUrl}?inline=1`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref={`/opportunities/${id}`}
        backLabel="Documents"
        title={document.filename}
        action={<LinkButton href={rawUrl} variant="secondary">Download</LinkButton>}
      />

      {document.mimeType === PDF_MIME ? (
        <Card className="overflow-hidden">
          <iframe src={inlineUrl} title={document.filename} className="h-[85vh] w-full" />
        </Card>
      ) : IMAGE_MIMES.includes(document.mimeType) ? (
        <Card className="flex justify-center p-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded content from private storage, not an optimizable static asset */}
          <img src={inlineUrl} alt={document.filename} className="max-w-full" />
        </Card>
      ) : document.mimeType === XLSX_MIME ? (
        <SpreadsheetView documentId={documentId} />
      ) : document.mimeType === DOCX_MIME ? (
        <DocxView documentId={documentId} />
      ) : (
        <Card className="p-10 text-center text-sm text-neutral-500">
          This file type can&apos;t be previewed in-app. Download it to view it locally.
        </Card>
      )}
    </div>
  );
}

async function SpreadsheetView({ documentId }: { documentId: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const sheets = await renderSpreadsheet(bytes);

  return (
    <div className="flex flex-col gap-6">
      {sheets.map((sheet) => (
        <Card key={sheet.name} className="p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {sheet.name}
          </h2>
          {sheet.rows.length === 0 ? (
            <p className="text-sm text-neutral-400">Empty sheet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-neutral-200">
              <table className="w-full text-xs">
                <tbody>
                  {sheet.rows.map((row, i) => (
                    <tr key={i} className="border-t border-neutral-100 first:border-t-0">
                      {row.map((cell, j) => (
                        <td key={j} className="whitespace-nowrap px-2 py-1">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

async function DocxView({ documentId }: { documentId: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const html = await renderDocx(bytes);

  return (
    <Card className="p-8">
      <div className="docx-view text-sm" dangerouslySetInnerHTML={{ __html: html }} />
    </Card>
  );
}
