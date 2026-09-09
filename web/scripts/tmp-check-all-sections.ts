import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const versionId = "cmtfu1vke000004josodky57v";
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const sections = await db.estimateSection.findMany({
    where: { estimateVersionId: versionId, optionId: null },
    select: {
      id: true,
      name: true,
      groupLabel: true,
      boothDescription: true,
      summarizeOnProposal: true,
      includeInProposal: true,
      buildType: true,
      _count: { select: { lineItems: true } },
      lineItems: { select: { totalCost: true } },
    },
    orderBy: { name: "asc" },
  });

  const sectionIds = new Set(sections.map((s) => s.id));

  console.log(`Total sections: ${sections.length}\n`);
  for (const s of sections) {
    const sum = s.lineItems.reduce((acc, li) => acc + Number(li.totalCost), 0);
    if (sum === 0 && s._count.lineItems === 0) continue;
    const isSelfMerged = s.groupLabel != null && sectionIds.has(s.groupLabel) && s.groupLabel !== s.id;
    const isWrapper = s.groupLabel === s.id;
    const flatFlag = s.groupLabel == null ? "FLAT" : isWrapper ? "WRAPPER(self)" : isSelfMerged ? "child-of-other" : "groupLabel=raw-sheet-name";
    console.log(`[${flatFlag}] "${s.name}" (booth: ${s.boothDescription ?? "-"}) buildType=${s.buildType ?? "-"} summarize=${s.summarizeOnProposal} include=${s.includeInProposal} -- ${s._count.lineItems} items $${sum.toFixed(2)}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
