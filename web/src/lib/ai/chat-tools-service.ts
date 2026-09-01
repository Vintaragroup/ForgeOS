// Chat roadmap Phase 4 (read-only) + Phase 5 (the first write): the pivot
// from "everything the model gets is decided upfront" to "the model can
// ask for more, or act, mid-answer."
//
// Phase 4's read tools -- a fourth candidate, search_documents, was
// scoped out deliberately: chat-context-service.ts's
// retrieveRelevantChunks already runs an opportunity-wide semantic
// search automatically before every reply (chat roadmap Phase 3), so an
// explicit search tool would just duplicate that. What's still missing
// after Phases 1-3 is the ability to go back for MORE once the static
// context wasn't enough, or to get a definitive answer instead of an
// inferred one:
//
// - get_line_items: chat-context-service.ts's line-item block is
//   budget-truncated (see its own MAX_CONTEXT_CHARS accounting) -- this
//   lets the model pull a specific, filtered slice instead of accepting
//   "N more not shown."
// - get_document_excerpt: Phase 3's automatic retrieval is opportunity-
//   wide top-K, so a real passage can simply not make the cut for a
//   broad question. This re-searches one named document specifically.
// - find_section: added after real usage showed the model had no way to
//   confirm a section/category actually exists (with zero items) vs.
//   doesn't exist at all -- it would either guess a name into
//   propose_line_item's sectionName (silently landing in the wrong one of
//   several same-named sections) or ask a vague "should I proceed?"
//   instead of the specific missing fact. This makes "does X exist, and
//   how many items does it have" a direct, always-available answer
//   rather than something inferred from a filtered item list.
//
// Phase 5's one write tool, deliberately scoped to just this for now:
//
// - propose_line_item: creates a real LineItem, but ALWAYS with
//   isDraft: true -- the same safety net imports and AI scope proposals
//   already use, not a new one. A draft counts toward nothing until a
//   person confirms it on the Line Items tab, so a wrong AI suggestion
//   costs nothing. It can also create a brand-new, standalone
//   EstimateSection when the target is a real category with nowhere to
//   go yet (see its own comment below) -- real usage showed a user
//   asking for a project-wide item, like a show-site-lead labor line,
//   got stuck being offered only booth-specific sections to force it
//   into. A new, empty section carries the same "nothing counts until
//   reviewed" safety as the draft item itself, so this is likewise never
//   gated behind a confirmation question -- just always disclosed in the
//   result. Editing an existing item, moving one between sections, or
//   retagging a booth are deliberately NOT here yet: unlike a brand new
//   row, those all mutate a real existing row immediately today
//   (updateLineItem/moveLineItemWithinSection/updateSectionBuildType have
//   no draft-staging concept at all), so giving chat access to them needs
//   its own pending-change design first, not a reuse of this one.
import type OpenAI from "openai";
import { db } from "@/lib/db";
import { getIndexedDocumentIds, retrieveRelevantChunks } from "@/lib/ai/document-embedding-service";
import { addLineItem, addSection } from "@/lib/estimate-service";
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
      name: "find_section",
      description:
        "Look up whether a name is a real section, a real category, both, or neither on this opportunity's estimate -- use this whenever the user asks you to locate, find, or check whether a section/category/tag exists, and BEFORE calling propose_line_item whenever you're not already certain a name is a section vs. a category. Reports the exact line item count for each match (including zero -- a category or section existing with no items yet is a real, reportable answer, not a failure), and every real category/section name when nothing matches.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The section or category name to look up." },
          estimateName: {
            type: "string",
            description: "Name of the estimate to search, only needed if the opportunity has more than one. Omit otherwise.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_line_item",
      description:
        "Add a new line item to this opportunity's estimate. It is ALWAYS created as a draft -- it will not count toward any total, and won't appear as a real line until a person reviews and confirms it on the Line Items tab. Use this when the user asks you to add, create, or price out a new item. sectionName and category are two DIFFERENT things: sectionName is the physical container (tied to a specific booth/component, e.g. \"Labor\" under \"FS - Reception Counter\" -- the same name is commonly reused across many different booths, so pass groupLabel too whenever the user's request implies a specific one, or when a plain sectionName turns out to be ambiguous -- call find_section first if unsure). category is the separate proposal-facing tag shown on the client PDF (e.g. \"Professional Services\", \"Labor\", \"Structure\") -- a user asking to add something \"under\" or \"in\" a named category (like \"Professional Services\"), or describing something as project-wide/not tied to one booth, means category, not sectionName. If sectionName resolves to a real category with no section holding it yet, a clean new standalone section (not tied to any booth) is created automatically to hold it -- this is reported back, never silent. Always tell the user afterward that it's a draft awaiting their confirmation.",
      parameters: {
        type: "object",
        properties: {
          estimateName: {
            type: "string",
            description: "Name of the estimate to add to, only needed if the opportunity has more than one. Omit otherwise.",
          },
          sectionName: {
            type: "string",
            description: "Name of an existing section (the physical container) to add the item to -- must match a real section, not a category.",
          },
          groupLabel: {
            type: "string",
            description: "Which booth/component's section to use, when sectionName alone is ambiguous (the same section name is often reused across many booths) -- e.g. \"FS - Reception Counter\" or \"Bid Comparison\" for a project-level (non-booth-specific) section.",
          },
          description: { type: "string", description: "The new line item's description." },
          lineType: { type: "string", enum: ["MATERIAL", "LABOR", "FEE"], description: "The line item's type." },
          category: {
            type: "string",
            description:
              "Proposal-facing category shown on the client PDF, e.g. \"Professional Services\", \"Structure\", \"Labor\", \"Furniture\". This is independent of sectionName -- set this whenever the user names a category, even if no section is literally named that.",
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

// How many (section, groupLabel) pairs to list when a section can't be
// resolved -- a real estimate can have dozens of booth-scoped sections
// sharing the same handful of names (see the ambiguous-name case below),
// so this is capped rather than dumped in full.
const MAX_SECTION_OPTIONS_SHOWN = 20;

function formatSectionLabel(s: { name: string; groupLabel: string | null }): string {
  return s.groupLabel ? `${s.name} (${s.groupLabel})` : s.name;
}

function listSectionOptions(sections: { name: string; groupLabel: string | null }[]): string {
  if (sections.length === 0) return "(no sections yet)";
  const labels = sections.map(formatSectionLabel);
  if (labels.length <= MAX_SECTION_OPTIONS_SHOWN) return labels.join(", ");
  return `${labels.slice(0, MAX_SECTION_OPTIONS_SHOWN).join(", ")}, and ${labels.length - MAX_SECTION_OPTIONS_SHOWN} more`;
}

// Every section/category listing in this file renders as "Name
// (GroupLabel)" via formatSectionLabel -- which means it's also the
// single most natural string for a model to echo straight back when it
// wants to reference one it just saw, instead of correctly splitting it
// into separate name/groupLabel arguments the way the tool schemas
// actually ask for. Rather than fail outright on that (confirmed in
// practice: a real section like "Labor (Bid Comparison)" reported as
// "doesn't exist" purely because the combined string was passed as one
// value), both find_section and propose_line_item retry against this
// parsed form before giving up.
function splitNameAndGroupLabel(raw: string): { name: string; groupLabel: string | null } {
  const match = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!match) return { name: raw.trim(), groupLabel: null };
  return { name: match[1].trim(), groupLabel: match[2].trim() };
}

// Answers "does this exist" definitively -- a section or category with
// zero items is a real, reportable fact (see the tool's own
// description), not the same thing as "not found" the way
// get_line_items' filtered listing would otherwise conflate them. Also
// the thing that lets propose_line_item's own sectionName/groupLabel be
// resolved correctly on the first attempt instead of by trial and error.
async function findSectionTool(
  opportunityId: string,
  args: { name?: string; estimateName?: string },
): Promise<string> {
  if (!args.name) return "name is required.";

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
            orderBy: [{ groupLabel: "asc" }, { name: "asc" }],
            select: { name: true, groupLabel: true, lineItems: { select: { isDraft: true, category: true } } },
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
  if (estimates.length > 1 && !args.estimateName) {
    return `This opportunity has more than one estimate -- specify estimateName. Options: ${estimates.map((e) => e.name).filter(Boolean).join(", ")}.`;
  }

  const estimate = estimates[0];
  const version = estimate.versions[0];
  if (!version) return `Estimate "${estimate.name ?? "Untitled"}" has no active version yet.`;

  const needle = args.name.toLowerCase();
  const lines: string[] = [];

  let sectionMatches = version.sections.filter((s) => s.name.toLowerCase() === needle);
  if (sectionMatches.length === 0) {
    const split = splitNameAndGroupLabel(args.name);
    if (split.groupLabel) {
      const splitNeedle = split.name.toLowerCase();
      const groupNeedle = split.groupLabel.toLowerCase();
      sectionMatches = version.sections.filter(
        (s) => s.name.toLowerCase() === splitNeedle && s.groupLabel?.toLowerCase() === groupNeedle,
      );
    }
  }
  if (sectionMatches.length > 0) {
    lines.push(`"${args.name}" is a section name -- found, ${sectionMatches.length} matching section(s):`);
    for (const s of sectionMatches) {
      const confirmed = s.lineItems.filter((li) => !li.isDraft).length;
      const draft = s.lineItems.length - confirmed;
      lines.push(`  - ${formatSectionLabel(s)}: ${s.lineItems.length} line item(s) (${confirmed} confirmed, ${draft} draft)`);
    }
  }

  const category = await db.category.findFirst({
    where: { name: { equals: args.name, mode: "insensitive" }, deletedAt: null },
    select: { name: true },
  });
  if (category) {
    const byLabel = new Map<string, number>();
    let total = 0;
    for (const s of version.sections) {
      const count = s.lineItems.filter((li) => li.category === category.name).length;
      if (count > 0) {
        byLabel.set(formatSectionLabel(s), count);
        total += count;
      }
    }
    const breakdown =
      total > 0 ? `, in: ${[...byLabel.entries()].map(([label, count]) => `${label} (${count})`).join(", ")}` : " (no section holds any yet)";
    lines.push(`"${category.name}" is a real proposal category -- found, ${total} line item(s) currently tagged with it${breakdown}.`);
  }

  if (lines.length === 0) {
    const [categories] = await Promise.all([
      db.category.findMany({ where: { deletedAt: null }, select: { name: true }, orderBy: { sortOrder: "asc" } }),
    ]);
    const distinctSectionNames = [...new Set(version.sections.map((s) => s.name))];
    return (
      `Not found -- no section or category named "${args.name}" exists.\n` +
      `Real categories: ${categories.map((c) => c.name).join(", ") || "(none)"}.\n` +
      `Distinct section names on this estimate (${version.sections.length} section(s) total): ${distinctSectionNames.join(", ") || "(none)"}.`
    );
  }

  return lines.join("\n");
}

async function proposeLineItemTool(
  opportunityId: string,
  args: {
    estimateName?: string;
    sectionName?: string;
    groupLabel?: string;
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
        select: {
          id: true,
          sections: {
            orderBy: [{ groupLabel: "asc" }, { name: "asc" }],
            select: { id: true, name: true, groupLabel: true, lineItems: { select: { category: true } } },
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
  if (estimates.length > 1 && !args.estimateName) {
    return `This opportunity has more than one estimate -- specify estimateName. Options: ${estimates.map((e) => e.name).filter(Boolean).join(", ")}.`;
  }

  const estimate = estimates[0];
  const version = estimate.versions[0];
  if (!version) return `Estimate "${estimate.name ?? "Untitled"}" has no active version to add to yet.`;

  const needle = args.sectionName.toLowerCase();
  let candidates =
    version.sections.filter((s) => s.name.toLowerCase() === needle).length > 0
      ? version.sections.filter((s) => s.name.toLowerCase() === needle)
      : version.sections.filter((s) => s.name.toLowerCase().includes(needle));

  // sectionName might be a combined "Name (GroupLabel)" string (see
  // splitNameAndGroupLabel's own comment) rather than a bare name --
  // retry against the parsed form before falling through to the
  // category check below, since a real (name, groupLabel) match is a
  // far stronger signal than a guess at a category with the same name.
  if (candidates.length === 0 && !args.groupLabel) {
    const split = splitNameAndGroupLabel(args.sectionName);
    if (split.groupLabel) {
      const splitNeedle = split.name.toLowerCase();
      const groupNeedle = split.groupLabel.toLowerCase();
      const retried = version.sections.filter(
        (s) => s.name.toLowerCase() === splitNeedle && s.groupLabel?.toLowerCase() === groupNeedle,
      );
      if (retried.length > 0) candidates = retried;
    }
  }

  let createdSectionNote = "";
  if (candidates.length === 0) {
    // sectionName might actually be a category (a proposal-facing tag,
    // not a physical section -- see the tool description) -- distinct
    // concepts that are easy for a request in plain English to conflate.
    // Rather than silently defaulting to some arbitrary section, check
    // whether it's a real category and, if there's already a section
    // holding that category's items, reuse it.
    const asCategory = await db.category.findFirst({
      where: { name: { equals: args.sectionName, mode: "insensitive" }, deletedAt: null },
      select: { name: true },
    });
    if (asCategory) {
      const holder = version.sections.find((s) => s.lineItems.some((li) => li.category === asCategory.name));
      if (holder) {
        candidates = [holder];
      } else {
        // No section holds this category at all -- rather than force the
        // item into whichever unrelated booth section happens to exist
        // (the actual complaint that led here: a project-wide item like
        // "Show Site Lead" has no business being filed under one
        // specific booth's Reception Counter section), create a clean,
        // standalone section for it -- groupLabel: null, the same shape
        // this estimate's own non-booth sections (e.g. "Other") already
        // use. A brand-new, empty section carries no more risk than the
        // draft line item itself: nothing counts until a person reviews
        // it, same safety net as everywhere else in this tool. Always
        // disclosed in the result below, never a silent structural change.
        const created = await addSection(version.id, { name: asCategory.name, sectionType: "CATEGORY", groupLabel: null });
        candidates = [{ id: created.id, name: created.name, groupLabel: created.groupLabel, lineItems: [] }];
        createdSectionNote = ` (created new, standalone -- not tied to any specific booth, since none existed yet)`;
      }
      args.category = args.category ?? asCategory.name;
    } else {
      return `No section named "${args.sectionName}" was found, and it isn't a real category either. Available sections: ${listSectionOptions(version.sections)}.`;
    }
  }

  if (args.groupLabel) {
    const groupNeedle = args.groupLabel.toLowerCase();
    const narrowed = candidates.filter((s) => s.groupLabel?.toLowerCase().includes(groupNeedle));
    if (narrowed.length > 0) candidates = narrowed;
  }

  if (candidates.length > 1) {
    // A hint, never a silent choice -- the full option list is always
    // still returned alongside it, and this can be wrong for an estimate
    // using a different naming convention. A booth/component instance's
    // groupLabel commonly follows this estimate's own "SHORT-CODE -
    // Description" pattern (e.g. "FS - Reception Counter"); one with no
    // such separator (e.g. "Bid Comparison") reads as a general/overall
    // bucket instead -- exactly the one a project-wide item belongs in,
    // and the one real usage showed getting lost/omitted when a model
    // had to pick it out of a long undifferentiated list on its own.
    const projectWide = candidates.filter((s) => s.groupLabel && !/\s-\s/.test(s.groupLabel));
    const hint =
      projectWide.length > 0 && projectWide.length < candidates.length
        ? ` If this item is project-wide rather than tied to one specific booth/component, the most likely fit is: ${listSectionOptions(projectWide)} -- confirm with the user if unsure.`
        : "";
    return (
      `More than one section is named "${args.sectionName}" -- specify groupLabel to pick which one. ` +
      `Options: ${listSectionOptions(candidates)}.${hint}`
    );
  }

  const section = candidates[0];

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

  return `Added a DRAFT line item to "${formatSectionLabel(section)}"${createdSectionNote}${args.category ? ` (category: ${args.category})` : ""}: ${args.description} -- qty ${args.qty}${args.unit ? ` ${args.unit}` : ""} × $${args.unitCost.toFixed(2)} = $${created.totalCost.toFixed(2)}. It won't count toward any total until it's reviewed and confirmed on the Line Items tab.`;
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
      case "find_section":
        return await findSectionTool(context.opportunityId, args);
      case "propose_line_item":
        return await proposeLineItemTool(context.opportunityId, args, context.userId);
      default:
        return `Unknown tool "${name}".`;
    }
  } catch (err) {
    return `That lookup failed: ${err instanceof Error ? err.message : "unknown error"}.`;
  }
}
