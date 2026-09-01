// One-time (re-runnable) backfill for chat roadmap Phase 3: indexes every
// already-analyzed document that has no chunks yet. Nothing regresses
// without running this -- chat-context-service.ts already falls back to
// a document's full text until it has chunks -- but a document analyzed
// before Phase 3 shipped won't get retrieval's scaling benefit until
// it's indexed once, either by this script or by re-clicking Analyze on
// it. Idempotent: a document that already has chunks is skipped
// entirely, not re-embedded.
//
// Costs real OpenAI usage (one embeddings call per document, batched
// internally) -- run it deliberately, not as part of every deploy.
//
// Run with: npx tsx scripts/backfill-document-embeddings.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { indexDocument } from "../src/lib/ai/document-embedding-service";

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const candidates = await db.document.findMany({
    where: { deletedAt: null, extractionStatus: "COMPLETE", extractedText: { not: null } },
    select: { id: true, opportunityId: true, filename: true, extractedText: true },
  });

  const alreadyIndexed = new Set(
    (await db.documentChunk.findMany({ select: { documentId: true }, distinct: ["documentId"] })).map(
      (c) => c.documentId,
    ),
  );

  const toIndex = candidates.filter((d) => !alreadyIndexed.has(d.id));
  console.log(`${candidates.length} analyzed document(s) with text; ${toIndex.length} not yet indexed.`);

  let indexed = 0;
  let failed = 0;
  for (const doc of toIndex) {
    try {
      await indexDocument(doc.id, doc.opportunityId, doc.extractedText!);
      indexed++;
      console.log(`  indexed: ${doc.filename} (${doc.id})`);
    } catch (err) {
      failed++;
      console.error(`  FAILED: ${doc.filename} (${doc.id}) -- ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`Done. Indexed ${indexed}, failed ${failed}, already had chunks ${candidates.length - toIndex.length}.`);
  await db.$disconnect();
}

main();
