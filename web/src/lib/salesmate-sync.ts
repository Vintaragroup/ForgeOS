// One-way Salesmate -> ForgeOS sync. Reps keep working in Salesmate; this
// mirrors companies, contacts, and deals into ForgeOS on a schedule (daily
// cron, see vercel.ts) and on demand (/admin/integrations/salesmate). It
// never writes to Salesmate.
//
// What goes where, and why:
// - Every Salesmate company is mirrored into SalesmateCompany. Linking a
//   mirror row to a ForgeOS Company is a separate step: automatic only on
//   an exact normalized-name match to exactly one unlinked company, and by
//   an admin otherwise -- name-only matching can't tell "Arena" from
//   "Arena Event Services Inc." and would create duplicates.
// - Contacts sync into Contact, but only under a LINKED company (a contact
//   with nowhere to live is counted as waiting, and arrives on the first
//   sync after its company is linked). Matched by Salesmate id, then by
//   email or name within the company, so the few contacts entered by hand
//   before the sync existed get adopted instead of duplicated. Existing
//   ForgeOS values are never overwritten -- only empty fields fill in --
//   except the lastContacted* fields, which Salesmate owns.
// - Deals are a read-only mirror (SalesmateDeal) shown as history on a
//   company, never turned into Opportunities -- see the model's comment.
//
// Anything Salesmate stops returning is marked removedAt, never deleted,
// and ONLY when the fetch for that module actually returned rows -- an
// empty response (outage, permission change) must not look like
// "everything was deleted".

import type { Prisma } from "@/generated/prisma/client";
import type { SalesmateSyncTrigger } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { significantTokens } from "@/lib/catalog-match-service";
import { UserError } from "@/lib/user-error";
import {
  salesmateApi,
  type SalesmateCompanyRow,
  type SalesmateContactRow,
  type SalesmateDealRow,
  type SalesmateFetcher,
  type SalesmateUserRow,
  type SalesmateActivityRow,
} from "@/lib/salesmate-client";

export interface SalesmateSyncStats {
  users: { fetched: number; matched: number; unmatched: string[] };
  companies: { fetched: number; created: number; updated: number; removed: number; autoLinked: number; autoCreated: number; linked: number; waitingReview: number };
  contacts: { fetched: number; created: number; updated: number; adopted: number; waitingOnCompany: number; skipped: number };
  deals: { fetched: number; created: number; updated: number; removed: number; onLinkedCompanies: number };
  activities: { fetched: number; created: number; updated: number; removed: number; onClients: number };
  // Real contact history, accumulated one sync at a time (see ClientTouch).
  touches: { recorded: number };
  warnings: string[];
}

// Case/punctuation-insensitive, and blind to legal-form words and a
// leading "The": "Club Glove, Inc." === "club glove" === "CLUB GLOVE LLC".
// Only words that never distinguish one client from another are dropped --
// anything fuzzier is left to suggestCompanyMatches and an admin.
const LEGAL_SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "sa", "srl"]);

export function normalizeCompanyName(name: string | null | undefined): string {
  const words = (name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join("");
}

function fromUnixSeconds(value: number | null | undefined): Date | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

function fromIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clean(value: string | null | undefined): string | null {
  const s = value?.trim();
  return s ? s : null;
}

export function composeSalesmateAddress(row: SalesmateCompanyRow): string | null {
  const lines = [row.billingAddressLine1, row.billingAddressLine2].map(clean).filter(Boolean);
  const cityLine = [row.billingCity, row.billingState, row.billingZipCode].map(clean).filter(Boolean).join(", ");
  const parts = [...lines, cityLine || null, clean(row.billingCountry)].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

// Ties each Salesmate user to a ForgeOS user so deal/company ownership is
// a real FK, not a name string: by stored salesmate id, then email, then
// exact name. Names alone were leaving 67 deals ($1.65M) unattributed on
// production, because Salesmate spells some reps differently ("David I.
// Stelly") or has reps who aren't ForgeOS users at all -- those are
// reported as unmatched rather than silently dropped.
async function syncUsers(rows: SalesmateUserRow[], stats: SalesmateSyncStats): Promise<Map<string, string>> {
  const s = stats.users;
  const active = rows.filter((r) => r.isActive === 1);
  s.fetched = active.length;
  const byUserId = new Map<string, string>();

  for (const row of active) {
    const salesmateUserId = String(row.id);
    const email = clean(row.email);
    const name = clean(row.name);
    let user = await db.user.findUnique({ where: { salesmateUserId }, select: { id: true } });
    if (!user && email) {
      user = await db.user.findFirst({
        where: { deletedAt: null, salesmateUserId: null, email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
    }
    if (!user && name) {
      user = await db.user.findFirst({
        where: { deletedAt: null, salesmateUserId: null, name: { equals: name, mode: "insensitive" } },
        select: { id: true },
      });
    }
    if (!user) {
      if (name) s.unmatched.push(name);
      continue;
    }
    await db.user.update({ where: { id: user.id }, data: { salesmateUserId } });
    byUserId.set(salesmateUserId, user.id);
    s.matched++;
  }
  return byUserId;
}

async function syncCompanies(rows: SalesmateCompanyRow[], now: Date, stats: SalesmateSyncStats, ownerUserIds: Map<string, string>) {
  const s = stats.companies;
  s.fetched = rows.length;
  const existing = new Map(
    (await db.salesmateCompany.findMany({ select: { salesmateId: true } })).map((r) => [r.salesmateId, true]),
  );
  const seen = new Set<string>();

  for (const row of rows) {
    const salesmateId = String(row.id);
    seen.add(salesmateId);
    const name = clean(row.name);
    if (!name) stats.warnings.push(`Salesmate company #${salesmateId} has no name.`);
    const data = {
      name: name ?? `(unnamed Salesmate company #${salesmateId})`,
      type: clean(row.type),
      phone: clean(row.phone),
      website: clean(row.website),
      address: composeSalesmateAddress(row),
      ownerName: clean(row.owner?.name),
      ownerSalesmateUserId: row.owner?.id != null ? String(row.owner.id) : null,
      ownerUserId: row.owner?.id != null ? (ownerUserIds.get(String(row.owner.id)) ?? null) : null,
      lastCommunicationAt: fromUnixSeconds(row.lastCommunicationAt),
      lastCommunicationMode: clean(row.lastCommunicationMode),
      lastCommunicationBy: clean(row.lastCommunicationBy),
      removedAt: null,
      syncedAt: now,
    };
    await db.salesmateCompany.upsert({ where: { salesmateId }, create: { salesmateId, ...data }, update: data });
    if (existing.has(salesmateId)) s.updated++;
    else s.created++;
  }

  if (rows.length > 0) {
    const removed = await db.salesmateCompany.updateMany({
      where: { salesmateId: { notIn: [...seen] }, removedAt: null },
      data: { removedAt: now },
    });
    s.removed = removed.count;
  }

  await autoResolveCompanies(s);

  s.linked = await db.salesmateCompany.count({ where: { companyId: { not: null }, removedAt: null } });
  s.waitingReview = await db.salesmateCompany.count({ where: { companyId: null, ignoredAt: null, removedAt: null } });
}

// A suggestCompanyMatches score ABOVE this means "plausibly the same
// client" -- too close to guess either way, so it waits for an admin. Set
// from the real production queue (2026-09-19): true matches scored
// 0.60-1.17 ("Full Swing Golf" / "Full Swing", "Nicklaus Childrens Health
// System" / "Nicklaus Children Hospital Systems"); unrelated names sharing
// only generic words scored 0.25-0.50 ("Golf Max USA" / "Aguila Golf",
// "National Pickleball Center" / "National Center for Simulation", "Mate
// LLC" / "Brumate Company") -- hence strictly greater than.
export const PLAUSIBLE_MATCH_SCORE = 0.5;

// Salesmate's own company records for Expo (typed "Partner") must never
// become a client company.
const NEVER_AUTO_CREATE_TYPES = new Set(["partner"]);

// The linking rules, applied to every unlinked, un-ignored mirror row on
// every sync -- so an admin only ever sees the genuinely fuzzy cases:
//   1. Exact match (normalizeCompanyName) to exactly one ForgeOS company,
//      or to an already-linked Salesmate twin -> link. Several Salesmate
//      duplicates may link to the same company.
//   2. Otherwise, if no ForgeOS company plausibly matches
//      (PLAUSIBLE_MATCH_SCORE) and it isn't a Partner -> create a ForgeOS
//      company and link. Salesmate duplicates of one name share it.
//   3. Otherwise -> leave for review.
async function autoResolveCompanies(s: SalesmateSyncStats["companies"]) {
  const [unlinkedMirrors, linkedMirrors, companies] = await Promise.all([
    db.salesmateCompany.findMany({ where: { companyId: null, ignoredAt: null, removedAt: null }, orderBy: { salesmateId: "asc" } }),
    db.salesmateCompany.findMany({ where: { companyId: { not: null } }, select: { name: true, companyId: true } }),
    db.company.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
  ]);
  // A Salesmate duplicate follows its already-linked twin -- whether an
  // admin or an earlier sync made that first link.
  const linkedByMirrorName = new Map<string, Set<string>>();
  for (const m of linkedMirrors) {
    const key = normalizeCompanyName(m.name);
    linkedByMirrorName.set(key, (linkedByMirrorName.get(key) ?? new Set()).add(m.companyId!));
  }
  const companiesByName = new Map<string, string[]>();
  for (const c of companies) {
    const key = normalizeCompanyName(c.name);
    companiesByName.set(key, [...(companiesByName.get(key) ?? []), c.id]);
  }
  // Companies created in THIS pass, so a second Salesmate duplicate of the
  // same name links to the first one's new company instead of making another.
  const createdByName = new Map<string, string>();

  for (const mirror of unlinkedMirrors) {
    const key = normalizeCompanyName(mirror.name);
    if (!key) continue;
    const exact = companiesByName.get(key) ?? [];
    if (exact.length === 1) {
      await db.salesmateCompany.update({ where: { salesmateId: mirror.salesmateId }, data: { companyId: exact[0] } });
      s.autoLinked++;
      continue;
    }
    if (exact.length > 1) continue; // two ForgeOS companies with one name -- an admin decides
    const twin = linkedByMirrorName.get(key);
    if (twin?.size === 1) {
      await db.salesmateCompany.update({ where: { salesmateId: mirror.salesmateId }, data: { companyId: [...twin][0] } });
      s.autoLinked++;
      continue;
    }
    const createdId = createdByName.get(key);
    if (createdId) {
      await db.salesmateCompany.update({ where: { salesmateId: mirror.salesmateId }, data: { companyId: createdId } });
      s.autoLinked++;
      continue;
    }
    if (NEVER_AUTO_CREATE_TYPES.has((mirror.type ?? "").toLowerCase())) continue;
    const plausible = suggestCompanyMatches(mirror.name, companies, 1)[0];
    if (plausible && plausible.score > PLAUSIBLE_MATCH_SCORE) continue;

    const company = await db.company.create({ data: { name: mirror.name, billingAddress: mirror.address } });
    await db.salesmateCompany.update({ where: { salesmateId: mirror.salesmateId }, data: { companyId: company.id } });
    companies.push({ id: company.id, name: company.name });
    createdByName.set(key, company.id);
    s.autoCreated++;
  }
}

async function syncContacts(rows: SalesmateContactRow[], now: Date, stats: SalesmateSyncStats) {
  const s = stats.contacts;
  s.fetched = rows.length;
  const companyIdBySalesmateId = new Map(
    (await db.salesmateCompany.findMany({ where: { companyId: { not: null } }, select: { salesmateId: true, companyId: true } })).map(
      (m) => [m.salesmateId, m.companyId!],
    ),
  );

  for (const row of rows) {
    const salesmateId = String(row.id);
    const salesmateCompanyId = row.company?.id != null ? String(row.company.id) : null;
    const companyId = salesmateCompanyId ? companyIdBySalesmateId.get(salesmateCompanyId) : undefined;
    if (!companyId) {
      s.waitingOnCompany++;
      continue;
    }
    const name = clean(row.name) ?? clean(row.email);
    if (!name) {
      s.skipped++;
      stats.warnings.push(`Salesmate contact #${salesmateId} has neither a name nor an email -- skipped.`);
      continue;
    }
    const email = clean(row.email);
    const phone = clean(row.phone);
    const title = clean(row.designation);
    const mobile = clean(row.mobile);
    const salesmateOwned = {
      lastContactedAt: fromUnixSeconds(row.lastCommunicationAt),
      lastContactedMode: clean(row.lastCommunicationMode),
      lastContactedBy: clean(row.lastCommunicationBy),
      salesmateSyncedAt: now,
    };

    let existing = await db.contact.findUnique({ where: { salesmateId } });
    let adopted = false;
    if (!existing) {
      // Adopt a hand-entered contact at the same company rather than
      // duplicating it -- email first (most reliable), then exact name.
      existing =
        (email &&
          (await db.contact.findFirst({
            where: { companyId, salesmateId: null, deletedAt: null, email: { equals: email, mode: "insensitive" } },
          }))) ||
        (await db.contact.findFirst({
          where: { companyId, salesmateId: null, deletedAt: null, name: { equals: name, mode: "insensitive" } },
        }));
      adopted = Boolean(existing);
    }

    if (existing) {
      // Fill-if-empty for anything a person might have edited in ForgeOS.
      await db.contact.update({
        where: { id: existing.id },
        data: {
          salesmateId,
          companyId,
          email: existing.email ?? email,
          phone: existing.phone ?? phone,
          title: existing.title ?? title,
          mobile: existing.mobile ?? mobile,
          // deletedAt deliberately untouched: a contact someone removed in
          // ForgeOS stays removed -- the sync keeps its Salesmate fields
          // current but doesn't bring it back.
          ...salesmateOwned,
        },
      });
      if (adopted) s.adopted++;
      else s.updated++;
    } else {
      await db.contact.create({
        data: { salesmateId, companyId, name, email, phone, title, mobile, role: "CLIENT_CONTACT", ...salesmateOwned },
      });
      s.created++;
    }
  }
}

async function syncDeals(rows: SalesmateDealRow[], now: Date, stats: SalesmateSyncStats, ownerUserIds: Map<string, string>) {
  const s = stats.deals;
  s.fetched = rows.length;
  const [links, contacts, existingIds] = await Promise.all([
    db.salesmateCompany.findMany({ where: { companyId: { not: null } }, select: { salesmateId: true, companyId: true } }),
    db.contact.findMany({ where: { salesmateId: { not: null } }, select: { id: true, salesmateId: true } }),
    db.salesmateDeal.findMany({
      select: { salesmateId: true, stage: true, status: true, stageSince: true, previousStage: true, statusChangedAt: true },
    }),
  ]);
  const previousById = new Map(existingIds.map((d) => [d.salesmateId, d]));
  const companyIdBySalesmateId = new Map(links.map((l) => [l.salesmateId, l.companyId!]));
  const contactIdBySalesmateId = new Map(contacts.map((c) => [c.salesmateId!, c.id]));
  const existing = new Set(existingIds.map((d) => d.salesmateId));
  const seen = new Set<string>();

  for (const row of rows) {
    const salesmateId = String(row.id);
    seen.add(salesmateId);
    const salesmateCompanyId = row.primaryCompany?.id != null ? String(row.primaryCompany.id) : null;
    const companyId = salesmateCompanyId ? (companyIdBySalesmateId.get(salesmateCompanyId) ?? null) : null;
    if (companyId) s.onLinkedCompanies++;
    const value = row.dealValue == null || row.dealValue === "" ? null : Number(row.dealValue);
    // opportunityId is deliberately absent: a hand-made link must survive.
    const data = {
      salesmateCompanyId,
      companyId,
      contactId: row.primaryContact?.id != null ? (contactIdBySalesmateId.get(String(row.primaryContact.id)) ?? null) : null,
      title: clean(row.title) ?? `(untitled Salesmate deal #${salesmateId})`,
      status: clean(row.status) ?? "Unknown",
      pipeline: clean(row.pipeline),
      stage: clean(row.stage),
      value: value != null && Number.isFinite(value) ? value : null,
      ownerName: clean(row.owner?.name),
      ownerSalesmateUserId: row.owner?.id != null ? String(row.owner.id) : null,
      ownerUserId: row.owner?.id != null ? (ownerUserIds.get(String(row.owner.id)) ?? null) : null,
      salesmateCreatedAt: fromUnixSeconds(row.createdAt),
      closedAt: fromUnixSeconds(row.closedDate),
      estimatedCloseAt: fromIsoDate(row.estimatedCloseDate),
      lastCommunicationAt: fromUnixSeconds(row.lastCommunicationAt),
      removedAt: null,
      syncedAt: now,
    };
    // Stage/status movement: only a change resets the clock, so "days in
    // stage" survives syncs that change nothing else.
    //
    // The `?? now` matters. A deal that was already mirrored before these
    // columns existed has a null stageSince, and its stage doesn't change
    // on the next sync -- so without the fallback it copies null forward
    // forever and the clock never starts. That's not hypothetical: 359 of
    // 363 production deals were stuck that way, and only the 4 that
    // happened to move stage had a value. Starting the clock at the first
    // sync that sees the deal in this stage is exactly what the schema
    // promises.
    const before = previousById.get(salesmateId);
    const movement = {
      stageSince: before && before.stage === data.stage ? (before.stageSince ?? now) : now,
      previousStage: before && before.stage !== data.stage ? before.stage : (before?.previousStage ?? null),
      statusChangedAt: before && before.status === data.status ? (before.statusChangedAt ?? now) : now,
    };
    await db.salesmateDeal.upsert({
      where: { salesmateId },
      create: { salesmateId, ...data, ...movement },
      update: { ...data, ...movement },
    });
    if (existing.has(salesmateId)) s.updated++;
    else s.created++;
  }

  if (rows.length > 0) {
    const removed = await db.salesmateDeal.updateMany({
      where: { salesmateId: { notIn: [...seen] }, removedAt: null },
      data: { removedAt: now },
    });
    s.removed = removed.count;
  }
}

// Scheduled calls/meetings/tasks. Salesmate links most activities to a
// contact rather than a company (360 vs 9 of 892 on the real account), so
// the company is resolved through the contact wherever it's missing.
async function syncActivities(rows: SalesmateActivityRow[], now: Date, stats: SalesmateSyncStats, ownerUserIds: Map<string, string>) {
  const s = stats.activities;
  s.fetched = rows.length;
  const [contacts, mirrors, existingIds] = await Promise.all([
    db.contact.findMany({ where: { salesmateId: { not: null } }, select: { id: true, salesmateId: true, companyId: true } }),
    db.salesmateCompany.findMany({ where: { companyId: { not: null } }, select: { salesmateId: true, companyId: true } }),
    db.salesmateActivity.findMany({ select: { salesmateId: true } }),
  ]);
  const contactBySalesmateId = new Map(contacts.map((c) => [c.salesmateId!, c]));
  const companyBySalesmateId = new Map(mirrors.map((m) => [m.salesmateId, m.companyId!]));
  const existing = new Set(existingIds.map((a) => a.salesmateId));
  const seen = new Set<string>();

  for (const row of rows) {
    const salesmateId = String(row.id);
    seen.add(salesmateId);
    const salesmateContactId = row.contact?.id != null ? String(row.contact.id) : null;
    const contact = salesmateContactId ? contactBySalesmateId.get(salesmateContactId) : undefined;
    const salesmateCompanyId = row.company?.id != null ? String(row.company.id) : null;
    const companyId =
      (salesmateCompanyId ? companyBySalesmateId.get(salesmateCompanyId) : undefined) ?? contact?.companyId ?? null;
    if (companyId) s.onClients++;

    const data = {
      type: clean(row.type) ?? "Activity",
      title: clean(row.title) ?? "(untitled activity)",
      description: clean(row.description),
      dueAt: fromUnixSeconds(row.dueDate),
      isCompleted: row.isCompleted === 1 || row.isCompleted === true,
      durationMinutes: typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : null,
      salesmateContactId,
      contactId: contact?.id ?? null,
      salesmateCompanyId,
      companyId,
      salesmateDealId: row.deal?.id != null ? String(row.deal.id) : null,
      ownerSalesmateUserId: row.owner?.id != null ? String(row.owner.id) : null,
      ownerUserId: row.owner?.id != null ? (ownerUserIds.get(String(row.owner.id)) ?? null) : null,
      salesmateCreatedAt: fromUnixSeconds(row.createdAt),
      removedAt: null,
      syncedAt: now,
    };
    await db.salesmateActivity.upsert({ where: { salesmateId }, create: { salesmateId, ...data }, update: data });
    if (existing.has(salesmateId)) s.updated++;
    else s.created++;
  }

  if (rows.length > 0) {
    const removed = await db.salesmateActivity.updateMany({
      where: { salesmateId: { notIn: [...seen] }, removedAt: null },
      data: { removedAt: now },
    });
    s.removed = removed.count;
  }
}

// Turns Salesmate's single "last communication" timestamp into history:
// every time that timestamp moves forward for a contact (or for a company
// that has none of its own contacts credited), that's one real touch,
// recorded once. Runs after contacts/companies are up to date, and is
// idempotent -- the unique key is (company, contact, moment), so a re-run
// of the same sync records nothing new.
async function recordTouches(stats: SalesmateSyncStats) {
  const s = stats.touches;
  const [contacts, mirrors, users] = await Promise.all([
    db.contact.findMany({
      where: { deletedAt: null, salesmateId: { not: null }, lastContactedAt: { not: null }, companyId: { not: null } },
      select: { id: true, companyId: true, lastContactedAt: true, lastContactedMode: true, lastContactedBy: true },
    }),
    db.salesmateCompany.findMany({
      where: { removedAt: null, companyId: { not: null }, lastCommunicationAt: { not: null } },
      select: { companyId: true, lastCommunicationAt: true, lastCommunicationMode: true, lastCommunicationBy: true },
    }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
  ]);
  const userIdByName = new Map(users.map((u) => [u.name.toLowerCase(), u.id]));
  const byUser = (name: string | null) => (name ? (userIdByName.get(name.toLowerCase()) ?? null) : null);

  for (const c of contacts) {
    const created = await db.clientTouch.createMany({
      data: [{
        companyId: c.companyId!,
        contactId: c.id,
        occurredAt: c.lastContactedAt!,
        mode: c.lastContactedMode,
        byName: c.lastContactedBy,
        byUserId: byUser(c.lastContactedBy),
      }],
      skipDuplicates: true,
    });
    s.recorded += created.count;
  }

  // Company-level rows cover communication Salesmate credits to the
  // company rather than to a specific contact. These can't rely on the
  // unique key + skipDuplicates: Postgres treats NULLs as distinct, so a
  // (company, NULL contact, moment) row never collides with itself and
  // would be re-inserted on every sync. Check first instead.
  for (const m of mirrors) {
    // Salesmate's company timestamp is usually the same email as its most
    // recent contact's -- recording both would show the client being
    // contacted twice. Any touch at that exact moment, contact-level or
    // not, means it's already accounted for.
    const already = await db.clientTouch.findFirst({
      where: { companyId: m.companyId!, occurredAt: m.lastCommunicationAt! },
      select: { id: true },
    });
    if (already) continue;
    await db.clientTouch.create({
      data: {
        companyId: m.companyId!,
        contactId: null,
        occurredAt: m.lastCommunicationAt!,
        mode: m.lastCommunicationMode,
        byName: m.lastCommunicationBy,
        byUserId: byUser(m.lastCommunicationBy),
      },
    });
    s.recorded++;
  }
}

function emptyStats(): SalesmateSyncStats {
  return {
    users: { fetched: 0, matched: 0, unmatched: [] },
    companies: { fetched: 0, created: 0, updated: 0, removed: 0, autoLinked: 0, autoCreated: 0, linked: 0, waitingReview: 0 },
    contacts: { fetched: 0, created: 0, updated: 0, adopted: 0, waitingOnCompany: 0, skipped: 0 },
    deals: { fetched: 0, created: 0, updated: 0, removed: 0, onLinkedCompanies: 0 },
    activities: { fetched: 0, created: 0, updated: 0, removed: 0, onClients: 0 },
    touches: { recorded: 0 },
    warnings: [],
  };
}

// The entry point for the cron route, the admin "Sync now" button, and the
// CLI script. Every attempt leaves a SalesmateSyncRun row -- success with
// its stats, or failure with the error -- so "is it working?" always has
// an answer on /admin/integrations/salesmate.
export async function runSalesmateSync(options: {
  trigger: SalesmateSyncTrigger;
  triggeredByUserId?: string | null;
  fetcher?: SalesmateFetcher;
}) {
  const fetcher = options.fetcher ?? salesmateApi;
  const run = await db.salesmateSyncRun.create({
    data: { trigger: options.trigger, triggeredByUserId: options.triggeredByUserId ?? null },
  });
  const stats = emptyStats();
  const now = new Date();
  try {
    // Fetch everything before writing anything, so a Salesmate error
    // part-way through doesn't leave a half-applied sync.
    const [users, companies, contacts, deals, activities] = await Promise.all([
      fetcher.users(),
      fetcher.companies(),
      fetcher.contacts(),
      fetcher.deals(),
      fetcher.activities(),
    ]);
    const ownerUserIds = await syncUsers(users, stats);
    await syncCompanies(companies, now, stats, ownerUserIds);
    await syncContacts(contacts, now, stats);
    await syncDeals(deals, now, stats, ownerUserIds);
    await syncActivities(activities, now, stats, ownerUserIds);
    await recordTouches(stats);
    return await db.salesmateSyncRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", stats: stats as unknown as Prisma.InputJsonValue, finishedAt: new Date() },
    });
  } catch (err) {
    return await db.salesmateSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: err instanceof Error ? err.message : String(err),
        stats: stats as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Company-link review (/admin/integrations/salesmate)
// ---------------------------------------------------------------------------

// Ranked ForgeOS companies that might be the same client as a Salesmate
// company -- shared significant words, plus one name containing the
// other ("Arena" inside "Arena Event Services Inc."). Suggestions only;
// an admin confirms every link.
export function suggestCompanyMatches(
  salesmateName: string,
  companies: { id: string; name: string }[],
  limit = 3,
): { id: string; name: string; score: number }[] {
  const target = new Set(significantTokens(salesmateName));
  const targetNorm = normalizeCompanyName(salesmateName);
  return companies
    .map((c) => {
      const tokens = new Set(significantTokens(c.name));
      const shared = [...tokens].filter((t) => target.has(t)).length;
      const union = new Set([...tokens, ...target]).size || 1;
      const norm = normalizeCompanyName(c.name);
      const contains = targetNorm.length >= 4 && norm.length >= 4 && (norm.includes(targetNorm) || targetNorm.includes(norm));
      return { id: c.id, name: c.name, score: shared / union + (contains ? 0.5 : 0) };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Linking reattaches that company's already-mirrored deals right away;
// its contacts arrive on the next sync (they aren't mirrored separately).
export async function linkSalesmateCompany(salesmateId: string, companyId: string) {
  const [mirror, company] = await Promise.all([
    db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId } }),
    db.company.findFirst({ where: { id: companyId, deletedAt: null } }),
  ]);
  if (!company) throw new UserError("That ForgeOS company no longer exists.");
  // Linking to a company that already has a Salesmate record is allowed on
  // purpose -- it's how a Salesmate duplicate gets folded in.
  await db.$transaction([
    db.salesmateCompany.update({ where: { salesmateId }, data: { companyId, ignoredAt: null } }),
    db.salesmateDeal.updateMany({ where: { salesmateCompanyId: mirror.salesmateId }, data: { companyId } }),
  ]);
}

export async function createCompanyFromSalesmate(salesmateId: string) {
  const mirror = await db.salesmateCompany.findUniqueOrThrow({ where: { salesmateId } });
  if (mirror.companyId) throw new UserError(`"${mirror.name}" is already linked to a ForgeOS company.`);
  const company = await db.company.create({ data: { name: mirror.name, billingAddress: mirror.address } });
  await linkSalesmateCompany(salesmateId, company.id);
  return company;
}

export async function ignoreSalesmateCompany(salesmateId: string) {
  await db.salesmateCompany.update({ where: { salesmateId }, data: { ignoredAt: new Date() } });
}

export async function unlinkSalesmateCompany(salesmateId: string) {
  await db.$transaction([
    db.salesmateCompany.update({ where: { salesmateId }, data: { companyId: null } }),
    db.salesmateDeal.updateMany({ where: { salesmateCompanyId: salesmateId }, data: { companyId: null } }),
  ]);
}
