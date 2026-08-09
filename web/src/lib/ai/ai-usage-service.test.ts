import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { estimateCostUsd, recordAiUsage, getUserAiUsageSummary } from "@/lib/ai/ai-usage-service";

afterEach(async () => {
  await db.aiUsageEvent.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("estimateCostUsd", () => {
  it("returns 0 for 0 tokens regardless of model", () => {
    expect(estimateCostUsd("gpt-4o-mini", 0, 0)).toBe(0);
  });

  it("matches a hand-computed value for a known model at round numbers", () => {
    // gpt-4o-mini: $0.15/1M input, $0.60/1M output (see the pricing table).
    // 1M input tokens + 1M output tokens -> 0.15 + 0.60 = 0.75.
    expect(estimateCostUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
  });

  it("falls back to gpt-4o's rate for an unrecognized model string, not $0", () => {
    const unknown = estimateCostUsd("some-future-model", 1_000_000, 1_000_000);
    const gpt4o = estimateCostUsd("gpt-4o", 1_000_000, 1_000_000);
    expect(unknown).toBe(gpt4o);
    expect(unknown).toBeGreaterThan(0);
  });
});

describe("recordAiUsage / getUserAiUsageSummary", () => {
  it("records a usage event and rolls it up correctly per user and per feature", async () => {
    const user = await db.user.create({ data: { name: "Test User", email: `t${Date.now()}@test.com` } });

    await recordAiUsage({
      userId: user.id,
      feature: "CHAT",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
    await recordAiUsage({
      userId: user.id,
      feature: "DOCUMENT_SUMMARY",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300 },
    });

    const { totals, byFeature } = await getUserAiUsageSummary(user.id);

    expect(totals._count._all).toBe(2);
    expect(totals._sum.totalTokens).toBe(3800);
    expect(totals._sum.estimatedCostUsd?.toNumber()).toBeCloseTo(
      estimateCostUsd("gpt-4o-mini", 1000, 500) + estimateCostUsd("gpt-4o-mini", 2000, 300),
      6,
    );
    expect(byFeature).toHaveLength(2);
    expect(byFeature.find((f) => f.feature === "CHAT")?._count._all).toBe(1);
  });

  it("never throws even if the insert fails -- a cost-tracking hiccup can't fail the AI call it's tracking", async () => {
    // No such userId exists -- the FK constraint would reject this insert
    // if it weren't swallowed internally, same as any other write failure.
    await expect(
      recordAiUsage({
        userId: "does-not-exist",
        feature: "CHAT",
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    ).resolves.toBeUndefined();
  });

  it("defaults missing usage fields to 0 rather than throwing", async () => {
    const user = await db.user.create({ data: { name: "Test User 2", email: `t2${Date.now()}@test.com` } });
    await recordAiUsage({ userId: user.id, feature: "CHAT", model: "gpt-4o-mini", usage: undefined });

    const { totals } = await getUserAiUsageSummary(user.id);
    expect(totals._count._all).toBe(1);
    expect(totals._sum.totalTokens).toBe(0);
  });
});
