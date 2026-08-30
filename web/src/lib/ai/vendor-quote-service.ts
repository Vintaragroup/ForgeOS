// Extracts a vendor's own priced line items from an already-analyzed
// VENDOR_QUOTE document's text -- the gap this closes: neither of
// ForgeOS's other two document-ingestion pipelines ever captures a
// price. pricing-import-service.ts's Pricing Schedule importer seeds
// unitCost only from a catalog match (its own Unit Rate column is blank
// by design); scope-line-item-service.ts's proposeLineItemsFromScope has
// no price field in its extraction schema at all. A vendor's quoted
// dollar amount has never had anywhere to land until now.
//
// Deliberately smaller than proposeLineItemsFromScope: no multi-project
// classification pass -- a vendor quote is already scoped to one known
// BidPackage's line items by the time this runs (see bid-package-
// actions.ts), no cross-project ambiguity to resolve -- and no
// category/lineType, since this is matched against EXISTING line items
// (vendor-match-ai-service.ts) to propose a price update, never used to
// create new sections the way a scope proposal is.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { extractPdfPageTexts, locateQuotePage, resolveHighlightableQuote, PDF_MIME } from "@/lib/ai/text-extraction";
import { getDocumentBytes } from "@/lib/document-service";
import { BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { addLineItemsBulk, findOrCreateSection } from "@/lib/estimate-service";
import type { VendorQuoteLine } from "@/lib/ai/vendor-match-ai-service";

const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from the document text above, showing where this line item and its price come from. Never paraphrase or summarize the quote itself.";

function buildVendorQuoteSchema() {
  return {
    name: "vendor_quote_line_items",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              unit: {
                type: "string",
                description: "The unit this line is priced by -- EA, SQFT, LF, HR, LOT, WK, etc. Empty string if none is stated.",
              },
              qty: { type: ["number", "null"], description: "The quantity stated for this line, or null if none is stated." },
              unitPrice: { type: "number", description: "The per-unit price for this line, in dollars." },
              totalPrice: {
                type: ["number", "null"],
                description: "This line's own stated total/extended price, or null if the document doesn't show one separately from unitPrice.",
              },
              sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
              unitCode: {
                type: ["string", "null"],
                description:
                  "The nearest preceding unit/section header this line is grouped under, if the document organizes its priced lines into labeled blocks (e.g. \"CAM-06\", \"BTH-04\", \"Section 203\") -- copy the header exactly as written. Null if the document has no such per-item grouping structure.",
              },
            },
            required: ["description", "unit", "qty", "unitPrice", "totalPrice", "sourceQuote", "unitCode"],
          },
        },
      },
      required: ["items"],
    },
  } as const;
}

const SYSTEM_PROMPT = `You read a vendor's price quote for an event/exhibit contractor and extract every distinct priced line item in it -- the individual goods/services/labor items the vendor is charging for, at whatever granularity the quote itself uses (don't merge or split lines the vendor kept separate).

For each item:
- description: the item's own description, as the vendor wrote it -- don't add context from elsewhere in the document (e.g. a section header) unless it's actually part of that line's own text.
- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT, WK) if the document states or implies one, otherwise an empty string.
- qty: the quantity actually stated for this line, or null if none is given -- never guess a number that isn't written down.
- unitPrice: the per-unit dollar price for this line.
- totalPrice: this line's own stated extended/total price if the document shows one separately from unitPrice, otherwise null.
- sourceQuote: a short verbatim quote copied EXACTLY from the document showing where this item and its price come from.
- unitCode: if this document organizes its priced lines into labeled blocks (a unit or section code like "CAM-06", "BTH-04", "Section 203" that several consecutive lines fall under), copy that block's own header exactly. Otherwise null -- don't invent a code the document doesn't actually use.

Only extract lines that represent an actual priced item -- skip subtotals, section headers, terms and conditions, and narrative text entirely. If the document has no priced line items at all, return an empty items array rather than inventing something.`;

// Same ceiling and reasoning as scope-line-item-service.ts's own
// MAX_INPUT_CHARS.
const MAX_INPUT_CHARS = 150_000;

type VendorQuoteLineFromAI = {
  description: string;
  unit: string;
  qty: number | null;
  unitPrice: number;
  totalPrice: number | null;
  sourceQuote: string;
  unitCode: string | null;
};

// opportunityId is the caller's already-access-checked opportunity, NOT
// trusted from documentId alone -- same rationale as
// proposeLineItemsFromScope's own header comment (cost-bearing AI call
// that also writes its result back onto the document).
export async function proposeVendorQuoteLineItems(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
) {
  const document = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId } });
  if (!document.extractedText) {
    throw new Error(`"${document.filename}" hasn't been analyzed yet -- click Analyze on it first.`);
  }

  // Throws AiNotConfiguredError before any DB write, same posture as
  // every other AI-proposal function in this app.
  const client = getOpenAiClient();
  const truncatedText = document.extractedText.slice(0, MAX_INPUT_CHARS);

  const completion = await client.chat.completions.create({
    model: BASIC_MODEL,
    // Low, not zero -- exhaustive extraction against a fixed shape, not
    // creative writing, same reasoning as scope-line-item-service.ts's
    // identical pin.
    temperature: 0.2,
    // Confirmed necessary against a real quote: a 217-line vendor binder
    // (ShowRig's Super Bowl scaffolding quote) produces a JSON response
    // long enough that, without this, the completion sometimes gets cut
    // off mid-string before the array closes -- JSON.parse below then
    // throws an opaque "Unterminated string" instead of a usable error.
    // gpt-4o-mini's real output ceiling is 16384 tokens; asking for the
    // full budget explicitly removes any smaller implicit default as a
    // variable, whether or not that was the actual cause this time.
    max_completion_tokens: 16384,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Document: ${document.filename}\n\n${truncatedText}` },
    ],
    response_format: { type: "json_schema", json_schema: buildVendorQuoteSchema() },
  });

  await recordAiUsage({
    userId,
    feature: "VENDOR_QUOTE_LINE_ITEMS",
    model: BASIC_MODEL,
    usage: completion.usage,
    documentId,
    opportunityId: document.opportunityId,
  });

  const choice = completion.choices[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  // A truncated response is a real, distinguishable outcome (finish_reason
  // "length"), not a parse bug -- give the user something actionable
  // instead of a raw SyntaxError, since JSON.parse on a cut-off string
  // always fails and the real cause (too many priced lines for one pass)
  // is a document-size limit, not a code defect to retry blindly against.
  if (choice.finish_reason === "length") {
    throw new Error(
      `"${document.filename}" has too many priced lines to extract in a single pass -- the response was cut off before finishing. Splitting this document (or the relevant pages) into a smaller upload would let this complete.`,
    );
  }
  const parsed = JSON.parse(content) as { items: VendorQuoteLineFromAI[] };

  // Same "→" citation link this app already uses elsewhere (see
  // citation.ts's citationHref) needs a real PDF page number, not just
  // the quote string -- resolved once per document, same lazy PDF-only
  // pattern as scope-coverage-service.ts's resolveCoverageGaps. A
  // reviewer looking at a bare "Test and adjust" line can click through
  // to the actual page and see the surrounding table for context this
  // app can't itself infer.
  const pageTexts = document.mimeType === PDF_MIME ? await extractPdfPageTexts((await getDocumentBytes(documentId)).bytes) : null;

  // Same discipline as scope-line-item-service.ts: resolve every quote
  // against the real extracted text so the review table's "Source" link
  // is a genuine excerpt, not whatever the model happened to return.
  const items: VendorQuoteLine[] = parsed.items.map((item) => {
    const sourceQuote = resolveHighlightableQuote(document.extractedText!, item.sourceQuote);
    return {
      description: item.description,
      unit: item.unit || null,
      qty: item.qty,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      sourceQuote,
      unitCode: item.unitCode || null,
      pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
    };
  });

  return db.document.update({
    where: { id: documentId },
    data: { vendorQuoteLineItems: items as unknown as Prisma.InputJsonValue },
  });
}

// The "Import from document" path for a standalone vendor-quote PDF with
// no pre-existing matching line items -- e.g. a booth graphics vendor's
// own itemized quote, uploaded before any estimate line exists to match
// it against. createBidPackage (estimate-service.ts) refuses to create a
// package with zero seed line items, which is the wrong fit here; this
// reuses proposeVendorQuoteLineItems's own extraction wholesale (same
// schema/prompt/model, same Document.vendorQuoteLineItems cache field --
// safe to share, a given document only ever goes through one of these
// two paths) and skips straight to a pricing-import-service.ts-shaped
// preview/commit, the same "Import from document" flow every other
// pricing document already gets.
export interface StandaloneVendorQuoteImportPreview {
  kind: "vendor-quote";
  documentId: string;
  filename: string;
  rows: VendorQuoteLine[];
}

// Same cache-first posture as spreadsheet-line-item-service.ts's own
// previewAiProposedImport -- a repeated "Preview import" click against
// the same document must not re-spend tokens. Unlike bid-package-
// actions.ts's runVendorExtractionAndMatch (which always re-extracts,
// since it only runs from an explicit "Extract & match" click), this is
// read-heavy the way a page render is.
export async function previewStandaloneVendorQuoteImport(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
): Promise<StandaloneVendorQuoteImportPreview> {
  const document = await db.document.findFirstOrThrow({ where: { id: documentId, opportunityId } });

  const cached = document.vendorQuoteLineItems as unknown as VendorQuoteLine[] | null;
  if (cached && cached.length > 0) {
    return { kind: "vendor-quote", documentId, filename: document.filename, rows: cached };
  }

  // proposeVendorQuoteLineItems itself throws AiNotConfiguredError before
  // any write, same posture as every other AI proposer in this app.
  const updated = await proposeVendorQuoteLineItems(documentId, opportunityId, userId);
  const rows = (updated.vendorQuoteLineItems as unknown as VendorQuoteLine[] | null) ?? [];
  return { kind: "vendor-quote", documentId, filename: document.filename, rows };
}

// Same idempotency-guard/findOrCreateSection/addLineItemsBulk shape every
// other importer in this app uses, grouped by unitCode (the vendor's own
// section/unit header, e.g. "CAM-06") the same way the other importers
// group by booth/sheet -- rows with no such header (the common case for
// a single flat pricing table, e.g. the real Booth Graphics quote) all
// land in one section named after the document. isDraft is still implied
// true via addLineItemsBulk's own default: unlike
// commitProposedVendorSectionAction's `isDraft: false` (where accepting
// an AI-proposed MATCH against an existing line item *is* the review
// step), this is a brand-new, never-reviewed extraction with nothing to
// match against, so it gets the same "needs human confirmation" gate
// every other document-sourced import in this app already gets.
export async function commitStandaloneVendorQuoteImport(estimateVersionId: string, documentId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });
  const preview = await previewStandaloneVendorQuoteImport(documentId, version.estimate.opportunityId);
  if (preview.rows.length === 0) {
    throw new Error(`No priced line items could be extracted from "${preview.filename}".`);
  }

  const alreadyImported = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  if (alreadyImported) {
    throw new Error(
      `"${preview.filename}" has already been imported into this estimate. Delete its existing line items first if you want to re-import.`,
    );
  }

  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });

  const unitCodes: (string | null)[] = [];
  const seen = new Set<string>();
  for (const row of preview.rows) {
    const key = row.unitCode ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    unitCodes.push(row.unitCode ?? null);
  }

  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const unitCode of unitCodes) {
    const section = await findOrCreateSection(estimateVersionId, {
      name: preview.filename,
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
      groupLabel: unitCode,
    });

    const rowsForGroup = preview.rows.filter((r) => (r.unitCode ?? null) === unitCode);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      rowsForGroup.map((row) => ({
        lineType: "MATERIAL" as const,
        description: row.description,
        qty: row.qty ?? 1,
        unit: row.unit,
        unitCost: row.unitPrice,
        documentId,
        sourceQuote: row.sourceQuote,
        sourcePageNumber: row.pageNumber,
      })),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: preview.rows.length };
}
