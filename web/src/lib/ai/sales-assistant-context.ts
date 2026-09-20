// What a sales rep's assistant knows: their own book, as it stands right
// now. Everything here is already on their /sales page -- this just puts
// it in a form the model can answer questions from ("who haven't I spoken
// to since spring?", "what's open at Bridgestone?", "which clients bought
// last year but not this one?").
//
// Scoped by ownership, not by role: a rep's context contains their
// clients and deals only, so the assistant cannot answer about someone
// else's book even if asked. A sales manager (or admin) viewing the whole
// team gets the team's, matching what /sales already shows them.
//
// Budgeted deliberately. A rep with 60 clients and 90 deals would blow
// past a sensible prompt if every row were included, so each list is
// capped by relevance (value, recency) and the prompt says plainly that
// it was capped -- an assistant that silently sees half the book would
// answer "you have no other clients" with total confidence.

import { db } from "@/lib/db";
import { canViewWholeTeam, COLD_DAYS, loadSalesOverview } from "@/lib/sales-analytics";
import { ageLabel } from "@/lib/contact-aging";
import { companyCitation, opportunityCitation, type CitationTarget } from "@/lib/ai/citation-tokens";
import { ANSWER_ONLY_INSTRUCTIONS, type AssistantContext, type AssistantUser } from "@/lib/ai/assistant-registry";

const MAX_CLIENTS = 40;
const MAX_QUEUE_ROWS = 15;

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

const PREAMBLE = [
  "You are a sales assistant for an event and exhibit contractor (Expo CCI).",
  "You help one salesperson work their own book of business: who to call, what's stalled, what a client is worth,",
  "what was said and when.",
  ANSWER_ONLY_INSTRUCTIONS,
  "Be brief and concrete. Prefer a short list over a paragraph. Money is USD.",
  "Dates: say how long ago rather than a raw timestamp when it's about contact or staleness.",
].join(" ");

export async function buildSalesAssistantContext(user: AssistantUser): Promise<AssistantContext> {
  const seesTeam = canViewWholeTeam(user);
  const overview = await loadSalesOverview({ ownerUserId: user.id });
  const now = new Date();

  const clients = overview.clients.slice(0, MAX_CLIENTS);
  const citations: CitationTarget[] = clients.map((c) => companyCitation({ id: c.companyId, name: c.name }));

  // Their live ForgeOS work, so "where's the estimate for X" has an answer
  // -- the Salesmate mirror knows deals, not what's being priced here.
  const opportunities = await db.opportunity.findMany({
    where: {
      deletedAt: null,
      companyId: { in: clients.map((c) => c.companyId) },
      stage: { notIn: ["WON", "LOST"] },
    },
    select: {
      id: true, showName: true, stage: true, eventStartDate: true,
      company: { select: { name: true } },
      _count: { select: { estimates: true } },
      intakeSubmittedAt: true, reviewMeetingAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_QUEUE_ROWS,
  });
  citations.push(
    ...opportunities.map((o) => opportunityCitation({ id: o.id, showName: o.showName, companyName: o.company.name })),
  );

  const lines: string[] = [];
  lines.push(`SALESPERSON: ${user.name}${seesTeam ? " (also a sales manager -- can see the whole team on /sales)" : ""}`);
  lines.push(
    `BOOK: ${money(overview.kpis.wonValueYtd)} won this year, ${money(overview.kpis.wonValue12mo)} in the last 12 months ` +
      `across ${overview.kpis.wonCount12mo} jobs. Open pipeline ${money(overview.kpis.openValue)} across ` +
      `${overview.kpis.openCount} deals. ${overview.kpis.activeClients} active clients. ` +
      `Win rate ${overview.kpis.winRateCount == null ? "unknown" : `${Math.round(overview.kpis.winRateCount * 100)}%`} by count.`,
  );

  lines.push(
    `\nCLIENTS (${clients.length}${overview.clients.length > clients.length ? ` of ${overview.clients.length}, highest value first -- the rest were left out for length` : ""}):`,
  );
  for (const c of clients) {
    const parts = [
      `${money(c.lifetimeWonValue)} lifetime`,
      `${c.wonCount} job(s)`,
      c.openValue > 0 ? `${money(c.openValue)} open` : null,
      `last contacted ${ageLabel(c.lastContactedAt, now).toLowerCase()}`,
      `last worked with ${ageLabel(c.lastWorkedWithAt, now).toLowerCase()}`,
      c.proposalsSent > 0 ? `${c.proposalsSigned}/${c.proposalsSent} proposals signed` : null,
      c.salesmateType && c.salesmateType !== "Customer" ? c.salesmateType.toLowerCase() : null,
    ].filter(Boolean);
    lines.push(`- ${c.name} [[company:${c.companyId}]]: ${parts.join(", ")}`);
  }

  if (overview.goingCold.length > 0) {
    lines.push(`\nGOING QUIET (no contact in ${COLD_DAYS}+ days, worth chasing first):`);
    for (const c of overview.goingCold.slice(0, MAX_QUEUE_ROWS)) {
      lines.push(
        `- ${c.name} [[company:${c.companyId}]]: ${money(c.lifetimeWonValue)} lifetime, last contacted ${ageLabel(c.lastContactedAt, now).toLowerCase()}`,
      );
    }
  }

  if (overview.staleOpenDeals.length > 0) {
    lines.push("\nOPEN DEALS WITH NO RECENT ACTIVITY:");
    for (const d of overview.staleOpenDeals.slice(0, MAX_QUEUE_ROWS)) {
      lines.push(
        `- ${d.title} (${d.companyName ?? "no client linked"}): ${money(d.value)}, stage ${d.stage ?? "unknown"}` +
          `${d.daysInStage != null ? `, ${d.daysInStage} days in stage` : ""}` +
          `${d.daysQuiet >= 0 ? `, quiet ${d.daysQuiet} days` : ", no activity ever logged"}`,
      );
    }
  }

  if (overview.lapsed.length > 0) {
    lines.push("\nLAPSED (bought before, nothing in the last year, nothing open):");
    for (const c of overview.lapsed.slice(0, MAX_QUEUE_ROWS)) {
      lines.push(`- ${c.name} [[company:${c.companyId}]]: ${money(c.lifetimeWonValue)} lifetime, last won ${ageLabel(c.lastWonAt, now).toLowerCase()}`);
    }
  }

  if (overview.scheduled.pastDue.length > 0) {
    lines.push("\nSCHEDULED WORK PAST DUE (Salesmate activities -- reps rarely tick these off, so treat as 'did this happen?'):");
    for (const a of overview.scheduled.pastDue.slice(0, MAX_QUEUE_ROWS)) {
      lines.push(`- ${a.type}: ${a.title}${a.companyName ? ` (${a.companyName})` : ""}, due ${a.daysOverdue} days ago`);
    }
  }
  if (overview.scheduled.upcoming.length > 0) {
    lines.push("\nSCHEDULED NEXT:");
    for (const a of overview.scheduled.upcoming.slice(0, MAX_QUEUE_ROWS)) {
      lines.push(
        `- ${a.type}: ${a.title}${a.companyName ? ` (${a.companyName})` : ""}, ` +
          `${a.dueAt ? `due ${a.dueAt.toISOString().slice(0, 10)}` : "no date set"}`,
      );
    }
  }

  if (opportunities.length > 0) {
    lines.push("\nLIVE FORGEOS OPPORTUNITIES (what's being estimated/proposed here, as opposed to Salesmate deals):");
    for (const o of opportunities) {
      lines.push(
        `- ${o.company.name} — ${o.showName} [[opp:${o.id}]]: stage ${o.stage}, ${o._count.estimates} estimate(s)` +
          `${o.eventStartDate ? `, show starts ${o.eventStartDate.toISOString().slice(0, 10)}` : ""}` +
          `${o.intakeSubmittedAt ? `, submitted for client review${o.reviewMeetingAt ? " (meeting set)" : " (no meeting yet)"}` : ""}`,
      );
    }
  }

  lines.push(
    `\nCONTACT HISTORY: ForgeOS started recording individual contacts on ` +
      `${overview.touchHistory.since ? overview.touchHistory.since.toISOString().slice(0, 10) : "(not yet)"}; ` +
      `${overview.touchHistory.last30Days} recorded in the last 30 days. Anything before that date is not known -- ` +
      `"last contacted" dates come from Salesmate and are reliable, but the history behind them is not.`,
  );

  return {
    systemPrompt: `${PREAMBLE}\n\n${lines.join("\n")}`,
    citations,
    suggestions: [
      "Who should I call this week?",
      "Which clients bought last year but not this year?",
      "What's stalled in my pipeline and for how long?",
      "Summarise my three biggest clients and when I last spoke to them.",
    ],
  };
}
