import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getDocument, getDocumentBytes } from "@/lib/document-service";
import { renderDocx, renderSpreadsheet, highlightQuote, findSpreadsheetMatch } from "@/lib/document-view-service";
import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@/lib/ai/text-extraction";
import { getThreadMessages } from "@/lib/chat-service";
import { linkifyDocumentMentions } from "@/lib/citation";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { ChatWidget } from "@/components/chat-widget";

export const dynamic = "force-dynamic";

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

  const [opportunity, chatMessages, allDocuments] = await Promise.all([
    db.opportunity.findFirst({ where: { id }, select: { showName: true } }),
    getThreadMessages(id),
    db.document.findMany({ where: { opportunityId: id, deletedAt: null }, select: { id: true, filename: true } }),
  ]);

  const rawUrl = `/opportunities/${id}/documents/${documentId}`;
  // A Project Brief citation links here with ?page=N&q=<quote> for a PDF --
  // #page=N is genuine, well-supported native browser PDF viewer behavior.
  // #search=<text> was an attempt to also highlight the quote inside the
  // embedded PDF itself using Chromium's PDF viewer open parameters; that
  // didn't hold up in practice (unverifiable from this environment, and
  // confirmed not working), so it's dropped rather than left in as a
  // silent no-op. The ReferencedExcerpt callout below is what actually
  // shows the highlighted text now, for every file type uniformly.
  const inlineUrl = `${rawUrl}?inline=1${pageParam ? `#page=${pageParam}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref={`/opportunities/${id}`}
        backLabel="Documents"
        title={document.filename}
        action={<LinkButton href={rawUrl} variant="secondary">Download</LinkButton>}
      />

      {quoteParam && <ReferencedExcerpt quote={quoteParam} />}

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
        <SpreadsheetView documentId={documentId} quote={quoteParam} />
      ) : document.mimeType === DOCX_MIME ? (
        <DocxView documentId={documentId} quote={quoteParam} />
      ) : (
        <Card className="p-10 text-center text-sm text-neutral-500">
          This file type can&apos;t be previewed in-app. Download it to view it locally.
        </Card>
      )}

      {opportunity && (
        <ChatWidget
          opportunityId={id}
          opportunityName={opportunity.showName}
          initialMessages={chatMessages.map((m) => ({
            id: m.id,
            role: m.role,
            segments: linkifyDocumentMentions(m.content, id, allDocuments),
          }))}
        />
      )}
    </div>
  );
}

// The one piece of this citation flow that doesn't depend on any
// particular viewer's behavior: whatever quote the citation carries is
// shown here, marked exactly like a yellow highlighter, regardless of
// whether the PDF/DOCX viewer below it manages to scroll/highlight
// in-place on its own. Plain server-rendered HTML -- always renders the
// same way, unlike relying on an embedded PDF viewer's undocumented
// support for a search parameter.
function ReferencedExcerpt({ quote }: { quote: string }) {
  return (
    <Card className="border-l-4 border-amber-400 bg-amber-50 p-4">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">Referenced text</p>
      <p className="text-sm text-neutral-800">
        <mark style={{ background: "#fddfb1" }}>{quote}</mark>
      </p>
    </Card>
  );
}

async function SpreadsheetView({ documentId, quote }: { documentId: string; quote?: string }) {
  const { bytes } = await getDocumentBytes(documentId);
  const sheets = await renderSpreadsheet(bytes);
  // An estimate line item's "Source" link carries the exact cell text it
  // was imported from (pricing-import-service.ts) -- an equality match
  // against the same rendered rows, not a fuzzy search. The browser
  // natively scrolls to id="hl" on load via the URL's own #hl fragment,
  // same mechanism DocxView uses, no client JS needed.
  const match = quote ? findSpreadsheetMatch(sheets, quote) : null;

  return (
    <div className="flex flex-col gap-6">
      {sheets.map((sheet, sheetIndex) => (
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
                  {sheet.rows.map((row, i) => {
                    const isMatchRow = match && match.sheetIndex === sheetIndex && match.rowIndex === i;
                    return (
                      <tr
                        key={i}
                        id={isMatchRow ? "hl" : undefined}
                        className={`border-t border-neutral-100 first:border-t-0 ${isMatchRow ? "bg-amber-100" : ""}`}
                      >
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className={`whitespace-nowrap px-2 py-1 ${isMatchRow && match.cellIndex === j ? "font-semibold text-amber-900" : ""}`}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
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
