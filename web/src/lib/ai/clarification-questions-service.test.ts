import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  CLARIFICATION_SCHEMA,
  resolveClarificationQuestions,
  runClarificationQuestionsAnalysis,
  type RawClarificationFinding,
} from "@/lib/ai/clarification-questions-service";

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

// mimeType defaults to DOCX, not PDF -- resolveClarificationQuestions
// fetches real bytes off disk to compute a page number for a PDF source,
// which this fixture's fake storageKey doesn't have. DOCX has no page
// concept, so it exercises the "no page lookup" path cleanly without
// needing a real file.
async function makeScopeDocument(
  opportunityId: string,
  extractedText: string | null,
  mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
) {
  return db.document.create({
    data: {
      opportunityId,
      filename: "Scope of Work.docx",
      mimeType,
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "SCOPE_OF_WORK",
      extractionStatus: extractedText ? "COMPLETE" : "PENDING",
      extractedText,
    },
  });
}

describe("runClarificationQuestionsAnalysis", () => {
  it("refuses to run for an opportunity with no analyzed scope documents, before ever touching the OpenAI client", async () => {
    const { opportunity } = await makeOpportunity();

    await expect(runClarificationQuestionsAnalysis(opportunity.id)).rejects.toThrow(/No analyzed scope documents/);
  });

  it("throws AiNotConfiguredError once an analyzed scope document exists -- .env.test deliberately has no API key", async () => {
    const { opportunity } = await makeOpportunity();
    await makeScopeDocument(opportunity.id, "Provide booth construction, graphics, and installation labor.");

    await expect(runClarificationQuestionsAnalysis(opportunity.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("ignores a PRICING_SCHEDULE or DRAWING document -- neither counts as a scope document", async () => {
    const { opportunity } = await makeOpportunity();
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Pricing Schedule.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "PRICING_SCHEDULE",
        extractionStatus: "COMPLETE",
      },
    });
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Booth Drawing.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
      },
    });

    await expect(runClarificationQuestionsAnalysis(opportunity.id)).rejects.toThrow(/No analyzed scope documents/);
  });
});

describe("resolveClarificationQuestions", () => {
  it("skips an EXCLUDE verdict entirely, regardless of question/rationale being present", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");
    const candidates = [{ id: "G1", filename: document.filename, text: "Labor scope unclear", sourceQuote: "installation labor" }];

    const questions = await resolveClarificationQuestions(
      [{ candidateId: "G1", verdict: "EXCLUDE", question: null, rationale: null }],
      candidates,
      [],
      [document],
    );

    expect(questions).toHaveLength(0);
  });

  it("drops a candidateId that doesn't match any given candidate -- a hallucination guard", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");
    const candidates = [{ id: "G1", filename: document.filename, text: "Labor scope unclear", sourceQuote: "installation labor" }];

    const questions = await resolveClarificationQuestions(
      [
        { candidateId: "G1", verdict: "RECOMMENDED", question: "Real question", rationale: "Matters for real" },
        { candidateId: "G99", verdict: "RECOMMENDED", question: "Hallucinated question", rationale: "n/a" },
      ],
      candidates,
      [],
      [document],
    );

    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe("Real question");
    expect(questions[0].documentId).toBe(document.id);
  });

  it("resolves a candidate's quote from server-known candidate data, carries confidence and rationale through, leaves pageNumber null for a non-PDF source", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");
    const candidates = [{ id: "G1", filename: document.filename, text: "Labor scope unclear", sourceQuote: "installation labor" }];

    const questions = await resolveClarificationQuestions(
      [
        {
          candidateId: "G1",
          verdict: "WORTH_REVIEWING",
          question: "What is the installation labor scope exactly?",
          rationale: "Ambiguous boundary between client and contractor labor.",
        },
      ],
      candidates,
      [],
      [document],
    );

    expect(questions[0].sourceQuote).toBe("installation labor");
    expect(questions[0].rationale).toBe("Ambiguous boundary between client and contractor labor.");
    expect(questions[0].pageNumber).toBeNull();
    expect(questions[0].confidence).toBe("WORTH_REVIEWING");
  });

  it("computes a real page number for a PDF source, from the PDF's own per-page text", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { uploadDocument } = await import("@/lib/document-service");
    const { extractPdfPageTexts } = await import("@/lib/ai/text-extraction");

    const rfpDir = path.resolve(
      import.meta.dirname,
      "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build",
    );
    const bytes = await readFile(path.join(rfpDir, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));

    const { opportunity } = await makeOpportunity();
    const file = new File([bytes], "RFP.pdf", { type: "application/pdf" });
    const document = await uploadDocument(opportunity.id, { file, documentType: "SCOPE_OF_WORK" });

    // A real, known substring pulled from a specific real page -- proves
    // the lookup finds the ACTUAL page, not just any non-null number.
    const pages = await extractPdfPageTexts(bytes);
    const targetPageIndex = 3;
    const realQuote = pages[targetPageIndex].slice(40, 90).trim();
    expect(realQuote.length).toBeGreaterThan(20);

    await db.document.update({
      where: { id: document.id },
      data: { extractionStatus: "COMPLETE", extractedText: pages.join("\n") },
    });
    const updated = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    const candidates = [{ id: "G1", filename: "RFP.pdf", text: "Some gap", sourceQuote: realQuote }];

    const questions = await resolveClarificationQuestions(
      [{ candidateId: "G1", verdict: "RECOMMENDED", question: "Real question", rationale: "Real rationale" }],
      candidates,
      [],
      [updated],
    );

    expect(questions[0].pageNumber).toBe(targetPageIndex + 1);
    expect(questions[0].sourceQuote).toBe(realQuote);
  });

  it("also resolves additionalFindings (freeform, cross-document contradictions), independent of candidateReview", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");

    const findings: RawClarificationFinding[] = [
      {
        question: "Document A says 20x20, Document B says 10x30 -- which is correct?",
        rationale: "Contradiction between two documents.",
        sourceQuote: "installation labor",
        documentFilename: document.filename,
        confidence: "RECOMMENDED",
      },
    ];
    const questions = await resolveClarificationQuestions([], [], findings, [document]);

    expect(questions).toHaveLength(1);
    expect(questions[0].confidence).toBe("RECOMMENDED");
    expect(questions[0].sourceQuote).toBe("installation labor");
  });

  it("drops an additionalFinding whose documentFilename doesn't match any document actually sent", async () => {
    const { opportunity } = await makeOpportunity();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");

    const findings: RawClarificationFinding[] = [
      {
        question: "Hallucinated finding",
        rationale: "n/a",
        sourceQuote: "anything",
        documentFilename: "Nonexistent Document.pdf",
        confidence: "RECOMMENDED",
      },
    ];
    const questions = await resolveClarificationQuestions([], [], findings, [document]);

    expect(questions).toHaveLength(0);
  });
});

describe("CLARIFICATION_SCHEMA", () => {
  it("is a strict JSON schema requiring a verdict for every candidate field -- proves the checklist shape is actually wired into the request, not just documented in the type", () => {
    expect(CLARIFICATION_SCHEMA.strict).toBe(true);
    expect(CLARIFICATION_SCHEMA.schema.properties.candidateReview.items.required).toEqual([
      "candidateId",
      "verdict",
      "question",
      "rationale",
    ]);
    expect(CLARIFICATION_SCHEMA.schema.properties.candidateReview.items.properties.verdict.enum).toEqual([
      "EXCLUDE",
      "RECOMMENDED",
      "WORTH_REVIEWING",
    ]);
    expect(CLARIFICATION_SCHEMA.schema.properties.additionalFindings.items.required).toEqual([
      "question",
      "rationale",
      "sourceQuote",
      "documentFilename",
      "confidence",
    ]);
    expect(CLARIFICATION_SCHEMA.schema.properties.candidateReview.items.additionalProperties).toBe(false);
    expect(CLARIFICATION_SCHEMA.schema.properties.additionalFindings.items.additionalProperties).toBe(false);
  });
});
