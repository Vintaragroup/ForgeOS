import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getDocument, getDocumentBytes } from "@/lib/document-service";
import { renderDocx, renderSpreadsheet, highlightQuote } from "@/lib/document-view-service";
import { DOCX_MIME, PDF_MIME } from "@/lib/ai/text-extraction";
import { getThreadMessages } from "@/lib/chat-service";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { ChatWidget } from "@/components/chat-widget";

export const dynamic = "force-dynamic";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg"];

export default async function DocumentViewPage(
  props: PageProps<"/opportunities/[id]/documents/[documentId]/view">,
) {
  const { id, documentId } = await props.params;
  const { page, q } = await props.searchParams;
  const pageParam = Array.isArray(page) ? page[0] : page;
  const quoteParam = Array.isArray(q) ? q[0] : q;

  let document;
  try {
    document = await getDocument(documentId);
  } catch {
    notFound();
  }
  if (document.opportunityId !== id) notFound();

  const [opportunity, chatMessages] = await Promise.all([
    db.opportunity.findFirst({ where: { id }, select: { showName: true } }),
    getThreadMessages(id),
  ]);

  const rawUrl = `/opportunities/${id}/documents/${documentId}`;
  // A Project Brief citation (Phase 7.4) links here with ?page=N for a PDF
  // -- native browser PDF viewers honor a #page=N fragment on the src URL,
  // no PDF.js integration needed for this.
  const inlineUrl = `${rawUrl}?inline=1${pageParam ? `#page=${pageParam}` : ""}`;

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
          <img src={`${rawUrl}?inline=1`} alt={document.filename} className="max-w-full" />
        </Card>
      ) : document.mimeType === XLSX_MIME ? (
        <SpreadsheetView documentId={documentId} />
      ) : document.mimeType === DOCX_MIME ? (
        <DocxView documentId={documentId} quote={quoteParam} />
      ) : (
        <Card className="p-10 text-center text-sm text-neutral-500">
          This file type can&apos;t be previewed in-app. Download it to view it locally.
        </Card>
      )}

      {opportunity && (
        <ChatWidget opportunityId={id} opportunityName={opportunity.showName} initialMessages={chatMessages} />
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

async function DocxView({ documentId, quote }: { documentId: string; quote?: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const html = await renderDocx(bytes);
  const highlighted = quote ? highlightQuote(html, quote) : html;

  // The browser natively scrolls to <mark id="hl"> on load when the URL's
  // own fragment is #hl (see the Project Brief's citation links) -- no
  // client JS needed here, just making sure the id exists when it should.
  return (
    <Card className="p-8">
      <div className="docx-view text-sm" dangerouslySetInnerHTML={{ __html: highlighted }} />
    </Card>
  );
}
