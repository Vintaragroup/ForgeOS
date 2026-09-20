// The numbers behind /sales: one rep's book of business, or the whole
// team's. Everything here reads the Salesmate mirror (salesmate-sync.ts)
// plus ForgeOS's own estimates/proposals -- Salesmate is where the money
// history actually lives (363 deals, real values), while ForgeOS's native
// pipeline is only just filling up, so a tile that depends on ForgeOS
// proposals says "0" honestly rather than being hidden.
//
// Attribution is by SalesmateDeal.ownerUserId / SalesmateCompany
// .ownerUserId (real FKs since the user mapping landed). Deals owned by
// someone who is no longer an active Salesmate user keep ownerName with no
// user -- those are reported under FORMER_REP_OWNER rather than silently
// dropped from team totals.

import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { showMonthEnd } from "@/lib/company-aging";
import { daysSince } from "@/lib/contact-aging";

export const FORMER_REP_OWNER = "__former__";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SalesScope {
  // null = the whole team (managers/admins only).
  ownerUserId: string | null;
}

export interface SalesKpis {
  wonValueYtd: number;
  wonValue12mo: number;
  wonCount12mo: number;
  openValue: number;
  openCount: number;
  activeClients: number;
  avgWonDealValue: number;
  // Won / (won + lost), over the last 12 months, by count and by value.
  winRateCount: number | null;
  winRateValue: number | null;
}

export interface ClientRow {
  companyId: string;
  name: string;
  salesmateType: string | null;
  lifetimeWonValue: number;
  wonValue12mo: number;
  wonCount: number;
  openValue: number;
  openCount: number;
  lastContactedAt: Date | null;
  lastWorkedWithAt: Date | null;
  proposalsSent: number;
  proposalsSigned: number;
}

export interface StaleDeal {
  salesmateId: string;
  title: string;
  value: number;
  stage: string | null;
  // Days in the current stage, counted from the first sync that saw it
  // there (Salesmate exposes no deal history) -- null until that's known.
  daysInStage: number | null;
  companyId: string | null;
  companyName: string | null;
  lastTouchAt: Date | null;
  daysQuiet: number;
}

export interface ScheduledActivity {
  salesmateId: string;
  type: string;
  title: string;
  dueAt: Date | null;
  companyId: string | null;
  companyName: string | null;
  daysOverdue: number | null;
}

export interface SalesOverview {
  kpis: SalesKpis;
  clients: ClientRow[];
  // Clients worth chasing first: value * how long they've been quiet.
  // Only clients with real history (won or open money) -- a prospect who
  // was never a client isn't "going cold", and would crowd out the ones
  // that matter.
  goingCold: ClientRow[];
  // Quiet prospects with no won/open value, counted rather than listed.
  quietProspects: number;
  // Clients who bought before but not in the last year, with nothing open
  // -- the "win them back" list. Ordered by what they used to be worth.
  lapsed: (ClientRow & { lastWonAt: Date | null })[];
  staleOpenDeals: StaleDeal[];
  pipelineByStage: { stage: string; count: number; value: number }[];
  forgeos: { openEstimates: number; proposalsSent: number; proposalsSigned: number };
  // Scheduled work from Salesmate. Past-due ones are shown as "did this
  // happen?" rather than "missed": on the real account reps almost never
  // tick an activity complete (1 of 892), so the flag can't be trusted.
  scheduled: { upcoming: ScheduledActivity[]; pastDue: ScheduledActivity[]; upcomingCount: number; pastDueCount: number };
  // Contact history accumulated since the sync started recording it.
  touchHistory: { last30Days: number; last90Days: number; since: Date | null };
}

export interface LeaderboardRow {
  userId: string | null;
  name: string;
  isFormer: boolean;
  wonValue12mo: number;
  wonCount12mo: number;
  openValue: number;
  clients: number;
  winRateCount: number | null;
  medianDaysSinceContact: number | null;
  coldClients: number;
}

function num(value: Prisma.Decimal | null): number {
  return value == null ? 0 : Number(value.toString());
}

// When a won deal actually landed: Salesmate's own closed date, else the
// show month its pipeline stages it under (see company-aging.ts).
export function dealWonAt(deal: { closedAt: Date | null; pipeline: string | null; stage: string | null }): Date | null {
  return deal.closedAt ?? showMonthEnd(deal.pipeline, deal.stage);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// A client is "going cold" past this many days with no contact -- same
// threshold as the dashboard's Going Cold card.
export const COLD_DAYS = 90;
// An open deal nobody has touched in this long needs a nudge.
const STALE_OPEN_DEAL_DAYS = 30;

interface DealRow {
  salesmateId: string;
  title: string;
  status: string;
  stage: string | null;
  pipeline: string | null;
  value: Prisma.Decimal | null;
  companyId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  closedAt: Date | null;
  lastCommunicationAt: Date | null;
  salesmateCreatedAt: Date | null;
  stageSince: Date | null;
}

async function loadDeals(ownerUserId: string | null): Promise<DealRow[]> {
  return db.salesmateDeal.findMany({
    where: { removedAt: null, ...(ownerUserId ? { ownerUserId } : {}) },
    select: {
      salesmateId: true, title: true, status: true, stage: true, pipeline: true, value: true,
      companyId: true, ownerUserId: true, ownerName: true, closedAt: true, lastCommunicationAt: true, salesmateCreatedAt: true, stageSince: true,
    },
  });
}

export async function loadSalesOverview(scope: SalesScope, now: Date = new Date()): Promise<SalesOverview> {
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const twelveMonthsAgo = new Date(now.getTime() - 365 * DAY_MS);

  const deals = await loadDeals(scope.ownerUserId);
  const companyIds = [...new Set(deals.map((d) => d.companyId).filter((id): id is string => Boolean(id)))];

  // A rep's clients = companies they own in Salesmate, plus any company
  // they have a deal on (an owner change shouldn't erase their history).
  const ownedMirrors = await db.salesmateCompany.findMany({
    where: { removedAt: null, companyId: { not: null }, ...(scope.ownerUserId ? { ownerUserId: scope.ownerUserId } : {}) },
    select: { companyId: true, type: true, lastCommunicationAt: true },
  });
  const allCompanyIds = [...new Set([...companyIds, ...ownedMirrors.map((m) => m.companyId!)])];

  const [companies, contacts, opportunities, proposals, estimates] = await Promise.all([
    db.company.findMany({ where: { id: { in: allCompanyIds }, deletedAt: null }, select: { id: true, name: true } }),
    db.contact.findMany({
      where: { companyId: { in: allCompanyIds }, deletedAt: null, lastContactedAt: { not: null } },
      select: { companyId: true, lastContactedAt: true },
    }),
    db.opportunity.findMany({
      where: { companyId: { in: allCompanyIds }, deletedAt: null, stage: "WON" },
      select: { companyId: true, eventStartDate: true, eventEndDate: true, show: { select: { eventStartDate: true, eventEndDate: true } } },
    }),
    db.proposal.findMany({
      where: { estimateVersion: { estimate: { opportunity: { companyId: { in: allCompanyIds } } } } },
      select: { sentAt: true, signedAt: true, estimateVersion: { select: { estimate: { select: { opportunity: { select: { companyId: true } } } } } } },
    }),
    db.estimate.count({
      where: { deletedAt: null, opportunity: { companyId: { in: allCompanyIds }, deletedAt: null, stage: { notIn: ["WON", "LOST"] } } },
    }),
  ]);

  const typeByCompany = new Map(ownedMirrors.map((m) => [m.companyId!, m.type]));
  const contactedByCompany = new Map<string, Date>();
  for (const m of ownedMirrors) {
    if (m.lastCommunicationAt) contactedByCompany.set(m.companyId!, m.lastCommunicationAt);
  }
  for (const c of contacts) {
    if (!c.companyId || !c.lastContactedAt) continue;
    const current = contactedByCompany.get(c.companyId);
    if (!current || c.lastContactedAt > current) contactedByCompany.set(c.companyId, c.lastContactedAt);
  }
  const workedByCompany = new Map<string, Date>();
  const noteWorked = (companyId: string | null, at: Date | null) => {
    if (!companyId || !at) return;
    const current = workedByCompany.get(companyId);
    if (!current || at > current) workedByCompany.set(companyId, at);
  };
  for (const o of opportunities) {
    noteWorked(o.companyId, o.eventEndDate ?? o.eventStartDate ?? o.show?.eventEndDate ?? o.show?.eventStartDate ?? null);
  }

  const rows = new Map<string, ClientRow>();
  const row = (companyId: string, name: string) => {
    let r = rows.get(companyId);
    if (!r) {
      r = {
        companyId, name,
        salesmateType: typeByCompany.get(companyId) ?? null,
        lifetimeWonValue: 0, wonValue12mo: 0, wonCount: 0, openValue: 0, openCount: 0,
        lastContactedAt: contactedByCompany.get(companyId) ?? null,
        lastWorkedWithAt: null,
        proposalsSent: 0, proposalsSigned: 0,
      };
      rows.set(companyId, r);
    }
    return r;
  };
  const nameById = new Map(companies.map((c) => [c.id, c.name]));
  for (const id of allCompanyIds) {
    const name = nameById.get(id);
    if (name) row(id, name);
  }

  const kpis: SalesKpis = {
    wonValueYtd: 0, wonValue12mo: 0, wonCount12mo: 0, openValue: 0, openCount: 0,
    activeClients: 0, avgWonDealValue: 0, winRateCount: null, winRateValue: null,
  };
  let wonCountAll = 0;
  let wonValueAll = 0;
  let won12 = 0, lost12 = 0, wonValue12 = 0, lostValue12 = 0;
  const staleOpenDeals: StaleDeal[] = [];
  const lastWonByCompany = new Map<string, Date>();
  const stageTotals = new Map<string, { count: number; value: number }>();

  for (const deal of deals) {
    const value = num(deal.value);
    const client = deal.companyId ? rows.get(deal.companyId) : undefined;
    if (deal.status === "Won") {
      const wonAt = dealWonAt(deal);
      wonCountAll++;
      wonValueAll += value;
      if (client) {
        client.lifetimeWonValue += value;
        client.wonCount++;
        noteWorked(deal.companyId, wonAt);
        if (wonAt && (!lastWonByCompany.has(client.companyId) || wonAt > lastWonByCompany.get(client.companyId)!)) {
          lastWonByCompany.set(client.companyId, wonAt);
        }
      }
      if (wonAt && wonAt >= yearStart) kpis.wonValueYtd += value;
      if (wonAt && wonAt >= twelveMonthsAgo) {
        kpis.wonValue12mo += value;
        kpis.wonCount12mo++;
        won12++;
        wonValue12 += value;
        if (client) client.wonValue12mo += value;
      }
    } else if (deal.status === "Lost") {
      const lostAt = dealWonAt(deal);
      if (lostAt && lostAt >= twelveMonthsAgo) {
        lost12++;
        lostValue12 += value;
      }
    } else {
      kpis.openValue += value;
      kpis.openCount++;
      if (client) {
        client.openValue += value;
        client.openCount++;
      }
      const stage = deal.stage ?? "(no stage)";
      const totals = stageTotals.get(stage) ?? { count: 0, value: 0 };
      stageTotals.set(stage, { count: totals.count + 1, value: totals.value + value });

      const lastTouch = deal.lastCommunicationAt ?? deal.salesmateCreatedAt;
      const quiet = lastTouch ? daysSince(lastTouch, now) : Infinity;
      if (quiet >= STALE_OPEN_DEAL_DAYS) {
        staleOpenDeals.push({
          salesmateId: deal.salesmateId, title: deal.title, value, stage: deal.stage,
          daysInStage: deal.stageSince ? daysSince(deal.stageSince, now) : null,
          companyId: deal.companyId, companyName: deal.companyId ? (nameById.get(deal.companyId) ?? null) : null,
          lastTouchAt: lastTouch ?? null,
          daysQuiet: lastTouch ? quiet : -1,
        });
      }
    }
  }

  for (const p of proposals) {
    const companyId = p.estimateVersion.estimate.opportunity.companyId;
    const client = rows.get(companyId);
    if (!client) continue;
    if (p.sentAt) client.proposalsSent++;
    if (p.signedAt) client.proposalsSigned++;
  }
  for (const [companyId, at] of workedByCompany) {
    const client = rows.get(companyId);
    if (client) client.lastWorkedWithAt = at;
  }

  kpis.avgWonDealValue = wonCountAll ? Math.round(wonValueAll / wonCountAll) : 0;
  kpis.winRateCount = won12 + lost12 > 0 ? won12 / (won12 + lost12) : null;
  kpis.winRateValue = wonValue12 + lostValue12 > 0 ? wonValue12 / (wonValue12 + lostValue12) : null;

  const clients = [...rows.values()].sort((a, b) => b.lifetimeWonValue - a.lifetimeWonValue || a.name.localeCompare(b.name));
  kpis.activeClients = clients.filter((c) => c.wonCount > 0 || c.openCount > 0).length;

  // Worth chasing = how much they're worth × how long they've been quiet.
  // A $200k client silent for 100 days outranks a $2k one silent for a year.
  // Bought before, nothing won in the last 12 months, nothing open now.
  const lapsed = clients
    .filter((c) => c.wonCount > 0 && c.openCount === 0)
    .map((c) => ({ ...c, lastWonAt: lastWonByCompany.get(c.companyId) ?? null }))
    .filter((c) => !c.lastWonAt || c.lastWonAt < twelveMonthsAgo)
    .sort((a, b) => b.lifetimeWonValue - a.lifetimeWonValue);

  const quiet = clients.filter((c) => !c.lastContactedAt || daysSince(c.lastContactedAt, now) >= COLD_DAYS);
  const goingCold = quiet
    .filter((c) => c.lifetimeWonValue > 0 || c.openValue > 0)
    .map((c) => ({ client: c, days: c.lastContactedAt ? daysSince(c.lastContactedAt, now) : 999 }))
    .sort((a, b) => b.client.lifetimeWonValue * b.days - a.client.lifetimeWonValue * a.days)
    .map((x) => x.client);
  const quietProspects = quiet.length - goingCold.length;

  const [activityRows, touchAgg, firstTouch] = await Promise.all([
    db.salesmateActivity.findMany({
      where: { removedAt: null, isCompleted: false, ...(scope.ownerUserId ? { ownerUserId: scope.ownerUserId } : {}) },
      select: { salesmateId: true, type: true, title: true, dueAt: true, companyId: true },
      orderBy: { dueAt: "asc" },
    }),
    db.clientTouch.findMany({
      where: {
        occurredAt: { gte: new Date(now.getTime() - 90 * DAY_MS) },
        ...(scope.ownerUserId ? { byUserId: scope.ownerUserId } : {}),
      },
      select: { occurredAt: true },
    }),
    db.clientTouch.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const activityNames = new Map(nameById);
  const toScheduled = (a: (typeof activityRows)[number]): ScheduledActivity => ({
    salesmateId: a.salesmateId,
    type: a.type,
    title: a.title,
    dueAt: a.dueAt,
    companyId: a.companyId,
    companyName: a.companyId ? (activityNames.get(a.companyId) ?? null) : null,
    daysOverdue: a.dueAt && a.dueAt < now ? daysSince(a.dueAt, now) : null,
  });
  const scheduledAll = activityRows.map(toScheduled);
  // Activities attached to a client come first in both lists: an activity
  // with no client link ("Weekly Update", "Tim at SIBOS") is someone's own
  // reminder, not client follow-up, and would otherwise crowd these out.
  const clientFirst = (a: ScheduledActivity, b: ScheduledActivity) => Number(Boolean(b.companyId)) - Number(Boolean(a.companyId));
  const pastDue = scheduledAll.filter((a) => a.daysOverdue != null).reverse().sort(clientFirst);
  const upcoming = scheduledAll.filter((a) => a.daysOverdue == null).sort(clientFirst);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

  return {
    kpis,
    clients,
    goingCold,
    quietProspects,
    lapsed: lapsed.slice(0, 8),
    staleOpenDeals: staleOpenDeals.sort((a, b) => b.value - a.value).slice(0, 10),
    pipelineByStage: [...stageTotals.entries()]
      .map(([stage, t]) => ({ stage, ...t }))
      .sort((a, b) => b.value - a.value),
    scheduled: {
      upcoming: upcoming.slice(0, 8),
      pastDue: pastDue.slice(0, 8),
      upcomingCount: upcoming.length,
      pastDueCount: pastDue.length,
    },
    touchHistory: {
      last30Days: touchAgg.filter((t) => t.occurredAt >= thirtyDaysAgo).length,
      last90Days: touchAgg.length,
      since: firstTouch?.createdAt ?? null,
    },
    forgeos: {
      openEstimates: estimates,
      proposalsSent: proposals.filter((p) => p.sentAt).length,
      proposalsSigned: proposals.filter((p) => p.signedAt).length,
    },
  };
}

// One row per rep with any deal, plus a "former reps" row for deals whose
// Salesmate owner is no longer active (they'd otherwise vanish from team
// totals, and their clients still need covering).
export async function loadLeaderboard(now: Date = new Date()): Promise<LeaderboardRow[]> {
  const twelveMonthsAgo = new Date(now.getTime() - 365 * DAY_MS);
  const [deals, mirrors, users] = await Promise.all([
    loadDeals(null),
    db.salesmateCompany.findMany({
      where: { removedAt: null, companyId: { not: null } },
      select: { companyId: true, ownerUserId: true, ownerName: true, lastCommunicationAt: true },
    }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
  ]);
  const nameByUser = new Map(users.map((u) => [u.id, u.name]));

  const byOwner = new Map<string, LeaderboardRow & { contactDays: number[]; clientIds: Set<string> }>();
  const owner = (userId: string | null, ownerName: string | null) => {
    const key = userId ?? FORMER_REP_OWNER;
    let r = byOwner.get(key);
    if (!r) {
      r = {
        userId,
        name: userId ? (nameByUser.get(userId) ?? "Unknown user") : "Former reps",
        isFormer: !userId,
        wonValue12mo: 0, wonCount12mo: 0, openValue: 0, clients: 0,
        winRateCount: null, medianDaysSinceContact: null, coldClients: 0,
        contactDays: [], clientIds: new Set(),
      };
      byOwner.set(key, r);
    }
    if (!userId && ownerName) r.name = "Former reps";
    return r;
  };

  const wonLost = new Map<string, { won: number; lost: number }>();
  for (const deal of deals) {
    const r = owner(deal.ownerUserId, deal.ownerName);
    if (deal.companyId) r.clientIds.add(deal.companyId);
    const at = dealWonAt(deal);
    const key = deal.ownerUserId ?? FORMER_REP_OWNER;
    const tally = wonLost.get(key) ?? { won: 0, lost: 0 };
    if (deal.status === "Won" && at && at >= twelveMonthsAgo) {
      r.wonValue12mo += num(deal.value);
      r.wonCount12mo++;
      tally.won++;
    } else if (deal.status === "Lost" && at && at >= twelveMonthsAgo) {
      tally.lost++;
    } else if (deal.status !== "Won" && deal.status !== "Lost") {
      r.openValue += num(deal.value);
    }
    wonLost.set(key, tally);
  }

  for (const m of mirrors) {
    const r = owner(m.ownerUserId, m.ownerName);
    if (m.companyId) r.clientIds.add(m.companyId);
    const days = m.lastCommunicationAt ? daysSince(m.lastCommunicationAt, now) : null;
    if (days == null || days >= COLD_DAYS) r.coldClients++;
    if (days != null) r.contactDays.push(days);
  }

  return [...byOwner.entries()]
    .map(([key, r]) => {
      const tally = wonLost.get(key) ?? { won: 0, lost: 0 };
      return {
        userId: r.userId,
        name: r.name,
        isFormer: r.isFormer,
        wonValue12mo: r.wonValue12mo,
        wonCount12mo: r.wonCount12mo,
        openValue: r.openValue,
        clients: r.clientIds.size,
        winRateCount: tally.won + tally.lost > 0 ? tally.won / (tally.won + tally.lost) : null,
        medianDaysSinceContact: median(r.contactDays),
        coldClients: r.coldClients,
      };
    })
    .sort((a, b) => Number(a.isFormer) - Number(b.isFormer) || b.wonValue12mo - a.wonValue12mo);
}

export function canViewWholeTeam(user: { systemRole: string; isSalesManager: boolean }): boolean {
  return user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN" || user.isSalesManager;
}
