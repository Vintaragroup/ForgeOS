import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  createAssistantThread,
  listAssistantThreads,
  loadAssistantThread,
  sendAssistantMessage,
} from "@/lib/assistant-service";
import { assistantsForUser, canUseAssistant, getDepartmentAssistant, type AssistantUser } from "@/lib/ai/assistant-registry";
import { UserError } from "@/lib/user-error";

afterEach(async () => {
  await db.chatMessage.deleteMany();
  await db.chatThread.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(name: string, departmentCode: string | null, systemRole: "EMPLOYEE" | "ADMIN" = "EMPLOYEE") {
  const user = await db.user.create({
    data: { name, email: `${name}.${Math.random().toString(36).slice(2)}@expocci.com`, systemRole, departmentCode },
  });
  return { id: user.id, name: user.name, systemRole: user.systemRole, departmentCode: user.departmentCode, isSalesManager: false } satisfies AssistantUser;
}

describe("who gets which assistant", () => {
  it("gives a rep their own department's, an admin every one, and nobody an unregistered department's", async () => {
    const rep = await makeUser("Terry", "SL");
    const graphics = await makeUser("Gina", "GR");
    const warehouse = await makeUser("Wes", "WH");
    const admin = await makeUser("Ada", null, "ADMIN");

    expect(assistantsForUser(rep).map((a) => a.departmentCode)).toEqual(["SL"]);
    expect(assistantsForUser(graphics).map((a) => a.departmentCode)).toEqual(["GR"]);
    // A department with nothing registered offers none, rather than a
    // half-invented assistant answering from nothing.
    expect(assistantsForUser(warehouse)).toEqual([]);
    expect(getDepartmentAssistant("WH")).toBeNull();
    expect(assistantsForUser(admin).map((a) => a.departmentCode)).toEqual(
      expect.arrayContaining(["SL", "GR"]),
    );

    expect(canUseAssistant(rep, "SL")).toBe(true);
    // Each department's board is its own: a rep cannot open Graphics's,
    // and a producer cannot open Sales's.
    expect(canUseAssistant(rep, "GR")).toBe(false);
    expect(canUseAssistant(graphics, "SL")).toBe(false);
    expect(canUseAssistant(graphics, "WH")).toBe(false);
  });
});

describe("threads", () => {
  it("creates a thread for your own department, refuses another's and one with no assistant", async () => {
    const rep = await makeUser("Terry", "SL");
    const thread = await createAssistantThread(rep, "SL");
    expect(thread).toMatchObject({ scope: "DEPARTMENT", userId: rep.id, departmentCode: "SL", title: null });

    await expect(createAssistantThread(rep, "GR")).rejects.toBeInstanceOf(UserError);

    const graphics = await makeUser("Gina", "GR");
    const grThread = await createAssistantThread(graphics, "GR");
    expect(grThread).toMatchObject({ scope: "DEPARTMENT", userId: graphics.id, departmentCode: "GR" });

    // Still nothing for a department with no assistant registered.
    const warehouse = await makeUser("Wes", "WH");
    await expect(createAssistantThread(warehouse, "WH")).rejects.toThrow(/access/);
  });

  it("never lets one rep open another rep's conversation, but an admin can", async () => {
    const terry = await makeUser("Terry", "SL");
    const brandon = await makeUser("Brandon", "SL");
    const admin = await makeUser("Ada", null, "ADMIN");
    const thread = await createAssistantThread(terry, "SL");

    await expect(loadAssistantThread(brandon, thread.id)).rejects.toThrow(/belongs to someone else/);
    await expect(sendAssistantMessage(brandon, thread.id, "what's in Terry's book?")).rejects.toThrow(/belongs to someone else/);
    expect((await loadAssistantThread(admin, thread.id)).id).toBe(thread.id);

    // And a thread list only ever shows your own.
    expect(await listAssistantThreads(brandon.id, "SL")).toEqual([]);
    expect((await listAssistantThreads(terry.id, "SL")).map((t) => t.id)).toEqual([thread.id]);
  });

  it("orders threads by most recent activity", async () => {
    const rep = await makeUser("Terry", "SL");
    const older = await createAssistantThread(rep, "SL");
    const newer = await createAssistantThread(rep, "SL");
    await db.chatThread.update({ where: { id: older.id }, data: { lastMessageAt: new Date("2026-09-01") } });
    await db.chatThread.update({ where: { id: newer.id }, data: { lastMessageAt: new Date("2026-09-20") } });

    expect((await listAssistantThreads(rep.id, "SL")).map((t) => t.id)).toEqual([newer.id, older.id]);
  });
});

// OPENAI_API_KEY is deliberately unset in .env.test (same posture as
// chat-service.test.ts) -- these check the guards around the call, not a
// real completion.
describe("sendAssistantMessage guards", () => {
  it("rejects an empty question before anything is stored", async () => {
    const rep = await makeUser("Terry", "SL");
    const thread = await createAssistantThread(rep, "SL");

    await expect(sendAssistantMessage(rep, thread.id, "   ")).rejects.toThrow(/Type a question/);
    expect(await db.chatMessage.count()).toBe(0);
  });

  it("stores nothing when AI isn't configured -- an unanswered question shouldn't sit in the thread", async () => {
    const rep = await makeUser("Terry", "SL");
    const thread = await createAssistantThread(rep, "SL");

    await expect(sendAssistantMessage(rep, thread.id, "Who should I call this week?")).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
    // Same posture as the opportunity chat: the config check runs before
    // the question is saved, so the thread stays clean and untitled.
    const after = await db.chatThread.findUniqueOrThrow({ where: { id: thread.id }, include: { messages: true } });
    expect(after.title).toBeNull();
    expect(after.messages).toEqual([]);
  });
});
