"use server";

import { convertOpportunityToEstimate } from "@/lib/opportunity-service";
import { convertOpportunityToProject } from "@/lib/project-service";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/**
 * docs/migration-plan.md Phase 2 scope: '"convert opportunity -> new
 * estimate" action that pre-fills Start Page-equivalent fields from the
 * Opportunity record.'
 *
 * The Estimate model is a deliberate stub (see prisma/schema.prisma) --
 * no line items, no pricing math, that's Phase 3's EstimateVersion/
 * LineItem work. All the "pre-filled" job identity (company, show name,
 * booth number) already lives on the Opportunity this Estimate points
 * back to; there's nothing to copy forward yet because Estimate doesn't
 * carry its own copy of those fields (by design -- avoids two sources of
 * truth for the same job identity before Phase 3 defines how estimates
 * actually consume it).
 *
 * The actual transaction (create Estimate + advance stage + log the
 * event) lives in src/lib/opportunity-service.ts, kept separate so it's
 * testable without fighting Server Action-only APIs like redirect().
 */
export async function convertToEstimate(opportunityId: string) {
  await convertOpportunityToEstimate(opportunityId);

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${opportunityId}`);
  redirect(`/opportunities/${opportunityId}`);
}

// docs/migration-plan.md Phase 5: "Convert to Project" from a WON
// Opportunity. No stage change here -- WON is already the opportunity's
// terminal pipeline stage.
export async function convertToProject(opportunityId: string) {
  const project = await convertOpportunityToProject(opportunityId);

  revalidatePath("/opportunities");
  revalidatePath(`/opportunities/${opportunityId}`);
  redirect(`/projects/${project.id}`);
}
