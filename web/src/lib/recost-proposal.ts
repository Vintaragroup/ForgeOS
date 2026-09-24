// What a model is allowed to have said about a re-cost.
//
// Step 5 of docs/recost-review.md is the first stage with AI in it, and
// this is the gate it has to come back through. Everything before it was
// deterministic: the estimator's own status column, the drawing
// comparison, the arithmetic. Here a model maps "the front structure
// with monitors and LED elements is no longer present" onto the line
// items that ARE that structure, which is genuinely a language problem
// and genuinely worth a model.
//
// It is also where a model can do real damage, because the output is
// money against a client's estimate. So nothing it returns is trusted:
//
//   every id it names must exist in this estimate
//   every quote it cites must appear verbatim in the source it cites
//   every number it proposes must appear in that quote
//   a removal must name something the finding is recognisably about
//   a removal on a value-engineering job is never pre-confirmed
//
// A proposal failing any of these is dropped with a reason rather than
// repaired. A repaired proposal is a guess wearing the clothes of a
// citation, and the guess is the thing being guarded against.
//
// A leaf module: pure functions over plain rows, no db import.

export type RecostActionValue =
  | "REMOVE"
  | "REDUCE_QTY"
  | "ADJUST_QTY"
  | "REPRICE"
  | "ADD"
  | "NEEDS_QUOTE"
  | "RE_SOURCE";
export type RecostConfidenceValue = "RECOMMEND_AND_CONFIRM" | "NEED_YOUR_DECISION";
export type RecostMode = "VALUE_ENGINEERING" | "REDESIGN";

const ACTIONS: RecostActionValue[] = [
  "REMOVE",
  "REDUCE_QTY",
  "ADJUST_QTY",
  "REPRICE",
  "ADD",
  "NEEDS_QUOTE",
  "RE_SOURCE",
];

// A finding the model was asked about, and the text it is allowed to
// quote from. Nothing outside sourceText is citable.
export interface ProposalFinding {
  id: string;
  sourceDocumentId: string;
  sourceText: string;
  // What the source called the thing, on its own. Matched against the
  // target's name for actions that take money out -- see below.
  subject: string;
}

export interface ProposalContext {
  mode: RecostMode;
  findings: ProposalFinding[];
  // Id to name. Names are needed, not just ids: a removal has to be
  // checked against WHAT it is removing, not only that the row exists.
  lineItems: Map<string, string>;
  sections: Map<string, string>;
}

// Exactly as the model returned it: every field optional and every type
// suspect, because a schema-constrained response is still a response.
export interface RawProposal {
  findingId?: unknown;
  action?: unknown;
  lineItemIds?: unknown;
  sectionId?: unknown;
  reason?: unknown;
  sourceQuote?: unknown;
  sourceLocation?: unknown;
  confidence?: unknown;
  newUnitCost?: unknown;
  newQty?: unknown;
}

export interface ValidatedProposal {
  findingId: string;
  action: RecostActionValue;
  // Exactly one of these is populated, matching what RecostProposal can
  // store: line items for a precise change, a section for a whole-booth
  // one -- which is how an estimator thinks about "the reception
  // counter" rather than as 25 separate removals.
  lineItemIds: string[];
  sectionId: string | null;
  reason: string;
  sourceDocumentId: string;
  sourceQuote: string;
  sourceLocation: string | null;
  confidence: RecostConfidenceValue;
  newUnitCost: number | null;
  newQty: number | null;
}

export interface ValidationResult {
  proposals: ValidatedProposal[];
  // Kept rather than counted. A model that returns eight proposals of
  // which six are dropped is a fact worth seeing, and the previous
  // silent-drop bug in this codebase took a direct database read to
  // diagnose.
  rejected: { findingId: string; why: string }[];
  // Findings nobody proposed anything for. Not an error -- "no proposal"
  // is a legitimate answer -- but it is the thing a prompt change should
  // be measured against.
  uncovered: string[];
}

// Loose enough to survive the model reformatting whitespace, tight
// enough that it cannot pass off a sentence the document never
// contained. Case and inner spacing are normalised; words are not.
function quotedFrom(quote: string, sourceText: string): boolean {
  const flatten = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”"']/g, "").trim();
  const needle = flatten(quote);
  if (needle.length < 8) return false;
  return flatten(sourceText).includes(needle);
}

// Whether a number the model proposed actually came from the quote.
//
// "$13,000", "13000", "13,000.00" all read as the same number, so the
// comparison is numeric rather than textual. A price nobody wrote down
// is an invention, and the estimating rules are explicit about not
// inferring what a document does not state (Estimate-Guidelines s10,
// s11, s15).
function numberAppearsIn(value: number, text: string): boolean {
  const found = [...text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  return found.some((n) => Math.abs(n - value) < 0.005);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

// Whether a target is recognisably the thing the finding is about.
//
// Only applied to actions that take money OUT of a row that already
// exists. Its whole purpose is the second production run on ABC Chicago,
// where removing the empty sections from the candidate list moved both
// structure findings onto real ones -- and the real ones were wrong:
//
//   "front structure ... no longer present"      -> FS - Reception Counter
//   "rear structure with closet ... no longer"   -> FS - Lit Spines Lounge
//
// Neither is what the drawing was talking about. That is a worse failure
// than the empty section it replaced, because a removal against a real
// section is a removal somebody might accept. The honest answer for both
// is that this estimate has no section for a "front structure", and the
// prompt does say omitting a finding is legitimate -- but a soft
// instruction is not a guarantee, and this is the guarantee.
//
// Deliberately NOT applied to ADD or NEEDS_QUOTE: new scope has to live
// somewhere, and "a seating area with tables and chairs" belongs in
// SS - Lounge Structure / Custom Build precisely because that is the
// lounge, not because the words match.
function namesTheSameThing(subject: string, target: string): boolean {
  const STOPWORDS = new Set(["a", "an", "and", "of", "the", "with", "w", "for", "qty", "s", "d", "custom", "build"]);
  const tokens = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
        .filter((word) => word && !STOPWORDS.has(word)),
    );

  // The client prefix is dropped the same way recost-corroboration does
  // it: "FS" and "SS" are Full Swing and Second Swing, two companies
  // sharing a stand, and no drawing says either.
  const separator = target.indexOf(" - ");
  const a = tokens(subject);
  const b = tokens(separator === -1 ? target : target.slice(separator + 3));
  if (a.size === 0 || b.size === 0) return false;

  // One shared identifying word is enough here, unlike the corroboration
  // pairing: a line item description is far longer and less regular than
  // a schedule element name, and this is a veto rather than a match.
  return [...a].some((word) => b.has(word));
}

export function validateProposals(raw: RawProposal[], context: ProposalContext): ValidationResult {
  const byFindingId = new Map(context.findings.map((f) => [f.id, f]));
  const proposals: ValidatedProposal[] = [];
  const rejected: { findingId: string; why: string }[] = [];
  const covered = new Set<string>();

  for (const item of raw) {
    const findingId = asString(item.findingId);
    const finding = byFindingId.get(findingId);
    if (!finding) {
      // A proposal about a finding nobody raised. There is nothing to
      // show it against and no source to check it in.
      rejected.push({ findingId: findingId || "(none)", why: "names a finding that was not in the review" });
      continue;
    }

    const action = ACTIONS.find((a) => a === asString(item.action).toUpperCase()) ?? null;
    if (!action) {
      rejected.push({ findingId, why: `action "${asString(item.action)}" is not one this system can take` });
      continue;
    }

    const sourceQuote = asString(item.sourceQuote);
    if (!quotedFrom(sourceQuote, finding.sourceText)) {
      // The single most important check here. A citation that cannot be
      // found in the document it cites is worse than no citation: it
      // reads as evidence.
      rejected.push({ findingId, why: "its quote does not appear in the source it cites" });
      continue;
    }

    const reason = asString(item.reason);
    if (!reason) {
      rejected.push({ findingId, why: "gives no reason" });
      continue;
    }

    const lineItemIds = Array.isArray(item.lineItemIds)
      ? [...new Set(item.lineItemIds.filter((id): id is string => typeof id === "string" && context.lineItems.has(id)))]
      : [];
    const sectionIdRaw = asString(item.sectionId);
    const sectionId = context.sections.has(sectionIdRaw) ? sectionIdRaw : null;

    if (lineItemIds.length === 0 && !sectionId) {
      // Either it named nothing real, or it named nothing at all. Both
      // are a proposal about nothing.
      rejected.push({ findingId, why: "does not name a line item or section that exists in this estimate" });
      continue;
    }
    // The schema stores one or the other. Line items win: they are the
    // more precise claim, and a model that gave both has not decided.
    const targetSectionId = lineItemIds.length > 0 ? null : sectionId;

    // Taking money out of a row means naming the right row.
    if (action === "REMOVE" || action === "REDUCE_QTY") {
      const targets =
        lineItemIds.length > 0
          ? lineItemIds.map((id) => context.lineItems.get(id) ?? "")
          : [context.sections.get(targetSectionId!) ?? ""];
      if (!targets.some((name) => namesTheSameThing(finding.subject, name))) {
        rejected.push({
          findingId,
          why: `proposes ${action} against "${targets[0]}", which is not what "${finding.subject}" is about`,
        });
        continue;
      }
    }

    let confidence: RecostConfidenceValue =
      asString(item.confidence).toUpperCase() === "RECOMMEND_AND_CONFIRM"
        ? "RECOMMEND_AND_CONFIRM"
        : "NEED_YOUR_DECISION";

    // On a value-engineering job the client likes the design and wants
    // the cost out of it. Taking scope off that job is a decision an
    // estimator makes, never one a screen arrives at already agreed --
    // and of roughly forty elements on Full Swing exactly two were true
    // eliminations, so a system confident about removals would be wrong
    // about nearly all of them.
    if (action === "REMOVE" && context.mode === "VALUE_ENGINEERING") {
      confidence = "NEED_YOUR_DECISION";
    }

    // A number survives only if the quote contains it. Dropping the
    // number rather than the proposal: "this changed and nobody has
    // priced it" is still worth raising, and is what NEEDS_QUOTE means.
    const proposedUnitCost = asNumber(item.newUnitCost);
    const proposedQty = asNumber(item.newQty);
    const keepsMoney = action === "REPRICE" || action === "REDUCE_QTY" || action === "RE_SOURCE";

    proposals.push({
      findingId,
      action,
      lineItemIds,
      sectionId: targetSectionId,
      reason,
      sourceDocumentId: finding.sourceDocumentId,
      sourceQuote,
      sourceLocation: asString(item.sourceLocation) || null,
      confidence,
      newUnitCost:
        keepsMoney && proposedUnitCost !== null && numberAppearsIn(proposedUnitCost, sourceQuote)
          ? proposedUnitCost
          : null,
      newQty:
        keepsMoney && proposedQty !== null && numberAppearsIn(proposedQty, sourceQuote) ? proposedQty : null,
    });
    covered.add(findingId);
  }

  return {
    proposals,
    rejected,
    uncovered: context.findings.map((f) => f.id).filter((id) => !covered.has(id)),
  };
}
