// Suggests a short, human-readable title for one EstimateSection whose
// raw name has no ELEMENT_TYPE_MAP entry (proposal-view-model.ts's
// elementTypeForSection) -- e.g. "Custom Build" tells an estimator
// nothing about what was actually built. Writes into
// EstimateSection.pendingDescription only, never `description` directly:
// the user must explicitly approve (or type their own) before it's shown
// as the real heading -- same propose-then-commit shape as
// Document.proposedLineItems elsewhere in this app.

import { db } from "@/lib/db";
import { BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { assertUnlocked } from "@/lib/estimate-service";

const MAX_ITEM_DESCRIPTIONS = 40;

function buildSuggestionSchema() {
  return {
    name: "section_description",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: {
          type: "string",
          description:
            "A short (2-8 word) title for the physical component these materials build, e.g. " +
            "'Reception counter -- laminate top, LED base'. Not a restatement of a material category.",
        },
      },
      required: ["description"],
    },
  };
}

export async function suggestSectionDescription(sectionId: string, userId: string | null): Promise<string> {
  const section = await db.estimateSection.findUniqueOrThrow({
    where: { id: sectionId },
    include: {
      lineItems: { select: { description: true }, take: MAX_ITEM_DESCRIPTIONS },
      estimateVersion: { select: { estimate: { select: { opportunityId: true } } } },
    },
  });
  await assertUnlocked(section.estimateVersionId);

  const client = getOpenAiClient();
  const itemList = section.lineItems.map((li) => `- ${li.description}`).join("\n");

  const completion = await client.chat.completions.create({
    model: BASIC_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You write short titles for a trade-show exhibit component, given its section name, the booth it " +
          "belongs to, and the list of materials/line items that make it up. Describe the physical thing being " +
          "built (what it is), not the raw category or acquisition method it was filed under.",
      },
      {
        role: "user",
        content:
          `Section name: ${section.name}\n` +
          `Booth: ${section.groupLabel ?? "(none)"}\n` +
          `Materials:\n${itemList || "(no line items yet)"}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: buildSuggestionSchema() },
  });

  await recordAiUsage({
    userId,
    feature: "SECTION_DESCRIPTION",
    model: BASIC_MODEL,
    usage: completion.usage,
    opportunityId: section.estimateVersion.estimate.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { description: string };

  await db.estimateSection.update({
    where: { id: sectionId },
    data: { pendingDescription: parsed.description },
  });

  return parsed.description;
}

// Booth-level counterpart, for the H1 heading -- same propose-then-commit
// shape, but summarizes across every section sharing the booth's
// groupLabel rather than one section's own materials (see
// EstimateSection.boothDescription's own schema comment on why a booth
// has no model of its own to hang this off of).
export async function suggestBoothDescription(
  estimateVersionId: string,
  groupLabel: string,
  userId: string | null,
): Promise<string> {
  await assertUnlocked(estimateVersionId);

  const sections = await db.estimateSection.findMany({
    where: { estimateVersionId, groupLabel },
    include: { lineItems: { select: { description: true }, take: MAX_ITEM_DESCRIPTIONS } },
  });
  if (sections.length === 0) throw new Error(`No sections found for booth "${groupLabel}".`);

  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });

  const client = getOpenAiClient();
  const itemList = sections
    .flatMap((s) => s.lineItems.map((li) => li.description))
    .slice(0, MAX_ITEM_DESCRIPTIONS)
    .map((d) => `- ${d}`)
    .join("\n");

  const completion = await client.chat.completions.create({
    model: BASIC_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You write short titles for a trade-show exhibit booth, given its raw booth label and the list of " +
          "materials/line items across every component in it. Describe the physical booth or exhibit (what it " +
          "is, e.g. a client/booth name or its distinguishing feature), not the raw label or acquisition method " +
          "it was filed under.",
      },
      {
        role: "user",
        content: `Booth label: ${groupLabel}\nMaterials:\n${itemList || "(no line items yet)"}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: buildSuggestionSchema() },
  });

  await recordAiUsage({
    userId,
    feature: "SECTION_DESCRIPTION",
    model: BASIC_MODEL,
    usage: completion.usage,
    opportunityId: version.estimate.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { description: string };

  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel },
    data: { boothPendingDescription: parsed.description },
  });

  return parsed.description;
}
