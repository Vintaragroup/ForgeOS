// Repeatable, read-only reconciliation check for one estimate version --
// automates what a real production incident took hours of manual
// detective work to catch by hand (Full Swing PGA Orlando, Sept 2026):
// a re-import against an already-merged booth silently recreated ~99
// duplicate line items, a section holding $204k of correctly-priced
// content was completely invisible in every category tab, and 52 items
// sat under the wrong category for weeks with nothing flagging it. Run
// this after any import, merge, or manual data-repair pass to catch the
// same class of problem before a human has to notice the dollar total
// looks wrong.
//
// Run with: npx tsx scripts/audit-estimate-version.ts <estimateVersionId>

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadDuplicateCandidates } from "../src/lib/ai/scope-line-item-service";

async function main() {
  const versionId = process.argv[2];
  if (!versionId) {
    console.error("Usage: npx tsx scripts/audit-estimate-version.ts <estimateVersionId>");
    process.exit(1);
  }

  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const version = await db.estimateVersion.findUnique({
    where: { id: versionId },
    select: { id: true, versionNumber: true, isLocked: true, estimate: { select: { opportunityId: true } } },
  });
  if (!version) {
    console.error(`No estimate version found for id "${versionId}".`);
    process.exit(1);
  }

  let issuesFound = 0;
  const flag = (msg: string) => {
    issuesFound += 1;
    console.log(`  ✗ ${msg}`);
  };
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);

  console.log(`\nAuditing estimate version ${versionId} (v${version.versionNumber})\n${"=".repeat(60)}`);

  // ---- 1. Per-document committed totals (informational -- cross-check
  // each figure against the real source document by hand; this script
  // can't read an arbitrary PDF/Excel's own stated total for you). ----
  console.log("\n1. Committed total by source document");
  const items = await db.lineItem.findMany({
    where: { section: { estimateVersionId: versionId, optionId: null } },
    select: {
      id: true,
      description: true,
      qty: true,
      unitCost: true,
      totalCost: true,
      isDraft: true,
      category: true,
      documentId: true,
      sectionId: true,
      section: { select: { id: true, name: true, groupLabel: true } },
    },
  });
  const docs = await db.document.findMany({
    where: { opportunityId: version.estimate.opportunityId },
    select: { id: true, filename: true, documentType: true },
  });
  const docById = new Map(docs.map((d) => [d.id, d]));
  const byDoc = new Map<string, typeof items>();
  for (const it of items) {
    const key = it.documentId ?? "(no document / manual entry)";
    byDoc.set(key, [...(byDoc.get(key) ?? []), it]);
  }
  for (const [docKey, arr] of [...byDoc.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const doc = docById.get(docKey);
    const label = doc ? `${doc.filename} (${doc.documentType})` : docKey;
    const sum = arr.reduce((s, i) => s + Number(i.totalCost), 0);
    console.log(`     $${sum.toFixed(2).padStart(12)}  ${arr.length.toString().padStart(4)} items  ${label}`);
  }
  const referencedDocIds = new Set(byDoc.keys());
  for (const doc of docs) {
    if ((doc.documentType === "PRICING_SCHEDULE" || doc.documentType === "VENDOR_QUOTE") && !referencedDocIds.has(doc.id)) {
      flag(`"${doc.filename}" (${doc.documentType}) has zero committed line items -- was it ever actually imported?`);
    }
  }

  // ---- 2. Exact-duplicate check, using the same groupKey resolution
  // Tier-1 dedup itself relies on -- reuses loadDuplicateCandidates
  // directly so this check degrades exactly the same way production
  // matching would, rather than a separately-written heuristic drifting
  // out of sync with it over time. ----
  console.log("\n2. Exact-duplicate check (same groupKey + description + qty + cost)");
  const candidates = await loadDuplicateCandidates(versionId);
  const costById = new Map(items.map((i) => [i.id, Number(i.unitCost)]));
  const docById2 = new Map(items.map((i) => [i.id, i.documentId]));
  const bySig = new Map<string, typeof candidates>();
  for (const c of candidates) {
    // Includes unit cost (a same-description-and-qty row at a genuinely
    // different price is not a duplicate) and documentId (two different
    // source documents can legitimately reuse the same generic H2 name --
    // "Sales", "Labor" -- for their own unrelated content; groupKey alone
    // can't always tell those apart, see this script's own findings notes).
    const key = `${c.groupKey ?? "(no groupKey)"}|${docById2.get(c.id) ?? "(none)"}|${c.description.trim().toLowerCase()}|${c.qty}|${costById.get(c.id)}`;
    bySig.set(key, [...(bySig.get(key) ?? []), c]);
  }
  const dupeSigs = [...bySig.entries()].filter(([, arr]) => arr.length > 1);
  if (dupeSigs.length === 0) {
    ok("No exact-duplicate (groupKey, document, description, qty, cost) signatures found.");
  } else {
    for (const [sig, arr] of dupeSigs) {
      flag(`x${arr.length}  ${sig}  -- ids: ${arr.map((c) => c.id).join(", ")}`);
    }
  }

  // ---- 3. Invisible-section check -- a section with real committed
  // items whose groupLabel points at another real section (i.e. it's a
  // merged booth child) but has no buildType set is silently skipped by
  // boothGroupsByCategoryForEditing's own rendering, even though its
  // dollar total is correctly counted -- confirmed live as the exact
  // cause of a real "the tab says 34 items but I only see 7" report. ----
  console.log("\n3. Sections invisible in category tabs despite holding real cost");
  const sections = await db.estimateSection.findMany({
    where: { estimateVersionId: versionId, optionId: null },
    select: { id: true, name: true, groupLabel: true, buildType: true, _count: { select: { lineItems: true } } },
  });
  const sectionIds = new Set(sections.map((s) => s.id));
  const invisible = sections.filter(
    (s) => s.groupLabel && sectionIds.has(s.groupLabel) && !s.buildType && s._count.lineItems > 0,
  );
  if (invisible.length === 0) {
    ok("No sections with real line items are missing a buildType tag.");
  } else {
    for (const s of invisible) {
      const sectionItems = items.filter((i) => i.sectionId === s.id);
      const sum = sectionItems.reduce((sum2, i) => sum2 + Number(i.totalCost), 0);
      flag(`[${s.id}] "${s.name}" -- ${s._count.lineItems} items, $${sum.toFixed(2)}, no buildType -- invisible in every category tab`);
    }
  }

  // ---- 4. Category consistency -- flag documents whose committed items
  // are scattered across many different categories, and any item with no
  // category at all (silently rolls up into whichever tab treats null as
  // its catch-all, rather than the category the estimator expects). ----
  console.log("\n4. Category consistency");
  const uncategorized = items.filter((i) => i.category == null);
  if (uncategorized.length === 0) {
    ok("No uncategorized line items.");
  } else {
    const sum = uncategorized.reduce((s, i) => s + Number(i.totalCost), 0);
    flag(`${uncategorized.length} items with no category at all, $${sum.toFixed(2)} -- silently rolls up into a catch-all tab`);
  }
  for (const [docKey, arr] of byDoc) {
    if (docKey === "(no document / manual entry)") continue;
    const categoriesUsed = new Set(arr.map((i) => i.category ?? "(none)"));
    if (categoriesUsed.size > 1) {
      const doc = docById.get(docKey);
      flag(`"${doc?.filename ?? docKey}" content is split across ${categoriesUsed.size} categories: ${[...categoriesUsed].join(", ")}`);
    }
  }

  // ---- 5. Drafts pending review -- excluded from totalCost/grandTotal
  // by design until reviewed, but a large draft balance is exactly what
  // makes "why does the total look wrong" reports show up. ----
  console.log("\n5. Drafts pending review");
  const draftItems = items.filter((i) => i.isDraft);
  if (draftItems.length === 0) {
    ok("No draft line items -- every committed dollar is already counted.");
  } else {
    const sum = draftItems.reduce((s, i) => s + Number(i.totalCost), 0);
    flag(`${draftItems.length} items still draft, $${sum.toFixed(2)} not yet counted in totals`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(issuesFound === 0 ? "All checks passed." : `${issuesFound} issue(s) flagged above -- review before trusting the totals.`);

  await db.$disconnect();
  process.exit(issuesFound === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
