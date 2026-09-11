import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  proposeLineItemsFromDrawing,
  SYSTEM_PROMPT,
  ELEMENT_MAP_SYSTEM_PROMPT,
  DRAWING_LINE_ITEM_SCHEMA,
  DRAWING_ELEMENT_MAP_SCHEMA,
  chunkPagesIntoBatches,
  filterChecklistForBatch,
  buildElementContextForBatch,
  mergeAdjacentBatchDuplicates,
  mergeSimilarDimensionlessDuplicates,
  flagPossibleMisreads,
} from "@/lib/ai/drawing-line-item-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";
import { SCOPE_CATEGORIES, type ProposedLineItem } from "@/lib/ai/scope-line-item-service";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

// Same fixture-builder pattern as drawing-summary-service.test.ts -- a
// deterministic, content-free PDF page reproduces the real "renders
// successfully but the canvas has nothing on it" shape (see
// blank-page-detection.ts's header for the real JPEG2000-decode incident
// this covers) without needing a real JPX fixture file.
async function buildBlankPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]); // no drawn content -- genuinely blank
  return Buffer.from(await doc.save());
}

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeDrawingDocument(bytes?: Buffer) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const pdfBytes = bytes ?? (await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf")));
  const file = new File([new Uint8Array(pdfBytes)], "drawing.pdf", { type: PDF_MIME });
  return uploadDocument(opportunity.id, { file, documentType: "DRAWING" });
}

describe("proposeLineItemsFromDrawing", () => {
  // OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
  // drawing-summary-service.test.ts's summarizeDrawing test: this proves
  // the "AI features not configured" path, checked before pageImages is
  // even called (same order as summarizeDrawing), not a real vision call
  // (that needs a real key, tested manually per this feature's own plan).
  it("throws AiNotConfiguredError before writing anything to the document", async () => {
    const document = await makeDrawingDocument();

    await expect(proposeLineItemsFromDrawing(document.id, document.opportunityId)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const refreshed = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(refreshed.proposedLineItems).toBeNull();
  });

  // Regression test for the cross-resource ID authorization gap: this
  // previously trusted documentId alone -- see the function's own header
  // comment.
  it("rejects a documentId that belongs to a different opportunity, before ever touching the OpenAI client", async () => {
    const document = await makeDrawingDocument();
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(proposeLineItemsFromDrawing(document.id, otherOpportunity.id)).rejects.toThrow(
      "This document doesn't belong to this opportunity.",
    );
  });
});

describe("proposeLineItemsFromDrawing blank-page handling", () => {
  // getDrawingAiClient() runs before pageImages() here too (same order as
  // summarizeDrawing), so reaching the all-blank branch needs a key
  // present -- a fake one is safe since that branch returns before any
  // real API call.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caches an empty proposal, not an error, when every page renders blank", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-real-key");
    const bytes = await buildBlankPdf(2);
    const document = await makeDrawingDocument(bytes);

    const result = await proposeLineItemsFromDrawing(document.id, document.opportunityId);

    expect(result.proposedLineItems).toEqual([]);
  });
});

describe("chunkPagesIntoBatches", () => {
  it("groups pages into sequential batches of the given size, without splitting a page across batches", () => {
    const images = ["img1", "img2", "img3", "img4", "img5"];
    const pageTexts = ["t1", "t2", "t3", "t4", "t5"];
    const pageNumbers = [1, 2, 3, 4, 5];

    const batches = chunkPagesIntoBatches(images, pageTexts, pageNumbers, 2);

    expect(batches).toEqual([
      { images: ["img1", "img2"], pageTexts: ["t1", "t2"], pageNumbers: [1, 2] },
      { images: ["img3", "img4"], pageTexts: ["t3", "t4"], pageNumbers: [3, 4] },
      { images: ["img5"], pageTexts: ["t5"], pageNumbers: [5] },
    ]);
  });

  it("preserves true (non-contiguous) page numbers when earlier blank pages were excluded", () => {
    // pageImages excludes blank pages mid-sequence -- array position no
    // longer matches page number (e.g. page 2 was blank and excluded).
    const batches = chunkPagesIntoBatches(["a", "b", "c"], ["", "", ""], [1, 3, 4], 2);
    expect(batches).toEqual([
      { images: ["a", "b"], pageTexts: ["", ""], pageNumbers: [1, 3] },
      { images: ["c"], pageTexts: [""], pageNumbers: [4] },
    ]);
  });
});

describe("filterChecklistForBatch", () => {
  it("includes only facts whose pageNumber falls within the batch's pages", () => {
    const checklist = [
      { text: "fact on page 1", sourceQuote: "", pageNumber: 1 },
      { text: "fact on page 5", sourceQuote: "", pageNumber: 5 },
      { text: "fact on page 3", sourceQuote: "", pageNumber: 3 },
    ];

    const result = filterChecklistForBatch(checklist, [3, 4]);

    expect(result.map((f) => f.text)).toEqual(["fact on page 3"]);
  });

  it("always includes a fact with no pageNumber, in every batch", () => {
    const checklist = [{ text: "unattributed fact", sourceQuote: "", pageNumber: null }];

    expect(filterChecklistForBatch(checklist, [1, 2]).map((f) => f.text)).toEqual(["unattributed fact"]);
    expect(filterChecklistForBatch(checklist, [9])).toHaveLength(1);
  });
});

describe("buildElementContextForBatch", () => {
  it("formats each in-batch page's title and elements into one line per page", () => {
    const elementMap = [
      { pageNumber: 12, pageTitle: "CENTER WALL", elements: [{ name: "Center Wall", category: "Booth Structure & Walls" as const }] },
      {
        pageNumber: 13,
        pageTitle: "FRONT TOWERS - Qty. 2",
        elements: [
          { name: "Front Towers", category: "Booth Structure & Walls" as const },
          { name: "LED Screen", category: "Audio/Visual" as const },
        ],
      },
    ];

    const result = buildElementContextForBatch(elementMap, [12, 13]);

    expect(result).toBe(
      'Page 12 ("CENTER WALL"): Center Wall (Booth Structure & Walls)\n' +
        'Page 13 ("FRONT TOWERS - Qty. 2"): Front Towers (Booth Structure & Walls), LED Screen (Audio/Visual)',
    );
  });

  it("returns null when no page in the batch has any identified element", () => {
    const elementMap = [{ pageNumber: 1, pageTitle: null, elements: [] }];
    expect(buildElementContextForBatch(elementMap, [1])).toBeNull();
  });

  it("omits a page whose elements array is empty even if pageTitle is present", () => {
    const elementMap = [
      { pageNumber: 1, pageTitle: "GENERAL NOTES", elements: [] },
      { pageNumber: 2, pageTitle: "CENTER WALL", elements: [{ name: "Center Wall", category: "Booth Structure & Walls" as const }] },
    ];

    const result = buildElementContextForBatch(elementMap, [1, 2]);

    expect(result).toBe('Page 2 ("CENTER WALL"): Center Wall (Booth Structure & Walls)');
  });

  it("tolerates a batch page number that isn't present in the element map at all", () => {
    const elementMap = [{ pageNumber: 2, pageTitle: "CENTER WALL", elements: [{ name: "Center Wall", category: "Booth Structure & Walls" as const }] }];

    const result = buildElementContextForBatch(elementMap, [1, 2]);

    expect(result).toBe('Page 2 ("CENTER WALL"): Center Wall (Booth Structure & Walls)');
  });
});

describe("mergeAdjacentBatchDuplicates", () => {
  const item = (description: string, pageNumber: number) =>
    ({
      description,
      qty: 1,
      qtyIsExplicit: true,
      unit: "EA",
      lineType: "MATERIAL" as const,
      category: "Booth Structure & Walls" as const,
      pageNumber,
      elementName: null,
      subElementName: null,
    });

  it("drops an unambiguous exact-description duplicate at a batch boundary", () => {
    const itemsByBatch = [
      [item("Wall Panel 39.06\" width", 3), item("Something else", 2)],
      [item("wall panel 39.06\" width", 3), item("Different item", 4)],
    ];
    const pageNumbersByBatch = [[2, 3], [3, 4]];

    const { items, droppedCount } = mergeAdjacentBatchDuplicates(itemsByBatch, pageNumbersByBatch);

    expect(droppedCount).toBe(1);
    expect(items.map((i) => i.description)).toEqual(["Wall Panel 39.06\" width", "Something else", "Different item"]);
  });

  it("does not merge genuinely different boundary items, even on the same page", () => {
    const itemsByBatch = [
      [item("Wall Panel 39.06\" width", 3)],
      [item("Wall Panel 42.43\" width", 3)],
    ];
    const pageNumbersByBatch = [[2, 3], [3, 4]];

    const { items, droppedCount } = mergeAdjacentBatchDuplicates(itemsByBatch, pageNumbersByBatch);

    expect(droppedCount).toBe(0);
    expect(items).toHaveLength(2);
  });

  it("does not treat batches separated by an excluded page as adjacent", () => {
    // Batch 1 ends at page 3, batch 2 starts at page 5 -- page 4 was
    // excluded (blank), so this is a real gap, not a seam.
    const itemsByBatch = [[item("Wall Panel 39.06\" width", 3)], [item("Wall Panel 39.06\" width", 5)]];
    const pageNumbersByBatch = [[2, 3], [5, 6]];

    const { items, droppedCount } = mergeAdjacentBatchDuplicates(itemsByBatch, pageNumbersByBatch);

    expect(droppedCount).toBe(0);
    expect(items).toHaveLength(2);
  });

  it("leaves an ambiguous match (2+ candidates share the same description) alone rather than guessing", () => {
    const itemsByBatch = [
      [item("Wall Panel 39.06\" width", 3), item("wall panel 39.06\" width", 3)],
      [item("Wall Panel 39.06\" width", 3)],
    ];
    const pageNumbersByBatch = [[2, 3], [3, 4]];

    const { items, droppedCount } = mergeAdjacentBatchDuplicates(itemsByBatch, pageNumbersByBatch);

    expect(droppedCount).toBe(0);
    expect(items).toHaveLength(3);
  });
});

describe("mergeSimilarDimensionlessDuplicates", () => {
  const item = (
    description: string,
    elementName: string | null,
    category: (typeof SCOPE_CATEGORIES)[number] = "Flooring & Platforms",
  ) => ({
    description,
    qty: 1,
    qtyIsExplicit: true,
    unit: "EA",
    lineType: "MATERIAL" as const,
    category,
    pageNumber: 1,
    elementName,
    subElementName: null,
  });

  // Real bug reproduction (Sept 2026, Titleist "GeneralMeasurements.pdf"
  // pages 1-4): the same physical elevated platform, proposed once per
  // batch with genuinely different wording -- confirmed live neither
  // mergeAdjacentBatchDuplicates gate (boundary page, exact-string match)
  // catches this.
  it("merges a reworded duplicate description sharing elementName and category", () => {
    const items = [
      item(
        "Elevated platform with raised deck on support posts, guardrail, and connecting staircase (approximate footprint -- no dimension printed on this sheet)",
        "LEFT FRONT CORNER",
      ),
      item(
        "Elevated platform/mezzanine with raised deck on support posts, guardrail, and connecting staircase (approximately 6-7 stair treads visible) - approximate footprint, no dimension printed on this sheet",
        "LEFT FRONT CORNER",
      ),
    ];

    const { items: result, droppedCount } = mergeSimilarDimensionlessDuplicates(items);

    expect(droppedCount).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe(items[0].description);
  });

  // The false-positive regression that matters most: significantTokens
  // (catalog-match-service.ts) silently shreds the differentiating digits
  // of a decimal-inch value ("39.06" and "95.20" both tokenize down to
  // just "190"/"wall"/"panel"), which would score two DIFFERENT dimensioned
  // panels as a 100% Jaccard match. The extractInchTokens gate must
  // exclude both items from this pass entirely, not merely score them low.
  it("never merges two dimensioned items, even with an identical elementName and near-total token overlap", () => {
    const items = [
      item(`39.06"W x 190.57"H wall panel`, "CENTER WALL", "Booth Structure & Walls"),
      item(`95.20"W x 190.57"H wall panel`, "CENTER WALL", "Booth Structure & Walls"),
    ];

    const { items: result, droppedCount } = mergeSimilarDimensionlessDuplicates(items);

    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  // Two genuinely different real sub-components of the same element --
  // low token overlap must NOT be merged.
  it("does not merge two dimensionless items sharing elementName and category but describing genuinely different scope", () => {
    const items = [
      item("Guardrail with vertical support posts along the platform perimeter", "LEFT FRONT CORNER"),
      item("Staircase connecting the elevated platform deck to the show floor", "LEFT FRONT CORNER"),
    ];

    const { items: result, droppedCount } = mergeSimilarDimensionlessDuplicates(items);

    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  it("does not merge identical wording across two different elementNames", () => {
    const description = "Elevated platform with raised deck on support posts, guardrail, and connecting staircase";
    const items = [item(description, "LEFT FRONT CORNER"), item(description, "RIGHT FRONT CORNER")];

    const { items: result, droppedCount } = mergeSimilarDimensionlessDuplicates(items);

    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  it("does not merge identical wording across two different categories", () => {
    const description = "Elevated platform with raised deck on support posts, guardrail, and connecting staircase";
    const items = [
      item(description, "LEFT FRONT CORNER", "Flooring & Platforms"),
      item(description, "LEFT FRONT CORNER", "Booth Structure & Walls"),
    ];

    const { items: result, droppedCount } = mergeSimilarDimensionlessDuplicates(items);

    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  // A null elementName (Pass 1 identified no element for that page) is a
  // deliberate non-signal -- two null-elementName items are NEVER grouped,
  // even with identical wording.
  it("never merges two items that both have a null elementName", () => {
    const description = "Miscellaneous approximate scope, no dimension printed on this sheet";
    const items = [item(description, null), item(description, null)];

    const { items: result, droppedCount } = mergeSimilarDimensionlessDuplicates(items);

    expect(droppedCount).toBe(0);
    expect(result).toHaveLength(2);
  });

  it("handles an empty array and a single-item array without crashing", () => {
    expect(mergeSimilarDimensionlessDuplicates([])).toEqual({ items: [], droppedCount: 0 });

    const single = [item("Elevated platform, approximate footprint", "LEFT FRONT CORNER")];
    expect(mergeSimilarDimensionlessDuplicates(single)).toEqual({ items: single, droppedCount: 0 });
  });
});

describe("flagPossibleMisreads", () => {
  const pli = (description: string, qty: number): ProposedLineItem => ({
    description,
    qty,
    qtyIsExplicit: true,
    unit: "EA",
    lineType: "MATERIAL",
    category: "Booth Structure & Walls",
    sourceQuote: "",
  });

  // Real bug reproduction (Sept 2026, Titleist "GeneralMeasurements.pdf"
  // page 12): confirmed live that "39.06"" is a real, repeated panel
  // width elsewhere in the document while "30.06"" (a single-digit
  // misread of it) appears on exactly one item.
  it("flags a singleton value that's a single-digit substitution of a commonly-confirmed value elsewhere", () => {
    const items = [
      pli('Wall panel 30.06"W x 190.51"H', 1),
      pli('Wall panel 39.06"W x 190.51"H', 2),
      pli('Wall panel 39.06"W x 137.17"H', 2),
      pli('Wall panel 39.06"W x 90.00"H', 2),
    ];

    const flagged = flagPossibleMisreads(items);

    expect(flagged[0].possibleMisread).toEqual({
      referenceValue: "39.06",
      referenceItemCount: 3,
      referenceTotalQty: 6,
      reason: expect.stringContaining('This document\'s own "39.06""'),
    });
    expect(flagged[1].possibleMisread).toBeUndefined();
    expect(flagged[2].possibleMisread).toBeUndefined();
    expect(flagged[3].possibleMisread).toBeUndefined();
  });

  // The false-positive regression that matters most: 39.01"/39.06"/39.17"
  // are REAL, confirmed-distinct panels this session (SYSTEM_PROMPT's own
  // "don't merge close-but-different numbers" warning exists specifically
  // for this trio). A singleton 39.01" is structurally identical in shape
  // to the real bug above (same length, single-digit substitution vs a
  // commonly-confirmed "39.06") -- proves the numeric-delta floor, not
  // the digit-substitution check alone, is what protects this case.
  it("does not flag a genuinely close but intentionally distinct value", () => {
    const items = [
      pli('Wall panel 39.01"W x 190.51"H', 1),
      pli('Wall panel 39.06"W x 190.51"H', 2),
      pli('Wall panel 39.06"W x 137.17"H', 2),
      pli('Wall panel 39.06"W x 90.00"H', 2),
    ];

    const flagged = flagPossibleMisreads(items);

    expect(flagged.every((i) => !i.possibleMisread)).toBe(true);
  });

  it("does not flag when the candidate value is referenced by too few other items", () => {
    const items = [
      pli('Wall panel 30.06"W x 190.51"H', 1),
      pli('Wall panel 39.06"W x 190.51"H', 2), // only 1 other item references "39.06" -- below MIN_REFERENCE_ITEM_COUNT
    ];

    const flagged = flagPossibleMisreads(items);

    expect(flagged.every((i) => !i.possibleMisread)).toBe(true);
  });

  it("never flags the commonly-confirmed items themselves", () => {
    const items = [
      pli('Wall panel 30.06"W x 190.51"H', 1),
      pli('Wall panel 39.06"W x 190.51"H', 2),
      pli('Wall panel 39.06"W x 137.17"H', 2),
      pli('Wall panel 39.06"W x 90.00"H', 2),
    ];

    const flagged = flagPossibleMisreads(items);

    expect(flagged[1].possibleMisread).toBeUndefined();
    expect(flagged[2].possibleMisread).toBeUndefined();
    expect(flagged[3].possibleMisread).toBeUndefined();
  });

  it("counts a repeated dimension once per item, not once per W/H occurrence", () => {
    // A square panel states the same value for both width and height --
    // must not double-count toward its own reference stats.
    const items = [
      pli('Wall panel 30.06"W x 190.51"H', 1),
      pli('Square panel 39.06"W x 39.06"H', 2),
      pli('Wall panel 39.06"W x 137.17"H', 2),
      pli('Wall panel 39.06"W x 90.00"H', 2),
    ];

    const flagged = flagPossibleMisreads(items);

    expect(flagged[0].possibleMisread?.referenceItemCount).toBe(3);
    expect(flagged[0].possibleMisread?.referenceTotalQty).toBe(6);
  });

  it("returns items unchanged when no description contains an inch token", () => {
    const items = [pli("Booth structure fabrication", 1), pli("Installation labor", 1)];

    const flagged = flagPossibleMisreads(items);

    expect(flagged).toEqual(items);
    expect(flagged.every((i) => !i.possibleMisread)).toBe(true);
  });
});

describe("SYSTEM_PROMPT", () => {
  // Same fix as scope-line-item-service.ts's buildSystemPrompt, applied
  // here too -- a drawing has no text layer to verify a sourceQuote
  // against (sourceQuote stays "" for every drawing-sourced item, see
  // proposeLineItemsFromDrawing's own comment), which makes getting the
  // description itself right even more important for this path than the
  // text-based one. Only proves the instruction is present, not that the
  // model follows it -- that needs a real key and a real drawing.
  it("instructs the model to preserve source wording for custom-fabricated items", () => {
    expect(SYSTEM_PROMPT).toMatch(/preserve the sheet's own specifying language/);
    expect(SYSTEM_PROMPT).toMatch(/single-sided Chinese birch/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf" --
  // see DrawingElementMapFromAI's own header comment): an LED screen's
  // tile grid was proposed with no overall size, and a 39.06" wall panel
  // had no height even though the sheet stated one elsewhere. Only proves
  // the instructions are present, not that the model follows them --
  // that's the real-file verification (see this feature's own plan).
  it("instructs the model to compute an overall size from a repeated-unit grid, not just report the tile count", () => {
    expect(SYSTEM_PROMPT).toMatch(/rectangular GRID of identically-dimensioned repeated units/);
    expect(SYSTEM_PROMPT).toMatch(/117\.18"W x 136\.71"H \(6x7 grid of 19\.53" tiles\)/);
    expect(SYSTEM_PROMPT).toMatch(/never in qty/);
  });

  it("instructs the model to include a panel's height only when it's actually determinable from the sheet", () => {
    expect(SYSTEM_PROMPT).toMatch(/leave it out of the description entirely rather than inventing or assuming one/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf" --
  // real production use): page 7 ("LEFT FRONT CORNER") in isolation
  // consistently read one height, but the SAME page batched with pages
  // 8-9 (its normal 3-page batch) produced a different, unstable height
  // on every real run -- confirmed via a dedicated isolation test that the
  // instability only appears once other pages' images are in the same
  // call. Page 7 is also itself a genuinely multi-elevation sheet (4
  // separate elevations, several with their own different heights),
  // confirmed by direct visual inspection.
  it("instructs the model not to borrow a height from a different page or a different elevation on the same page", () => {
    expect(SYSTEM_PROMPT).toMatch(/must come from the SAME page as that panel/);
    expect(SYSTEM_PROMPT).toMatch(/match each panel to the height labeled on its OWN elevation/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf",
  // real production use): page 12 ("CENTER WALL") genuinely has two
  // separate elevations, each with its own individual segments AND its
  // own overall dimension(s) -- confirmed by direct, careful visual
  // inspection: right elevation 29.29"+39.06"x5 (aggregate 224.59"), left
  // elevation 19.53"x2+95.21"+56.15"+95.20" with TWO overlapping overall
  // totals (290.50" full width, 246.56" grid-only sub-width). Real models
  // tested against this exact page were both incomplete/unstable --
  // gpt-4o consistently missed the 95.21"/95.20" segments, Claude Sonnet
  // 4.5 swung between finding almost nothing and treating one elevation's
  // aggregate as a "return panel" belonging to the other.
  it("instructs the model that one elevation can have more than one overall/aggregate dimension", () => {
    expect(SYSTEM_PROMPT).toMatch(/MORE THAN ONE such overall dimension/);
    expect(SYSTEM_PROMPT).toMatch(/Every one of these overall\/sub-total numbers is a check-dimension/);
  });

  it("instructs the model to fully work through every elevation on a multi-elevation sheet, not just the first or most prominent one", () => {
    expect(SYSTEM_PROMPT).toMatch(/don't stop after the first elevation you process/);
    expect(SYSTEM_PROMPT).toMatch(/has 11 real segments to account for in total/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf",
  // real production use): a "219.53"W x 190.51"H wall panel" item appeared
  // in 3 separate real runs on page 12 ("CENTER WALL"). Direct, careful
  // visual inspection of both of that page's elevations (every printed
  // number cross-checked) confirmed "219.53"" is printed NOWHERE on the
  // page -- but a real segment "19.53"" is printed twice, and three real
  // aggregate totals on the same sheet (224.59", 290.50", 246.56") all
  // start with the same leading digit "2". Not caught by
  // flagPossibleMisreads: that function only catches a same-length
  // single-digit substitution ("30.06" vs "39.06"), and "219.53" (6 chars)
  // vs "19.53" (5 chars) is a digit INSERTION, a different corruption mode.
  it("instructs the model not to blend a digit from a nearby aggregate total into a segment's own value", () => {
    expect(SYSTEM_PROMPT).toMatch(/never blend, prepend, or append a digit from a different, nearby label/);
    expect(SYSTEM_PROMPT).toMatch(/"19\.53"" sitting near an unrelated "224\.59"" or "290\.50"" total/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf" --
  // real production use): a page titled "CALLOUTS" that's purely a
  // floor-plan legend (dashed boxes naming zones like "Left Back Corner,"
  // "Front Tower Left," with no dimensions or fabrication detail of its
  // own -- confirmed by rendering and looking at the real page) produced
  // its own generic, dimension-less placeholder item per named zone --
  // scope that gets double-priced once here and again by that same zone's
  // own dedicated detail sheet elsewhere in the document.
  it("instructs the model not to propose a placeholder item per named callout on a floor-plan legend sheet", () => {
    expect(SYSTEM_PROMPT).toMatch(/reference index, not fabrication scope/);
    expect(SYSTEM_PROMPT).toMatch(/propose NOTHING from a page like this/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf",
  // real production use): the real document shows two elevated platforms
  // with staircases (one per back corner) only on its whole-booth overview
  // pages, with no printed numeric dimension for either anywhere in the
  // 14-page document (confirmed by direct visual inspection of every
  // corner/wall detail sheet) -- repeated real Pass-2 runs against the
  // batch containing the back-corner detail sheet never produced a
  // platform/staircase item at all, a substantial, expensive, physically
  // real structure silently dropped because nothing distinguished it from
  // the CALLOUTS-exclusion case just above (a page with no dimension line
  // was being treated as having no real scope to price).
  it("instructs the model to propose an elevated platform/staircase structure even with no printed dimension, distinct from the CALLOUTS-exclusion case", () => {
    expect(SYSTEM_PROMPT).toMatch(/raised deck on support posts/);
    expect(SYSTEM_PROMPT).toMatch(/propose it as its own line item even when no dimension line anywhere in the document gives it a printed numeric size/);
    expect(SYSTEM_PROMPT).toMatch(/a bare 2D zone-location index with nothing of its own to price/);
  });

  it("instructs the model to give each visually distinct platform its own item, qty 1 EA, category Flooring & Platforms", () => {
    expect(SYSTEM_PROMPT).toMatch(/qty 1 EA, qtyIsExplicit: true, the same directly-countable logic already covered above/);
    expect(SYSTEM_PROMPT).toMatch(/category is "Flooring & Platforms"/);
  });

  it("instructs the model to state in the description itself when a platform's size is approximate rather than read from a printed value", () => {
    expect(SYSTEM_PROMPT).toMatch(/say so directly in the description itself/);
    expect(SYSTEM_PROMPT).toMatch(/Never invent a precise-looking width x height the sheet never actually gives/);
  });

  it("instructs the model not to go looking for a platform on every booth", () => {
    expect(SYSTEM_PROMPT).toMatch(/most booths have none/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf",
  // real production use): confirmed directly against page 12 ("CENTER
  // WALL") that its own printed aggregate (224.59") is exactly the sum of
  // five individually-dimensioned segments (29.29" + 39.06"x4) already
  // being proposed as their own items -- yet the aggregate was ALSO
  // proposed as a separate "wall section" item, double-counting real
  // material cost.
  it("instructs the model not to propose an overall/aggregate dimension as its own item alongside the segments it sums", () => {
    expect(SYSTEM_PROMPT).toMatch(/check-dimension confirming the segments below it add up correctly/);
    expect(SYSTEM_PROMPT).toMatch(/Never propose the overall\/aggregate span as its own separate item/);
  });

  it("instructs the model to copy elementName from the per-page element list given below, never guessing one", () => {
    expect(SYSTEM_PROMPT).toMatch(/Elements identified per page/);
    expect(SYSTEM_PROMPT).toMatch(/copy that string exactly, don't reword it/);
    expect(SYSTEM_PROMPT).toMatch(/leave elementName null rather than guessing one/);
  });
});

describe("ELEMENT_MAP_SYSTEM_PROMPT", () => {
  it("instructs the model to read the page's own printed title first", () => {
    expect(ELEMENT_MAP_SYSTEM_PROMPT).toMatch(/Read that title FIRST/);
  });

  it("instructs the model to reuse the exact same element name across pages of the same element", () => {
    expect(ELEMENT_MAP_SYSTEM_PROMPT).toMatch(/MUST use the exact same name string on every page/);
  });

  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf",
  // real production use): the whole-booth overview pages (1-4) clearly show
  // two elevated second-level platforms with staircases (one per back
  // corner, confirmed by direct high-resolution visual inspection), but a
  // real Pass-1 run against the full 14-page document collapsed all four
  // overview pages to one generic "Booth Overview" element with no
  // sub-decomposition -- so neither platform ever got its own
  // elementName, and downstream Pass 2 had nothing distinct to route a
  // platform item's section through.
  it("instructs the model to give an elevated platform/mezzanine deck its own named element, not fold it into a generic overview entry", () => {
    expect(ELEMENT_MAP_SYSTEM_PROMPT).toMatch(/raised deck on support posts/);
    expect(ELEMENT_MAP_SYSTEM_PROMPT).toMatch(/connected to the floor by its own staircase/);
    expect(ELEMENT_MAP_SYSTEM_PROMPT).toMatch(/Elevated Platform - Left Back Corner/);
  });

  it("instructs the model not to invent a platform entry that isn't genuinely visible", () => {
    expect(ELEMENT_MAP_SYSTEM_PROMPT).toMatch(/don't go looking for a platform that isn't there/);
  });

  it("lists the same SCOPE_CATEGORIES values used by the line-item pass", () => {
    for (const category of SCOPE_CATEGORIES) {
      expect(ELEMENT_MAP_SYSTEM_PROMPT).toContain(category);
    }
  });
});

describe("DRAWING_LINE_ITEM_SCHEMA", () => {
  it("declares elementName and subElementName as nullable strings, required under strict mode", () => {
    const itemProps = DRAWING_LINE_ITEM_SCHEMA.schema.properties.items.items.properties as Record<string, { type: unknown }>;
    const required = DRAWING_LINE_ITEM_SCHEMA.schema.properties.items.items.required as readonly string[];

    expect(itemProps.elementName.type).toEqual(["string", "null"]);
    expect(itemProps.subElementName.type).toEqual(["string", "null"]);
    // strict: true requires every declared property to be listed here --
    // a missed entry fails silently at the OpenAI API level, not at parse
    // time, so this is worth a direct assertion.
    expect(required).toContain("elementName");
    expect(required).toContain("subElementName");
  });
});

describe("DRAWING_ELEMENT_MAP_SCHEMA", () => {
  it("requires pageNumber, pageTitle, and elements on every page entry", () => {
    const pageRequired = DRAWING_ELEMENT_MAP_SCHEMA.schema.properties.pages.items.required as readonly string[];
    expect(pageRequired).toEqual(["pageNumber", "pageTitle", "elements"]);
  });

  it("requires name and category on every element entry", () => {
    const elementRequired = DRAWING_ELEMENT_MAP_SCHEMA.schema.properties.pages.items.properties.elements.items
      .required as readonly string[];
    expect(elementRequired).toEqual(["name", "category"]);
  });
});
