// Real-data recalibration check for DRAWING_BATCH_TIME_ESTIMATE_MINUTES
// (drawing-ai-client.ts) -- that constant is still "1" from before Pass 1
// (identifyDrawingElements) existed, calibrated purely on Pass 2's 5
// batches (~41s). Runs the REAL current two-pass pipeline end-to-end
// against the real Titleist file to get a fresh, current total-duration
// data point, since the only one on record under the current code is the
// flagged 6m31s outlier.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { db } from "../src/lib/db";
import { uploadDocument } from "../src/lib/document-service";
import { proposeLineItemsFromDrawing } from "../src/lib/ai/drawing-line-item-service";

const FILE_PATH = "/Users/ryanmorrow/Downloads/Titleist/Titleist 2027 - DESIGN V1F GeneralMeasurements.pdf";

async function main() {
  const company = await db.company.create({ data: { name: "Duration Recalibrate Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Duration Recalibrate" } });
  const bytes = await readFile(FILE_PATH);
  const file = new File([new Uint8Array(bytes)], "titleist-duration-recalibrate.pdf", { type: "application/pdf" });
  const document = await uploadDocument(opportunity.id, { file, documentType: "DRAWING" });

  const wallStart = Date.now();
  await proposeLineItemsFromDrawing(document.id, opportunity.id);
  const totalMs = Date.now() - wallStart;

  const doc = await db.document.findUniqueOrThrow({
    where: { id: document.id },
    select: { lineItemProposalStartedAt: true, lineItemProposalBatchTotal: true },
  });
  console.log(`\nTotal wall time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Pass-2 batch total (this run's real page count / batch size 3): ${doc.lineItemProposalBatchTotal}`);
  console.log(`Total AI calls this run: ${(doc.lineItemProposalBatchTotal ?? 0) + 1} (Pass 1 + Pass 2 batches)`);

  console.log(`\nopportunityId=${opportunity.id} documentId=${document.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
