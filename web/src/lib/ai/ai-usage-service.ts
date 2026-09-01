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
