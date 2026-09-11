// Sibling to scope-line-item-service.ts the same way drawing-summary-
// service.ts is a sibling to document-summary-service.ts -- a genuinely
// different input pipeline (vision page images, plus each page's own
// extracted text when pageImages finds one -- see that file's header
// comment), not a variant of the text-based proposer. Document.extractedText
// itself is still never populated for a DRAWING (that field is
// document-summary-service.ts's own stored, merged-across-pages text, a
// different thing from pageImages' fresh per-request per-page text), so
// this stays its own pipeline. Closes a real gap: DRAWING documents were
// excluded from every line-item path (see estimate-synthesis-service.ts's
// old DRAWING exclusion) because proposeLineItemsFromScope requires
// Document.extractedText -- so renderings, the most reliably
// single-project-tagged documents in a real RFP package, contributed zero
// line items no matter what.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { pageImages } from "@/lib/ai/drawing-summary-service";
import {
  getDrawingAiClient,
  DEFAULT_DRAWING_BATCH_SIZE,
  reasoningBudgetForBatch,
  DRAWING_REASONING_BUDGET,
  DRAWING_REQUEST_TIMEOUT_MS,
  buildPageContentParts,
} from "@/lib/ai/drawing-ai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import {
  buildProposedLineItemMatchesCache,
  SCOPE_CATEGORIES,
  type ProposedLineItem,
  type ScopeCategory,
} from "@/lib/ai/scope-line-item-service";
import { normalizeDescriptionForMatch } from "@/lib/ai/line-item-duplicate-service";
import type { DocumentSummary, CitedText } from "@/lib/ai/document-summary-service";

type DrawingLineItemFromAI = {
  description: string;
  qty: number;
  qtyIsExplicit: boolean;
  unit: string;
  lineType: "MATERIAL" | "LABOR" | "FEE";
  category: ScopeCategory;
  pageNumber: number;
  // H2/H3 -- see identifyDrawingElements below and Document.proposedLineItemGaps'
  // neighboring schema comments for the general "why a separate earlier
  // pass feeds this one" pattern. elementName is copied verbatim from that
  // earlier pass's own per-page element list (see buildElementContextForBatch),
  // never invented fresh here -- null only when that pass identified no
  // element for this item's page. subElementName is a finer split WITHIN
  // one elementName (e.g. "LED Screen" vs "Touch Screen" both under "Front
  // Towers") -- null whenever elementName alone is already specific enough.
  elementName: string | null;
  subElementName: string | null;
};

// Sept 2026 (Titleist "GeneralMeasurements.pdf" -- real production use):
// confirmed live that an item like "LED Screen qty=2" got proposed with no
// overall size at all, even though the real sheet shows a 6x7 grid of
// 19.53" tiles and no overall L x W printed anywhere -- and more broadly,
// proposed items had no sense of which physical element of the exhibit
// (e.g. "Front Towers") they actually belonged to, so everything of one
// category landed in one flat bucket regardless of which real component it
// came from. This whole-document pass fixes the second problem directly
// (see DRAWING_ELEMENT_MAP_SCHEMA/ELEMENT_MAP_SYSTEM_PROMPT below) and
// feeds proposeLineItemsFromDrawing's per-batch calls the per-page element
// map they need to tag each item correctly -- the first problem (grid/tile
// dimension recognition) is a separate, unrelated SYSTEM_PROMPT addition
// below, since a page can need grid recognition without needing this pass
// at all (the two are complementary, not the same fix).
type DrawingElementMapFromAI = {
  pages: {
    pageNumber: number;
    pageTitle: string | null;
    elements: { name: string; category: ScopeCategory }[];
  }[];
};

// Page-keyed (not element-keyed): lets the model emit however many
// elements one page actually shows, and reuse one name across several
// pages for a rare multi-page element, using nothing more than ordinary
// string matching downstream -- no separate step is needed to have the
// model pre-decide element boundaries into a different shape. This is also
// exactly the lookup shape proposeLineItemsFromDrawing's batch loop needs
// ("what element(s) does page N belong to"), so nothing has to invert it.
export const DRAWING_ELEMENT_MAP_SCHEMA = {
  name: "drawing_element_map",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            pageNumber: {
              type: "integer",
              description: "The page's real 'Page N' label -- same convention as DRAWING_LINE_ITEM_SCHEMA's own pageNumber.",
            },
            pageTitle: {
              type: ["string", "null"],
              description:
                "The page's own printed title/heading, copied exactly as shown (e.g. \"FRONT TOWERS - QTY. 2\", \"CENTER WALL\"). Null only if no legible title is printed anywhere on the sheet.",
            },
            elements: {
              type: "array",
              description:
                "The main physical element(s) shown/detailed on this page, most prominent first. Almost every sheet shows exactly ONE element (matching its own title) -- more than one only for a genuine multi-element overview sheet.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {
                    type: "string",
                    description:
                      "A short, real element/component name -- prefer the sheet's own printed title verbatim; only invent a descriptive name when no title is legible. Reuse the EXACT SAME string across every page showing/continuing this same physical element.",
                  },
                  category: { type: "string", enum: SCOPE_CATEGORIES },
                },
                required: ["name", "category"],
              },
            },
          },
          required: ["pageNumber", "pageTitle", "elements"],
        },
      },
    },
    required: ["pages"],
  },
} as const;

export const ELEMENT_MAP_SYSTEM_PROMPT = `You are looking at every page of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Your only job on this pass is to identify, for each page, which real physical element(s) of the exhibit that page shows or details -- you are NOT extracting dimensions or line items here, just building a map of what's on each sheet.

Real CAD export sheets from this kind of contractor are consistently titled -- almost every sheet has its own printed title, usually large text near a corner (e.g. "FRONT TOWERS - QTY. 2", "CENTER WALL", "GENERAL MEASUREMENTS"). Read that title FIRST -- it is the primary, most reliable signal for what the page is about. Copy it into pageTitle exactly as printed. Only fall back to inferring an element name yourself, from what's actually drawn, when no legible title is printed anywhere on the sheet.

Most sheets detail exactly ONE physical element -- put exactly one entry in elements for those. A small number of sheets are different:
- A whole-booth overview/isometric sheet can show several distinct named elements at once (platforms, an entrance canopy, a graphic wall, tower structures, a display table, etc.) -- list each one you can actually identify, most visually prominent first.
- A single detail sheet can occasionally cover more than one closely-related element (e.g. a tower sheet showing both its structure AND the AV equipment mounted on it) -- when that's genuinely the case, list each as its own entry rather than merging them into one vague name.

An element that spans or continues across more than one page (rare in this kind of export, but real) MUST use the exact same name string on every page it appears on -- downstream processing groups pages together purely by matching this string exactly, so consistency matters more than wording quality.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")} -- the closest fit for what that element mainly is (an LED video wall or touch screen is Audio/Visual even though it's also a structure; a booth's own walls/frame/shell is Booth Structure & Walls; a fixture built to showcase a specific product is Custom Build).

If a page has no identifiable element at all (a pure title block, index, or general-notes page), return an empty elements array for it -- don't invent one.`;

// Separate, side-effect-free (no DB write, no recordAiUsage of its own --
// the caller records usage, since only it knows documentId/opportunityId
// at the point this resolves) so a diagnostic script can call this
// directly against a real file, same precedent as SYSTEM_PROMPT being
// exported for exactly that reason. Reuses the SAME already-rasterized
// images/pageTexts/pageNumbers pageImages() already produced -- rendering
// a second, different-resolution pass would reintroduce the exact PDF.js
// memory-leak risk pdf.cleanup() was added to fix, for a token savings
// that's speculative and unmeasured. One whole-document call, not batched:
// reading page titles and coarse element identification is far less
// demanding than Pass 2's fine dimension-reading, and needs whole-document
// context to keep one element's name consistent across pages -- something
// per-page-group batching can't provide. Reuses DRAWING_REASONING_BUDGET
// UNSCALED (not reasoningBudgetForBatch) since that constant was tuned
// against exactly this call shape: one whole-document vision call.
export async function identifyDrawingElements(
  client: ReturnType<typeof getDrawingAiClient>["client"],
  model: string,
  viaOpenRouter: boolean,
  filename: string,
  images: string[],
  pageTexts: string[],
  pageNumbers: number[],
): Promise<{
  elementMap: DrawingElementMapFromAI;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
}> {
  const completion = await client.chat.completions.create(
    {
      model,
      temperature: 0.2,
      ...(viaOpenRouter ? (DRAWING_REASONING_BUDGET as unknown as Record<string, unknown>) : {}),
      messages: [
        { role: "system", content: ELEMENT_MAP_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Drawing: ${filename} -- whole-document element identification pass (${images.length} page image${images.length === 1 ? "" : "s"})`,
            },
            ...buildPageContentParts(images, pageTexts, pageNumbers),
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: DRAWING_ELEMENT_MAP_SCHEMA },
    },
    { timeout: DRAWING_REQUEST_TIMEOUT_MS },
  );
  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      viaOpenRouter
        ? `${model} returned an empty response during element identification (possibly exhausted its reasoning token budget) -- see DRAWING_REASONING_BUDGET in drawing-ai-client.ts.`
        : "OpenAI returned an empty response during element identification.",
    );
  }
  return { elementMap: JSON.parse(content) as DrawingElementMapFromAI, usage: completion.usage };
}

// A scope-summary fact (from this SAME document's own summarizeDrawing
// pass) the model could not map to any proposed item -- see
// Document.proposedLineItemGaps' own schema comment for the real gap
// this closes. reason is the model's own account of why, e.g. "covered
// under the general frame-fabrication line above" is legitimate; a weak
// or missing reason is itself a signal something was genuinely missed.
type DrawingLineItemGapFromAI = { text: string; pageNumber: number | null; reason: string | null };

// No quote field requested from the model at all -- same accepted
// trust-reduction precedent as drawing-summary-service.ts's own schema
// (scopeSummary/riskFlags there have no quote either): a per-page text
// block is now given to the model (see buildPageContentParts), but nothing
// here re-verifies a claimed quote against it the way
// document-summary-service.ts's locateQuotePage does for a real text
// document, so asking for one would still just invite a fabricated-looking
// string. pageNumber is model-reported and trusted directly, same as that
// file's keyDates/scopeSummary.
export const DRAWING_LINE_ITEM_SCHEMA = {
  name: "drawing_line_items",
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
              description:
                "True when qty was actually dimensioned/labeled on the sheet, or when it's the count of named instances in a \"Left & Right\"-style element title (see system prompt) -- false when genuinely inferred or guessed.",
            },
            unit: { type: "string", description: "A sensible unit for this item -- EA, SQFT, LF, HR, LOT, etc." },
            lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"] },
            category: { type: "string", enum: SCOPE_CATEGORIES },
            pageNumber: {
              type: "integer",
              description:
                "The page number given in that page's 'Page N' label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).",
            },
            elementName: {
              type: ["string", "null"],
              description:
                "The real physical element/component this item belongs to, taken from the 'Elements identified per page' list given below for the page it came from (see system prompt) -- copy that string exactly, don't reword it. Null only if no element was identified for that item's page.",
            },
            subElementName: {
              type: ["string", "null"],
              description:
                "A more specific sub-element name only when it adds real distinguishing detail beyond elementName (e.g. separating 'LED Screen' items from 'Touch Screen' items that share one elementName like 'Front Towers'). Null when elementName alone is already specific enough.",
            },
          },
          required: ["description", "qty", "qtyIsExplicit", "unit", "lineType", "category", "pageNumber", "elementName", "subElementName"],
        },
      },
      gaps: {
        type: "array",
        description:
          "Facts from the 'already identified in this document's summary' checklist (see system prompt) that aren't reflected in items above. Empty array if no checklist was provided, or every fact is accounted for.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", description: "The checklist fact, copied as given." },
            pageNumber: { type: ["integer", "null"] },
            reason: {
              type: ["string", "null"],
              description:
                "Why this fact isn't its own line item -- e.g. already covered under a broader item, a note rather than biddable scope. Null only if genuinely unclear why it was missed.",
            },
          },
          required: ["text", "pageNumber", "reason"],
        },
      },
    },
    required: ["items", "gaps"],
  },
} as const;

export const SYSTEM_PROMPT = `You are looking at pages of a fabrication/construction drawing or CAD export for an event/exhibit contractor. Propose a list of distinct, biddable line items a contractor would need to price to build what's shown -- the granularity a real pricing schedule would use (e.g. "Booth structure fabrication", "Countertop fabrication", "Rigging/truss installation"), grounded in what's actually labeled or dimensioned on the sheets, not a generic paraphrase of "a booth drawing."

Each page is given to you twice: first as its real extracted PDF text (when the export tool embedded one -- exact labels, dimensions, and callouts, character-for-character as printed), then as a rendered image of that same page. When real text is present for a page, treat it as the authoritative source for exact wording and numbers -- it can't be misread the way a visual scan can, and it's your best tool for catching every distinct component on a dense sheet rather than only the most visually prominent one. Use the image to see how those labels relate to what they're pointing at. A page whose text line says none was extracted has no text layer at all (an AutoCAD SHX-annotation table, or a scanned page) -- read the image alone for that one.

When reading dimensions directly off an image (no text layer for that page), read the actual punctuation printed rather than assuming a format: exhibit/booth CAD exports commonly use decimal-inch notation exclusively -- e.g. 39.06" means thirty-nine and six-hundredths of an INCH (a decimal point before the last two digits, not a feet mark) -- not the X'-Y" feet-and-inches format common in other construction drawings. Don't convert or reinterpret a decimal-inch number into feet-and-inches; copy the digits and punctuation exactly as they appear.

For each item:
- description: name the item at that same biddable granularity, but for a custom-fabricated item -- a built structure, graphic, finish, or design element made specifically for this job rather than an off-the-shelf catalog product or rental -- preserve the sheet's own specifying language inside the name: the exact material, finish, dimension, or design detail as labeled or called out (e.g. "single-sided Chinese birch," not a generic paraphrase like "plywood"). That original wording is often the actual spec a shop floor builds from, and a paraphrase can silently lose it. For a standard catalog/rental/labor item, a concise generic name is fine and preferred -- this only matters for items nothing off-the-shelf will satisfy.
- qty: the quantity actually dimensioned or labeled on the sheet if there is one (a count, square footage, linear footage, etc.). If nothing is stated, use 1 and set qtyIsExplicit to false -- 1 is a placeholder meaning "this item exists, quantity unknown," never a guess at a real number. A sheet or element titled for multiple named instances (e.g. "Left & Right Back Corner," "Left and Right Side Wall") IS an explicit quantity, even with no numeral printed -- that title is stating there are 2 of whatever the sheet shows, typically mirrored and identical apart from a logo or graphic. Propose qty 2 (or however many instances the title names) with qtyIsExplicit: true for those, not a bare qty 1 as if only one existed.
- qtyIsExplicit: true when that qty value is actually printed on the sheet, OR when it's the count of named instances in a "Left & Right"-style element title as described above -- both are things the sheet itself states, just not always as a numeral.

A wall or panel elevation is sometimes dimensioned as a sequence of individual segment widths along one dimension line (e.g. several consecutive callouts marching across the top of a wall), rather than one aggregate span for the whole wall -- each such segment is one physical panel. When you see this: group segments that share the exact same stated dimension into ONE item with qty equal to how many segments share it (qtyIsExplicit: true -- that count comes directly from the sheet's own repeated dimensions). A segment whose dimension doesn't match any other segment on that same elevation is its own distinct item, qty 1, qtyIsExplicit: true -- its size is genuinely stated, this isn't the "unknown quantity" placeholder case. Match on the exact printed value -- don't treat close-but-different numbers (e.g. 39.01" vs 39.06") as the same panel just because they're similar; a corner or return panel is often intentionally cut to a slightly different width on purpose, and merging them would misreport both the count and what's actually on the sheet. Don't collapse an entire dimensioned run into one generic "wall panel" item with no count either -- every segment is a real, priceable panel.

A run of individual segments like this is frequently ALSO labeled with one larger overall dimension spanning the whole run, printed above or outside the individual segment callouts (e.g. a "224.59"" total printed above five sequential segments -- 29.29", 39.06", 39.06", 39.06", 39.06" -- that literally sum to it). That overall number is a check-dimension confirming the segments below it add up correctly -- it is not a physical panel of its own. Never propose the overall/aggregate span as its own separate item alongside the individual segments it's the sum of; only the individually-dimensioned segments are real, priceable panels. If you're ever unsure whether a number is an individual segment or the aggregate of others nearby, check whether it roughly equals the sum of other numbers on that same dimension line -- if it does, it's the aggregate, skip it as its own item.
A separate, genuinely different pattern from the sequential-segment case above: some elements (most commonly an LED video wall's tiles, but the same reading applies to any modular/repeated-unit component -- a slat-panel grid, a tile floor, a lattice) are shown as a rectangular GRID of identically-dimensioned repeated units -- rows and columns of the same small dimensioned square/rectangle -- with no overall length x width printed anywhere on the sheet. This differs from the sequential-segment case (a single dimension line of consecutive different-width panels): here every unit repeats the exact same stated dimension in both directions, arranged in a visible rows x columns layout. When you see this, don't just report the tile count -- compute the overall assembled size yourself: count the grid's rows and columns directly from the drawing (don't guess; count what's actually drawn), multiply columns x each tile's stated width for the overall width and rows x each tile's stated height for the overall height (tiles are usually square, so one stated dimension often applies to both), and report ALL of it in one item's description: the overall computed size, the row x column grid count, and the per-tile dimension -- e.g. "LED Screen 117.18"W x 136.71"H (6x7 grid of 19.53" tiles)" for a 6-column x 7-row grid of 19.53" square tiles. qty for this item is the count of ASSEMBLED units shown (e.g. qty 2 for an element titled "LED Screen qty=2"), not the individual tile count -- the tile count belongs in the description as shown above, never in qty.

The sequential-segment grouping above captures each panel's WIDTH from the dimension line, but a panel's real size for sheet-good/material costing needs both dimensions. When a real height value for that same wall/panel run is determinable from the sheet -- a shared "total height"/overall-elevation dimension printed elsewhere on the same sheet, or a per-panel height callout -- include it in the item's description alongside the width, e.g. "39.06"W x 190.51"H wall panel". Only state a height that's actually determinable from a real printed value on the sheet; if no height is stated or inferable anywhere on the sheet, leave it out of the description entirely rather than inventing or assuming one -- the same honesty rule qtyIsExplicit already applies to quantity applies here to dimensions.

A height you use for a panel must come from the SAME page as that panel, never a different page you're also looking at in this same batch -- even when another page shown to you happens to have its own similar-looking height dimension nearby, it belongs to that other page's own elevation, not this one's. This matters even more on a page that itself shows more than one elevation or view of the same corner/component (common on a single detail sheet): match each panel to the height labeled on its OWN elevation specifically, not a different elevation drawn elsewhere on that same sheet -- two elevations on one sheet showing the same corner from different angles often have two different, both-correct heights (e.g. a shorter returned side wall next to a taller front wall), and applying one elevation's height to a panel that actually belongs to the other would misstate its real size.

- unit: a sensible unit for this item (EA, SQFT, LF, HR, LOT) -- infer from context if the sheet doesn't state one.
- lineType: MATERIAL for goods/fabrication, LABOR for installation/labor-only work, FEE for flat fees/rentals/services.
- category: which section this item belongs to.
- pageNumber: the page number given in that page's "Page N" label -- the document's real page number, not your position in the list (a page that failed to render may have been skipped, so these numbers can skip values).
- elementName: the real physical element this item belongs to, taken from the "Elements identified per page" list given below for the page it came from (item's own pageNumber) -- see below for exactly how to set this. Null only if no element was identified for that item's page.
- subElementName: a more specific sub-element name only when it adds real distinguishing detail beyond elementName (e.g. separating "LED Screen" items from "Touch Screen" items that share one elementName like "Front Towers") -- null when elementName alone is already specific enough.

Only propose items that describe actual work or goods to be provided -- skip title blocks, revision notes, and general notes entirely. If a sheet has no concrete fabrication scope (e.g. it's purely a floor plan with no callouts), it can contribute nothing.

A floor-plan/legend sheet (often titled something like "CALLOUTS") that labels WHERE each named element is located -- dashed boxes or pointer lines naming zones like "Left Back Corner," "Front Tower Left," "Hanging Sign" -- but states no dimension, material, or fabrication detail of its own for any of them, is a reference index, not fabrication scope: this is exactly the "no concrete fabrication scope" case above. Every element it names gets its own dedicated, fully-detailed sheet elsewhere in this document -- propose NOTHING from a page like this. Don't propose a placeholder item per named callout just because a name is printed on it; a bare location label with no size or spec attached isn't an item, it's a map reference to where the real item is detailed.

category must be exactly one of: ${SCOPE_CATEGORIES.join(", ")}. Pick the closest fit rather than inventing a new name -- use "Other" only when nothing on the list is a reasonable match.

Two categories are easy to misroute into a broader neighbor -- check these before defaulting elsewhere:
- Audio/Visual: any screen, monitor, LED video wall/tile, touch screen, or other AV equipment -- even though it's electrically powered, it belongs here, not Electrical & Lighting (reserve that one for house power, task/accent lighting, and electrical hookups that aren't themselves a display or AV device).
- Custom Build: a fixture built specifically to showcase or display a particular product (a product rail, a dedicated display stand or cabinet, a feature element) -- reserve Booth Structure & Walls for the booth's own walls, frame, and structural shell, not fixtures placed inside it that exist to show off a product.

You may also be given a checklist below labeled "Facts already identified in this document's summary" -- specific dimensions/materials/callouts a separate earlier pass over this SAME document already found. Cross-check your proposed items against every fact on that list: each one should either be clearly reflected in an item's description (directly, or as part of a broader item that covers it), or added to gaps with a real, specific reason it isn't its own biddable line -- never silently dropped. A weak or generic reason ("not important") is worse than an honest "missed on first pass, should be its own item" -- gaps is a genuine coverage check, not a formality to satisfy. If no checklist was provided below, return gaps: [].

You may also be given a list below labeled "Elements identified per page" -- which real physical element(s) each of this batch's pages show, from an earlier whole-document pass over this SAME drawing. Set each item's elementName to the element name listed for the page it came from -- copy that string exactly, don't reword it, so items belonging to the same physical element group together correctly downstream. If a page lists more than one element, pick whichever specific one that item's own content clearly belongs to (e.g. on a page listing both "LED Video Wall" and "Touch Screen Monitor", a touchscreen callout's elementName is "Touch Screen Monitor", not the sheet's other element). If a page isn't listed below at all, leave elementName null rather than guessing one.`;

// A group of consecutive whole pages sent to the model as one call --
// never splits a single page's own images/text across two batches, which
// keeps the page-local "Left & Right" convention and the per-elevation
// segment-grouping instruction (see SYSTEM_PROMPT) working exactly as they
// did before batching existed -- both are conventions that live within one
// sheet, never across sheets.
interface DrawingPageBatch {
  images: string[];
  pageTexts: string[];
  pageNumbers: number[];
}

export function chunkPagesIntoBatches(
  images: string[],
  pageTexts: string[],
  pageNumbers: number[],
  batchSize: number,
): DrawingPageBatch[] {
  const batches: DrawingPageBatch[] = [];
  for (let i = 0; i < images.length; i += batchSize) {
    batches.push({
      images: images.slice(i, i + batchSize),
      pageTexts: pageTexts.slice(i, i + batchSize),
      pageNumbers: pageNumbers.slice(i, i + batchSize),
    });
  }
  return batches;
}

// Scopes the "Facts already identified in this document's summary"
// checklist (see SYSTEM_PROMPT) down to just the facts relevant to one
// batch's own pages, instead of resending the whole document's checklist
// on every batch call -- a real token-spend lever now that one document
// makes N calls instead of 1. A fact with no pageNumber (the earlier
// summarizeDrawing pass couldn't attribute it to a specific page) is
// included in EVERY batch rather than dropped or arbitrarily assigned to
// one -- cheap (checklist facts are short one-liners, not images) and
// keeps gap-coverage complete for facts the earlier pass genuinely
// couldn't pin down.
export function filterChecklistForBatch(scopeChecklist: CitedText[], batchPageNumbers: number[]): CitedText[] {
  const pages = new Set(batchPageNumbers);
  return scopeChecklist.filter((fact) => fact.pageNumber === null || pages.has(fact.pageNumber));
}

// Formats identifyDrawingElements' whole-document page map down to just
// the pages in one batch, as the "Elements identified per page" context
// block SYSTEM_PROMPT instructs the model to copy elementName from. A page
// with an empty elements array (identifyDrawingElements found nothing --
// a title block, index, or notes-only page) is left out entirely rather
// than listed with nothing to show. Returns null (omit the block) when no
// page in this batch has anything to report.
export function buildElementContextForBatch(
  elementMap: DrawingElementMapFromAI["pages"],
  batchPageNumbers: number[],
): string | null {
  const pages = new Set(batchPageNumbers);
  const relevant = elementMap.filter((p) => pages.has(p.pageNumber) && p.elements.length > 0);
  if (relevant.length === 0) return null;
  return relevant
    .map((p) => `Page ${p.pageNumber}${p.pageTitle ? ` ("${p.pageTitle}")` : ""}: ${p.elements.map((e) => `${e.name} (${e.category})`).join(", ")}`)
    .join("\n");
}

// Narrow, adjacent-batch-boundary-only safety net -- NOT a general
// cross-batch dedup pass. Splitting a document into sequential batches
// introduces one real new risk plain single-call proposing never had: the
// SAME physical element straddling a batch boundary (its last labeled
// panel on one batch's final page, its mirror/continuation on the next
// batch's first page) getting proposed twice, once per batch, since
// neither call can see the other's page. Mirrors findExactDuplicates's own
// posture (line-item-duplicate-service.ts): only drops a boundary item
// when it matches EXACTLY ONE item on the other side of the boundary -- an
// ambiguous or absent match is left alone rather than guessed, the same
// "don't force it" rule that file already established for the unrelated
// proposed-vs-committed case. Two adjacent batches separated by an
// excluded blank page (see pageImages' blankPageNumbers) are deliberately
// NOT treated as touching -- a real gap sits between them, not a seam.
export function mergeAdjacentBatchDuplicates(
  itemsByBatch: DrawingLineItemFromAI[][],
  pageNumbersByBatch: number[][],
): { items: DrawingLineItemFromAI[]; droppedCount: number } {
  const kept = itemsByBatch.map((batch) => [...batch]);
  let droppedCount = 0;
  for (let i = 1; i < kept.length; i++) {
    const prevPages = pageNumbersByBatch[i - 1];
    const thisPages = pageNumbersByBatch[i];
    if (prevPages.length === 0 || thisPages.length === 0) continue;
    const prevLastPage = Math.max(...prevPages);
    const thisFirstPage = Math.min(...thisPages);
    if (thisFirstPage - prevLastPage > 1) continue; // a real gap, not a seam
    const prevBoundaryItems = kept[i - 1].filter((item) => item.pageNumber === prevLastPage);
    const thisBoundaryItems = kept[i].filter((item) => item.pageNumber === thisFirstPage);
    for (const candidate of thisBoundaryItems) {
      const key = normalizeDescriptionForMatch(candidate.description);
      if (!key) continue;
      const matches = prevBoundaryItems.filter((item) => normalizeDescriptionForMatch(item.description) === key);
      if (matches.length === 1) {
        kept[i] = kept[i].filter((item) => item !== candidate);
        droppedCount++;
      }
    }
  }
  return { items: kept.flat(), droppedCount };
}

// Explicitly triggered (the Propose button, or buildEstimateFromAllDocuments),
// never run automatically at Analyze time -- same posture scope-line-
// item-service.ts's own header comment establishes for the text path, so
// a routine Analyze click doesn't silently double every drawing's vision
// cost.
// opportunityId ownership check -- see scope-line-item-service.ts's
// proposeLineItemsFromScope for the full rationale (same pipeline, same
// cost-bearing-AI-call-plus-write-back shape).
//
// Sept 2026: internally batches the vision call per small group of pages
// instead of one call for the whole document (see chunkPagesIntoBatches
// above and DEFAULT_DRAWING_BATCH_SIZE's own comment for why). Still one
// fully-awaitable async function with the same signature as before
// batching existed -- callers (this function's own tests,
// estimate-synthesis-service.ts's buildEstimateFromAllDocuments, and the
// throwaway diagnostic scripts used to develop this feature) keep working
// unchanged; only proposeScopeItemsAction (import-actions.ts) now wraps
// this call in next/server's after() instead of awaiting it directly, so
// its caller can poll Document.lineItemProposalStatus/BatchIndex/BatchTotal
// for live progress instead of blocking on one long request. Every DB
// write inside the loop below touches ONLY those progress fields (and, on
// failure, status/error) -- proposedLineItems/Gaps/Matches are written
// exactly once, in the single final update after every batch succeeds, so
// a mid-run failure never leaves partial item data behind.
export async function proposeLineItemsFromDrawing(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
  // See proposeLineItemsFromScope's own identical parameter comment --
  // this shares commitScopeLineItems as its commit function, so the same
  // Tier 2 caching applies here too.
  versionId: string | null = null,
) {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  // Throws before any DB write, same posture as proposeLineItemsFromScope.
  // See drawing-ai-client.ts's own header for why this can be OpenRouter
  // instead of OpenAI direct -- scoped to this pipeline only.
  const { client, model, viaOpenRouter } = getDrawingAiClient();

  // Real gap this closes (Sept 2026, FootJoy PGA 2027 -- see
  // Document.proposedLineItemGaps' own schema comment): summarizeDrawing
  // (Analyze) and this function are two fully independent AI calls that
  // both re-read the same pages cold, so nothing previously forced this
  // pass to account for every fact the summary pass already found.
  // Building the checklist from whatever extractedSummary is ALREADY on
  // this document row -- if Analyze hasn't run yet (or predates this
  // field), scopeSummary is undefined and the checklist is simply skipped
  // (SYSTEM_PROMPT's own instruction covers the no-checklist case).
  const existingSummary = document.extractedSummary as unknown as DocumentSummary | null;
  const scopeChecklist = existingSummary?.scopeSummary ?? [];

  const { images, totalPages, pageTexts, pageNumbers, blankPageNumbers } = await pageImages(document.mimeType, bytes);
  const attempted = images.length + blankPageNumbers.length;
  if (totalPages > attempted) {
    // No schema/UI channel to surface this to the estimator reviewing the
    // proposed items yet (unlike summarizeDrawing's riskFlags, which
    // already reaches ProjectBriefCard for free) -- at minimum this makes
    // the truncation visible in server logs instead of purely silent.
    // attempted (not images.length) is the right comparand now that blank
    // pages are excluded from images -- see drawing-summary-service.ts's
    // pageImages for why.
    console.warn(
      `[proposeLineItemsFromDrawing] document ${documentId}: only analyzed ${attempted} of ${totalPages} pages (AI_DRAWING_MAX_PAGES limit).`,
    );
  }
  if (blankPageNumbers.length > 0) {
    // Real incident (Titleist "Concept V1E" upload, Sept 2026) -- see
    // isBlankPageImage's own header. Same "log only" posture as the
    // truncation warning above, not a new schema field.
    console.warn(
      `[proposeLineItemsFromDrawing] document ${documentId}: page(s) ${blankPageNumbers.join(", ")} rendered blank (likely an undecodable embedded image, e.g. JPEG2000) -- excluded from analysis.`,
    );
  }
  if (images.length === 0) {
    // A genuinely empty PDF, or every page rendered blank -- nothing to
    // propose, and re-running won't change that. Same "real, not a
    // failure" posture as summarizeDrawing's UNSUPPORTED branch, but
    // propose has no separate status field to flip -- an empty cached
    // proposal is itself the correct signal (matches commitScopeLineItems's
    // "click Propose items first" guard for a genuinely never-proposed
    // document only when the cache is still null, not an empty array).
    return db.document.update({
      where: { id: documentId },
      data: {
        proposedLineItems: [] as unknown as Prisma.InputJsonValue,
        proposedLineItemGaps: null as unknown as Prisma.InputJsonValue,
        lineItemProposalStatus: "COMPLETE",
        lineItemProposalBatchIndex: 0,
        lineItemProposalBatchTotal: 0,
        lineItemProposalError: null,
      },
    });
  }

  // First write of the run -- moved to BEFORE Pass 1 (element
  // identification) runs, not after, so Pass 1's own real wall time counts
  // toward lineItemProposalStartedAt and the progress UI's elapsed-time
  // baseline. batchTotal starts at 0/unknown (only knowable once Pass 1
  // has finished and batches below is computed) -- the progress poller
  // already shows a plain "Starting analysis..." state whenever batchTotal
  // is falsy, so this needs no new UI string for Pass 1 at all. Also makes
  // this function self-sufficient for progress tracking regardless of
  // caller (a direct test/script call, or proposeScopeItemsAction's
  // after()-backgrounded call).
  await db.document.update({
    where: { id: documentId },
    data: {
      lineItemProposalStatus: "ANALYZING",
      lineItemProposalBatchIndex: 0,
      lineItemProposalBatchTotal: 0,
      lineItemProposalStartedAt: new Date(),
      lineItemProposalError: null,
    },
  });

  // Pass 1: identify which real physical element each page shows, before
  // any of Pass 2's per-segment extraction runs -- see
  // identifyDrawingElements' own header for why this needs whole-document
  // context and can't just be folded into the batch loop below. Failure
  // here aborts the whole run (same FAILED-and-rethrow posture as a batch
  // failure below) rather than silently falling back to un-elemented,
  // category-only output -- a deliberate choice matching this pipeline's
  // existing "honest, not silently degraded" pattern (qtyIsExplicit, the
  // gaps checklist): a transient Pass 1 failure should surface as a real,
  // visible FAILED state the user can just retry, not a quietly worse
  // result they'd have no way to notice.
  let elementMap: DrawingElementMapFromAI["pages"];
  const pass1StartedAt = Date.now();
  try {
    const { elementMap: map, usage } = await identifyDrawingElements(
      client,
      model,
      viaOpenRouter,
      document.filename,
      images,
      pageTexts,
      pageNumbers,
    );
    elementMap = map.pages;
    await recordAiUsage({
      userId,
      feature: "DRAWING_LINE_ITEMS",
      model,
      usage,
      documentId,
      opportunityId: document.opportunityId,
    });
    console.log(
      `[proposeLineItemsFromDrawing] document ${documentId}: element identification pass took ${((Date.now() - pass1StartedAt) / 1000).toFixed(1)}s.`,
    );
  } catch (err) {
    const message = `Element identification pass failed: ${err instanceof Error ? err.message : String(err)}`;
    await db.document.update({
      where: { id: documentId },
      data: { lineItemProposalStatus: "FAILED", lineItemProposalError: message },
    });
    throw err;
  }

  const batchSize = Number(process.env.AI_DRAWING_BATCH_SIZE) || DEFAULT_DRAWING_BATCH_SIZE;
  const batches = chunkPagesIntoBatches(images, pageTexts, pageNumbers, batchSize);
  await db.document.update({ where: { id: documentId }, data: { lineItemProposalBatchTotal: batches.length } });

  const itemsByBatch: DrawingLineItemFromAI[][] = [];
  const gapsByBatch: DrawingLineItemGapFromAI[][] = [];

  // Sequential, not parallel -- no concurrency limiter exists anywhere in
  // this codebase yet (confirmed against every other AI pipeline), and
  // running batches one at a time is what makes a coherent, real
  // elapsed-time-so-far estimate possible for the progress UI (see
  // line-item-proposal-progress.tsx).
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (i > 0) {
      await db.document.update({ where: { id: documentId }, data: { lineItemProposalBatchIndex: i } });
    }
    const batchChecklist = filterChecklistForBatch(scopeChecklist, batch.pageNumbers);
    const elementContext = buildElementContextForBatch(elementMap, batch.pageNumbers);

    // No per-batch timing was ever recorded before this -- a real
    // production run once took 6m31s total across 7 calls with no way
    // after the fact to tell whether that was even latency across every
    // call or one call stalling near DRAWING_REQUEST_TIMEOUT_MS. This
    // makes the NEXT slow run diagnosable from server logs alone.
    const batchStartedAt = Date.now();
    try {
      const completion = await client.chat.completions.create(
        {
          model, // vision extraction -- same bar as summarizeDrawing, not the text path's tiered choice
          temperature: 0.2,
          // See drawing-ai-client.ts's own comment -- only relevant for an
          // OpenRouter-routed reasoning model, inert otherwise. Scaled to
          // this batch's own page count rather than the flat
          // whole-document DRAWING_REASONING_BUDGET.
          ...(viaOpenRouter ? (reasoningBudgetForBatch(batch.pageNumbers.length) as unknown as Record<string, unknown>) : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Drawing: ${document.filename} -- batch ${i + 1} of ${batches.length} (${batch.images.length} page image${batch.images.length === 1 ? "" : "s"})`,
                },
                ...(batchChecklist.length > 0
                  ? [
                      {
                        type: "text" as const,
                        text: `Facts already identified in this document's summary (cross-check against these -- see system prompt):\n${batchChecklist
                          .map((fact, idx) => `${idx + 1}. [page ${fact.pageNumber ?? "?"}] ${fact.text}`)
                          .join("\n")}`,
                      },
                    ]
                  : []),
                ...(elementContext
                  ? [
                      {
                        type: "text" as const,
                        text: `Elements identified per page (from an earlier whole-document pass over this SAME drawing -- see system prompt):\n${elementContext}`,
                      },
                    ]
                  : []),
                ...buildPageContentParts(batch.images, batch.pageTexts, batch.pageNumbers),
              ],
            },
          ],
          response_format: { type: "json_schema", json_schema: DRAWING_LINE_ITEM_SCHEMA },
        },
        { timeout: DRAWING_REQUEST_TIMEOUT_MS },
      );

      await recordAiUsage({
        userId,
        feature: "DRAWING_LINE_ITEMS",
        model,
        usage: completion.usage,
        documentId,
        opportunityId: document.opportunityId,
      });

      console.log(
        `[proposeLineItemsFromDrawing] document ${documentId}: batch ${i + 1} of ${batches.length} (pages ${batch.pageNumbers.join(", ")}) took ${((Date.now() - batchStartedAt) / 1000).toFixed(1)}s.`,
      );

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        // A reasoning model can burn its whole token budget on internal
        // reasoning and never reach the actual JSON -- a real failure mode
        // confirmed live via OpenRouter (see DRAWING_REASONING_BUDGET), not
        // hypothetical.
        throw new Error(
          viaOpenRouter
            ? `${model} returned an empty response (possibly exhausted its reasoning token budget) -- see reasoningBudgetForBatch in drawing-ai-client.ts.`
            : "OpenAI returned an empty response.",
        );
      }
      const parsed = JSON.parse(content) as { items: DrawingLineItemFromAI[]; gaps: DrawingLineItemGapFromAI[] };
      itemsByBatch.push(parsed.items);
      gapsByBatch.push(batchChecklist.length > 0 ? parsed.gaps : []);
    } catch (err) {
      // Deliberately does NOT touch proposedLineItems/Gaps/Matches -- any
      // prior successful run's data is left exactly as it was. Re-running
      // is cheap (click Propose again), so this is the simplest safe
      // default over building partial-result/resume machinery.
      const message = `Batch ${i + 1} of ${batches.length} (pages ${batch.pageNumbers.join(", ")}) failed: ${err instanceof Error ? err.message : String(err)}`;
      await db.document.update({
        where: { id: documentId },
        data: { lineItemProposalStatus: "FAILED", lineItemProposalError: message },
      });
      throw err;
    }
  }

  const { items: mergedRaw, droppedCount } = mergeAdjacentBatchDuplicates(
    itemsByBatch,
    batches.map((b) => b.pageNumbers),
  );
  if (droppedCount > 0) {
    console.warn(
      `[proposeLineItemsFromDrawing] document ${documentId}: dropped ${droppedCount} likely cross-batch-boundary duplicate(s).`,
    );
  }

  // estimateId inherits the document's own manual tag directly -- same
  // "a rendering package is always cleanly single-project" reasoning as
  // drawing-summary-service.ts's withEmptyQuote, no vision-based project
  // classification here. sourceQuote stays empty, same accepted trust
  // reduction as that file (no text layer to verify a quote against).
  const items: ProposedLineItem[] = mergedRaw.map((item) => ({
    ...item,
    sourceQuote: "",
    estimateId: document.estimateId ?? null,
  }));

  const matchesCache = await buildProposedLineItemMatchesCache(items, versionId, document.opportunityId, documentId, userId);

  // Explicitly null (not the model's own gaps: []) when no checklist
  // existed to check against -- distinguishes "nothing to report because
  // there was nothing to check" from "checked a real checklist and every
  // fact was accounted for," per Document.proposedLineItemGaps' own
  // schema comment. Doesn't trust the model to make this distinction on
  // its own even though the prompt asks for it.
  const gaps = scopeChecklist.length > 0 ? gapsByBatch.flat() : null;

  return db.document.update({
    where: { id: documentId },
    data: {
      proposedLineItems: items as unknown as Prisma.InputJsonValue,
      proposedLineItemGaps: gaps as unknown as Prisma.InputJsonValue,
      ...(matchesCache ? { proposedLineItemMatches: matchesCache as unknown as Prisma.InputJsonValue } : {}),
      lineItemProposalStatus: "COMPLETE",
      lineItemProposalBatchIndex: batches.length,
      lineItemProposalError: null,
    },
  });
}
