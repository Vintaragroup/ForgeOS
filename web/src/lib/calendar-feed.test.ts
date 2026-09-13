import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  issueCalendarFeedToken,
  validateCalendarFeedToken,
  hasActiveCalendarFeedToken,
  buildIcsFeed,
} from "@/lib/calendar-feed";
import type { CalendarItem } from "@/lib/calendar";

afterEach(async () => {
  await db.calendarFeedToken.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string) {
  return db.user.create({ data: { email, name: email, systemRole: "EMPLOYEE" } });
}

describe("issueCalendarFeedToken / validateCalendarFeedToken", () => {
  it("round-trips to the correct user", async () => {
    const user = await makeUser("feed1@test.com");
    const token = await issueCalendarFeedToken(user.id);

    const resolved = await validateCalendarFeedToken(token);
    expect(resolved?.id).toBe(user.id);
  });

  it("never persists the raw token or any substring of the issued URL as the stored hash", async () => {
    const user = await makeUser("feed2@test.com");
    const token = await issueCalendarFeedToken(user.id);
    const [, rawToken] = token.split(".");

    const row = await db.calendarFeedToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).not.toBe(rawToken);
    expect(row.tokenHash.includes(rawToken)).toBe(false);
  });

  it("rejects a revoked token", async () => {
    const user = await makeUser("feed3@test.com");
    const token = await issueCalendarFeedToken(user.id);
    await db.calendarFeedToken.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });

    expect(await validateCalendarFeedToken(token)).toBeNull();
  });

  it("issuing a second token invalidates the first (regenerate semantics)", async () => {
    const user = await makeUser("feed4@test.com");
    const first = await issueCalendarFeedToken(user.id);
    const second = await issueCalendarFeedToken(user.id);

    expect(await validateCalendarFeedToken(first)).toBeNull();
    expect((await validateCalendarFeedToken(second))?.id).toBe(user.id);
  });

  it("rejects a malformed tokenParam with no delimiter", async () => {
    expect(await validateCalendarFeedToken("notatoken")).toBeNull();
  });

  it("rejects a real id paired with a tampered raw token", async () => {
    const user = await makeUser("feed5@test.com");
    const token = await issueCalendarFeedToken(user.id);
    const [id] = token.split(".");

    expect(await validateCalendarFeedToken(`${id}.tamperedtoken`)).toBeNull();
  });
});

describe("hasActiveCalendarFeedToken", () => {
  it("is false before issuance and true after", async () => {
    const user = await makeUser("feed6@test.com");
    expect(await hasActiveCalendarFeedToken(user.id)).toBe(false);
    await issueCalendarFeedToken(user.id);
    expect(await hasActiveCalendarFeedToken(user.id)).toBe(true);
  });
});

function makeItem(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id: "TASK_DUE:abc123",
    type: "TASK_DUE",
    title: "Cut vinyl",
    dateStart: new Date(Date.UTC(2026, 8, 15)),
    href: "/projects/abc",
    tone: "neutral",
    ...overrides,
  };
}

describe("buildIcsFeed", () => {
  it("wraps output in BEGIN:VCALENDAR / END:VCALENDAR with one VEVENT per item", () => {
    const ics = buildIcsFeed([makeItem(), makeItem({ id: "TASK_DUE:def456", title: "Second task" })], { calendarName: "ForgeOS" });
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics.split("BEGIN:VEVENT")).toHaveLength(3); // 2 events + the empty prefix before the first
  });

  it("a point item gets DTSTART;VALUE=DATE with no DTEND", () => {
    const ics = buildIcsFeed([makeItem()], { calendarName: "ForgeOS" });
    expect(ics).toContain("DTSTART;VALUE=DATE:20260915");
    expect(ics).not.toContain("DTEND");
  });

  it("a spanning item's DTEND is dateEnd + 1 day (ICS DTEND is exclusive)", () => {
    const ics = buildIcsFeed(
      [makeItem({ type: "OPPORTUNITY_EVENT_WINDOW", dateStart: new Date(Date.UTC(2026, 8, 15)), dateEnd: new Date(Date.UTC(2026, 8, 16)) })],
      { calendarName: "ForgeOS" },
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20260915");
    expect(ics).toContain("DTEND;VALUE=DATE:20260917");
  });

  it("escapes commas, semicolons, backslashes, and newlines in title per RFC 5545", () => {
    const ics = buildIcsFeed([makeItem({ title: "Due, urgent; note\\here\nline2" })], { calendarName: "ForgeOS" });
    expect(ics).toContain("Due\\, urgent\\; note\\\\here\\nline2");
  });

  it("folds a line longer than 75 octets, with no continuation splitting a multi-byte character", () => {
    // A title padded past the fold boundary, including a multi-byte
    // character (é, 2 bytes in UTF-8) placed right at the likely fold
    // point.
    const longTitle = "A".repeat(70) + "é" + "B".repeat(20);
    const ics = buildIcsFeed([makeItem({ title: longTitle })], { calendarName: "ForgeOS" });
    const summaryLine = ics.split("\r\n").find((l) => l.startsWith("SUMMARY:"));
    expect(summaryLine).toBeDefined();

    // Reconstruct the folded SUMMARY block (the physical line plus any
    // " "-prefixed continuation lines that follow it) and confirm every
    // physical line -- as bytes -- is within the 75-octet limit, and that
    // re-joining the fold recovers the original escaped text exactly (a
    // split mid-character would corrupt the UTF-8 and fail this).
    const lines = ics.split("\r\n");
    const startIdx = lines.findIndex((l) => l.startsWith("SUMMARY:"));
    const block: string[] = [lines[startIdx]];
    let i = startIdx + 1;
    while (i < lines.length && lines[i].startsWith(" ")) {
      block.push(lines[i]);
      i++;
    }
    for (const physicalLine of block) {
      expect(Buffer.byteLength(physicalLine, "utf8")).toBeLessThanOrEqual(75);
    }
    const rejoined = block[0] + block.slice(1).map((l) => l.slice(1)).join("");
    expect(rejoined).toBe(`SUMMARY:${longTitle}`);
  });
});
