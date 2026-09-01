// Chat roadmap Phase 4: the pivot from "everything the model gets is
// decided upfront" to "the model can ask for more, precisely, mid-
// answer." Two tools only -- a third, search_documents, was scoped out
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
// Both are read-only -- no tool here can change the estimate. That's a
// deliberate, separate bar (chat roadmap Phase 5, gated behind the
// existing draft-and-confirm review flow), not an oversight.

import type OpenAI from "openai";
import { db } from "@/lib/db";
import { getIndexedDocumentIds, retrieveRelevantChunks } from "@/lib/ai/document-embedding-service";

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
      default:
        return `Unknown tool "${name}".`;
    }
  } catch (err) {
    return `That lookup failed: ${err instanceof Error ? err.message : "unknown error"}.`;
  }
}
