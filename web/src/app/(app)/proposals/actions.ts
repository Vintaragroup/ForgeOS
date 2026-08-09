"use server";

import { sendProposal, signProposal } from "@/lib/proposal-service";
import { requireProposalAccess } from "@/lib/opportunity-access";
import { revalidatePath } from "next/cache";

export async function sendProposalAction(proposalId: string) {
  await requireProposalAccess(proposalId);
  await sendProposal(proposalId);
  revalidatePath(`/proposals/${proposalId}`);
}

export async function signProposalAction(proposalId: string, formData: FormData) {
  await requireProposalAccess(proposalId);
  const signedByName = String(formData.get("signedByName") ?? "");
  const signedByTitle = String(formData.get("signedByTitle") ?? "");
  await signProposal(proposalId, signedByName, signedByTitle || null);
  revalidatePath(`/proposals/${proposalId}`);
}
