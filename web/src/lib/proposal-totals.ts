// Every money figure a proposal prints beneath its itemized rows, in one
// place, because there used to be two.
//
// The Proposal PDF and the web proposal page each carried their own copy
// of this arithmetic. Every correction this week -- burying, the margin
// gross-up, the taxable basis -- landed in the PDF's copy, and the page's
// copy stayed where it was. The two then disagreed about the same
// estimate: the page showed raw COST under a PRICE grand total, and left
// out every buried section, which on ABC Chicago was $38,738.10 of cost
// missing from a figure a rep reads out loud.
//
// So neither surface computes this any more. They render what this
// returns, and they cannot drift apart again without changing it here.
//
// A leaf module: pure functions over plain view rows, no db import.
import type { Category } from "@/generated/prisma/client";
import {
  aggregateByCategory,
  bucketSubtotal,
  computeRentalAndServicesTotals,
  foldOmittedIntoTotals,
  type ProposalViewSection,
} from "@/lib/proposal-view-model";

export interface ProposalTotals {
  // Raw cost, kept for the internal Cost -> Price display only.
  rentalTotal: number;
  servicesTotal: number;
  // What the client actually pays, each bucket grossed up at its OWN
  // category's margin rather than the whole sum at one rate.
  sellRentalTotal: number;
  sellServicesTotal: number;
  totalCostSum: number;
  // Whether to draw the split at all -- deliberately decided on VISIBLE
  // buckets, so a document whose only show-service cost is buried does
  // not grow a split that explains nothing.
  hasServiceSplit: boolean;
  // Only rental components are taxable; services are not. The same basis
  // both surfaces label "Total taxable".
  taxableBasis: number;
  grandTotal: number;
}

export function computeProposalTotals(
  sections: ProposalViewSection[],
  categories: Category[],
  sellForCategory: (cost: number, categoryName: string) => number,
  showServiceCategoryNames: ReadonlySet<string>,
): ProposalTotals {
  const buckets = aggregateByCategory(sections, categories);
  const { rentalTotal: visibleRental, servicesTotal: visibleServices, hasServiceSplit } =
    computeRentalAndServicesTotals(buckets, showServiceCategoryNames);
  const sellOf = (wantService: boolean) =>
    buckets
      .filter((b) => showServiceCategoryNames.has(b.name) === wantService)
      .reduce((sum, b) => sum + sellForCategory(bucketSubtotal(b.items), b.name), 0);

  // Buried sections are excluded from buckets above, exactly like fully
  // hidden ones; this is what puts their money back into the totals
  // without it ever printing as a row. See foldOmittedIntoTotals.
  const folded = foldOmittedIntoTotals(
    {
      rentalTotal: visibleRental,
      servicesTotal: visibleServices,
      sellRentalTotal: sellOf(false),
      sellServicesTotal: sellOf(true),
      totalCostSum: buckets.reduce((sum, b) => sum + bucketSubtotal(b.items), 0),
    },
    sections.filter((s) => s.omittedFromProposal),
    categories,
    showServiceCategoryNames,
    sellForCategory,
  );

  return {
    ...folded,
    hasServiceSplit,
    taxableBasis: folded.sellRentalTotal,
    grandTotal: folded.sellRentalTotal + folded.sellServicesTotal,
  };
}
