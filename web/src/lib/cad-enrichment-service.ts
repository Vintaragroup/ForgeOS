// Fills a gap in an already-committed, Excel-derived LineItem's
// description using its matching CAD Pull Sheet row -- enrichment, not a
// second import. Confirmed live: a booth workbook's own Type/Part Number
// row is often terse ("1/3M X 1/2M FRAME") while the matching CAD Pull
// Sheet carries the real dimension for that exact part ("310mm x
// 434mm"). Distinct from cad-reconciliation-service.ts, which only
// reports agreement/disagreement between the two documents and never
// writes anything -- this is the write path once you've decided the CAD
// data is worth folding in.
//
// Matched by LineItem.positionCode (design-cost-estimate-import-
// service.ts now stamps the same Part Number onto it at import time) --
// only ever touches a LineItem whose source document shares the CAD's own
// filename stem (see filenameStem's comment), so a coincidentally-equal
// Part Number on an unrelated booth can never cross-contaminate.
import { db } from "@/lib/db";
import { getDocumentBytes } from "@/lib/document-service";
import { extractPullSheetRows } from "@/lib/cad-pull-sheet-service";
import { groupCadByPartNumber, normalizePartNumber, type PartNumberGroup } from "@/lib/cad-reconciliation-service";
import { filenameStem } from "@/lib/document-filename";
import { updateLineItem } from "@/lib/estimate-service";

export interface EnrichmentProposal {
  lineItemId: string;
  currentDescription: string;
  proposedDescription: string;
  partNumber: string;
  cadSize: string;
}

export interface EnrichmentPreview {
  proposals: EnrichmentProposal[];
  alreadyComplete: number;
  noCadMatch: number;
}

export type EnrichmentPreviewResult = EnrichmentPreview | { status: "UNSUPPORTED"; reason: string };

interface EnrichableLineItem {
  id: string;
  description: string;
  positionCode: string;
}

async function loadEnrichableLineItems(estimateVersionId: string, cadStem: string): Promise<EnrichableLineItem[]> {
  const lineItems = await db.lineItem.findMany({
    where: {
      section: { estimateVersionId, optionId: null },
      positionCode: { not: null },
      document: { isNot: null },
    },
    select: { id: true, description: true, positionCode: true, document: { select: { filename: true } } },
  });
  return lineItems
    .filter((li) => filenameStem(li.document!.filename) === cadStem)
    .map((li) => ({ id: li.id, description: li.description, positionCode: li.positionCode! }));
}

function buildProposals(
  lineItems: EnrichableLineItem[],
  cadGroups: Map<string, PartNumberGroup>,
): EnrichmentPreview {
  const proposals: EnrichmentProposal[] = [];
  let alreadyComplete = 0;
  let noCadMatch = 0;

  for (const lineItem of lineItems) {
    const cad = cadGroups.get(normalizePartNumber(lineItem.positionCode));
    if (!cad || !cad.size) {
      noCadMatch++;
      continue;
    }
    if (lineItem.description.toLowerCase().includes(cad.size.toLowerCase())) {
      alreadyComplete++;
      continue;
    }
    proposals.push({
      lineItemId: lineItem.id,
      currentDescription: lineItem.description,
      proposedDescription: `${lineItem.description} (${cad.size})`,
      partNumber: lineItem.positionCode,
      cadSize: cad.size,
    });
  }

  return { proposals, alreadyComplete, noCadMatch };
}

export async function previewPullSheetEnrichment(
  estimateVersionId: string,
  cadDocumentId: string,
): Promise<EnrichmentPreviewResult> {
  const { document, bytes } = await getDocumentBytes(cadDocumentId);
  const pullSheet = await extractPullSheetRows(bytes);
  if (pullSheet.status !== "COMPLETE") {
    return { status: "UNSUPPORTED", reason: pullSheet.reason };
  }

  const cadGroups = groupCadByPartNumber(pullSheet.rows);
  const lineItems = await loadEnrichableLineItems(estimateVersionId, filenameStem(document.filename));
  return buildProposals(lineItems, cadGroups);
}

export async function applyPullSheetEnrichment(
  opportunityId: string,
  estimateVersionId: string,
  cadDocumentId: string,
): Promise<{ updated: number } | { status: "UNSUPPORTED"; reason: string }> {
  const preview = await previewPullSheetEnrichment(estimateVersionId, cadDocumentId);
  if ("status" in preview) return preview;

  for (const proposal of preview.proposals) {
    await updateLineItem(opportunityId, proposal.lineItemId, { description: proposal.proposedDescription });
  }
  return { updated: preview.proposals.length };
}
