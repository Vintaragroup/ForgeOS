import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { AiFeature } from "@/generated/prisma/enums";

// Point-in-time, hand-maintained USD-per-million-token rates -- OpenAI
// changes pricing without notice and has no pricing-lookup API, so this
// is deliberately approximate and must be read as "close enough for a
// cost-awareness dashboard," never as a billing-accurate ledger. Update
// this table by hand when OpenAI's published pricing changes; nothing in
// this app can detect drift automatically.
const PRICING_PER_MILLION_TOKENS_USD: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  // No output tokens on an embeddings call -- recordAiUsage's caller
  // (document-embedding-service.ts) always passes completion_tokens: 0,
  // so `output` here is never actually multiplied against anything, but
  // still declared instead of omitted so this entry has the same shape
  // as every other rate.
  "text-embedding-3-small": { input: 0.02, output: 0 },
  // Real gap this closes (Sept 2026): drawing-ai-client.ts's AI_DRAWING_MODEL
  // override routes proposeLineItemsFromDrawing/summarizeDrawing through
  // OpenRouter to one of these two model ids (see that file's own header
  // for the A/B test that picked between them) -- neither had an entry
  // here, so every OpenRouter-routed call was silently falling back to
  // gpt-4o's rate below, UNDERSTATING real cost (confirmed live: Claude
  // Sonnet 4.5's real output-token rate is 50% higher than gpt-4o's).
  // Real, current per-token rates below (Sept 2026, both ≤200K-token
  // prompts -- this pipeline's real page-image prompts stay well under
  // that): Anthropic's own published direct rate for Sonnet 4.5, and
  // Google's own published direct rate for Gemini 2.5 Pro. OpenRouter
  // itself passes through the underlying provider's per-token rate with
  // no markup (confirmed via current OpenRouter/Anthropic pricing
  // comparisons) -- its own separate ~5% credit-purchase fee is a
  // funding-level cost, not a per-call one, and isn't modeled here, same
  // as this function's existing "close enough for a cost-awareness
  // dashboard" posture already accepts.
  "anthropic/claude-sonnet-4.5": { input: 3.0, output: 15.0 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10.0 },
};

// Falls back to gpt-4o's (higher) rate for an unrecognized model string
// rather than silently reporting $0 -- an unrecognized model is far more
// likely to be a pricing-table gap than a genuinely free call, and
// undercounting cost is the worse failure mode for a cost-tracking
// feature to have.
function rateFor(model: string) {
  return PRICING_PER_MILLION_TOKENS_USD[model] ?? PRICING_PER_MILLION_TOKENS_USD["gpt-4o"];
}

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const rate = rateFor(model);
  return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
}

// Never let a usage-recording failure fail the AI operation it's tracking
// -- a flaky insert here is not a reason to mark an otherwise-successful
// document analysis or chat reply as FAILED. Every call site awaits this
// but the failure is swallowed internally, not left for the caller to
// (mis)handle.
export async function recordAiUsage(params: {
  userId: string | null;
  feature: AiFeature;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  documentId?: string;
  opportunityId?: string;
}): Promise<void> {
  try {
    const promptTokens = params.usage?.prompt_tokens ?? 0;
    const completionTokens = params.usage?.completion_tokens ?? 0;
    const totalTokens = params.usage?.total_tokens ?? promptTokens + completionTokens;

    await db.aiUsageEvent.create({
      data: {
        userId: params.userId,
        feature: params.feature,
        model: params.model,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd: new Prisma.Decimal(estimateCostUsd(params.model, promptTokens, completionTokens)),
        documentId: params.documentId,
        opportunityId: params.opportunityId,
      },
    });
  } catch {
    // Swallowed deliberately -- see the function comment above.
  }
}

export async function getUserAiUsageSummary(userId: string) {
  const [totals, byFeature] = await Promise.all([
    db.aiUsageEvent.aggregate({
      where: { userId },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
    db.aiUsageEvent.groupBy({
      by: ["feature"],
      where: { userId },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
  ]);
  return { totals, byFeature };
}

// Real per-run token/cost visibility for the batched drawing line-item
// proposal flow (see drawing-line-item-service.ts and the estimates page's
// own Propose card) -- `since` is typically that run's own
// Document.lineItemProposalStartedAt, and recordAiUsage already writes one
// AiUsageEvent row per batch automatically (proposeLineItemsFromDrawing's
// own loop), so this needs no new tracking table: just scoping the
// existing events to one document and one run's time window. The concrete "way to
// optimize token spend" this feature settled on is visibility, not an
// invented auto-optimization -- letting the estimator see the real cost of
// a run is what lets them decide whether it's worth splitting a huge
// document, re-running at a different batch size, etc.
export async function getDocumentAiUsageSince(documentId: string, since: Date) {
  const result = await db.aiUsageEvent.aggregate({
    where: { documentId, createdAt: { gte: since } },
    _sum: { totalTokens: true, estimatedCostUsd: true },
    _count: { _all: true },
    // No durationMs field exists on AiUsageEvent (or anywhere else) --
    // the latest event's own createdAt in this run's window is a real,
    // already-available stand-in for "when the run finished" (recordAiUsage
    // is called right after each batch's completion, so the last one lands
    // within moments of the whole run's final write), letting the caller
    // compute elapsed time as lastEventAt - since with no new migration.
    _max: { createdAt: true },
  });
  return {
    totalTokens: result._sum.totalTokens ?? 0,
    estimatedCostUsd: result._sum.estimatedCostUsd?.toNumber() ?? 0,
    callCount: result._count._all,
    lastEventAt: result._max.createdAt ?? null,
  };
}

// No internal access control, same posture as admin-analytics.ts's
// getAdminAnalytics() -- only ever called from the Dashboard's already
// isAdmin-gated branch (src/app/(app)/page.tsx), not exposed as its own
// Server Action.
export async function getOrgAiUsageSummary() {
  const [totals, byFeature] = await Promise.all([
    db.aiUsageEvent.aggregate({
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
    db.aiUsageEvent.groupBy({
      by: ["feature"],
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
  ]);
  return { totals, byFeature };
}

// What one job has cost in AI, and where it went.
//
// Every AI call already records an AiUsageEvent carrying opportunityId --
// the data has been there all along, aggregated only per user (/account)
// and per organisation (admin analytics). Neither answers the question an
// estimator actually asks, which is "what has THIS job cost me".
//
// Real numbers make that concrete rather than abstract: The Pharmacy Hub
// reached 23 calls and $0.65 during a single build, most of it two
// twelve-page drawings read page by page. Knowing which document did that
// is what lets someone decide it was worth it, or not to re-run it.
//
// Cost is the same approximation estimateCostUsd makes everywhere else --
// a cost-awareness figure, never a billing ledger. See its own comment.
export async function getOpportunityAiUsageSummary(opportunityId: string) {
  const [totals, byFeature, byDocument] = await Promise.all([
    db.aiUsageEvent.aggregate({
      where: { opportunityId },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
    db.aiUsageEvent.groupBy({
      by: ["feature"],
      where: { opportunityId },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
      orderBy: { _sum: { estimatedCostUsd: "desc" } },
    }),
    db.aiUsageEvent.groupBy({
      by: ["documentId"],
      where: { opportunityId, documentId: { not: null } },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
      orderBy: { _sum: { estimatedCostUsd: "desc" } },
      take: 10,
    }),
  ]);

  // groupBy gives ids; the reader needs filenames.
  const documentIds = byDocument.map((d) => d.documentId).filter((id): id is string => id !== null);
  const documents = documentIds.length
    ? await db.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, filename: true } })
    : [];
  const filenameById = new Map(documents.map((d) => [d.id, d.filename]));

  return {
    callCount: totals._count._all,
    totalTokens: totals._sum.totalTokens ?? 0,
    estimatedCostUsd: Number(totals._sum.estimatedCostUsd ?? 0),
    byFeature: byFeature.map((f) => ({
      feature: f.feature,
      callCount: f._count._all,
      totalTokens: f._sum.totalTokens ?? 0,
      estimatedCostUsd: Number(f._sum.estimatedCostUsd ?? 0),
    })),
    byDocument: byDocument.map((d) => ({
      documentId: d.documentId,
      filename: d.documentId ? (filenameById.get(d.documentId) ?? "(deleted document)") : "(no document)",
      callCount: d._count._all,
      totalTokens: d._sum.totalTokens ?? 0,
      estimatedCostUsd: Number(d._sum.estimatedCostUsd ?? 0),
    })),
  };
}
