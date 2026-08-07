"use server";

import { sendProposal, signProposal } from "@/lib/proposal-service";
import { revalidatePath } from "next/cache";

export async function sendProposalAction(proposalId: string) {
  await sendProposal(proposalId);
  revalidatePath(`/proposals/${proposalId}`);
}

export async function signProposalAction(proposalId: string) {
  await signProposal(proposalId);
  revalidatePath(`/proposals/${proposalId}`);
}
