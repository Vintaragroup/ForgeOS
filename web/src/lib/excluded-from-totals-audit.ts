// Surfaces every booth/section flagged EstimateSection.excludedFromTotals
// (see that field's own schema comment) as a real, actionable review item
// -- same "pure function over already-loaded data" shape as
// category-audit.ts, so the Line Items tab's own quick banner, the Review
// tab's detailed card, and the cross-opportunity Dashboard list
// (dashboard.ts) all agree on exactly what counts as "flagged" and how
// it's grouped, instead of three separately-drifting computations.
//
// Added after a real production estimate had $139k of internal reference
// data (a labor/freight rate comparison an estimator was pricing against
// another vendor) silently counted in both the estimate's own Grand Total
// and the client-facing PDF -- discovered only by manual investigation.
// The point of this module is that nobody should have to rediscover that
// by accident again: whatever gets excludedFromTotals shows up here,
// with enough context to actually resolve it.

export interface ExcludedLineItem {
  id: string;
  description: string;
  totalCost: number;
  // Null for a manually-typed line item -- there's no document to check
  // it against (see LineItem.documentId's own schema comment). This is
  // the correct, honest state to show, not an error -- the real Craig
  // Wells "Bid Comparison" example this was built from was entered
  // directly, no import involved.
  document: { id: string; mimeType: string } | null;
  sourceQuote: string | null;
  sourcePageNumber: number | null;
}

export interface ExcludedGroupIssue {
  groupLabel: string;
  cost: number;
  itemCount: number;
  createdAt: Date;
  // Null when the audit log has no CREATE entry for any of this group's
  // line items -- most jobs' data predates line-item audit logging
  // entirely, or the section was created some other way (bulk import).
  actorName: string | null;
  items: ExcludedLineItem[];
}

interface AuditableLineItem {
  id: string;
  description: string;
  totalCost: { toString(): string } | number;
  isDraft?: boolean;
  documentId?: string | null;
  document?: { id: string; mimeType: string } | null;
  sourceQuote?: string | null;
  sourcePageNumber?: number | null;
}

interface AuditableSection {
  groupLabel: string | null;
  excludedFromTotals?: boolean;
  createdAt: Date;
  lineItems: AuditableLineItem[];
}

interface AuditLogEntry {
  action: string;
  lineItemId: string | null;
  actor: { name: string } | null;
}

export function auditExcludedFromTotals(
  sections: AuditableSection[],
  auditLog: AuditLogEntry[],
): ExcludedGroupIssue[] {
  const groupLabels = [
    ...new Set(sections.filter((s) => s.excludedFromTotals && s.groupLabel).map((s) => s.groupLabel!)),
  ];

  return groupLabels.map((groupLabel) => {
    const groupSections = sections.filter((s) => s.groupLabel === groupLabel && s.excludedFromTotals);
    const lineItems = groupSections.flatMap((s) => s.lineItems).filter((li) => !li.isDraft);
    const lineItemIds = new Set(lineItems.map((li) => li.id));
    const createEntry = auditLog.find(
      (log) => log.action === "CREATE" && log.lineItemId && lineItemIds.has(log.lineItemId),
    );
    const earliestCreatedAt = groupSections.reduce(
      (min, s) => (s.createdAt < min ? s.createdAt : min),
      groupSections[0].createdAt,
    );

    return {
      groupLabel,
      cost: lineItems.reduce((sum, li) => sum + Number(li.totalCost), 0),
      itemCount: lineItems.length,
      createdAt: earliestCreatedAt,
      actorName: createEntry?.actor?.name ?? null,
      items: lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        totalCost: Number(li.totalCost),
        document: li.document ?? null,
        sourceQuote: li.sourceQuote ?? null,
        sourcePageNumber: li.sourcePageNumber ?? null,
      })),
    };
  });
}

// Shared by the Line Items tab banner, the Review tab card, and the
// Dashboard's cross-opportunity list -- an anchor id/query param has to
// agree across all three or the hyperlinks between them silently 404 into
// nothing. Lowercased, non-alphanumeric runs collapsed to a single hyphen
// -- good enough for a real booth label ("FS - Hitting Bay Wall" ->
// "fs-hitting-bay-wall"); collisions between two differently-cased or
// differently-punctuated labels that slug to the same string are the same
// acceptable edge case every other anchor-id scheme in this app already
// accepts (e.g. line-item-row.tsx's own `#line-item-${id}`, which doesn't
// have this problem only because ids are already unique).
export function slugifyGroupLabel(groupLabel: string): string {
  return groupLabel
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
