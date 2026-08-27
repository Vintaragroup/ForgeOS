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
// (vendor-match-service.ts) to propose a price update, never used to
// create new sections the way a scope proposal is.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { resolveHighlightableQuote } from "@/lib/ai/text-extraction";
import { BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import type { VendorQuoteLine } from "@/lib/vendor-match-service";

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
            },
            required: ["description", "unit", "qty", "unitPrice", "totalPrice", "sourceQuote"],
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

  // Same discipline as scope-line-item-service.ts: resolve every quote
  // against the real extracted text so the review table's "Source" link
  // is a genuine excerpt, not whatever the model happened to return.
  const items: VendorQuoteLine[] = parsed.items.map((item) => ({
    description: item.description,
    unit: item.unit || null,
    qty: item.qty,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
    sourceQuote: resolveHighlightableQuote(document.extractedText!, item.sourceQuote),
  }));

  return db.document.update({
    where: { id: documentId },
    data: { vendorQuoteLineItems: items as unknown as Prisma.InputJsonValue },
  });
}
