import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type {
  SalesmateCompanyRow,
  SalesmateContactRow,
  SalesmateDealRow,
  SalesmateActivityRow,
  SalesmateFetcher,
  SalesmateUserRow,
} from "@/lib/salesmate-client";
import {
  createCompanyFromSalesmate,
  ignoreSalesmateCompany,
  linkSalesmateCompany,
  normalizeCompanyName,
  runSalesmateSync,
  suggestCompanyMatches,
  type SalesmateSyncStats,
} from "@/lib/salesmate-sync";

afterEach(async () => {
  await db.clientTouch.deleteMany();
  await db.salesmateActivity.deleteMany();
  await db.salesmateDeal.deleteMany();
  await db.user.deleteMany();
  await db.salesmateSyncRun.deleteMany();
  await db.salesmateCompany.deleteMany();
  await db.opportunity.deleteMany();
  await db.contact.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// 2026-09-18 12:00:00 UTC, in Salesmate's unix-seconds format.
const SEPT_18 = 1789732800;

function company(id: number, name: string, extra: Partial<SalesmateCompanyRow> = {}): SalesmateCompanyRow {
  return {
    id, name, type: "Customer", phone: null, website: null,
    billingAddressLine1: null, billingAddressLine2: null, billingCity: null, billingState: null, billingZipCode: null, billingCountry: null,
    owner: { id: 1, name: "Terry Genovese" },
    lastCommunicationAt: SEPT_18, lastCommunicationMode: "Email", lastCommunicationBy: "Terry Genovese",
    ...extra,
  };
}

function contact(id: number, companyId: number, name: string, extra: Partial<SalesmateContactRow> = {}): SalesmateContactRow {
  return {
    id, name, email: null, phone: null, mobile: null, designation: null,
    company: { id: companyId, name: "" },
    lastCommunicationAt: SEPT_18, lastCommunicationMode: "Email", lastCommunicationBy: "Tim Morris",
    ...extra,
  };
}

function deal(id: number, companyId: number, title: string, extra: Partial<SalesmateDealRow> = {}): SalesmateDealRow {
  return {
    id, title, status: "Won", pipeline: "Pipeline 2026", stage: "January", dealValue: "12500.5000",
    owner: { id: 1, name: "Terry Genovese" }, primaryCompany: { id: companyId, name: "" }, primaryContact: null,
    createdAt: SEPT_18, closedDate: SEPT_18, estimatedCloseDate: "2026-01-20T00:00:00.000Z", lastCommunicationAt: null,
    ...extra,
  };
}

function fakeSalesmate(data: {
  users?: SalesmateUserRow[];
  activities?: SalesmateActivityRow[];
  companies?: SalesmateCompanyRow[];
  contacts?: SalesmateContactRow[];
  deals?: SalesmateDealRow[];
}): SalesmateFetcher {
  return {
    users: async () => data.users ?? [],
    activities: async () => data.activities ?? [],
    companies: async () => data.companies ?? [],
    contacts: async () => data.contacts ?? [],
    deals: async () => data.deals ?? [],
  };
}

async function sync(data: Parameters<typeof fakeSalesmate>[0]) {
  const run = await runSalesmateSync({ trigger: "SCRIPT", fetcher: fakeSalesmate(data) });
  return { run, stats: run.stats as unknown as SalesmateSyncStats };
}

describe("runSalesmateSync -- companies", () => {
  it("auto-links exact matches, auto-creates clearly-new companies, and leaves only fuzzy/ambiguous ones for review", async () => {
    const clubGlove = await db.company.create({ data: { name: "Club Glove, Inc." } });
    await db.company.create({ data: { name: "Arena Event Services Inc." } });
    // Two ForgeOS companies normalize to the same name -> ambiguous, must not auto-link.
    await db.company.create({ data: { name: "Titleist" } });
    await db.company.create({ data: { name: "TITLEIST" } });

    const { run, stats } = await sync({
      companies: [
        company(1, "club glove inc", { phone: "407-555-0100", billingCity: "Orlando", billingState: "FL" }),
        company(2, "Arena"),
        company(3, "Titleist"),
        company(4, "Brand New Prospect", { type: "Prospect" }),
      ],
    });

    expect(run.status).toBe("SUCCEEDED");
    // Club Glove: exact match (legal suffix ignored) -> linked.
    // Brand New Prospect: nothing plausible in ForgeOS -> created + linked.
    // Arena: close to "Arena Event Services Inc." but not the same -> review.
    // Titleist: two ForgeOS companies normalize to it -> review.
    expect(stats.companies).toMatchObject({ fetched: 4, created: 4, autoLinked: 1, autoCreated: 1, linked: 2, waitingReview: 2 });
    const mirror = await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "1" } });
    expect(mirror).toMatchObject({ companyId: clubGlove.id, phone: "407-555-0100", address: "Orlando, FL", type: "Customer" });
    expect(mirror.lastCommunicationAt?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(await db.company.count()).toBe(5);
    const created = await db.company.findFirstOrThrow({ where: { name: "Brand New Prospect" } });
    expect((await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "4" } })).companyId).toBe(created.id);
    expect((await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "2" } })).companyId).toBeNull();
  });

  it("marks a company Salesmate stopped returning as removed -- but never on an empty response", async () => {
    await sync({ companies: [company(1, "Keep Me"), company(2, "Gone Soon")] });

    await sync({ companies: [] });
    expect(await db.salesmateCompany.count({ where: { removedAt: { not: null } } })).toBe(0);

    const { stats } = await sync({ companies: [company(1, "Keep Me")] });
    expect(stats.companies.removed).toBe(1);
    expect((await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "2" } })).removedAt).not.toBeNull();
  });

  it("records a failed run with the error, and writes nothing, when Salesmate errors", async () => {
    const run = await runSalesmateSync({
      trigger: "MANUAL",
      fetcher: { ...fakeSalesmate({}), deals: async () => Promise.reject(new Error("Salesmate deal search failed: HTTP 401")) },
    });
    expect(run.status).toBe("FAILED");
    expect(run.error).toContain("HTTP 401");
    expect(run.finishedAt).not.toBeNull();
    expect(await db.salesmateCompany.count()).toBe(0);
  });
});

describe("runSalesmateSync -- contacts", () => {
  it("creates contacts under linked companies and counts the rest as waiting", async () => {
    await db.company.create({ data: { name: "Club Glove" } });
    const { stats } = await sync({
      companies: [company(1, "Club Glove"), company(2, "Unlinked Co", { type: "Partner" })],
      contacts: [
        contact(10, 1, "Dana Reyes", { email: "dana@clubglove.com", designation: "Marketing Director", mobile: "555-1111" }),
        contact(11, 2, "Waiting Person"),
      ],
    });

    expect(stats.contacts).toMatchObject({ fetched: 2, created: 1, waitingOnCompany: 1 });
    const dana = await db.contact.findUniqueOrThrow({ where: { salesmateId: "10" } });
    expect(dana).toMatchObject({ name: "Dana Reyes", email: "dana@clubglove.com", title: "Marketing Director", role: "CLIENT_CONTACT", lastContactedBy: "Tim Morris" });
    expect(dana.lastContactedAt?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
  });

  it("adopts a hand-entered contact by email, fills only empty fields, and never resurrects a deleted one", async () => {
    const co = await db.company.create({ data: { name: "Club Glove" } });
    const handEntered = await db.contact.create({
      data: { name: "Dana R.", email: "DANA@clubglove.com", phone: "edited-in-forgeos", role: "CLIENT_CONTACT", companyId: co.id },
    });
    const deleted = await db.contact.create({
      data: { name: "Old Contact", role: "CLIENT_CONTACT", companyId: co.id, deletedAt: new Date() },
    });

    const { stats } = await sync({
      companies: [company(1, "Club Glove")],
      contacts: [
        contact(10, 1, "Dana Reyes", { email: "dana@clubglove.com", phone: "from-salesmate", designation: "Director" }),
        contact(11, 1, "Old Contact"),
      ],
    });

    // Dana adopted (not duplicated); "Old Contact" wasn't matched because the
    // hand-entered row is deleted -- a fresh one is created instead.
    expect(stats.contacts).toMatchObject({ adopted: 1, created: 1 });
    const dana = await db.contact.findUniqueOrThrow({ where: { id: handEntered.id } });
    expect(dana).toMatchObject({ salesmateId: "10", name: "Dana R.", phone: "edited-in-forgeos", title: "Director" });
    expect((await db.contact.findUniqueOrThrow({ where: { id: deleted.id } })).deletedAt).not.toBeNull();

    // Deleting a synced contact in ForgeOS sticks across the next sync too.
    await db.contact.update({ where: { id: handEntered.id }, data: { deletedAt: new Date() } });
    await sync({ companies: [company(1, "Club Glove")], contacts: [contact(10, 1, "Dana Reyes")] });
    expect((await db.contact.findUniqueOrThrow({ where: { id: handEntered.id } })).deletedAt).not.toBeNull();
  });
});

describe("runSalesmateSync -- deals", () => {
  it("mirrors deals with value and dates, attached to linked companies and synced contacts", async () => {
    const co = await db.company.create({ data: { name: "Club Glove" } });
    const { stats } = await sync({
      companies: [company(1, "Club Glove"), company(2, "Unlinked Co", { type: "Partner" })],
      contacts: [contact(10, 1, "Dana Reyes")],
      deals: [
        deal(100, 1, "Club Glove - PGA 2026 - 20x20 - Orlando", { primaryContact: { id: 10, name: "Dana Reyes" } }),
        deal(101, 2, "Unlinked - Some Show", { status: "Lost", dealValue: "0.0000" }),
      ],
    });

    expect(stats.deals).toMatchObject({ fetched: 2, created: 2, onLinkedCompanies: 1 });
    const won = await db.salesmateDeal.findUniqueOrThrow({ where: { salesmateId: "100" }, include: { contact: true } });
    expect(won).toMatchObject({ companyId: co.id, status: "Won", pipeline: "Pipeline 2026", ownerName: "Terry Genovese" });
    expect(won.value?.toString()).toBe("12500.5");
    expect(won.estimatedCloseAt?.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    expect(won.contact?.name).toBe("Dana Reyes");
    expect((await db.salesmateDeal.findUniqueOrThrow({ where: { salesmateId: "101" } })).companyId).toBeNull();
  });

  it("keeps a hand-made opportunity link across re-syncs", async () => {
    const co = await db.company.create({ data: { name: "Club Glove" } });
    const opp = await db.opportunity.create({ data: { companyId: co.id, showName: "PGA Show" } });
    const data = { companies: [company(1, "Club Glove")], deals: [deal(100, 1, "Club Glove - PGA 2026")] };
    await sync(data);
    await db.salesmateDeal.update({ where: { salesmateId: "100" }, data: { opportunityId: opp.id } });

    const { stats } = await sync({ ...data, deals: [deal(100, 1, "Club Glove - PGA 2026 (renamed)")] });
    expect(stats.deals.updated).toBe(1);
    expect(await db.salesmateDeal.findUniqueOrThrow({ where: { salesmateId: "100" } })).toMatchObject({
      opportunityId: opp.id,
      title: "Club Glove - PGA 2026 (renamed)",
    });
  });
});

describe("company-link review", () => {
  it("suggests the likely ForgeOS match for a differently-spelled company", () => {
    const companies = [
      { id: "a", name: "Arena Event Services Inc." },
      { id: "b", name: "Titleist" },
      { id: "c", name: "Club Glove" },
    ];
    expect(suggestCompanyMatches("Arena", companies)[0]).toMatchObject({ id: "a" });
    expect(suggestCompanyMatches("Zzz Unrelated", companies)).toEqual([]);
    expect(normalizeCompanyName("Club Glove, Inc.")).toBe("clubglove");
  });

  it("linking reattaches deals immediately and brings contacts on the next sync; create-new and ignore work too", async () => {
    const arena = await db.company.create({ data: { name: "Arena Event Services Inc." } });
    const data = {
      companies: [company(2, "Arena"), company(3, "Brand New Prospect", { billingCity: "Miami", billingState: "FL" }), company(4, "Expo CCI", { type: "Partner" })],
      contacts: [contact(20, 2, "Arena Person")],
      deals: [deal(200, 2, "ARENA - RFP 3 - LA")],
    };
    await sync(data);

    // The sync already created "Brand New Prospect" (nothing plausible to match).
    expect(await db.company.findFirst({ where: { name: "Brand New Prospect", billingAddress: "Miami, FL" } })).not.toBeNull();
    // Expo's own Partner record is never auto-created; an admin ignores it.
    expect((await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "4" } })).companyId).toBeNull();

    await linkSalesmateCompany("2", arena.id);
    expect((await db.salesmateDeal.findUniqueOrThrow({ where: { salesmateId: "200" } })).companyId).toBe(arena.id);
    await ignoreSalesmateCompany("4");

    const { stats } = await sync(data);
    expect(stats.companies).toMatchObject({ linked: 2, waitingReview: 0 });
    await expect(createCompanyFromSalesmate("2")).rejects.toThrow(/already linked/);
    expect(stats.contacts.created).toBe(1);
    expect((await db.contact.findUniqueOrThrow({ where: { salesmateId: "20" } })).companyId).toBe(arena.id);
  });
});

describe("automatic linking rules", () => {
  it("ignores legal suffixes, punctuation, '&', and a leading 'The' when matching names", () => {
    expect(normalizeCompanyName("Club Glove, Inc.")).toBe("clubglove");
    expect(normalizeCompanyName("CLUB GLOVE LLC")).toBe("clubglove");
    expect(normalizeCompanyName("The Nest Group")).toBe("nestgroup");
    expect(normalizeCompanyName("Flag & Anthem")).toBe(normalizeCompanyName("Flag and Anthem"));
    // A single word is never stripped away entirely.
    expect(normalizeCompanyName("Company")).toBe("company");
    expect(normalizeCompanyName("The")).toBe("the");
  });

  it("auto-creates when the only overlap is a generic word, but not when a name is plausibly the same client", async () => {
    await db.company.create({ data: { name: "Aguila Golf" } });
    await db.company.create({ data: { name: "Full Swing" } });
    const { stats } = await sync({
      companies: [company(1, "Golf Max USA", { type: "Lead" }), company(2, "Full Swing Golf", { type: "Lead" })],
    });
    expect(stats.companies).toMatchObject({ autoCreated: 1, waitingReview: 1 });
    expect(await db.company.findFirst({ where: { name: "Golf Max USA" } })).not.toBeNull();
    expect((await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "2" } })).companyId).toBeNull();
  });

  it("folds Salesmate duplicates into one company -- created once, or following an admin-linked twin", async () => {
    await db.company.create({ data: { name: "Nicklaus Children Hospital Systems" } });
    const first = await sync({
      companies: [
        company(1, "ENCOPIM", { type: "Lead" }),
        company(2, "Encopim", { type: "Prospect" }),
        company(3, "Nicklaus Children's Health System"),
        company(4, "Nicklaus Childrens Health System"),
      ],
    });
    // One ENCOPIM company for both records; both Nicklaus records wait (close, not exact).
    expect(first.stats.companies).toMatchObject({ autoCreated: 1, autoLinked: 1, waitingReview: 2 });
    expect(await db.company.count({ where: { name: { equals: "encopim", mode: "insensitive" } } })).toBe(1);

    const nicklaus = await db.company.findFirstOrThrow({ where: { name: "Nicklaus Children Hospital Systems" } });
    await linkSalesmateCompany("4", nicklaus.id);
    const second = await sync({
      companies: [
        company(1, "ENCOPIM", { type: "Lead" }),
        company(2, "Encopim", { type: "Prospect" }),
        company(3, "Nicklaus Children's Health System"),
        company(4, "Nicklaus Childrens Health System"),
      ],
    });
    // Record 3 followed its twin onto the admin's choice.
    expect(second.stats.companies).toMatchObject({ autoLinked: 1, waitingReview: 0 });
    expect((await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "3" } })).companyId).toBe(nicklaus.id);
  });
});

describe("owner mapping", () => {
  const smUser = (id: number, name: string, email: string | null, isActive = 1): SalesmateUserRow => ({ id, name, email, isActive });

  it("matches reps by email, then name, records the rest as unmatched, and stamps owners onto companies and deals", async () => {
    const byEmail = await db.user.create({ data: { name: "Terry G.", email: "terry@expocci.com", systemRole: "EMPLOYEE" } });
    const byName = await db.user.create({ data: { name: "Craig Wells", email: "cw@other.com", systemRole: "EMPLOYEE" } });

    const { stats } = await sync({
      users: [
        smUser(1, "Terry Genovese", "TERRY@expocci.com"),
        smUser(2, "Craig Wells", "craig.wells@expocci.com"),
        smUser(3, "David I. Stelly", "dstelly@expocci.com"),
        smUser(4, "Retired Rep", "retired@expocci.com", 0),
      ],
      companies: [company(1, "Club Glove", { owner: { id: 2, name: "Craig Wells" } })],
      deals: [deal(100, 1, "Club Glove - PGA 2026", { owner: { id: 1, name: "Terry Genovese" } })],
    });

    // Inactive Salesmate users are ignored entirely.
    expect(stats.users).toMatchObject({ fetched: 3, matched: 2, unmatched: ["David I. Stelly"] });
    expect((await db.user.findUniqueOrThrow({ where: { id: byEmail.id } })).salesmateUserId).toBe("1");
    expect((await db.user.findUniqueOrThrow({ where: { id: byName.id } })).salesmateUserId).toBe("2");

    const mirror = await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId: "1" } });
    expect(mirror).toMatchObject({ ownerUserId: byName.id, ownerSalesmateUserId: "2", ownerName: "Craig Wells" });
    const d = await db.salesmateDeal.findUniqueOrThrow({ where: { salesmateId: "100" } });
    expect(d).toMatchObject({ ownerUserId: byEmail.id, ownerSalesmateUserId: "1" });
  });

  it("keeps a rep matched after a rename in Salesmate, via the stored id", async () => {
    const user = await db.user.create({ data: { name: "Tim Morris", email: "tim@expocci.com", systemRole: "EMPLOYEE" } });
    await sync({ users: [smUser(7, "Tim Morris", "tim@expocci.com")] });
    const { stats } = await sync({
      users: [smUser(7, "Timothy Morris-Smith", "newemail@expocci.com")],
      deals: [deal(101, 1, "Some deal", { owner: { id: 7, name: "Timothy Morris-Smith" } })],
    });
    expect(stats.users).toMatchObject({ matched: 1, unmatched: [] });
    expect((await db.salesmateDeal.findUniqueOrThrow({ where: { salesmateId: "101" } })).ownerUserId).toBe(user.id);
  });
});

describe("activities and touch history", () => {
  const activity = (id: number, extra: Partial<SalesmateActivityRow> = {}): SalesmateActivityRow => ({
    id, type: "Call", title: `Call ${id}`, description: null,
    dueDate: SEPT_18, isCompleted: 0, duration: 30, createdAt: SEPT_18,
    owner: { id: 1, name: "Terry Genovese" }, company: null, contact: null, deal: null,
    ...extra,
  });

  it("mirrors scheduled activities and finds the client through the contact when the company link is missing", async () => {
    const co = await db.company.create({ data: { name: "Club Glove" } });
    const { stats } = await sync({
      companies: [company(1, "Club Glove")],
      contacts: [contact(10, 1, "Dana Reyes")],
      activities: [
        // Only a contact link -- the common case in the real account.
        activity(500, { contact: { id: 10, name: "Dana Reyes" } }),
        // Neither link: kept, but attached to nobody.
        activity(501, { type: "Meeting", duration: 60 }),
      ],
    });

    expect(stats.activities).toMatchObject({ fetched: 2, created: 2, onClients: 1 });
    const viaContact = await db.salesmateActivity.findUniqueOrThrow({ where: { salesmateId: "500" } });
    expect(viaContact).toMatchObject({ companyId: co.id, type: "Call", isCompleted: false, durationMinutes: 30 });
    expect(viaContact.dueAt?.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect((await db.salesmateActivity.findUniqueOrThrow({ where: { salesmateId: "501" } })).companyId).toBeNull();
  });

  it("records one touch per real communication, and never double-counts on a re-run", async () => {
    const terry = await db.user.create({ data: { name: "Tim Morris", email: `tim.${Math.random()}@expocci.com`, systemRole: "EMPLOYEE" } });
    await db.company.create({ data: { name: "Club Glove" } });
    const data = {
      companies: [company(1, "Club Glove")],
      contacts: [contact(10, 1, "Dana Reyes", { email: "dana@clubglove.com" })],
    };

    const first = await sync(data);
    // The company's timestamp is the same email as the contact's, so it's
    // recorded once, not twice.
    expect(first.stats.touches.recorded).toBe(1);
    const second = await sync(data);
    expect(second.stats.touches.recorded).toBe(0);

    // A later communication is a new touch, and the old one is kept.
    const later = SEPT_18 + 3 * 24 * 60 * 60;
    const third = await sync({
      companies: [company(1, "Club Glove", { lastCommunicationAt: later })],
      contacts: [contact(10, 1, "Dana Reyes", { email: "dana@clubglove.com", lastCommunicationAt: later })],
    });
    expect(third.stats.touches.recorded).toBe(1);

    const touches = await db.clientTouch.findMany({ orderBy: { occurredAt: "asc" } });
    expect(touches).toHaveLength(2);
    expect(touches[0]).toMatchObject({ mode: "Email", byName: "Tim Morris", byUserId: terry.id });
    expect(touches.at(-1)!.occurredAt.toISOString()).toBe(new Date(later * 1000).toISOString());
  });
});

