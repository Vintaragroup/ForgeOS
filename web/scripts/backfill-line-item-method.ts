// One-off backfill: existing LineItem rows that sit on a flat, Method-
// splittable Type category (e.g. plain "Structure", from before the
// Type x Method leaf categories existed -- see
// scripts/seed-type-method-categories.ts) get moved onto their real
// "<Type> - <Method>" leaf wherever resolveAcquisitionMethod can infer a
// Method from the item's own text. Catalog source ("Material" vs.
// "Rental") isn't recoverable retroactively -- that signal only exists
// at import time (pricing-import-service.ts) -- so this relies on
// resolveAcquisitionMethod's text-based branches only (BeMatrix /
// "rental" / "purchase" wording). Where nothing resolves, the row is
// left exactly as-is -- never guessed -- and shows up afterward in the
// estimate page's own "No Rental/Purchase/Custom Fabricated method yet"
// audit banner (category-audit.ts's methodUnresolvedIssues) as a real,
// visible punch list instead of a silent gap.
//
// Safe to re-run: a row already moved onto its leaf category no longer
// matches the flat-Type-category candidate query, so a second run is a
// no-op.
//
// Run with: npx tsx scripts/backfill-line-item-method.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { leafCategoryKey, resolveAcquisitionMethod, TYPE_KEYS_WITH_METHOD_SPLIT } from "../src/lib/line-item-category";

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const categories = await db.category.findMany({ where: { deletedAt: null } });
  const categoryByName = new Map(categories.map((c) => [c.name, c]));
  const categoryByKey = new Map(categories.map((c) => [c.key, c]));

  // Candidates: every live category that's a flat Type parent supporting
  // a Method split (Structure/Flooring/Furniture/Audio-Visual/Misc) --
  // any LineItem still sitting directly on one of these by name is a
  // pre-split-era row that never got a Method.
  const splitTypeNames = categories
    .filter((c) => (TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(c.key))
    .map((c) => c.name);

  const candidates = await db.lineItem.findMany({
    where: { category: { in: splitTypeNames } },
    select: {
      id: true,
      category: true,
      description: true,
      section: {
        select: {
          estimateVersion: {
            select: {
              estimate: {
                select: { name: true, opportunity: { select: { showName: true } } },
              },
            },
          },
        },
      },
    },
  });

  console.log(`Found ${candidates.length} line item(s) on a flat, Method-splittable Type category.`);

  const summaryByJob = new Map<string, { moved: number; left: number }>();

  for (const li of candidates) {
    const typeCategory = categoryByName.get(li.category!)!;
    const method = resolveAcquisitionMethod({ description: li.description, category: li.category });
    const jobName =
      li.section.estimateVersion.estimate.opportunity.showName +
      (li.section.estimateVersion.estimate.name ? ` (${li.section.estimateVersion.estimate.name})` : "");
    const jobSummary = summaryByJob.get(jobName) ?? { moved: 0, left: 0 };

    if (!method) {
      jobSummary.left++;
      summaryByJob.set(jobName, jobSummary);
      continue;
    }

    const leafCategory = categoryByKey.get(leafCategoryKey(typeCategory.key, method));
    if (!leafCategory) {
      // Shouldn't happen once seed-type-method-categories.ts has run, but
      // never guess a fallback -- leave the row untouched if it does.
      jobSummary.left++;
      summaryByJob.set(jobName, jobSummary);
      continue;
    }

    await db.lineItem.update({ where: { id: li.id }, data: { category: leafCategory.name } });
    jobSummary.moved++;
    summaryByJob.set(jobName, jobSummary);
  }

  console.log("\nPer-job summary:");
  for (const [jobName, { moved, left }] of [...summaryByJob.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${jobName}: moved ${moved}, left as-is (no Method inferred) ${left}`);
  }

  const totalMoved = [...summaryByJob.values()].reduce((sum, s) => sum + s.moved, 0);
  const totalLeft = [...summaryByJob.values()].reduce((sum, s) => sum + s.left, 0);
  console.log(`\nTotal: moved ${totalMoved}, left as-is ${totalLeft}.`);

  await db.$disconnect();
}

main();
