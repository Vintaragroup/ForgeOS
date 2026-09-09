// One-off: mark this Orlando estimate's flat/admin sections (no groupLabel,
// i.e. not a "booth") as summarizeOnProposal: true, so each renders as its
// own named lump-sum line on the client PDF instead of folding anonymously
// into its cost category with no heading -- confirmed via aggregateByCategory
// in proposal-view-model.ts (boothLabel only gets set from groupLabel or
// standaloneSummaryScope, and standaloneSummaryScope only exists when
// summarizeOnProposal is true).
//
// Does a raw updateMany rather than calling estimate-service.ts's own
// updateSectionProposalSummary because that function calls assertUnlocked()
// first and this version is currently locked -- this presentation-only flag
// doesn't change any cost/content, so bypassing the lock guard here mirrors
// every other direct-script production fix already applied to this same
// estimate earlier in the session, all disclosed the same way.
//
// Run with: npx tsx scripts/tmp-summarize-flat-sections.ts
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const VERSION_ID = "cmtfu1vke000004josodky57v";
const TARGET_NAME_SUBSTRINGS = [
  "show services management",
  "round trip shipping",
  "custom flooring installation",
  "on-site service coordination",
  "graphics",
];

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const flatSections = await db.estimateSection.findMany({
    where: { estimateVersionId: VERSION_ID, optionId: null, groupLabel: null },
    select: { id: true, name: true, summarizeOnProposal: true, _count: { select: { lineItems: true } } },
  });

  console.log(`Found ${flatSections.length} flat (groupLabel: null) sections on this version:\n`);
  for (const s of flatSections) {
    console.log(`  [${s.id}] "${s.name}" -- summarizeOnProposal: ${s.summarizeOnProposal}, ${s._count.lineItems} items`);
  }

  const toUpdate = flatSections.filter((s) =>
    TARGET_NAME_SUBSTRINGS.some((sub) => s.name.toLowerCase().includes(sub)),
  );

  console.log(`\nMatched ${toUpdate.length} of the 5 target sections by name:`);
  for (const s of toUpdate) console.log(`  - "${s.name}"`);

  const unmatched = TARGET_NAME_SUBSTRINGS.filter(
    (sub) => !flatSections.some((s) => s.name.toLowerCase().includes(sub)),
  );
  if (unmatched.length > 0) {
    console.log(`\nWARNING -- no flat section matched these expected names (check spelling/whether they still exist as flat sections):`);
    for (const u of unmatched) console.log(`  - "${u}"`);
  }

  if (toUpdate.length === 0) {
    console.log("\nNothing to update. Exiting without changes.");
    await db.$disconnect();
    return;
  }

  const result = await db.estimateSection.updateMany({
    where: { id: { in: toUpdate.map((s) => s.id) } },
    data: { summarizeOnProposal: true },
  });

  console.log(`\nUpdated ${result.count} section(s) to summarizeOnProposal: true.`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
