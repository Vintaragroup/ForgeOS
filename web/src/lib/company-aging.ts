// "Last contacted" and "last worked with" per company -- the data behind
// the aging chips on the company/contact pages and the dashboard's Going
// cold card. Pure date math lives in contact-aging.ts; this file is only
// about WHICH date counts.
//
// Last contacted: the most recent of Salesmate's own company-level
// last-communication date and any of the company's synced contacts' dates
// (reps log communication in Salesmate; see salesmate-sync.ts).
//
// Last worked with: the most recent WON job's SHOW date (the user's
// choice, 2026-09-19 -- when we actually delivered, not when they signed).
// Two sources:
// - ForgeOS won opportunities: the event's own dates, else its Show's.
// - Salesmate won deals: Salesmate has no show-date field, but its
//   "Pipeline YYYY" pipelines stage deals by show month -- confirmed
//   against real data (every PGA deal is in "January", FIFA in "June",
//   Summer Fancy Food in "June"). The last day of that month stands in for
//   the show date. Won deals in other pipelines (Sales-Orlando,
//   PRODUCTION-Orlando) carry no show month and are counted as "won, no
//   show date" rather than given a made-up date.

import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// "Pipeline 2026" + "January" -> 2026-01-31 (end of the show month).
export function showMonthEnd(pipeline: string | null, stage: string | null): Date | null {
  const year = /^pipeline\s+(\d{4})$/i.exec(pipeline?.trim() ?? "")?.[1];
  const month = MONTHS.indexOf(stage?.trim().toLowerCase() ?? "");
  if (!year || month === -1) return null;
  // Day 0 of the next month = last day of this one, at noon UTC so no
  // timezone shifts it into a neighboring day.
  return new Date(Date.UTC(Number(year), month + 1, 0, 12));
}

export interface LastContacted {
  at: Date;
  by: string | null;
  mode: string | null;
  // Set when the most recent communication was with a specific contact.
  contactName: string | null;
}

export interface LastWorkedWith {
  at: Date;
  // The job it came from -- a Salesmate deal title or a ForgeOS show name.
  label: string;
  source: "salesmate" | "forgeos";
}

export interface CompanyAging {
  lastContacted: LastContacted | null;
  lastWorkedWith: LastWorkedWith | null;
  // Won jobs we couldn't date. Non-zero with lastWorkedWith null means
  // "we have worked with them -- the show dates just aren't recorded".
  wonWithoutShowDate: number;
  salesmateType: string | null;
}

function later<T extends { at: Date }>(a: T | null, b: T | null): T | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

// Omit companyIds for every company (the list page, the dashboard).
export async function loadCompanyAging(companyIds?: string[]): Promise<Map<string, CompanyAging>> {
  // Every relation here is nullable, so "all companies" is `not: null`.
  const idFilter: Prisma.StringNullableFilter = companyIds ? { in: companyIds } : { not: null };
  const [mirrors, contacts, deals, opportunities] = await Promise.all([
    db.salesmateCompany.findMany({
      where: { companyId: idFilter, removedAt: null },
      select: { companyId: true, type: true, lastCommunicationAt: true, lastCommunicationBy: true, lastCommunicationMode: true },
    }),
    db.contact.findMany({
      where: { companyId: idFilter, deletedAt: null, lastContactedAt: { not: null } },
      select: { companyId: true, name: true, lastContactedAt: true, lastContactedBy: true, lastContactedMode: true },
    }),
    db.salesmateDeal.findMany({
      where: { companyId: idFilter, removedAt: null, status: "Won" },
      select: { companyId: true, title: true, pipeline: true, stage: true },
    }),
    db.opportunity.findMany({
      where: { companyId: companyIds ? { in: companyIds } : undefined, deletedAt: null, stage: "WON" },
      select: {
        companyId: true,
        showName: true,
        eventStartDate: true,
        eventEndDate: true,
        show: { select: { name: true, eventStartDate: true, eventEndDate: true } },
      },
    }),
  ]);

  const result = new Map<string, CompanyAging>();
  const entry = (companyId: string) => {
    let e = result.get(companyId);
    if (!e) {
      e = { lastContacted: null, lastWorkedWith: null, wonWithoutShowDate: 0, salesmateType: null };
      result.set(companyId, e);
    }
    return e;
  };

  for (const m of mirrors) {
    const e = entry(m.companyId!);
    e.salesmateType = m.type;
    if (m.lastCommunicationAt) {
      e.lastContacted = later(e.lastContacted, {
        at: m.lastCommunicationAt,
        by: m.lastCommunicationBy,
        mode: m.lastCommunicationMode,
        contactName: null,
      });
    }
  }
  for (const c of contacts) {
    if (!c.companyId) continue;
    const e = entry(c.companyId);
    e.lastContacted = later(e.lastContacted, {
      at: c.lastContactedAt!,
      by: c.lastContactedBy,
      mode: c.lastContactedMode,
      contactName: c.name,
    });
  }
  for (const d of deals) {
    const e = entry(d.companyId!);
    const at = showMonthEnd(d.pipeline, d.stage);
    if (at) e.lastWorkedWith = later(e.lastWorkedWith, { at, label: d.title, source: "salesmate" });
    else e.wonWithoutShowDate++;
  }
  for (const o of opportunities) {
    const e = entry(o.companyId);
    const at = o.eventEndDate ?? o.eventStartDate ?? o.show?.eventEndDate ?? o.show?.eventStartDate ?? null;
    if (at) e.lastWorkedWith = later(e.lastWorkedWith, { at, label: o.show?.name ?? o.showName, source: "forgeos" });
    else e.wonWithoutShowDate++;
  }
  return result;
}

export const EMPTY_AGING: CompanyAging = { lastContacted: null, lastWorkedWith: null, wonWithoutShowDate: 0, salesmateType: null };
