// Companion to document-summary-service.ts, but a distinct, explicitly
// triggered operation -- proposing biddable line items from a Scope of
// Work / RFP document's text, for RFP packages that don't come with a
// pre-built Pricing Schedule XLSX (pricing-import-service.ts). Without
// this, such a package converts to an estimate with ZERO line items no
// matter what.
//
// Structurally unlike a real pricing schedule: nothing here has a
// guaranteed real quantity. qtyIsExplicit tells a reviewer which numbers
// actually came from the document text versus which are a bare "1"
// placeholder standing in for "this exists, quantity unknown" -- never
// let the model invent a number that isn't written down.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { extractPdfPageTexts, locateQuotePage, resolveHighlightableQuote, PDF_MIME } from "@/lib/ai/text-extraction";
import { BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { addLineItemsBulk, findOrCreateSection } from "@/lib/estimate-service";
import { loadCatalogForMatching, matchDescription } from "@/lib/catalog-match-service";
import { getDocumentBytes } from "@/lib/document-service";
import {
  CUSTOM_BUILD_CATEGORY_KEY,
  inferCategoryFromDescription,
  inferIsClientOwned,
  isCompoundAssemblyDescription,
  mapCatalogCategoryToCanonical,
  mapScopeCategoryToCanonical,
  resolveCategoryNameFromKey,
} from "@/lib/line-item-category";

// Fixed vocabulary, not free text -- re-running "Propose items" on the
// exact same document used to produce a different taxonomy every time
// ("Doors and Hardware" vs. "Doors and Locks," "Electrical and Lighting"
// vs. folded into "Lighting and Safety"). This list is the merged,
// canonical form of every category name two real AI runs on the same
// document actually produced. "Other" is the deliberate catch-all so a
// genuinely novel scope item never gets force-fit into a wrong bucket.
export const SCOPE_CATEGORIES = [
  "Booth Structure & Walls",
  "Doors & Hardware",
  "Countertops & Cable Management",
  "Electrical & Lighting",
  "Fire & Life Safety",
  "Roof & Coverings",
  "Flooring & Platforms",
  "Labor & Installation",
  "Documentation & Compliance",
  "Other",
] as const;

export type ScopeCategory = (typeof SCOPE_CATEGORIES)[number];

export interface ProposedLineItem {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: ScopeCategory;
  sourceQuote: string;
}

const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from the document text above, showing where this item comes from. Never paraphrase or summarize the quote itself.";

export const PROPOSAL_SCHEMA = {
  name: "scope_line_items",
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
            qty: { type: "number" },
            qtyIsExplicit: {
              type: "boolean",
              description: "True only when qty was actually written in the source text, not inferred or guessed.",
            },
            unit: { type: "string", description: "A sensible unit for this item -- EA, SQFT, LF, HR, LOT, etc." },
            lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"] },
            category: { type: "string", enum: SCOPE_CATEGORIES },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
          },
          required: ["description", "qty", "qtyIsExplicit", "unit", "lineType", "category", "sourceQuote"],
        },
      },
    },
    required: ["items"],
  },
} as const;

const SYSTEM_PROMPT = `You read a Scope of Work / RFP document for an event/exhibit contractor and propose a list of distinct, biddable line items a contractor would need to price to build a complete quote -- the granularity a real pricing schedule would use (e.g. "Booth structure fabrication", "Graphics production", "Installation labor"), not one item paraphrasing the entire scope.

For each item:
- qty: the quantity actually stated in the text if there is one (a count, square footage, linear footage, day count, etc.). If no quantity is stated, use 1 and set qtyIsExplicit to false -- 1 is a placeholder meaning "this item exists, quantity unknown," never a guess at a real number.
- qtyIsExplicit: true ONLY when that qty value was actually written in the source text.
- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT) -- infer from context if the document doesn't state one.
- lineType: MATERIAL for goods/fabrication, LABOR for installation/labor-only work, FEE for flat fees/rentals/services.
- category: which section this item belongs to.
- sourceQuote: a short verbatim quote copied EXACTLY from the document showing where this item comes from -- an exact substring of the source text, never a paraphrase.

Only propose items that describe actual work or goods to be provided -- skip administrative, legal, or process clauses entirely. If the document has no concrete scope of deliverables, return an empty items array rather than inventing something.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")}. Pick the closest fit rather than inventing a new name -- use "Other" only when nothing on the list is a reasonable match. Always use this fixed list, even if a previous run on the same document used different wording.`;

const MAX_INPUT_CHARS = 60_000;

export async function proposeLineItemsFromScope(documentId: string, userId: string | null = null) {
  const document = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  if (!document.extractedText) {
    throw new Error(`"${document.filename}" hasn't been analyzed yet -- click Analyze on it first.`);
  }

  // Throws AiNotConfiguredError before any DB write, same posture as
  // summarizeDocument -- a missing key is a configuration problem the
  // caller surfaces distinctly, not a reason to write a broken result.
  const client = getOpenAiClient();

  const completion = await client.chat.completions.create({
    model: BASIC_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Document: ${document.filename}\n\n${document.extractedText.slice(0, MAX_INPUT_CHARS)}` },
    ],
    response_format: { type: "json_schema", json_schema: PROPOSAL_SCHEMA },
  });

  await recordAiUsage({
    userId,
    feature: "SCOPE_LINE_ITEMS",
    model: BASIC_MODEL,
    usage: completion.usage,
    documentId,
    opportunityId: document.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { items: ProposedLineItem[] };

  // Same discipline as document-summary-service.ts: resolve every quote
  // against the real extracted text so the preview table's quote is a
  // genuine excerpt, not whatever the model happened to return.
  const items: ProposedLineItem[] = parsed.items.map((item) => ({
    ...item,
    sourceQuote: resolveHighlightableQuote(document.extractedText!, item.sourceQuote),
  }));

  return db.document.update({
    where: { id: documentId },
    data: { proposedLineItems: items as unknown as Prisma.InputJsonValue },
  });
}

// Creates one EstimateSection per distinct category (mirroring
// pricing-import-service.ts's commitPricingImport) and bulk-inserts every
// proposed item as an isDraft LineItem, seeding a catalog-matched unitCost
// the same way an imported pricing-schedule row does. A qty that wasn't
// explicitly stated in the source gets flagged right in the description
// text -- LineItem has no separate field for "this quantity is a
// placeholder," and burying that caveat only in a preview table that
// disappears after commit would let it silently get treated as real.
export async function commitScopeLineItems(estimateVersionId: string, documentId: string) {
  const document = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  const items = (document.proposedLineItems as unknown as ProposedLineItem[] | null) ?? [];
  if (items.length === 0) {
    throw new Error(`No proposed line items for "${document.filename}" -- click Propose items first.`);
  }

  // Same reasoning as commitPricingImport's identical check -- a second
  // click created a full second set of sections/items for a real job,
  // with different (AI-regenerated) category names each time, before this
  // check existed. A re-commit must go through deleting the old rows
  // first, not by re-clicking Commit.
  const alreadyImported = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  if (alreadyImported) {
    throw new Error(
      `"${document.filename}"'s proposed items have already been committed to this estimate. Delete the existing line items first if you want to re-commit.`,
    );
  }

  const catalog = await loadCatalogForMatching();
  const liveCategories = await db.category.findMany({ where: { deletedAt: null } });
  const categories = [...new Set(items.map((i) => i.category))];

  // pageNumber is computed here, not stored at propose time -- same
  // reasoning as document-summary-service.ts: searching the PDF's own
  // per-page text for each already-verified sourceQuote is trustworthy in
  // a way an LLM-reported page number wouldn't be. DOCX has no page
  // concept; those items get a text-search highlight in the viewer
  // instead (sourcePageNumber stays null, sourceQuote still links there).
  let pageTexts: string[] | null = null;
  if (document.mimeType === PDF_MIME) {
    const { bytes } = await getDocumentBytes(documentId);
    pageTexts = await extractPdfPageTexts(bytes);
  }

  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });
  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const category of categories) {
    // Reuses an existing section of the same name in this version rather
    // than creating a duplicate -- matters once more than one document is
    // committed into the same version (see estimate-synthesis-service.ts),
    // where two documents proposing the same category (e.g. "Other") used
    // to produce two separate sections on a real test job.
    const section = await findOrCreateSection(estimateVersionId, {
      name: category,
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
    });

    const itemsForCategory = items.filter((i) => i.category === category);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      itemsForCategory.map((item) => {
        const catalogMatch = matchDescription(item.description, catalog);
        return {
          lineType: item.lineType,
          description: item.qtyIsExplicit ? item.description : `${item.description} (qty estimated -- verify)`,
          qty: item.qty,
          unit: item.unit || null,
          unitCost: catalogMatch?.unitCost ?? 0,
          // A compound "Complete X Build" assembly line wins outright (see
          // line-item-category.ts -- catalog match is unreliable against
          // that much text). Otherwise prefer a confident catalog match's
          // own category over the AI's coarser scope bucket, and fall
          // back to the description heuristic only if neither resolved.
          category: isCompoundAssemblyDescription(item.description)
            ? resolveCategoryNameFromKey(liveCategories, CUSTOM_BUILD_CATEGORY_KEY)
            : (mapCatalogCategoryToCanonical(catalogMatch?.category, liveCategories) ??
              mapScopeCategoryToCanonical(category, liveCategories) ??
              inferCategoryFromDescription(item.description, liveCategories)),
          isClientOwned: inferIsClientOwned(item.description),
          documentId,
          sourceQuote: item.sourceQuote,
          sourcePageNumber: pageTexts ? locateQuotePage(pageTexts, item.sourceQuote) : null,
        };
      }),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: document.filename, sectionsCreated: created.length, rowsImported: items.length };
}
