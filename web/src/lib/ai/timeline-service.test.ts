import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  runTimelineExtraction,
  resolveTimelineSuggestions,
  matchCandidatesToTypesByLabel,
  TIMELINE_SCHEMA,
} from "@/lib/ai/timeline-service";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return { company, opportunity };
}

// A DRAWING never gets extractedText (text-extraction.ts marks it
// UNSUPPORTED for text extraction) even though drawing-summary-service.ts's
// vision pass still populates extractedSummary.keyDates -- this fixture
// exercises exactly that shape, the one the real production bug hit.
async function makeDrawingDocument(
  opportunityId: string,
  keyDates: { label: string; date: string; dateType: string; sourceQuote: string; pageNumber: number | null }[],
) {
  return db.document.create({
    data: {
      opportunityId,
      filename: "Project Timeline.png",
      mimeType: "image/png",
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "DRAWING",
      extractionStatus: "COMPLETE",
      extractedText: null,
      extractedSummary: {
        eventOrProjectName: null,
        venue: null,
        submissionDeadline: null,
        keyDates,
        scopeSummary: [],
        riskFlags: [],
      },
    },
  });
}

// mimeType defaults to DOCX -- resolveTimelineSuggestions fetches real
// bytes off disk for a PDF source's page number, which this fixture's fake
// storageKey doesn't have. DOCX has no page concept, exercising the
// "no page lookup" path without a real file.
async function makeScopeDocument(
  opportunityId: string,
  keyDates: { label: string; date: string; dateType: string; sourceQuote: string; pageNumber: number | null }[],
  extractedText: string,
) {
  return db.document.create({
    data: {
      opportunityId,
      filename: "Contract.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "CONTRACT",
      extractionStatus: "COMPLETE",
      extractedText,
      extractedSummary: {
        eventOrProjectName: null,
        venue: null,
        submissionDeadline: null,
        keyDates,
        scopeSummary: [],
        riskFlags: [],
      },
    },
  });
}

describe("matchCandidatesToTypesByLabel", () => {
  function candidate(label: string): { id: string; filename: string; label: string; date: string; sourceQuote: string; pageNumber: number | null } {
    return { id: "K1", filename: "doc.docx", label, date: "2026-01-01", sourceQuote: label, pageNumber: null };
  }

  it("matches every real-world label from the reference project-timeline document to its milestone type", () => {
    const cases: [string, string][] = [
      ["SIGNED_PROPOSAL", "Signed Proposal"],
      ["DEPOSIT_DUE", "50% Deposit: Initiates Build"],
      ["PRODUCTION_MEETING", "Production Meeting"],
      ["ARTWORK_DEADLINE", "Production Ready Artwork"],
      ["BALANCE_DUE", "Balance Due prior to shipping"],
      ["SHIPPING", "Shipping to Show Site"],
      ["INSTALLATION", "Installation"],
      ["SHOW_OPEN", "Show Open"],
      ["DISMANTLE", "Dismantle"],
    ];
    for (const [type, label] of cases) {
      const matches = matchCandidatesToTypesByLabel([candidate(label)], [type as never]);
      expect(matches.get(type as never)?.label).toBe(label);
    }
  });

  it("does not match ARTWORK_DEADLINE against a rush-fee-cutoff line stating the same phrase", () => {
    const matches = matchCandidatesToTypesByLabel(
      [candidate("Production Ready Artwork Before 50% Rush Fees Apply")],
      ["ARTWORK_DEADLINE"],
    );
    expect(matches.has("ARTWORK_DEADLINE")).toBe(false);
  });

  it("does not match SHIPPING against a Balance Due line that merely mentions shipping as timing context -- the real production bug", () => {
    const candidates = [candidate("Balance Due prior to shipping"), { ...candidate("Shipping to Show Site"), id: "K2" }];
    const matches = matchCandidatesToTypesByLabel(candidates, ["BALANCE_DUE", "SHIPPING"]);
    expect(matches.get("BALANCE_DUE")?.label).toBe("Balance Due prior to shipping");
    expect(matches.get("SHIPPING")?.label).toBe("Shipping to Show Site");
  });

  it("leaves a type unmatched when no candidate's label names it", () => {
    const matches = matchCandidatesToTypesByLabel([candidate("Some unrelated note")], ["DEPOSIT_DUE"]);
    expect(matches.has("DEPOSIT_DUE")).toBe(false);
  });
});

describe("runTimelineExtraction", () => {
  it("returns no suggestions, without touching the OpenAI client, when no requested types are given", async () => {
    const { opportunity } = await makeOpportunity();
    const result = await runTimelineExtraction(opportunity.id, null, []);
    expect(result).toEqual([]);
  });

  it("returns no suggestions when the opportunity has no scope documents at all", async () => {
    const { opportunity } = await makeOpportunity();
    const result = await runTimelineExtraction(opportunity.id, null, ["DEPOSIT_DUE"]);
    expect(result).toEqual([]);
  });

  it("returns no suggestions when scope documents exist but none have any extracted keyDates", async () => {
    const { opportunity } = await makeOpportunity();
    await makeScopeDocument(opportunity.id, [], "Provide booth construction and installation labor.");

    const result = await runTimelineExtraction(opportunity.id, null, ["DEPOSIT_DUE"]);
    expect(result).toEqual([]);
  });

  it("throws AiNotConfiguredError once a real candidate key date exists -- .env.test deliberately has no API key", async () => {
    const { opportunity } = await makeOpportunity();
    await makeScopeDocument(
      opportunity.id,
      [{ label: "Some ambiguous note", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "some ambiguous note", pageNumber: null }],
      "A 50% deposit due September 23, 2026 initiates the build.",
    );

    await expect(runTimelineExtraction(opportunity.id, null, ["DEPOSIT_DUE"])).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });

  it("resolves entirely via label matching, without ever touching the OpenAI client, when every requested type's label is unambiguous -- proves the deterministic path actually short-circuits the AI call", async () => {
    const { opportunity } = await makeOpportunity();
    await makeScopeDocument(
      opportunity.id,
      [
        { label: "Shipping to Show Site", date: "2027-01-04", dateType: "MILESTONE", sourceQuote: "Shipping to Show Site", pageNumber: null },
        { label: "Installation", date: "2027-01-22", dateType: "MILESTONE", sourceQuote: "Installation", pageNumber: null },
        { label: "Dismantle", date: "2027-01-29", dateType: "MILESTONE", sourceQuote: "Dismantle", pageNumber: null },
      ],
      "Full project timeline.",
    );

    // Would throw AiNotConfiguredError (.env.test has no API key) if this
    // ever reached the OpenAI client -- succeeding proves it didn't.
    const suggestions = await runTimelineExtraction(opportunity.id, null, ["SHIPPING", "INSTALLATION", "DISMANTLE"]);

    expect(suggestions).toHaveLength(3);
    expect(suggestions.find((s) => s.type === "SHIPPING")?.date).toBe(new Date("2027-01-04").toISOString());
    expect(suggestions.find((s) => s.type === "INSTALLATION")?.date).toBe(new Date("2027-01-22").toISOString());
    expect(suggestions.find((s) => s.type === "DISMANTLE")?.date).toBe(new Date("2027-01-29").toISOString());
  });

  it("still throws AiNotConfiguredError for whatever's left over once label matching resolves only some of the requested types", async () => {
    const { opportunity } = await makeOpportunity();
    await makeScopeDocument(
      opportunity.id,
      [
        { label: "Shipping to Show Site", date: "2027-01-04", dateType: "MILESTONE", sourceQuote: "Shipping to Show Site", pageNumber: null },
        { label: "Some unrelated internal note", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "some unrelated internal note", pageNumber: null },
      ],
      "Full project timeline.",
    );

    await expect(
      runTimelineExtraction(opportunity.id, null, ["SHIPPING", "DEPOSIT_DUE"]),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("resolveTimelineSuggestions", () => {
  it("drops a candidateId that doesn't match any given candidate -- a hallucination guard", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(
      opportunity.id,
      [{ label: "50% Deposit Due", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "50% deposit due", pageNumber: null }],
      "A 50% deposit due September 23, 2026 initiates the build.",
    );
    const candidates = [{ id: "K1", filename: document.filename, label: "50% Deposit Due", date: "2026-09-23", sourceQuote: "50% deposit due", pageNumber: null }];

    const suggestions = await resolveTimelineSuggestions(
      [{ milestoneType: "DEPOSIT_DUE", candidateId: "K99" }],
      candidates,
      [document],
    );

    expect(suggestions).toHaveLength(0);
  });

  it("returns nothing for a null verdict -- no clear match is a valid, common outcome", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, [], "No dates mentioned.");
    const suggestions = await resolveTimelineSuggestions(
      [{ milestoneType: "SIGNED_PROPOSAL", candidateId: null }],
      [],
      [document],
    );
    expect(suggestions).toHaveLength(0);
  });

  it("resolves a matched candidate's date, quote, and document, leaving pageNumber null for a non-PDF source", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(
      opportunity.id,
      [{ label: "50% Deposit Due", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "50% deposit due", pageNumber: null }],
      "A 50% deposit due September 23, 2026 initiates the build.",
    );
    const candidates = [{ id: "K1", filename: document.filename, label: "50% Deposit Due", date: "2026-09-23", sourceQuote: "50% deposit due", pageNumber: null }];

    const suggestions = await resolveTimelineSuggestions(
      [{ milestoneType: "DEPOSIT_DUE", candidateId: "K1" }],
      candidates,
      [document],
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].type).toBe("DEPOSIT_DUE");
    expect(suggestions[0].documentId).toBe(document.id);
    expect(suggestions[0].sourceQuote).toBe("50% deposit due");
    expect(suggestions[0].pageNumber).toBeNull();
    expect(new Date(suggestions[0].date).toISOString().slice(0, 10)).toBe("2026-09-23");
  });

  it("resolves a DRAWING-sourced candidate using its own quote/page instead of dropping it -- the real production bug", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeDrawingDocument(opportunity.id, [
      { label: "Installation", date: "2027-01-22", dateType: "MILESTONE", sourceQuote: "Installation", pageNumber: 1 },
    ]);
    const candidates = [
      { id: "K1", filename: document.filename, label: "Installation", date: "2027-01-22", sourceQuote: "Installation", pageNumber: 1 },
    ];

    const suggestions = await resolveTimelineSuggestions(
      [{ milestoneType: "INSTALLATION", candidateId: "K1" }],
      candidates,
      [document],
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].sourceQuote).toBe("Installation");
    expect(suggestions[0].pageNumber).toBe(1);
    expect(new Date(suggestions[0].date).toISOString().slice(0, 10)).toBe("2027-01-22");
  });

  it("drops a candidate whose date can't be parsed rather than guessing", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, [], "Some contract text.");
    const candidates = [{ id: "K1", filename: document.filename, label: "Production Meeting", date: "sometime in the fall", sourceQuote: "production meeting", pageNumber: null }];

    const suggestions = await resolveTimelineSuggestions(
      [{ milestoneType: "PRODUCTION_MEETING", candidateId: "K1" }],
      candidates,
      [document],
    );

    expect(suggestions).toHaveLength(0);
  });
});

describe("TIMELINE_SCHEMA", () => {
  it("is a strict JSON schema requiring exactly one verdict entry per milestone type -- proves the checklist shape is actually wired into the request", () => {
    expect(TIMELINE_SCHEMA.strict).toBe(true);
    expect(TIMELINE_SCHEMA.schema.properties.verdicts.items.required).toEqual(["milestoneType", "candidateId"]);
    expect(TIMELINE_SCHEMA.schema.properties.verdicts.items.properties.milestoneType.enum).toEqual([
      "SIGNED_PROPOSAL",
      "DEPOSIT_DUE",
      "PRODUCTION_MEETING",
      "ARTWORK_DEADLINE",
      "BALANCE_DUE",
      "SHIPPING",
      "INSTALLATION",
      "SHOW_OPEN",
      "DISMANTLE",
    ]);
    expect(TIMELINE_SCHEMA.schema.properties.verdicts.items.additionalProperties).toBe(false);
  });
});
