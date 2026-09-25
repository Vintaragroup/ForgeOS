// Folds each element group on an estimate version back into ONE section,
// under the element's own category.
//
// "The system should not break out labor and graphics out of the elements
// that are being built." A counter's plywood, its drawer slides, its LED
// strip, its front logo and the shop hours to build it are one thing a
// client is quoted for, not five rows filed under five headings.
//
// The importer no longer produces the split (see moduleCategory); this
// repairs the estimates committed before that.
//
// Dry run by default. Pass --apply to write.
//
//   npx tsx scripts/fold-elements.mts <estimateId> [--apply]
//
// A group is left alone when nothing in it is built -- no labor and no
// fabrication materials -- which is how a pure logistics or shipping
// module keeps its own category.
import { db } from "@/lib/db";
import { writeFileSync } from "node:fs";

const estimateId = process.argv[2];
const apply = process.argv.includes("--apply");
if (!estimateId) throw new Error("usage: fold-elements.mts <estimateId> [--apply]");

const version = await db.estimateVersion.findFirstOrThrow({
  where: { estimateId },
  orderBy: { versionNumber: "desc" },
  select: {
    id: true,
    versionNumber: true,
    isLocked: true,
    sections: {
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        groupLabel: true,
        sortOrder: true,
        lineItems: { select: { id: true, description: true, category: true, lineType: true, totalCost: true } },
      },
    },
  },
});
if (version.isLocked) throw new Error("This version is locked. Folding happens on the open version.");

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const CUSTOM_BUILD = "Custom Build";

// Every section that shares a groupLabel is one element.
const byGroup = new Map<string, typeof version.sections>();
for (const section of version.sections) {
  if (!section.groupLabel) continue;
  byGroup.set(section.groupLabel, [...(byGroup.get(section.groupLabel) ?? []), section]);
}

const plan: {
  group: string;
  keepSectionId: string;
  category: string;
  moveLineItemIds: string[];
  dropSectionIds: string[];
  cost: number;
}[] = [];

for (const [group, sections] of byGroup) {
  const items = sections.flatMap((s) => s.lineItems);
  const cost = items.reduce((n, li) => n + Number(li.totalCost), 0);
  // Built when the shop touches it: any labor line, or anything already
  // filed as fabrication.
  const built = items.some((li) => li.lineType === "LABOR" || li.category === CUSTOM_BUILD);
  if (!built) {
    console.log(`  leave   [${group}] -- nothing built here (${sections.length} section(s), ${money(cost)})`);
    continue;
  }
  if (sections.length === 1 && items.every((li) => li.category === CUSTOM_BUILD)) {
    console.log(`  ok      [${group}] -- already one group`);
    continue;
  }
  // Keep the section that is already the build, else the earliest.
  const keep = sections.find((s) => s.name === CUSTOM_BUILD) ?? sections[0];
  const moveLineItemIds = items.filter((li) => !keep.lineItems.some((k) => k.id === li.id)).map((li) => li.id);
  const dropSectionIds = sections.filter((s) => s.id !== keep.id).map((s) => s.id);
  plan.push({ group, keepSectionId: keep.id, category: CUSTOM_BUILD, moveLineItemIds, dropSectionIds, cost });
  console.log(
    `  FOLD    [${group}] ${sections.length} sections -> one "${CUSTOM_BUILD}"  ${items.length} items  ${money(cost)}`,
  );
  for (const s of sections) {
    const cats = [...new Set(s.lineItems.map((li) => li.category))].join(",");
    console.log(
      `            ${s.id === keep.id ? "keeping  " : "absorbing"} "${s.name}"${cats ? ` [${cats}]` : ""} (${s.lineItems.length} items)`,
    );
  }
}

const totalBefore = version.sections.reduce(
  (n, s) => n + s.lineItems.reduce((m, li) => m + Number(li.totalCost), 0),
  0,
);
console.log(`\n${plan.length} groups to fold. Version total ${money(totalBefore)} (must not change).`);

if (!apply) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

writeFileSync(
  `/tmp/fold-elements-backup-${version.id}.json`,
  JSON.stringify(
    {
      versionId: version.id,
      takenAt: new Date().toISOString(),
      sections: version.sections.map((s) => ({
        id: s.id,
        name: s.name,
        groupLabel: s.groupLabel,
        sortOrder: s.sortOrder,
        lineItems: s.lineItems.map((li) => ({ id: li.id, category: li.category, sectionId: s.id })),
      })),
    },
    null,
    2,
  ),
);

for (const step of plan) {
  await db.$transaction(async (tx) => {
    if (step.moveLineItemIds.length > 0) {
      await tx.lineItem.updateMany({
        where: { id: { in: step.moveLineItemIds } },
        data: { sectionId: step.keepSectionId },
      });
    }
    // Every row of the element carries the element's category, which is
    // what actually keeps it together in the proposal -- placement there
    // is resolved from the LINE ITEM's category, not its section's.
    await tx.lineItem.updateMany({
      where: { sectionId: step.keepSectionId },
      data: { category: step.category },
    });
    await tx.estimateSection.update({ where: { id: step.keepSectionId }, data: { name: step.category } });
    if (step.dropSectionIds.length > 0) {
      const orphans = await tx.lineItem.count({ where: { sectionId: { in: step.dropSectionIds } } });
      if (orphans > 0) throw new Error(`${orphans} line items still in sections about to be deleted`);
      // Two other tables point at a section, both optionally. Repoint
      // rather than delete: an internal cost and a re-cost proposal are
      // records of real work, not section furniture.
      await tx.internalCost.updateMany({
        where: { sectionId: { in: step.dropSectionIds } },
        data: { sectionId: step.keepSectionId },
      });
      await tx.recostProposal.updateMany({
        where: { sectionId: { in: step.dropSectionIds } },
        data: { sectionId: step.keepSectionId },
      });
      await tx.estimateSectionCategoryDescription.deleteMany({ where: { sectionId: { in: step.dropSectionIds } } });
      await tx.estimateSection.deleteMany({ where: { id: { in: step.dropSectionIds } } });
    }
  });
  console.log(`  folded [${step.group}]`);
}

const after = await db.estimateSection.findMany({
  where: { estimateVersionId: version.id },
  select: { name: true, groupLabel: true, lineItems: { select: { totalCost: true, category: true } } },
  orderBy: { sortOrder: "asc" },
});
const totalAfter = after.reduce((n, s) => n + s.lineItems.reduce((m, li) => m + Number(li.totalCost), 0), 0);
console.log(`\n${after.length} sections now. Total ${money(totalAfter)} (was ${money(totalBefore)}).`);
if (Math.abs(totalAfter - totalBefore) > 0.01) throw new Error("TOTAL MOVED -- investigate before trusting this");
for (const s of after) {
  const cost = s.lineItems.reduce((n, li) => n + Number(li.totalCost), 0);
  console.log(`  [${s.groupLabel ?? "-"}] ${s.name} ${money(cost)} (${s.lineItems.length} items)`);
}
process.exit(0);
