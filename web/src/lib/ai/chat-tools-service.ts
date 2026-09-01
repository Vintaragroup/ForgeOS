// Chat roadmap Phase 4 (read-only) + Phase 5 (the first write): the pivot
// from "everything the model gets is decided upfront" to "the model can
// ask for more, or act, mid-answer."
//
// Phase 4's two read tools -- a third, search_documents, was scoped out
// deliberately: chat-context-service.ts's retrieveRelevantChunks already
// runs an opportunity-wide semantic search automatically before every
// reply (chat roadmap Phase 3), so an explicit search tool would just
// duplicate that. What's still missing after Phases 1-3 is the ability
// to go back for MORE once the static context wasn't enough:
//
// - get_line_items: chat-context-service.ts's line-item block is
//   budget-truncated (see its own MAX_CONTEXT_CHARS accounting) -- this
//   lets the model pull a specific, filtered slice instead of accepting
//   "N more not shown."
// - get_document_excerpt: Phase 3's automatic retrieval is opportunity-
//   wide top-K, so a real passage can simply not make the cut for a
//   broad question. This re-searches one named document specifically.
//
// Phase 5's one write tool, deliberately scoped to just this for now:
//
// - propose_line_item: creates a real LineItem, but ALWAYS with
//   isDraft: true -- the same safety net imports and AI scope proposals
//   already use, not a new one. A draft counts toward nothing until a
//   person confirms it on the Line Items tab, so a wrong AI suggestion
//   costs nothing. Editing an existing item, moving one between sections,
//   or retagging a booth are deliberately NOT here yet: unlike a brand
//   new row, those all mutate a real existing row immediately today
//   (updateLineItem/moveLineItemWithinSection/updateSectionBuildType have
//   no draft-staging concept at all), so giving chat access to them needs
//   its own pending-change design first, not a reuse of this one.
import type OpenAI from "openai";
import { db } from "@/lib/db";
import { getIndexedDocumentIds, retrieveRelevantChunks } from "@/lib/ai/document-embedding-service";
import { addLineItem } from "@/lib/estimate-service";
import type { LineItemType } from "@/generated/prisma/enums";

export const CHAT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_line_items",
      description:
        "Look up line items on this opportunity's estimate(s), filtered precisely -- use this when the line items shown above were truncated for length, or when you need every item matching a specific filter rather than whatever happened to fit in the initial context.",
      parameters: {
        type: "object",
        properties: {
          estimateName: {
            type: "string",
            description: "Name of the estimate to search, only needed if the opportunity has more than one. Omit otherwise.",
          },
          category: { type: "string", description: "Filter to items in this proposal-facing category, e.g. \"Labor\" or \"Structure\"." },
          sectionName: { type: "string", description: "Filter to items in a section whose name contains this text." },
          isDraft: { type: "boolean", description: "true for draft (unreviewed) items only, false for confirmed items only. Omit for both." },
          searchText: { type: "string", description: "Filter to items whose description contains this text." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document_excerpt",
      description:
        "Search one specific uploaded document by name for a passage relevant to a query -- use this when you know a document exists (it's been mentioned above) but the excerpts already shown didn't cover what you need.",
      parameters: {
        type: "object",
        properties: {
          documentName: { type: "string", description: "The document's filename, as given above (e.g. \"RFP Final.pdf\")." },
          query: { type: "string", description: "What to look for in this document." },
        },
        required: ["documentName", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_line_item",
      description:
        "Add a new line item to an existing section on this opportunity's estimate. It is ALWAYS created as a draft -- it will not count toward any total, and won't appear as a real line until a person reviews and confirms it on the Line Items tab. Use this when the user asks you to add, create, or price out a new item. Always tell the user afterward that it's a draft awaiting their confirmation.",
      parameters: {
        type: "object",
        properties: {
          estimateName: {
            type: "string",
            description: "Name of the estimate to add to, only needed if the opportunity has more than one. Omit otherwise.",
          },
          sectionName: { type: "string", description: "Name of an existing section to add the item to -- must match a real section." },
          description: { type: "string", description: "The new line item's description." },
          lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"], description: "The line item's type." },
          category: {
            type: "string",
            description: "Proposal-facing category, e.g. \"Structure\", \"Labor\", \"Furniture\". Optional -- leave unset to auto-detect.",
          },
          qty: { type: "number", description: "Quantity." },
          unit: { type: "string", description: "Unit of measure, e.g. \"ea\", \"sqft\", \"hrs\". Optional." },
          unitCost: { type: "number", description: "Cost per unit, in dollars." },
        },
        required: ["sectionName", "description", "lineType", "qty", "unitCost"],
      },
    },
  },
];

// Bounds how much one tool call can hand back -- generous relative to a
// single reply's needs, but this is a tool RESULT feeding back into the
// same conversation's context, not a fresh budget of its own; an
// unbounded dump here would defeat the point of asking for a filtered
// slice in the first place.
const MAX_LINE_ITEM_ROWS = 60;
const MAX_FALLBACK_TEXT_CHARS = 8_000;
const DOCUMENT_EXCERPT_TOP_K = 6;

async function getLineItemsTool(
  opportunityId: string,
  args: { estimateName?: string; category?: string; sectionName?: string; isDraft?: boolean; searchText?: string },
): Promise<string> {
  const estimates = await db.estimate.findMany({
    where: {
      opportunityId,
      deletedAt: null,
      archivedAt: null,
      ...(args.estimateName ? { name: { equals: args.estimateName, mode: "insensitive" } } : {}),
    },
    select: {
      name: true,
      versions: {
        where: { isCurrent: true },
        take: 1,
        select: {
          sections: {
            select: {
              name: true,
              groupLabel: true,
              lineItems: {
                select: { description: true, category: true, isDraft: true, qty: true, unit: true, unitCost: true, totalCost: true },
              },
            },
          },
        },
      },
    },
  });

  if (estimates.length === 0) {
    return args.estimateName
      ? `No estimate named "${args.estimateName}" was found on this opportunity.`
      : "No live estimate found on this opportunity.";
  }

  const category = args.category?.toLowerCase();
  const sectionName = args.sectionName?.toLowerCase();
  const searchText = args.searchText?.toLowerCase();

  const rows: string[] = [];
  for (const estimate of estimates) {
    for (const version of estimate.versions) {
      for (const section of version.sections) {
        if (sectionName && !section.name.toLowerCase().includes(sectionName)) continue;
        const sectionLabel = section.groupLabel ? `${section.name} (${section.groupLabel})` : section.name;
        for (const li of section.lineItems) {
          if (category && li.category?.toLowerCase() !== category) continue;
          if (args.isDraft !== undefined && li.isDraft !== args.isDraft) continue;
          if (searchText && !li.description.toLowerCase().includes(searchText)) continue;
          const status = li.isDraft ? "DRAFT" : "CONFIRMED";
          const qty = `${li.qty.toString()}${li.unit ? ` ${li.unit}` : ""}`;
          const cat = li.category ? ` (${li.category})` : "";
          rows.push(
            `- [${status}] ${estimate.name ?? "Estimate"} / ${sectionLabel}: ${li.description} -- qty ${qty} × $${li.unitCost.toFixed(2)} = $${li.totalCost.toFixed(2)}${cat}`,
          );
        }
      }
    }
  }

  if (rows.length === 0) return "No line items matched those filters.";
  if (rows.length <= MAX_LINE_ITEM_ROWS) return rows.join("\n");
  const shown = rows.slice(0, MAX_LINE_ITEM_ROWS).join("\n");
  return `${shown}\n\n(${rows.length - MAX_LINE_ITEM_ROWS} more item(s) matched but aren't shown -- narrow the filters for the rest.)`;
}

async function getDocumentExcerptTool(
  opportunityId: string,
  args: { documentName?: string; query?: string },
  userId: string | null,
): Promise<string> {
  if (!args.documentName || !args.query) return "Both documentName and query are required.";

  const documents = await db.document.findMany({
    where: { opportunityId, deletedAt: null },
    select: { id: true, filename: true, extractedText: true },
  });
  const needle = args.documentName.toLowerCase();
  const doc =
    documents.find((d) => d.filename.toLowerCase() === needle) ??
    documents.find((d) => d.filename.toLowerCase().includes(needle));
  if (!doc) {
    const available = documents.map((d) => d.filename).join(", ") || "(no documents on this opportunity)";
    return `No document named "${args.documentName}" was found. Available documents: ${available}.`;
  }

  const indexed = await getIndexedDocumentIds(opportunityId);
  if (indexed.has(doc.id)) {
    const chunks = await retrieveRelevantChunks(opportunityId, args.query, userId, DOCUMENT_EXCERPT_TOP_K, doc.id);
    if (chunks.length === 0) return `No relevant excerpt found in "${doc.filename}" for that query.`;
    return chunks.map((c) => `[${doc.filename}, excerpt ${c.chunkIndex + 1}]\n${c.content}`).join("\n\n");
  }

  // Not indexed yet -- same bounded full-text fallback posture as
  // chat-context-service.ts's own per-document fallback.
  if (!doc.extractedText) {
    return `"${doc.filename}" has no extracted text to search (not yet analyzed, or an unsupported document type).`;
  }
  if (doc.extractedText.length <= MAX_FALLBACK_TEXT_CHARS) return doc.extractedText;
  return `${doc.extractedText.slice(0, MAX_FALLBACK_TEXT_CHARS)}\n\n[truncated -- "${doc.filename}" is longer than shown here]`;
}

const LINE_TYPES = new Set(["MATERIAL", "LABOR", "FEE"]);

async function proposeLineItemTool(
  opportunityId: string,
  args: {
    estimateName?: string;
    sectionName?: string;
    description?: string;
    lineType?: string;
    category?: string;
    qty?: number;
    unit?: string;
    unitCost?: number;
  },
  userId: string | null,
): Promise<string> {
  if (!args.sectionName || !args.description || !args.lineType || args.qty === undefined || args.unitCost === undefined) {
    return "sectionName, description, lineType, qty, and unitCost are all required.";
  }
  if (!LINE_TYPES.has(args.lineType)) {
    return `lineType must be one of MATERIAL, LABOR, FEE (got "${args.lineType}").`;
  }

  const estimates = await db.estimate.findMany({
    where: {
      opportunityId,
      deletedAt: null,
      archivedAt: null,
      ...(args.estimateName ? { name: { equals: args.estimateName, mode: "insensitive" } } : {}),
    },
    select: {
      name: true,
      versions: {
        where: { isCurrent: true },
        take: 1,
        select: { id: true, sections: { select: { id: true, name: true } } },
      },
    },
  });

  if (estimates.length === 0) {
    return args.estimateName
      ? `No estimate named "${args.estimateName}" was found on this opportunity.`
      : "No live estimate found on this opportunity.";
  }
  if (estimates.length > 1 && !args.estimateName) {
    return `This opportunity has more than one estimate -- specify estimateName. Options: ${estimates.map((e) => e.name).filter(Boolean).join(", ")}.`;
  }

  const estimate = estimates[0];
  const version = estimate.versions[0];
  if (!version) return `Estimate "${estimate.name ?? "Untitled"}" has no active version to add to yet.`;

  const needle = args.sectionName.toLowerCase();
  const section =
    version.sections.find((s) => s.name.toLowerCase() === needle) ??
    version.sections.find((s) => s.name.toLowerCase().includes(needle));
  if (!section) {
    const available = version.sections.map((s) => s.name).join(", ") || "(no sections yet)";
    return `No section named "${args.sectionName}" was found. Available sections: ${available}.`;
  }

  const created = await addLineItem(
    version.id,
    section.id,
    {
      lineType: args.lineType as LineItemType,
      description: args.description,
      category: args.category ?? null,
      qty: args.qty,
      unit: args.unit ?? null,
      unitCost: args.unitCost,
      isDraft: true,
    },
    userId,
  );

  return `Added a DRAFT line item to "${section.name}": ${args.description} -- qty ${args.qty}${args.unit ? ` ${args.unit}` : ""} × $${args.unitCost.toFixed(2)} = $${created.totalCost.toFixed(2)}. It won't count toward any total until it's reviewed and confirmed on the Line Items tab.`;
}

// Dispatches one model-requested tool call to its real implementation and
// returns the tool message's content -- never throws: a failed lookup
// becomes a plain-text error result the model can read and explain,
// rather than aborting the whole reply over one bad tool call.
export async function executeChatTool(
  name: string,
  rawArguments: string,
  context: { opportunityId: string; userId: string | null },
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    return "Those arguments weren't valid JSON -- try the call again.";
  }

  try {
    switch (name) {
      case "get_line_items":
        return await getLineItemsTool(context.opportunityId, args);
      case "get_document_excerpt":
        return await getDocumentExcerptTool(context.opportunityId, args, context.userId);
      case "propose_line_item":
        return await proposeLineItemTool(context.opportunityId, args, context.userId);
      default:
        return `Unknown tool "${name}".`;
    }
  } catch (err) {
    return `That lookup failed: ${err instanceof Error ? err.message : "unknown error"}.`;
  }
}
