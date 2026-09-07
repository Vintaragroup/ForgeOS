// One-time backfill for LineItem.aiProposalSnapshot (see its own schema
// comment) -- every pre-existing AI-derived row was created before this
// field existed, so it's null even though the row really did come from
// an AI proposal. Without this, an estimator can never see the
// "AI-proposed" badge or the "flag as wrong" checkbox on any line item
// committed before this feature shipped.
//
// The snapshot this writes is an APPROXIMATION, not the row's true
// original AI proposal -- that data was never durably captured for a
// bulk-imported item (see LineItemAuditLog's own "one summary row per
// batch, not one per item" comment), so this uses the row's CURRENT
// values as the best available stand-in. If someone already silently
// corrected an item before today, this backfill can't recover what the
// AI actually said, and that specific past correction can never be
// flagged -- only edits made from now on are catchable.
//
// Candidates are scoped to documentId + Document.documentType values
// that are UNAMBIGUOUSLY AI-only in this codebase (RFP/SCOPE_OF_WORK/
// MEETING_NOTES -> scope-line-item-service.ts, DRAWING ->
// drawing-line-item-service.ts, VENDOR_QUOTE -> vendor-quote-service.ts).
// PRICING_SCHEDULE is deliberately excluded even though some of those
// rows are genuinely AI-derived (spreadsheet-line-item-service.ts's AI
// fallback) -- a PRICING_SCHEDULE document's rows are indistinguishable
// from a deterministic pricing-import-service.ts import by documentType
// alone (both set documentId + a verbatim sourceQuote), and this never
// guesses a fallback. Same reasoning excludes CONTRACT/SCHEDULE/OTHER --
// no confirmed evidence any committed line item ever came from those
// types via the scope pipeline.
//
// Never touches an item's real fields (description/qty/unitCost/etc.) --
// only ever writes the new aiProposalSnapshot column, so this can't
// change any total, margin, or PDF output. Bypasses updateLineItem's
// audit log entirely, the same way every other backfill script in this
// directory does for a one-time schema fill.
//
// Safe to re-run: a row with aiProposalSnapshot already set no longer
// matches the candidate query, so a second run is a no-op.
//
// Run with: npx tsx scripts/backfill-ai-proposal-snapshot.ts

import "dotenv/config";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { AiFeature, DocumentType } from "../src/generated/prisma/enums";

const AI_FEATURE_BY_DOCUMENT_TYPE: Partial<Record<DocumentType, AiFeature>> = {
  RFP: "SCOPE_LINE_ITEMS",
  SCOPE_OF_WORK: "SCOPE_LINE_ITEMS",
  MEETING_NOTES: "SCOPE_LINE_ITEMS",
  DRAWING: "DRAWING_LINE_ITEMS",
  VENDOR_QUOTE: "VENDOR_QUOTE_LINE_ITEMS",
};

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const candidates = await db.lineItem.findMany({
    where: {
      // A truly untouched row (created via addLineItem, which never
      // references this column) stores real SQL NULL; a row created via
      // addLineItemsBulk without an aiProposalSnapshot passed stores the
      // JSON `null` literal instead (a `null` value written into a Json
      // field writes JsonNull, not DbNull -- confirmed live: DbNull alone
      // matched 0 of 98 real pre-existing candidates). Match both.
      OR: [{ aiProposalSnapshot: { equals: Prisma.DbNull } }, { aiProposalSnapshot: { equals: Prisma.JsonNull } }],
      documentId: { not: null },
      document: { deletedAt: null, documentType: { in: Object.keys(AI_FEATURE_BY_DOCUMENT_TYPE) as DocumentType[] } },
    },
    select: {
      id: true,
      description: true,
      qty: true,
      unit: true,
      unitCost: true,
      lineType: true,
      category: true,
      document: { select: { documentType: true } },
      section: {
        select: {
          estimateVersion: {
            select: { estimate: { select: { name: true, opportunity: { select: { showName: true } } } } },
          },
        },
      },
    },
  });

  console.log(`Found ${candidates.length} pre-existing AI-derived line item(s) with no aiProposalSnapshot yet.`);

  const summaryByJob = new Map<string, number>();

  for (const li of candidates) {
    const aiFeature = AI_FEATURE_BY_DOCUMENT_TYPE[li.document!.documentType]!;
    await db.lineItem.update({
      where: { id: li.id },
      data: {
        aiProposalSnapshot: {
          description: li.description,
          qty: li.qty.toString(),
          unit: li.unit,
          unitCost: li.unitCost.toString(),
          lineType: li.lineType,
          category: li.category,
          aiFeature,
        },
      },
    });

    const jobName =
      li.section.estimateVersion.estimate.opportunity.showName +
      (li.section.estimateVersion.estimate.name ? ` (${li.section.estimateVersion.estimate.name})` : "");
    summaryByJob.set(jobName, (summaryByJob.get(jobName) ?? 0) + 1);
  }

  console.log("\nPer-job summary:");
  for (const [jobName, count] of [...summaryByJob.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${jobName}: ${count} backfilled`);
  }

  console.log(`\nTotal backfilled: ${candidates.length}.`);

  await db.$disconnect();
}

main();
