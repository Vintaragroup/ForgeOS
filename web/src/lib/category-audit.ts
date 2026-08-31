// Surfaces exactly what aggregateByCategory (proposal-view-model.ts)
// already silently detects and papers over with its "Other" fallback --
// as a visible, actionable signal instead. Two genuinely distinct hard
// failure states, not one: a line item that was never categorized at all
// (category is null) versus one that was categorized once but now
// references a category that no longer exists in the live catalog
// (renamed with no cascade, or deleted). A line item explicitly and
// correctly filed under the real "Other" category is never flagged --
// "Other" is a legitimate catch-all for genuinely miscellaneous items
// (e.g. "Or other proprietary system", "Daily Rate" on a real job), not
// itself a problem.
//
// A third, deliberately SOFT state: a line item sitting on a flat Type
// category (e.g. plain "Structure") that supports a Rental/Purchase/
// Custom Fabricated split but never got one -- resolveAcquisitionMethod
// couldn't infer a Method from its own text/catalog source, and no
// estimator has tagged its booth. This is an expected, legitimate
// resting state (see resolveComposedCategory/resolveEffectiveCategory's
// own "never guess" fallback), not a broken reference -- it renders
// fine, just without a Method breakdown -- so it's tracked separately
// from `issues` and never affects `isClean`/the send-proposal gate.

import type { Category } from "@/generated/prisma/client";
import { TYPE_KEYS_WITH_METHOD_SPLIT } from "@/lib/line-item-category";

export interface CategoryAuditIssue {
  lineItemId: string;
  description: string;
  sectionName: string;
  groupLabel: string | null;
  category: string | null;
  reason: "uncategorized" | "orphaned";
}

export interface MethodUnresolvedIssue {
  lineItemId: string;
  description: string;
  sectionName: string;
  groupLabel: string | null;
  category: string;
}

export interface CategoryAuditResult {
  issues: CategoryAuditIssue[];
  methodUnresolvedIssues: MethodUnresolvedIssue[];
  isClean: boolean;
}

interface AuditableLineItem {
  id: string;
  description: string;
  category: string | null;
}

interface AuditableSection {
  name: string;
  groupLabel: string | null;
  lineItems: AuditableLineItem[];
}

// Scans exactly the population that renders on a sent proposal -- every
// line item in every passed-in section, regardless of isDraft (neither
// proposal-pdf.tsx nor proposals/[id]/page.tsx filter draft items out),
// so this audit can never be cleaner than what a client would actually
// see. Callers decide which sections to pass (proposal-service.ts's
// sendProposal scopes to optionId: null; the estimate page passes the
// currently-viewed version's sections directly).
export function auditLineItemCategories(
  sections: AuditableSection[],
  categories: Pick<Category, "name" | "key">[],
): CategoryAuditResult {
  const issues: CategoryAuditIssue[] = [];
  const methodUnresolvedIssues: MethodUnresolvedIssue[] = [];
  for (const section of sections) {
    for (const li of section.lineItems) {
      if (li.category === null) {
        issues.push({
          lineItemId: li.id,
          description: li.description,
          sectionName: section.name,
          groupLabel: section.groupLabel,
          category: null,
          reason: "uncategorized",
        });
        continue;
      }
      const ownCategory = categories.find((c) => c.name === li.category);
      if (!ownCategory) {
        issues.push({
          lineItemId: li.id,
          description: li.description,
          sectionName: section.name,
          groupLabel: section.groupLabel,
          category: li.category,
          reason: "orphaned",
        });
      } else if ((TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(ownCategory.key)) {
        methodUnresolvedIssues.push({
          lineItemId: li.id,
          description: li.description,
          sectionName: section.name,
          groupLabel: section.groupLabel,
          category: li.category,
        });
      }
    }
  }
  return { issues, methodUnresolvedIssues, isClean: issues.length === 0 };
}
