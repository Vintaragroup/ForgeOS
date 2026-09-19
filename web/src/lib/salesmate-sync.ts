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
} from "@/lib/salesmate-client";

export interface SalesmateSyncStats {
  companies: { fetched: number; created: number; updated: number; removed: number; autoLinked: number; linked: number; waitingReview: number };
  contacts: { fetched: number; created: number; updated: number; adopted: number; waitingOnCompany: number; skipped: number };
  deals: { fetched: number; created: number; updated: number; removed: number; onLinkedCompanies: number };
  warnings: string[];
}

// Case/punctuation-insensitive: "Club Glove, Inc." === "club glove inc".
// Deliberately NOT stripping Inc/LLC here -- that's a fuzzy decision, and
// fuzzy decisions are the admin's (see suggestCompanyMatches).
export function normalizeCompanyName(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
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

async function syncCompanies(rows: SalesmateCompanyRow[], now: Date, stats: SalesmateSyncStats) {
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

  // Exact-name auto-link, only when unambiguous on both sides.
  const [unlinkedMirrors, companies] = await Promise.all([
    db.salesmateCompany.findMany({ where: { companyId: null, ignoredAt: null, removedAt: null } }),
    db.company.findMany({ where: { deletedAt: null, salesmateCompany: null }, select: { id: true, name: true } }),
  ]);
  const companiesByName = new Map<string, string[]>();
  for (const c of companies) {
    const key = normalizeCompanyName(c.name);
    companiesByName.set(key, [...(companiesByName.get(key) ?? []), c.id]);
  }
  const mirrorsByName = new Map<string, number>();
  for (const m of unlinkedMirrors) {
    const key = normalizeCompanyName(m.name);
    mirrorsByName.set(key, (mirrorsByName.get(key) ?? 0) + 1);
  }
  for (const mirror of unlinkedMirrors) {
    const key = normalizeCompanyName(mirror.name);
    const candidates = companiesByName.get(key) ?? [];
    if (key && candidates.length === 1 && mirrorsByName.get(key) === 1) {
      await db.salesmateCompany.update({ where: { salesmateId: mirror.salesmateId }, data: { companyId: candidates[0] } });
      s.autoLinked++;
    }
  }

  s.linked = await db.salesmateCompany.count({ where: { companyId: { not: null }, removedAt: null } });
  s.waitingReview = await db.salesmateCompany.count({ where: { companyId: null, ignoredAt: null, removedAt: null } });
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

async function syncDeals(rows: SalesmateDealRow[], now: Date, stats: SalesmateSyncStats) {
  const s = stats.deals;
  s.fetched = rows.length;
  const [links, contacts, existingIds] = await Promise.all([
    db.salesmateCompany.findMany({ where: { companyId: { not: null } }, select: { salesmateId: true, companyId: true } }),
    db.contact.findMany({ where: { salesmateId: { not: null } }, select: { id: true, salesmateId: true } }),
    db.salesmateDeal.findMany({ select: { salesmateId: true } }),
  ]);
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
      salesmateCreatedAt: fromUnixSeconds(row.createdAt),
      closedAt: fromUnixSeconds(row.closedDate),
      estimatedCloseAt: fromIsoDate(row.estimatedCloseDate),
      lastCommunicationAt: fromUnixSeconds(row.lastCommunicationAt),
      removedAt: null,
      syncedAt: now,
    };
    await db.salesmateDeal.upsert({ where: { salesmateId }, create: { salesmateId, ...data }, update: data });
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

function emptyStats(): SalesmateSyncStats {
  return {
    companies: { fetched: 0, created: 0, updated: 0, removed: 0, autoLinked: 0, linked: 0, waitingReview: 0 },
    contacts: { fetched: 0, created: 0, updated: 0, adopted: 0, waitingOnCompany: 0, skipped: 0 },
    deals: { fetched: 0, created: 0, updated: 0, removed: 0, onLinkedCompanies: 0 },
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
    const [companies, contacts, deals] = await Promise.all([fetcher.companies(), fetcher.contacts(), fetcher.deals()]);
    await syncCompanies(companies, now, stats);
    await syncContacts(contacts, now, stats);
    await syncDeals(deals, now, stats);
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
    db.company.findFirst({ where: { id: companyId, deletedAt: null }, include: { salesmateCompany: true } }),
  ]);
  if (!company) throw new UserError("That ForgeOS company no longer exists.");
  if (company.salesmateCompany && company.salesmateCompany.salesmateId !== salesmateId) {
    throw new UserError(`${company.name} is already linked to Salesmate company "${company.salesmateCompany.name}".`);
  }
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
