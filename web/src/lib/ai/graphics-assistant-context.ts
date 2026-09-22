// What a Graphics person's assistant knows: the department's live board,
// as it stands right now. Everything here is already on
// /departments/graphics -- this puts it in a form the model can answer
// questions from ("what's late at Binick?", "what still has no shop?",
// "which Seatrade pieces are waiting on the client?").
//
// Built from the same two modules the dashboard itself renders from
// (graphics-today, graphics-shop-floor) rather than its own queries. That
// is the point: if the assistant and the page disagreed about what is
// late, one of them would be wrong, and nobody would know which.
//
// Scoped exactly like the page. getGraphicsOrders already widens to the
// whole department for a GR member and narrows to owned/collaborated
// opportunities for anyone else, so a non-GR admin's assistant and a GR
// producer's assistant see what each of them would see on the page.
//
// Budgeted deliberately. The department carries hundreds of live pieces
// (281 on the day this was written), so every list is capped by urgency
// and the prompt says plainly where it was cut -- an assistant that
// silently saw six of ninety late pieces would answer "that's all of
// them" with total confidence.

import type { SystemRole } from "@/generated/prisma/enums";
import { getGraphicsOrders, type GraphicsOrder } from "@/lib/artwork-hub";
import { buildTodayBuckets, NEXT_STEP } from "@/lib/graphics-today";
import { buildShopFloor } from "@/lib/graphics-shop-floor";
import { APPROVAL_LEAD_BUSINESS_DAYS } from "@/lib/graphics-sla";
import { artworkCitation, showCitation, type CitationTarget } from "@/lib/ai/citation-tokens";
import { ANSWER_ONLY_INSTRUCTIONS, type AssistantContext, type AssistantUser } from "@/lib/ai/assistant-contract";

// Questions this assistant can actually answer well from the context
// below -- not a wish list.
export const GRAPHICS_SUGGESTIONS = [
  "What's late, and whose fault is it?",
  "What does each print shop still owe us?",
  "Which pieces are waiting on a client right now?",
  "What's at risk of a rush fee this week?",
];

// Per list, not overall. A department with 90 late pieces should get a
// usable answer about the worst 25 plus an honest count, not a truncated
// prompt.
const MAX_ROWS = 25;
const MAX_SHOPS = 12;

const PREAMBLE = [
  "You are a graphics production assistant for an event and exhibit contractor (Expo CCI).",
  "You help the Graphics department run its board: what is late, what is about to cost a rush fee, whose move each",
  "piece is, and what each print shop still owes.",
  ANSWER_ONLY_INSTRUCTIONS,
  "Be brief and concrete. Prefer a short list over a paragraph.",
  "A 'piece' is one graphic. A piece can be split across two shops, and each half finishes separately, so a piece",
  "can be half done -- never call a split piece finished because one half is.",
  "Turnaround targets: fabric 5 business days, outsourced rigid 5, hanging signs 10.",
  `Every show graphic is meant to be approved ${APPROVAL_LEAD_BUSINESS_DAYS} business days before show-site setup.`,
].join(" ");

function showNameOf(order: GraphicsOrder): string | null {
  return order.opportunity?.showName ?? order.show?.name ?? null;
}

// The token is the name. It renders as the piece's full label -- client or
// show, graphic code, job code -- so writing the name beside it made every
// answer say the same thing three times over:
//
//   Seatrade 2027 (show piece) [Seatrade 2027 (show piece) - 102A - ...] - 102A - ...
//
// Only facts the label does NOT already carry go alongside it: the show,
// for a client's piece (a show piece is named after its show already), and
// the material.
function describe(order: GraphicsOrder): string {
  const bits = [order.opportunity ? showNameOf(order) : null, order.material].filter(Boolean);
  return `[[art:${order.id}]]${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

function citationFor(order: GraphicsOrder): CitationTarget {
  return artworkCitation({
    id: order.id,
    jobCode: order.jobCode,
    companyName: order.opportunity?.company.name ?? null,
    showName: showNameOf(order),
    graphicCode: order.graphicCode,
  });
}

// "and 64 more" rather than silence. Returned as a line to append, so the
// caller decides whether the list was worth printing at all.
function cappedNote(total: number, shown: number): string {
  return total > shown ? ` ...and ${total - shown} more not listed here.` : "";
}

export async function buildGraphicsAssistantContext(user: AssistantUser): Promise<AssistantContext> {
  // AssistantUser carries systemRole as a plain string so the contract
  // module stays free of Prisma imports (see assistant-contract.ts). The
  // value does come from that enum column, and every check downstream
  // (canAccessArtworkOrdersViaDepartment, opportunityAccessWhere) treats an
  // unrecognised role as the least privileged one -- so a bad value can
  // only ever narrow what this assistant sees, never widen it.
  const scoped = {
    id: user.id,
    systemRole: user.systemRole as SystemRole,
    departmentCode: user.departmentCode,
  };
  const orders = await getGraphicsOrders(scoped);
  const now = new Date();

  const eventStartDateOf = (o: GraphicsOrder) => o.opportunity?.eventStartDate ?? o.show?.eventStartDate ?? null;

  const today = buildTodayBuckets(
    orders,
    (o) => ({
      status: o.status,
      inHandDate: o.inHandDate,
      material: o.material,
      graphicCode: o.graphicCode,
      showStartDate: eventStartDateOf(o),
    }),
    now,
  );
  const floor = buildShopFloor(
    orders,
    (o) => ({
      status: o.status,
      inHandDate: o.inHandDate,
      routings: o.routings.map((r) => ({
        id: r.id,
        kind: r.kind,
        productionStatus: r.productionStatus,
        vendor: r.vendor,
        office: r.office,
      })),
    }),
    now,
  );

  // Only what actually appears below gets a citation token -- a directory
  // of 281 pieces would cost more prompt than the answer is worth, and the
  // model must never be handed a token for something it can't see.
  const cited = new Map<string, CitationTarget>();
  const cite = (order: GraphicsOrder) => {
    if (!cited.has(order.id)) cited.set(order.id, citationFor(order));
  };

  const lines: string[] = [];
  lines.push(`PERSON: ${user.name}${user.departmentCode ? ` (department ${user.departmentCode})` : ""}`);
  lines.push(
    `BOARD: ${orders.length} live pieces. ${today.needsYou} need Graphics; ` +
      `${today.escalated.length} escalated, ${today.overdue.length} past their in-hand date, ` +
      `${today.rushRisk.length} at risk of a rush fee, ${today.approvalWindow.length} unapproved with the show close. ` +
      `${floor.openHalfCount} halves still open across ${floor.shops.length} shops.`,
  );
  lines.push(
    "Pieces that are delivered, cancelled or archived are not in this list at all -- if someone asks about one, " +
      "say you only have live work and point them at the production log (/departments/graphics/log).",
  );

  if (today.escalated.length > 0) {
    lines.push(`\nESCALATED (hit the revision cap -- nothing moves until someone decides):`);
    for (const { order, sla } of today.escalated.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(`- ${describe(order)}${sla?.overdue ? `, ${Math.abs(sla.businessDaysRemaining)} business days past in-hand` : ""}`);
    }
    lines[lines.length - 1] += cappedNote(today.escalated.length, MAX_ROWS);
  }

  if (today.overdue.length > 0) {
    lines.push("\nPAST ITS IN-HAND DATE (not yet made):");
    for (const { order, sla, turnaroundIsKnown } of today.overdue.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(
        `- ${describe(order)}: ${Math.abs(sla.businessDaysRemaining)} business days over, ` +
          `waiting on ${NEXT_STEP[order.status].toLowerCase()}` +
          `${turnaroundIsKnown ? "" : " (no material on file, so its turnaround is an estimate)"}`,
      );
    }
    lines[lines.length - 1] += cappedNote(today.overdue.length, MAX_ROWS);
  }

  if (today.rushRisk.length > 0) {
    lines.push("\nRUSH-FEE RISK (less time left than the material's standard turnaround). A warning, never a price -- rush charges are negotiated per invoice by the Graphics Manager and live in NetSuite:");
    for (const { order, sla, turnaroundIsKnown } of today.rushRisk.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(
        `- ${describe(order)}: ${sla.businessDaysRemaining} business days left, needs ${sla.turnaroundDays}` +
          `${turnaroundIsKnown ? "" : " (turnaround estimated -- no material on file)"}`,
      );
    }
    lines[lines.length - 1] += cappedNote(today.rushRisk.length, MAX_ROWS);
  }

  if (today.approvalWindow.length > 0) {
    lines.push(`\nNOT APPROVED WITH THE SHOW INSIDE ${APPROVAL_LEAD_BUSINESS_DAYS} BUSINESS DAYS:`);
    for (const { order, businessDaysToShow } of today.approvalWindow.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(
        `- ${describe(order)}: ${businessDaysToShow <= 0 ? "show has already started" : `${businessDaysToShow} business days to setup`}, ` +
          `currently ${NEXT_STEP[order.status].toLowerCase()}`,
      );
    }
    lines[lines.length - 1] += cappedNote(today.approvalWindow.length, MAX_ROWS);
  }

  if (today.waitingOnUs.length > 0) {
    lines.push("\nWAITING ON GRAPHICS (our move):");
    for (const { order, nextStep } of today.waitingOnUs.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(`- ${describe(order)}: ${nextStep.toLowerCase()}`);
    }
    lines[lines.length - 1] += cappedNote(today.waitingOnUs.length, MAX_ROWS);
  }

  if (today.waitingOnOthers.length > 0) {
    const clients = today.waitingOnOthers.filter((i) => i.waitingOn === "CLIENT");
    const vendors = today.waitingOnOthers.filter((i) => i.waitingOn === "VENDOR");
    lines.push(
      `\nWAITING ON SOMEONE ELSE: ${clients.length} on a client, ${vendors.length} on a vendor. ` +
        "Soonest show first:",
    );
    for (const { order, nextStep, waitingOn } of today.waitingOnOthers.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(`- ${describe(order)}: ${waitingOn === "CLIENT" ? "client" : "vendor"} -- ${nextStep.toLowerCase()}`);
    }
    lines[lines.length - 1] += cappedNote(today.waitingOnOthers.length, MAX_ROWS);
  }

  if (floor.shops.length > 0) {
    lines.push("\nSHOP FLOOR (a split piece counts once per shop -- each half finishes on its own):");
    for (const shop of floor.shops.slice(0, MAX_SHOPS)) {
      const where = shop.byStatus.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(", ");
      lines.push(
        `- ${shop.label}: ${shop.open.length} open (${where || "nothing open"}), ` +
          `${shop.settledCount} settled${shop.lateCount > 0 ? `, ${shop.lateCount} past in-hand` : ""}`,
      );
    }
    if (floor.shops.length > MAX_SHOPS) {
      lines[lines.length - 1] += cappedNote(floor.shops.length, MAX_SHOPS);
    }
  }

  if (floor.unrouted.length > 0) {
    lines.push("\nNOWHERE TO BE MADE (art accepted, no shop assigned):");
    for (const order of floor.unrouted.slice(0, MAX_ROWS)) {
      cite(order);
      lines.push(`- ${describe(order)}`);
    }
    lines[lines.length - 1] += cappedNote(floor.unrouted.length, MAX_ROWS);
  }

  // Shows are how a Graphics person actually frames a question ("what's
  // left for Seatrade?"), so they get their own tokens even though no
  // list above is keyed on them.
  const shows = new Map<string, { id: string; name: string }>();
  for (const order of orders) {
    const show = order.show ?? order.opportunity?.show ?? null;
    if (show && !shows.has(show.id)) shows.set(show.id, { id: show.id, name: show.name });
  }

  lines.push(
    "\nWHAT YOU DON'T KNOW: costs, invoices and rush charges (NetSuite), anything about a piece that is already " +
      "delivered or archived, and the contents of the artwork files themselves. Say so rather than guessing.",
  );

  return {
    systemPrompt: `${PREAMBLE}\n\n${lines.join("\n")}`,
    citations: [...cited.values(), ...[...shows.values()].map(showCitation)],
  };
}
