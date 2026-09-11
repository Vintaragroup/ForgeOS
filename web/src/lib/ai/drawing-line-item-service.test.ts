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
} from "@/lib/ai/drawing-line-item-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";
import { SCOPE_CATEGORIES } from "@/lib/ai/scope-line-item-service";

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
