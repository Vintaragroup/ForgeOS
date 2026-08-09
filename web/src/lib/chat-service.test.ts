import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { RateLimitError } from "@/lib/rate-limit";
import { sendMessage } from "@/lib/chat-service";

afterEach(async () => {
  await db.chatMessage.deleteMany();
  await db.chatThread.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
}

// OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
// document-summary-service.test.ts. These verify the config-guard and
// rate-limit mechanics, not a real completion (that needs a real key).
describe("sendMessage", () => {
  it("throws AiNotConfiguredError before creating a thread or saving the message", async () => {
    const opportunity = await makeOpportunity();

    await expect(sendMessage(opportunity.id, "user-1", "hello")).rejects.toBeInstanceOf(AiNotConfiguredError);

    expect(await db.chatThread.findUnique({ where: { opportunityId: opportunity.id } })).toBeNull();
    expect(await db.chatMessage.count()).toBe(0);
  });

  it("rate-limits by user id, independent of the AI configuration error", async () => {
    const opportunity = await makeOpportunity();
    const userId = randomUUID();

    // The limit (20) is checked before the config check, so it's exercised
    // even though every one of these calls will also hit AiNotConfiguredError.
    for (let i = 0; i < 20; i++) {
      await expect(sendMessage(opportunity.id, userId, `msg ${i}`)).rejects.toBeInstanceOf(AiNotConfiguredError);
    }

    await expect(sendMessage(opportunity.id, userId, "one too many")).rejects.toBeInstanceOf(RateLimitError);
  });
});
