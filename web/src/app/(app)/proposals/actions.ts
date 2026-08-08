"use server";

import { sendProposal, signProposal } from "@/lib/proposal-service";
import { revalidatePath } from "next/cache";

export async function sendProposalAction(proposalId: string) {
  await sendProposal(proposalId);
  revalidatePath(`/proposals/${proposalId}`);
}

export async function signProposalAction(proposalId: string, formData: FormData) {
  const signedByName = String(formData.get("signedByName") ?? "");
  const signedByTitle = String(formData.get("signedByTitle") ?? "");
  await signProposal(proposalId, signedByName, signedByTitle || null);
  revalidatePath(`/proposals/${proposalId}`);
}
