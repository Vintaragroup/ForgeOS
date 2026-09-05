import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { runTimelineExtraction, resolveTimelineSuggestions, TIMELINE_SCHEMA } from "@/lib/ai/timeline-service";

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
      [{ label: "50% Deposit Due", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "50% deposit due", pageNumber: null }],
      "A 50% deposit due September 23, 2026 initiates the build.",
    );

    await expect(runTimelineExtraction(opportunity.id, null, ["DEPOSIT_DUE"])).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
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
    const candidates = [{ id: "K1", filename: document.filename, label: "50% Deposit Due", date: "2026-09-23", sourceQuote: "50% deposit due" }];

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
    const candidates = [{ id: "K1", filename: document.filename, label: "50% Deposit Due", date: "2026-09-23", sourceQuote: "50% deposit due" }];

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

  it("drops a candidate whose date can't be parsed rather than guessing", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, [], "Some contract text.");
    const candidates = [{ id: "K1", filename: document.filename, label: "Production Meeting", date: "sometime in the fall", sourceQuote: "production meeting" }];

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
