// Recomputes every opportunity's timeline from its anchor dates.
//
// These milestones used to be read off documents by a model. They are
// arithmetic on two entered dates now (see timeline-service.ts), so the
// timelines written before that are guesses standing where facts belong.
//
// Dry run by default. Pass --apply to write.
//
//   npx tsx scripts/recompute-timelines.mts [--apply] [--id <opportunityId>]
//
// What it will NOT touch, in order of precedence:
//   - a row an estimator edited by hand (source MANUAL with a real date)
//   - a row already confirmed
//   - ANY row whose anchor is missing, which is left exactly as it is
//
// That last one was added after the first dry run, which would have wiped
// both of the most advanced jobs in the system. Their anchors had never
// been entered as structured dates -- the only record of the ship date was
// the SHIPPING milestone itself -- so "recompute from the formula" meant
// eleven real dates replaced by blanks.
//
// So this promotes the anchors first: where a structured field is empty
// and the existing timeline carries the milestone that field feeds, the
// field adopts that date. Then the formula runs from real anchors, and the
// rest of the timeline follows from them instead of being erased by them.
import { db } from "@/lib/db";
import { writeFileSync } from "node:fs";
import {
  buildDeterministicMilestones,
  getTimelineData,
  resolveAnchorDates,
  type TimelineData,
  type TimelineMilestone,
} from "@/lib/timeline-service";
import type { Prisma } from "@/generated/prisma/client";

const apply = process.argv.includes("--apply");
const idFlag = process.argv.indexOf("--id");
const onlyId = idFlag !== -1 ? process.argv[idFlag + 1] : null;

const opportunities = await db.opportunity.findMany({
  where: { deletedAt: null, ...(onlyId ? { id: onlyId } : {}) },
  select: {
    id: true,
    showName: true,
    targetMoveIn: true,
    targetMoveOut: true,
    eventStartDate: true,
    shipDate: true,
    signedProposalTargetDate: true,
    timelineMilestones: true,
    show: { select: { shipDate: true, targetMoveIn: true, targetMoveOut: true, eventStartDate: true } },
  },
  orderBy: { createdAt: "asc" },
});

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

// The milestone that records each anchor, for reading an anchor back out
// of a timeline that was written before anchors existed.
const ANCHOR_FROM_MILESTONE = {
  shipDate: "SHIPPING",
  targetMoveIn: "INSTALLATION",
  eventStartDate: "SHOW_OPEN",
  targetMoveOut: "DISMANTLE",
  signedProposalTargetDate: "SIGNED_PROPOSAL",
} as const;

type Change = { type: string; before: string | null; after: string | null; kept: boolean };
type Adoption = { field: string; date: Date };
const plan: {
  id: string;
  showName: string;
  changes: Change[];
  milestones: TimelineMilestone[];
  adoptions: Adoption[];
}[] = [];

for (const opportunity of opportunities) {
  const existing = getTimelineData(opportunity.timelineMilestones);
  const existingByType = new Map(existing?.milestones.map((m) => [m.type, m]) ?? []);

  // Promote anchors the timeline already knows into the fields that should
  // have held them all along.
  const resolved = resolveAnchorDates(opportunity, opportunity.show);
  const adoptions: Adoption[] = [];
  const anchors = { ...resolved };
  for (const [field, milestoneType] of Object.entries(ANCHOR_FROM_MILESTONE)) {
    const key = field as keyof typeof anchors;
    if (anchors[key]) continue;
    const recorded = existingByType.get(milestoneType as TimelineMilestone["type"])?.date;
    if (!recorded) continue;
    const date = new Date(recorded);
    anchors[key] = date;
    adoptions.push({ field, date });
  }

  const fresh = buildDeterministicMilestones(anchors);

  const milestones = fresh.map((m) => {
    const prior = existingByType.get(m.type);
    // A hand edit or a reviewed date is somebody's decision, not a guess.
    const decided = prior && prior.date !== null && (prior.source === "MANUAL" || prior.confirmed);
    // And a date the formula cannot produce is kept rather than erased.
    // Recomputing is meant to correct a timeline, never to empty one.
    const wouldErase = m.date === null && prior?.date != null;
    return decided || wouldErase ? prior! : m;
  });

  const changes: Change[] = milestones.map((m, i) => {
    const prior = existingByType.get(m.type);
    const kept = prior !== undefined && prior === m;
    return { type: m.type, before: prior?.date ?? null, after: kept ? (prior?.date ?? null) : fresh[i].date, kept };
  });

  const moved = changes.filter((c) => !c.kept && (c.before ?? null) !== (c.after ?? null));
  if (moved.length === 0 && adoptions.length === 0) continue;
  plan.push({ id: opportunity.id, showName: opportunity.showName, changes, milestones, adoptions });
}

console.log(`${opportunities.length} opportunities read, ${plan.length} whose timeline would change.\n`);
let movedRows = 0;
let clearedRows = 0;
for (const entry of plan) {
  console.log(`${entry.showName}  (${entry.id})`);
  for (const a of entry.adoptions) {
    console.log(`    adopt   ${a.field.padEnd(24)} ${a.date.toISOString().slice(0, 10)}  (read from its own timeline)`);
  }
  for (const c of entry.changes) {
    if (c.kept) {
      const prior = entry.milestones.find((m) => m.type === c.type);
      if (prior?.date) console.log(`    keep    ${c.type.padEnd(20)} ${day(prior.date)}  (edited or confirmed)`);
      continue;
    }
    if ((c.before ?? null) === (c.after ?? null)) continue;
    if (c.after === null) clearedRows += 1;
    else movedRows += 1;
    console.log(`    ${c.after === null ? "CLEAR " : "move  "}  ${c.type.padEnd(20)} ${day(c.before)} -> ${day(c.after)}`);
  }
  console.log("");
}
console.log(`${movedRows} dates would move, ${clearedRows} would be cleared for want of an anchor.`);

if (!apply) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

writeFileSync(
  `/tmp/recompute-timelines-backup-${Date.now()}.json`,
  JSON.stringify(
    opportunities.map((o) => ({ id: o.id, timelineMilestones: o.timelineMilestones })),
    null,
    2,
  ),
);

for (const entry of plan) {
  const data: TimelineData = { generatedAt: new Date().toISOString(), milestones: entry.milestones };
  await db.opportunity.update({
    where: { id: entry.id },
    data: {
      timelineMilestones: data as unknown as Prisma.InputJsonValue,
      // Written back so the anchor is a real field from here on -- the page
      // can show it, intake can check it, and the next regenerate computes
      // from it instead of having to rediscover it.
      ...Object.fromEntries(entry.adoptions.map((a) => [a.field, a.date])),
    },
  });
  console.log(`  rewrote ${entry.showName}`);
}
console.log(`\n${plan.length} timelines rewritten.`);
process.exit(0);
