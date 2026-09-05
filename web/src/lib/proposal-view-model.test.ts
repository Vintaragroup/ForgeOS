import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import {
  aggregateByCategory,
  boothGroupsByCategory,
  bucketLineItemsByCategory,
  groupBoothLineItems,
  groupBoothLineItemsForEditing,
  groupPrimaryCategoryTabs,
  mergeBoothGroupsForAllMethods,
  mergeCategoryBucketsForAllMethods,
  resolveEffectiveCategory,
  standaloneSummaryGroupsByCategory,
  type ProposalViewSection,
  type RawBoothGroup,
  type RawCategoryBucket,
} from "@/lib/proposal-view-model";

function cat(name: string, key: string) {
  return { id: key, name, key, parentId: null, sortOrder: 0, isShowService: false, isLumpSum: false, deletedAt: null } as never;
}

function li(overrides: Partial<{ id: string; description: string; category: string | null; qty: number; unit: string | null; totalCost: number; isClientOwned: boolean; sortOrder: number }>) {
  return {
    id: overrides.id ?? "li1",
    description: overrides.description ?? "Item",
    category: overrides.category ?? "Structure",
    isClientOwned: overrides.isClientOwned ?? false,
    qty: new Prisma.Decimal(overrides.qty ?? 1),
    unit: overrides.unit ?? "EA",
    totalCost: new Prisma.Decimal(overrides.totalCost ?? 100),
    sortOrder: overrides.sortOrder ?? 0,
  };
}

const categories = [cat("Structure", "structure")];

describe("aggregateByCategory -- booth-scoped grouping", () => {
  it("keeps the same part description separate across two different booths instead of merging their pricing", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 211", lineItems: [li({ id: "a", description: "614 x 2418mm Post", qty: 3, totalCost: 327 })] },
      { name: "BeMatrix", groupLabel: "SECTION 428", lineItems: [li({ id: "b", description: "614 x 2418mm Post", qty: 2, totalCost: 218 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(2);
    const bySection = Object.fromEntries(bucket.items.map((i) => [i.boothLabel, i]));
    expect(bySection["SECTION 211"]?.qty).toBe(3);
    expect(bySection["SECTION 211"]?.totalCost).toBe(327);
    expect(bySection["SECTION 428"]?.qty).toBe(2);
    expect(bySection["SECTION 428"]?.totalCost).toBe(218);
  });

  it("still merges duplicate rows of the same part WITHIN one booth", () => {
    const sections: ProposalViewSection[] = [
      {
        name: "BeMatrix",
        groupLabel: "SECTION 428",
        lineItems: [
          li({ id: "a", description: "614 x 2418mm Post", qty: 3, totalCost: 327 }),
          li({ id: "b", description: "614 x 2418mm Post", qty: 1, totalCost: 109 }),
        ],
      },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0].qty).toBe(4);
    expect(bucket.items[0].totalCost).toBe(436);
    expect(bucket.items[0].boothLabel).toBe("SECTION 428");
  });

  it("still sums a booth-INDEPENDENT part (no groupLabel) across the whole show, unchanged from before", () => {
    const sections: ProposalViewSection[] = [
      { name: "Add-Ons", groupLabel: null, lineItems: [li({ id: "a", description: "Compliant Door", qty: 1, totalCost: 150 })] },
      { name: "Add-Ons", groupLabel: null, lineItems: [li({ id: "b", description: "Compliant Door", qty: 1, totalCost: 150 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0].qty).toBe(2);
    expect(bucket.items[0].totalCost).toBe(300);
    expect(bucket.items[0].boothLabel).toBeNull();
  });

  it("never merges a compound assembly across booths even when they share identical spec text", () => {
    const sections: ProposalViewSection[] = [
      { name: "Booth", groupLabel: "SECTION 203", lineItems: [li({ id: "a", description: "Complete Booth Build\n12' x 7' booth", qty: 1, totalCost: 5000 })] },
      { name: "Booth", groupLabel: "SECTION 211", lineItems: [li({ id: "b", description: "Complete Booth Build\n12' x 7' booth", qty: 1, totalCost: 6000 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(2);
    expect(bucket.items.map((i) => i.totalCost).sort()).toEqual([5000, 6000]);
  });

  it("excludes a hidden section entirely, and a hidden line item within an otherwise-visible section", () => {
    const sections: ProposalViewSection[] = [
      { name: "Booth", groupLabel: "SECTION 203", includeInProposal: false, lineItems: [li({ id: "a", totalCost: 5000 })] },
      {
        name: "Add-Ons",
        groupLabel: null,
        lineItems: [
          li({ id: "b", description: "Visible", totalCost: 150 }),
          { ...li({ id: "c", description: "Hidden", totalCost: 9999 }), includeInProposal: false },
        ],
      },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0].description).toBe("Visible");
    expect(bucket.items[0].totalCost).toBe(150);
  });

  it("excludes a whole section flagged excludedFromTotals from the client PDF, distinct from includeInProposal", () => {
    const sections: ProposalViewSection[] = [
      {
        name: "Labor",
        groupLabel: "Bid Comparison",
        excludedFromTotals: true,
        lineItems: [li({ id: "a", description: "Straight Time Rate in Chicago - CSI", totalCost: 20100 })],
      },
      { name: "Booth", groupLabel: "SECTION 203", lineItems: [li({ id: "b", description: "Real scope", totalCost: 5000 })] },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(1);
    expect(bucket.items[0].description).toBe("Real scope");
  });

  it("scopes a summarized standalone section's items to itself, never cross-merging with another section", () => {
    // Regression: a booth-independent line normally sums across the whole
    // show on purpose (see the "Compliant Door" test above) -- but a
    // section explicitly switched to "Summarized on proposal" is meant to
    // render as its OWN lump-sum line (standaloneSummaryGroupsByCategory
    // below), so its items must stay scoped to that one section the same
    // way a real booth's own items already do, not get folded into an
    // unrelated section's identical-looking row.
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "Custom Flooring",
        groupLabel: null,
        summarizeOnProposal: true,
        lineItems: [li({ id: "a", description: "Turf", qty: 1, totalCost: 5000 })],
      },
      {
        id: "s2",
        name: "Other Flooring Section",
        groupLabel: null,
        summarizeOnProposal: false,
        lineItems: [li({ id: "b", description: "Turf", qty: 1, totalCost: 5000 })],
      },
    ];

    const [bucket] = aggregateByCategory(sections, categories);

    expect(bucket.items).toHaveLength(2);
    const totalCost = bucket.items.reduce((sum, i) => sum + i.totalCost, 0);
    expect(totalCost).toBe(10000);
    const summarizedItem = bucket.items.find((i) => i.boothLabel?.includes("s1"));
    expect(summarizedItem?.qty).toBe(1);
    expect(summarizedItem?.boothLabel).not.toBeNull();
  });
});

describe("boothGroupsByCategory", () => {
  it("keys a tagged booth's own group by the composed Method leaf, not the plain top-level Type name", () => {
    // This is the exact mismatch proposal-pdf.tsx's own render loop used
    // to fall into: a tagged booth's items resolve (resolveEffectiveCategory)
    // into the COMPOSED leaf category ("Audio/Visual - Rental") the
    // instant its section has both a groupLabel and a buildType, so this
    // function's own output has to be keyed there too, not under the
    // plain Type name a caller might naively look it up by.
    const audioVisual = cat("Audio/Visual", "audio_visual");
    const audioVisualRental = {
      id: "audio_visual_rental",
      name: "Audio/Visual - Rental",
      key: "audio_visual_rental",
      parentId: "audio_visual",
      sortOrder: 0,
      isShowService: false,
      isLumpSum: false,
      deletedAt: null,
    } as never;
    const categoriesWithSplit = [audioVisual, audioVisualRental];
    const sections: ProposalViewSection[] = [
      {
        name: "LED Screen",
        groupLabel: "RENTAL",
        buildType: "RENTAL",
        boothDescription: "Large LED Display Wall",
        lineItems: [li({ id: "a", description: "LED Screen 8h x 11w", category: "Audio/Visual", totalCost: 16460 })],
      },
    ];

    const result = boothGroupsByCategory(sections, categoriesWithSplit);

    expect(result.get("Audio/Visual")).toBeUndefined();
    const [booth] = result.get("Audio/Visual - Rental") ?? [];
    expect(booth?.boothDescription).toBe("Large LED Display Wall");
    expect(booth?.subtotal).toBe(16460);
  });

  it("keys a real booth's own H2 (elementType) label by its approved per-category heading, not the raw section name (confirmed live on production's Audio/Visual tab: a component approved as 'All Audio and Video elements - Rentals' in the editor still rendered as its raw import filename here)", () => {
    const audioVisual = cat("Audio/Visual", "audio_visual");
    const audioVisualRental = {
      id: "audio_visual_rental",
      name: "Audio/Visual - Rental",
      key: "audio_visual_rental",
      parentId: "audio_visual",
      sortOrder: 0,
      isShowService: false,
      isLumpSum: false,
      deletedAt: null,
    } as never;
    const categoriesWithSplit = [audioVisual, audioVisualRental];
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "369711-Version-2-Expo-CCI--Full-Swing-Baseball--ABCA--Chicago--No-LX-or-Rig--V2.pdf",
        groupLabel: "RENTAL",
        buildType: "RENTAL",
        boothDescription: "Large LED Display Wall",
        categoryDescriptions: [{ categoryId: "audio_visual_rental", description: "All Audio and Video elements - Rentals" }],
        lineItems: [li({ id: "a", description: "LED Screen 8h x 11w", category: "Audio/Visual", totalCost: 16460 })],
      },
    ];

    const [booth] = boothGroupsByCategory(sections, categoriesWithSplit).get("Audio/Visual - Rental") ?? [];

    expect(booth?.elementGroups[0]?.elementType).toBe("All Audio and Video elements - Rentals");
  });
});

describe("standaloneSummaryGroupsByCategory", () => {
  it("renders a booth-independent summarized section as its own lump-sum group, using its approved description", () => {
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "Custom Flooring Installation",
        description: "Turf & Carpet Package",
        groupLabel: null,
        summarizeOnProposal: true,
        lineItems: [
          li({ id: "a", description: "Turf", qty: 1, totalCost: 5000 }),
          li({ id: "b", description: "Carpet", qty: 1, totalCost: 3000 }),
        ],
      },
    ];

    const [group] = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(group?.boothDescription).toBe("Turf & Carpet Package");
    expect(group?.subtotal).toBe(8000);
    expect(group?.summarizeOnProposal).toBe(true);
  });

  it("falls back to the section's raw name when it has no approved description", () => {
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "Custom Flooring Installation",
        groupLabel: null,
        summarizeOnProposal: true,
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
    ];

    const [group] = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(group?.boothDescription).toBe("Custom Flooring Installation");
  });

  it("prefers a per-category description override over the section's shared description, for both the booth (H1) and element-type (H2) headings", () => {
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "QUOTE-EXPOCCI-55672-BASEBALL_BOOTH.PDF",
        description: null,
        groupLabel: null,
        summarizeOnProposal: true,
        categoryDescriptions: [{ categoryId: "structure", description: "Suspended Baseball Signage Display" }],
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
    ];

    const [group] = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(group?.boothDescription).toBe("Suspended Baseball Signage Display");
    // elementTypeForSection (groupBoothLineItems' own H2 label) reads
    // straight off whatever `name` it's given -- without also resolving
    // this override into the clone's `name`, H2 would still show the raw
    // filename even after H1 was fixed (exactly what production showed).
    expect(group?.elementGroups[0]?.elementType).toBe("Suspended Baseball Signage Display");
  });

  it("falls back to the shared description when a category-override row exists but hasn't been approved yet", () => {
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "Raw Filename.pdf",
        description: "Shared Approved Heading",
        groupLabel: null,
        summarizeOnProposal: true,
        categoryDescriptions: [{ categoryId: "structure", description: null }],
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
    ];

    const [group] = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(group?.boothDescription).toBe("Shared Approved Heading");
  });

  it("keeps two different summarized standalone sections as two separate groups, not merged into one", () => {
    const sections: ProposalViewSection[] = [
      { id: "s1", name: "Flooring A", groupLabel: null, summarizeOnProposal: true, lineItems: [li({ id: "a", totalCost: 100 })] },
      { id: "s2", name: "Flooring B", groupLabel: null, summarizeOnProposal: true, lineItems: [li({ id: "b", totalCost: 200 })] },
    ];

    const groups = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.subtotal).sort()).toEqual([100, 200]);
  });

  it("excludes a non-summarized standalone section entirely -- unaffected, unchanged flat rendering", () => {
    const sections: ProposalViewSection[] = [
      { id: "s1", name: "Flooring", groupLabel: null, summarizeOnProposal: false, lineItems: [li({ id: "a", totalCost: 100 })] },
    ];

    const groups = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(groups).toHaveLength(0);
  });

  it("excludes a real tagged booth entirely -- that's boothGroupsByCategory's own job", () => {
    const sections: ProposalViewSection[] = [
      {
        id: "s1",
        name: "Booth",
        groupLabel: "SECTION 211",
        buildType: "RENTAL",
        summarizeOnProposal: true,
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
    ];

    const groups = standaloneSummaryGroupsByCategory(sections, categories).get("Structure") ?? [];

    expect(groups).toHaveLength(0);
  });
});

describe("groupBoothLineItems", () => {
  it("groups by booth, then by element type -- keeping BeMatrix (Wall Structure) and Wall Panels (Wall Covering) separate", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 211", lineItems: [li({ id: "a", description: "310mm x 2418mm Frame", qty: 4, totalCost: 1300 })] },
      { name: "Wall Panels", groupLabel: "SECTION 211", lineItems: [li({ id: "b", description: "SEG w/ Blackout White", qty: 6, totalCost: 200, unit: "SQFT" })] },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.boothLabel).toBe("SECTION 211");
    expect(booth.elementGroups.map((g) => g.elementType)).toEqual(["Wall Structure", "Wall Covering"]);
    expect(booth.elementGroups[0].items[0].description).toBe("310mm x 2418mm Frame");
    expect(booth.elementGroups[1].items[0].description).toBe("SEG w/ Blackout White");
    expect(booth.subtotal).toBe(1500);
  });

  it("orders multiple booths by their own label and ignores booth-independent sections entirely", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 428", lineItems: [li({ id: "a", totalCost: 100 })] },
      { name: "BeMatrix", groupLabel: "SECTION 211", lineItems: [li({ id: "b", totalCost: 200 })] },
      { name: "Add-Ons", groupLabel: null, lineItems: [li({ id: "c", totalCost: 9999 })] },
    ];

    const groups = groupBoothLineItems(sections);

    expect(groups.map((g) => g.boothLabel)).toEqual(["SECTION 211", "SECTION 428"]);
    const total = groups.reduce((sum, g) => sum + g.subtotal, 0);
    expect(total).toBe(300); // the $9999 Add-Ons item never contributes -- no groupLabel
  });

  it("orders booths by proposalSortOrder when set, overriding the alphabetical default", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 211", proposalSortOrder: 1, lineItems: [li({ id: "a", totalCost: 100 })] },
      { name: "BeMatrix", groupLabel: "SECTION 428", proposalSortOrder: 0, lineItems: [li({ id: "b", totalCost: 200 })] },
    ];

    const groups = groupBoothLineItems(sections);

    expect(groups.map((g) => g.boothLabel)).toEqual(["SECTION 428", "SECTION 211"]);
  });

  it("orders a booth's own custom-named groups by sortOrder -- moveElementGroupOrder must actually reach the client-facing PDF/web proposal", () => {
    // Regression: moveElementGroupOrder (estimate-service.ts) already
    // persisted this correctly, and the editing view already reflected
    // it, but this function -- the one the real Proposal PDF and web
    // view are built from -- never read the field at all, so a moved
    // group kept rendering in its original position there. Confirmed
    // live: reordering a booth's groups had no visible effect on Preview
    // PDF whatsoever.
    const sections: ProposalViewSection[] = [
      { name: "Platform", groupLabel: "SECTION 231", sortOrder: 1, lineItems: [li({ id: "a", totalCost: 100 })] },
      { name: "Booth Build", groupLabel: "SECTION 231", sortOrder: 0, lineItems: [li({ id: "b", totalCost: 200 })] },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.elementGroups.map((g) => g.elementType)).toEqual(["Booth Build", "Platform"]);
  });

  it("carries summarizeOnProposal through to the BoothGroup, defaulting false when unset", () => {
    const summarized: ProposalViewSection[] = [
      { name: "Platform", groupLabel: "SECTION 231", summarizeOnProposal: true, lineItems: [li({ id: "a", totalCost: 100 })] },
    ];
    const plain: ProposalViewSection[] = [
      { name: "Platform", groupLabel: "SECTION 428", lineItems: [li({ id: "b", totalCost: 100 })] },
    ];

    const [summarizedBooth] = groupBoothLineItems(summarized);
    const [plainBooth] = groupBoothLineItems(plain);

    expect(summarizedBooth.summarizeOnProposal).toBe(true);
    expect(plainBooth.summarizeOnProposal).toBe(false);
  });

  it("never removes a summarized booth's items from its own subtotal -- only proposal-pdf.tsx's rendering skips them", () => {
    // The whole point of summarizeOnProposal (see its own schema comment):
    // hide the itemized detail on the client PDF without changing any
    // total. groupBoothLineItems itself must keep computing the real
    // subtotal regardless -- it's proposal-pdf.tsx's job to skip
    // rendering elementGroups, never this function's job to drop them
    // from the math.
    const sections: ProposalViewSection[] = [
      {
        name: "Platform",
        groupLabel: "SECTION 231",
        summarizeOnProposal: true,
        lineItems: [
          li({ id: "a", description: "Sleeper floor", totalCost: 100 }),
          li({ id: "b", description: "Platform for booth", totalCost: 200 }),
        ],
      },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.summarizeOnProposal).toBe(true);
    expect(booth.subtotal).toBe(300);
    expect(booth.elementGroups[0].items).toHaveLength(2);
  });

  it("uses the booth's approved boothDescription for its heading, falling back to the raw boothLabel when unset", () => {
    // Regression: this function -- the one the real Proposal PDF and web
    // proposal are built from -- never read boothDescription at all, so
    // an estimator's approved friendly booth name (e.g. "Large LED
    // Display Wall") never reached the client-facing document; it always
    // showed the raw, often cryptic internal groupLabel (e.g. "RENTAL")
    // instead, even though the Line Items tab showed the approved name
    // correctly. Confirmed live on a real production estimate.
    const described: ProposalViewSection[] = [
      {
        name: "Platform",
        groupLabel: "RENTAL",
        boothDescription: "Large LED Display Wall",
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
    ];
    const plain: ProposalViewSection[] = [
      { name: "Platform", groupLabel: "SECTION 428", lineItems: [li({ id: "b", totalCost: 100 })] },
    ];

    const [describedBooth] = groupBoothLineItems(described);
    const [plainBooth] = groupBoothLineItems(plain);

    expect(describedBooth.boothDescription).toBe("Large LED Display Wall");
    expect(plainBooth.boothDescription).toBeNull();
  });

  it("prefers a section with a real boothDescription over one encountered first with none", () => {
    // Same class of bug as groupBoothLineItemsForEditing's own regression
    // test -- a new section joining an already-described booth (e.g. via
    // "Move to group" or a merge) could still land here with a null
    // boothDescription; if it happened to sort before the booth's real,
    // approved section, "first section wins outright" made an approved
    // heading appear to silently revert on the PDF specifically.
    const sections: ProposalViewSection[] = [
      { name: "Labor", groupLabel: "RENTAL", boothDescription: null, lineItems: [li({ id: "a", totalCost: 100 })] },
      {
        name: "Platform",
        groupLabel: "RENTAL",
        boothDescription: "Large LED Display Wall",
        lineItems: [li({ id: "b", totalCost: 200 })],
      },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.boothDescription).toBe("Large LED Display Wall");
  });

  it("carries boothSummary through to the BoothGroup, defaulting null when unset", () => {
    const withSummary: ProposalViewSection[] = [
      {
        name: "Platform",
        groupLabel: "SECTION 231",
        summarizeOnProposal: true,
        boothSummary: "A custom hitting bay wall with integrated monitor mounts.",
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
    ];
    const withoutSummary: ProposalViewSection[] = [
      { name: "Platform", groupLabel: "SECTION 428", summarizeOnProposal: true, lineItems: [li({ id: "b", totalCost: 100 })] },
    ];

    const [boothWithSummary] = groupBoothLineItems(withSummary);
    const [boothWithoutSummary] = groupBoothLineItems(withoutSummary);

    expect(boothWithSummary.boothSummary).toBe("A custom hitting bay wall with integrated monitor mounts.");
    expect(boothWithoutSummary.boothSummary).toBeNull();
  });

  it("carries elementSummary through to the ElementTypeGroup, defaulting null when unset", () => {
    const sections: ProposalViewSection[] = [
      {
        name: "Structure",
        groupLabel: "SECTION 231",
        elementSummary: "Aluminum extrusion frame with printed fabric panels.",
        lineItems: [li({ id: "a", totalCost: 100 })],
      },
      { name: "Graphics", groupLabel: "SECTION 231", lineItems: [li({ id: "b", totalCost: 50 })] },
    ];

    const [booth] = groupBoothLineItems(sections);
    const structureGroup = booth.elementGroups.find((g) => g.elementType === "Structure");
    const graphicsGroup = booth.elementGroups.find((g) => g.elementType === "Graphics");

    expect(structureGroup?.elementSummary).toBe("Aluminum extrusion frame with printed fabric panels.");
    expect(graphicsGroup?.elementSummary).toBeNull();
  });

  it("excludes a section whose includeInProposal is false, and a line item whose own flag is false", () => {
    const sections: ProposalViewSection[] = [
      { name: "BeMatrix", groupLabel: "SECTION 211", includeInProposal: false, lineItems: [li({ id: "a", totalCost: 100 })] },
      {
        name: "Wall Panels",
        groupLabel: "SECTION 428",
        lineItems: [
          li({ id: "b", description: "Visible item", totalCost: 200 }),
          { ...li({ id: "c", description: "Hidden item", totalCost: 9999 }), includeInProposal: false },
        ],
      },
    ];

    const groups = groupBoothLineItems(sections);

    expect(groups.map((g) => g.boothLabel)).toEqual(["SECTION 428"]);
    expect(groups[0].subtotal).toBe(200);
  });

  it("falls back to the raw section name for an unmapped element-type category instead of dropping it", () => {
    const sections: ProposalViewSection[] = [
      { name: "Cleaning", groupLabel: "SECTION 211", lineItems: [li({ id: "a", description: "Post-show cleaning", totalCost: 50 })] },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.elementGroups[0].elementType).toBe("Cleaning");
  });

  it("still merges duplicate parts within the same booth+element-type, but never removes a compound assembly's booth label ambiguity across booths", () => {
    const sections: ProposalViewSection[] = [
      {
        name: "BeMatrix",
        groupLabel: "SECTION 428",
        lineItems: [
          li({ id: "a", description: "614 x 2418mm Post", qty: 3, totalCost: 327 }),
          li({ id: "b", description: "614 x 2418mm Post", qty: 1, totalCost: 109 }),
        ],
      },
    ];

    const [booth] = groupBoothLineItems(sections);

    expect(booth.elementGroups[0].items).toHaveLength(1);
    expect(booth.elementGroups[0].items[0].qty).toBe(4);
    // The booth is already the group's own heading -- redundant per-item
    // label would just repeat it under every single row.
    expect(booth.elementGroups[0].items[0].boothLabel).toBeNull();
  });
});

describe("groupBoothLineItemsForEditing -- description/pendingDescription carry-through", () => {
  function editableSection(overrides: {
    id: string;
    name: string;
    groupLabel: string | null;
    description?: string | null;
    pendingDescription?: string | null;
    boothDescription?: string | null;
    boothPendingDescription?: string | null;
    sortOrder?: number;
  }) {
    return {
      id: overrides.id,
      name: overrides.name,
      groupLabel: overrides.groupLabel,
      description: overrides.description ?? null,
      pendingDescription: overrides.pendingDescription ?? null,
      boothDescription: overrides.boothDescription ?? null,
      boothPendingDescription: overrides.boothPendingDescription ?? null,
      sortOrder: overrides.sortOrder ?? 0,
      lineItems: [li({ id: `${overrides.id}-item`, totalCost: 100 })],
    };
  }

  it("carries an unmapped section's description/pendingDescription onto its bucket, marked not-mapped", () => {
    const sections = [
      editableSection({ id: "s1", name: "Custom Build", groupLabel: "FS - Reception Counter", description: "Reception counter" }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.elementGroups[0].elementType).toBe("Custom Build");
    expect(booth.elementGroups[0].sectionIds).toEqual(["s1"]);
    expect(booth.elementGroups[0].description).toBe("Reception counter");
    expect(booth.elementGroups[0].isMapped).toBe(false);
  });

  it("marks a mapped section (e.g. BeMatrix -> Wall Structure) as isMapped regardless of its own description fields", () => {
    const sections = [editableSection({ id: "s1", name: "BeMatrix", groupLabel: "SECTION 211", description: "should be ignored" })];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.elementGroups[0].elementType).toBe("Wall Structure");
    expect(booth.elementGroups[0].isMapped).toBe(true);
  });

  it("keeps a merged (two-same-named-sections) unmapped bucket editable -- merging isn't a mapped category", () => {
    // Regression: an estimator recategorizing one item into an existing
    // custom-named component (e.g. a Shipping-tab item joining a booth's
    // "Custom Build") used to force isMapped true and null out the
    // description the instant a second section started contributing to
    // the same bucket -- silently stripping that component's own AI-
    // suggest icon and (once moveElementGroupOrder shipped) its up/down
    // reorder buttons too, with no indication why. Merging two sections
    // sharing a name is not a fixed ELEMENT_TYPE_MAP category, so it must
    // never flip isMapped on its own.
    const sections = [
      editableSection({ id: "s1", name: "Custom Build", groupLabel: "FS - Reception Counter", description: "Reception counter" }),
      editableSection({ id: "s2", name: "Custom Build", groupLabel: "FS - Reception Counter", description: "A different component" }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.elementGroups[0].sectionIds).toEqual(["s1", "s2"]);
    expect(booth.elementGroups[0].isMapped).toBe(false);
    // The bucket's own description is whichever section it was first
    // set from (s1, encountered first) -- s2's separate description is
    // simply not surfaced through this bucket, same simplification the
    // single-section case already makes.
    expect(booth.elementGroups[0].description).toBe("Reception counter");
  });

  it("carries the booth-level (H1) description/pendingDescription from the first section seen for that booth", () => {
    const sections = [
      editableSection({
        id: "s1",
        name: "BeMatrix",
        groupLabel: "SECTION 211",
        boothDescription: "Acme Corp booth",
      }),
      editableSection({
        id: "s2",
        name: "Wall Panels",
        groupLabel: "SECTION 211",
        boothDescription: "Acme Corp booth",
      }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.boothLabel).toBe("SECTION 211");
    expect(booth.boothDescription).toBe("Acme Corp booth");
    expect(booth.boothPendingDescription).toBeNull();
  });

  it("prefers a section with a real booth description over one encountered first with none", () => {
    // Regression: a brand-new H2 joining an already-described booth (e.g.
    // via "Move to group", or a booth merge from before
    // resolveOrCreateTargetSection/mergeBoothIntoAnotherBooth both started
    // inheriting the booth's fields) could still land here with a null
    // boothDescription. If that section happened to sort before the
    // booth's real, approved one, the old "first section wins outright"
    // rule made an already-approved H1 heading appear to silently revert
    // to its raw groupLabel -- confirmed live on a real production estimate.
    const sections = [
      editableSection({ id: "s1", name: "New Component", groupLabel: "SECTION 211", boothDescription: null }),
      editableSection({ id: "s2", name: "BeMatrix", groupLabel: "SECTION 211", boothDescription: "Acme Corp booth" }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.boothDescription).toBe("Acme Corp booth");
  });

  it("orders a booth's own custom-named groups by sortOrder (moveElementGroupOrder's own field)", () => {
    const sections = [
      editableSection({ id: "s1", name: "Platform", groupLabel: "SECTION 231", sortOrder: 1 }),
      editableSection({ id: "s2", name: "Booth Build", groupLabel: "SECTION 231", sortOrder: 0 }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.elementGroups.map((g) => g.elementType)).toEqual(["Booth Build", "Platform"]);
  });

  it("falls back to the fixed build-sequence rank only while every group still ties at the default sortOrder", () => {
    const sections = [
      // Graphics ranks after Wall Structure in ELEMENT_TYPE_ORDER; with
      // both sections still at the shared 0 default (nobody has
      // manually reordered this booth yet), that fixed rank is what
      // decides.
      editableSection({ id: "s1", name: "Graphic Panels", groupLabel: "SECTION 211" }),
      editableSection({ id: "s2", name: "BeMatrix", groupLabel: "SECTION 211" }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.elementGroups.map((g) => g.elementType)).toEqual(["Wall Structure", "Graphics"]);
  });

  it("lets an explicit sortOrder override a mapped group's fixed build-sequence rank", () => {
    // Regression: moveElementGroupOrder now reorders every group in a
    // booth, the 6 fixed ELEMENT_TYPE_MAP labels included -- confirmed
    // live as a real, wanted case (a manually-built component wanting
    // its own custom groups ordered above "Shipping," not the generic
    // frame-then-covering-then-shipping sequence). Once sortOrder
    // actually discriminates between two groups, it wins over the fixed
    // rank, not the other way around.
    const sections = [
      editableSection({ id: "s1", name: "Graphic Panels", groupLabel: "SECTION 211", sortOrder: 0 }),
      editableSection({ id: "s2", name: "BeMatrix", groupLabel: "SECTION 211", sortOrder: 1 }),
    ];

    const [booth] = groupBoothLineItemsForEditing(sections);

    expect(booth.elementGroups.map((g) => g.elementType)).toEqual(["Graphics", "Wall Structure"]);
  });
});

describe("bucketLineItemsByCategory -- description/pendingDescription carry-through", () => {
  it("carries a section's description, pendingDescription, and isMapped through to its RawCategorySectionGroup", () => {
    const sections = [
      {
        id: "s1",
        name: "Custom Build",
        groupLabel: null,
        description: null,
        pendingDescription: "Suggested title",
        lineItems: [li({ id: "a", category: "Structure" })],
      },
    ];

    const [bucket] = bucketLineItemsByCategory(sections, categories);
    const [group] = bucket.sectionGroups;

    expect(group.description).toBeNull();
    expect(group.pendingDescription).toBe("Suggested title");
    expect(group.isMapped).toBe(false);
  });

  it("carries a section's own elementSummary/elementPendingSummary through too, defaulting to null when the caller's section objects don't have them", () => {
    const sections = [
      {
        id: "s1",
        name: "Custom Build",
        groupLabel: null,
        description: null,
        pendingDescription: null,
        elementSummary: "Approved summary text.",
        elementPendingSummary: "Suggested summary text.",
        lineItems: [li({ id: "a", category: "Structure" })],
      },
      {
        id: "s2",
        name: "Other Section",
        groupLabel: null,
        description: null,
        pendingDescription: null,
        lineItems: [li({ id: "b", category: "Structure" })],
      },
    ];

    const [bucket] = bucketLineItemsByCategory(sections, categories);
    const [groupWithSummary, groupWithout] = bucket.sectionGroups;

    expect(groupWithSummary.elementSummary).toBe("Approved summary text.");
    expect(groupWithSummary.elementPendingSummary).toBe("Suggested summary text.");
    expect(groupWithout.elementSummary).toBeNull();
    expect(groupWithout.elementPendingSummary).toBeNull();
  });
});

describe("resolveEffectiveCategory", () => {
  it("resolves a tagged booth's Type to its Method leaf even when the Type's own parentId is wrongly non-null", () => {
    // Confirmed against real data: a Type category's parentId can be
    // non-null for a reason unrelated to this taxonomy (observed live --
    // "Structure" pointed at an unrelated flat category's id). Resolution
    // must key off each leaf's own stable `key`, never Category.parentId,
    // or a tagged booth's untagged-Type items resolve as if they were a
    // Method leaf of whatever category parentId happens to (wrongly)
    // point to instead of composing their own Type with the tag's Method.
    const unrelatedFlat = { id: "flat", name: "Custom Build / Rental", key: "custom_build", parentId: null };
    const structure = { id: "structure", name: "Structure", key: "structure", parentId: "flat" };
    const structureRental = { id: "structure_rental", name: "Structure - Rental", key: "structure_rental", parentId: "structure" };
    const categories = [unrelatedFlat, structure, structureRental];

    const result = resolveEffectiveCategory(
      { category: "Structure" },
      { groupLabel: "SECTION 211", buildType: "RENTAL" },
      categories,
    );

    expect(result).toBe("Structure - Rental");
  });

  it("falls through to the item's own raw category when the section isn't tagged", () => {
    const structure = { id: "structure", name: "Structure", key: "structure", parentId: null };

    const result = resolveEffectiveCategory({ category: "Structure" }, { groupLabel: null, buildType: null }, [structure]);

    expect(result).toBe("Structure");
  });

  it("falls back to Other for a category no longer in the live list", () => {
    const result = resolveEffectiveCategory({ category: "Deleted Category" }, { groupLabel: null, buildType: null }, []);

    expect(result).toBe("Other");
  });
});

describe("groupPrimaryCategoryTabs", () => {
  const TYPES = [
    { key: "structure", name: "Structure" },
    { key: "flooring", name: "Flooring" },
    { key: "furniture", name: "Furniture" },
    { key: "audio_visual", name: "Audio/Visual" },
    { key: "misc", name: "Misc" },
  ];
  const METHODS: { suffix: string; label: string }[] = [
    { suffix: "rental", label: "Rental" },
    { suffix: "purchase", label: "Purchase" },
    { suffix: "custom_fabricated", label: "Custom Fabricated" },
  ];
  const FLATS = [
    { key: "custom_build", name: "Custom Components" },
    { key: "labor", name: "Labor" },
  ];

  type CatShape = { id: string; name: string; key: string; parentId: string | null };

  function makeCategories(): CatShape[] {
    const types = TYPES.map((t) => cat(t.name, t.key) as unknown as CatShape);
    const leaves = types.flatMap((type) =>
      METHODS.map(({ suffix, label }) => ({
        ...(cat(`${type.name} - ${label}`, `${type.key}_${suffix}`) as unknown as CatShape),
        parentId: type.id,
      })),
    );
    const flats = FLATS.map((f) => cat(f.name, f.key) as unknown as CatShape);
    return [...types, ...leaves, ...flats];
  }

  function makeBucket(category: { id: string; name: string; key: string }, totalItems = 0): RawCategoryBucket<unknown> {
    return { category, totalItems, sectionGroups: [] };
  }

  it("groups ~28 flat categories into 5 Type-with-children tabs plus 2 flat tabs", () => {
    const categories = makeCategories();
    const buckets = categories.map((c) => makeBucket(c));

    const tabs = groupPrimaryCategoryTabs(buckets, categories);

    expect(tabs).toHaveLength(TYPES.length + FLATS.length);
    const withSplit = tabs.filter((t) => t.hasMethodSplit);
    expect(withSplit.map((t) => t.label).sort()).toEqual(TYPES.map((t) => t.name).sort());
    const flat = tabs.filter((t) => !t.hasMethodSplit);
    expect(flat.map((t) => t.label).sort()).toEqual(FLATS.map((t) => t.name).sort());
  });

  it("orders a Type's method buckets Rental, Purchase, Custom Fabricated and labels them from the stable key, not the name", () => {
    const categories = makeCategories();
    const buckets = categories.map((c) => makeBucket(c));

    const [structureTab] = groupPrimaryCategoryTabs(buckets, categories).filter((t) => t.label === "Structure");

    expect(structureTab.methodBuckets.map((m) => m.key)).toEqual(["rental", "purchase", "custom_fabricated"]);
    expect(structureTab.methodBuckets.map((m) => m.label)).toEqual(["Rental", "Purchase", "Custom Fabricated"]);
  });

  it("sums a Type's own bucket and its Method buckets into totalItems", () => {
    const categories = makeCategories();
    const buckets = categories.map((c) => {
      if (c.name === "Structure") return makeBucket(c, 2);
      if (c.name === "Structure - Rental") return makeBucket(c, 3);
      if (c.name === "Structure - Purchase") return makeBucket(c, 1);
      return makeBucket(c);
    });

    const [structureTab] = groupPrimaryCategoryTabs(buckets, categories).filter((t) => t.label === "Structure");

    expect(structureTab.totalItems).toBe(6);
  });

  it("does not split a flat category even if it happens to share a Method-split Type's key prefix", () => {
    const categories = makeCategories();
    const buckets = categories.map((c) => makeBucket(c));

    const [customBuildTab] = groupPrimaryCategoryTabs(buckets, categories).filter((t) => t.label === "Custom Components");

    expect(customBuildTab.hasMethodSplit).toBe(false);
    expect(customBuildTab.methodBuckets).toEqual([]);
  });

  it("still shows a Type as its own primary tab even when its own parentId is wrongly non-null", () => {
    // Confirmed against real data: a Type category's parentId can be
    // non-null for a reason unrelated to this taxonomy (observed live --
    // "Structure" pointed at an unrelated flat category's id, apparently
    // from a hand-edit in /catalog/categories). Grouping must key off each
    // leaf's own `key` (${typeKey}_${method}), never Category.parentId, or
    // a Type in this state -- and every item under it -- silently
    // disappears from the tab bar entirely.
    const categories = makeCategories();
    const flatCustomBuild = categories.find((c) => c.name === "Custom Components")!;
    const structure = categories.find((c) => c.name === "Structure")!;
    structure.parentId = flatCustomBuild.id;
    const buckets = categories.map((c) => makeBucket(c, c.name === "Structure" ? 5 : 0));

    const tabs = groupPrimaryCategoryTabs(buckets, categories);

    const structureTab = tabs.find((t) => t.label === "Structure");
    expect(structureTab).toBeDefined();
    expect(structureTab!.hasMethodSplit).toBe(true);
    expect(structureTab!.totalItems).toBe(5);
    expect(tabs).toHaveLength(TYPES.length + FLATS.length);
  });
});

describe("mergeCategoryBucketsForAllMethods / mergeBoothGroupsForAllMethods", () => {
  const structure = { id: "structure", name: "Structure", key: "structure" };
  const rental = { id: "structure_rental", name: "Structure - Rental", key: "structure_rental" };
  const purchase = { id: "structure_purchase", name: "Structure - Purchase", key: "structure_purchase" };

  function group(sectionId: string, categoryName: string) {
    return {
      sectionId,
      sectionName: sectionId,
      groupLabel: null,
      categoryName,
      lineItems: [],
      description: null,
      pendingDescription: null,
      elementSummary: null,
      elementPendingSummary: null,
      isMapped: false,
    };
  }

  const tab = {
    id: structure.id,
    label: structure.name,
    hasMethodSplit: true,
    ownBucket: { category: structure, totalItems: 1, sectionGroups: [group("own", "Structure")] },
    methodBuckets: [
      { key: "rental" as const, label: "Rental", bucket: { category: rental, totalItems: 2, sectionGroups: [group("r", "Structure - Rental")] } },
      { key: "purchase" as const, label: "Purchase", bucket: { category: purchase, totalItems: 1, sectionGroups: [group("p", "Structure - Purchase")] } },
    ],
    totalItems: 4,
  };

  it("concatenates the Type's own sectionGroups with every Method bucket's, under the Type's own category identity", () => {
    const merged = mergeCategoryBucketsForAllMethods(tab);

    expect(merged.category).toBe(structure);
    expect(merged.totalItems).toBe(4);
    expect(merged.sectionGroups.map((g) => g.sectionId)).toEqual(["own", "r", "p"]);
    expect(merged.sectionGroups.map((g) => g.categoryName)).toEqual(["Structure", "Structure - Rental", "Structure - Purchase"]);
  });

  it("unions booth groups from the Type's own bucket and every Method bucket's category name", () => {
    const boothA: RawBoothGroup<unknown> = {
      boothLabel: "Booth A",
      elementGroups: [],
      subtotal: 100,
      boothDescription: null,
      boothPendingDescription: null,
    };
    const boothB: RawBoothGroup<unknown> = {
      boothLabel: "Booth B",
      elementGroups: [],
      subtotal: 200,
      boothDescription: null,
      boothPendingDescription: null,
    };
    const boothGroupsByCategoryName = new Map<string, RawBoothGroup<unknown>[]>([
      ["Structure", [boothA]],
      ["Structure - Rental", [boothB]],
    ]);

    const merged = mergeBoothGroupsForAllMethods(tab, boothGroupsByCategoryName);

    expect(merged).toEqual([boothA, boothB]);
  });
});
