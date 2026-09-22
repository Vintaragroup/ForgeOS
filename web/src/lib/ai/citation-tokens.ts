// Citations the model can actually produce.
//
// The original approach (citation.ts's linkifyMentions) turns a reply into
// links by searching it for text it already knows -- a filename, a line
// item's description, a verified quote. That only fires when the model
// echoes the string character for character, and in practice it doesn't:
// checked against the four real assistant replies on the Super Bowl
// opportunity (6 documents, 163 citable line items, 161 quotes), it
// produced ZERO links, because the model writes 'the RFP titled "SBLXI -
// Temporary Booth Build RFP Final"' where the file is actually
// "Schedule A - SBLXI - 006. Temporary Booth Build - Final.pdf".
//
// So instead of guessing from prose: hand the model a short directory of
// things it may cite, each with an opaque token, and ask it to drop the
// token in. Rendering then swaps tokens for real links. The model can
// paraphrase however it likes; the citation still lands. linkifyMentions
// stays as a second pass for verbatim mentions.

export interface CitationTarget {
  // "doc:cmx123" -- the text the model writes inside [[ ]].
  token: string;
  // What the link reads as when the model doesn't supply its own text.
  label: string;
  href: string;
}

// Kept short: a directory is part of every request's prompt budget, so it
// lists what's citable, not what each thing contains.
export function buildCitationDirectory(targets: CitationTarget[], heading = "Things you can cite"): string {
  if (targets.length === 0) return "";
  const lines = targets.map((t) => `- [[${t.token}]] ${t.label}`);
  return `${heading} (cite by writing the token exactly, e.g. [[${targets[0].token}]]):\n${lines.join("\n")}`;
}

export const CITATION_INSTRUCTIONS = [
  "When you refer to a document, line item, client, or deal that appears in the citable list, write its token",
  "(for example [[doc:abc123]]) immediately after the thing you are referring to. The reader sees a link, not the",
  "token. Never invent a token that isn't in the list, and never write a token for something you're only guessing at.",
].join(" ");

const TOKEN_PATTERN = /\[\[([a-zA-Z]+:[A-Za-z0-9_-]+)\]\]/g;

// Swaps every [[token]] for a markdown link. A token that isn't in the
// directory is dropped entirely rather than rendered: a hallucinated id
// would otherwise become a link to nowhere, which is worse than no link.
export function renderCitationTokens(text: string, targets: CitationTarget[]): string {
  if (!text.includes("[[")) return text;
  const byToken = new Map(targets.map((t) => [t.token, t]));
  return text.replace(TOKEN_PATTERN, (_match, token: string) => {
    const target = byToken.get(token);
    if (!target) return "";
    // Markdown link text can't contain unescaped brackets.
    const label = target.label.replace(/[[\]]/g, "");
    return `[${label}](${target.href})`;
  });
}

// Tokens are opaque on purpose (an id, not a name): a model copying a
// label into a token would otherwise produce something that looks right
// and links nowhere.
export function documentCitation(opportunityId: string, doc: { id: string; filename: string }): CitationTarget {
  return {
    token: `doc:${doc.id}`,
    label: doc.filename,
    href: `/opportunities/${opportunityId}/documents/${doc.id}/view`,
  };
}

export function lineItemCitation(item: { id: string; estimateId: string; description: string }): CitationTarget {
  return {
    token: `item:${item.id}`,
    label: item.description,
    href: `/estimates/${item.estimateId}#line-item-${item.id}`,
  };
}

export function companyCitation(company: { id: string; name: string }): CitationTarget {
  return { token: `company:${company.id}`, label: company.name, href: `/companies/${company.id}` };
}

export function opportunityCitation(opportunity: { id: string; showName: string; companyName?: string }): CitationTarget {
  return {
    token: `opp:${opportunity.id}`,
    label: opportunity.companyName ? `${opportunity.companyName} — ${opportunity.showName}` : opportunity.showName,
    href: `/opportunities/${opportunity.id}`,
  };
}

// A piece of artwork. Labelled by who it's for plus its job code, since
// "A1" or "Door panel" means nothing without the booth it belongs to --
// and a Hub/hanging-sign piece has no client at all (see
// ArtworkOrder.showId's schema comment), so it is named after its show.
export function artworkCitation(order: {
  id: string;
  jobCode: string;
  companyName?: string | null;
  showName?: string | null;
  graphicCode?: string | null;
}): CitationTarget {
  const who = order.companyName ?? (order.showName ? `${order.showName} (show piece)` : "Unattributed piece");
  const what = order.graphicCode ? `${order.graphicCode} · ${order.jobCode}` : order.jobCode;
  return { token: `art:${order.id}`, label: `${who} — ${what}`, href: `/artwork/${order.id}` };
}

export function showCitation(show: { id: string; name: string }): CitationTarget {
  return { token: `show:${show.id}`, label: show.name, href: `/shows/${show.id}` };
}
