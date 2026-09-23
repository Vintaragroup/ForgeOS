"use server";

import { recordProposalStatus, requestProposalRevisions, sendProposal, signProposal } from "@/lib/proposal-service";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";
import type { ProposalStatus } from "@/generated/prisma/enums";
import { requireProposalAccess } from "@/lib/opportunity-access";
import { revalidatePath } from "next/cache";

// Blank means "now", which is the normal case. A date is only given when
// recording something that already happened outside ForgeOS. Noon local
// rather than midnight: a date-only input has no timezone, and midnight
// lands on the previous day for anyone behind UTC.
function parseWhen(formData: FormData | undefined, field: string): Date | undefined {
  const raw = String(formData?.get(field) ?? "").trim();
  if (!raw) return undefined;
  const at = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(at.getTime())) throw new UserError("That isn't a date.");
  return at;
}

export async function sendProposalAction(proposalId: string, formData?: FormData) {
  await requireProposalAccess(proposalId);
  await sendProposal(proposalId, parseWhen(formData, "sentAt"));
  revalidatePath(`/proposals/${proposalId}`);
  revalidatePath("/estimates", "layout");
}

export async function signProposalAction(proposalId: string, formData: FormData) {
  await requireProposalAccess(proposalId);
  const signedByName = String(formData.get("signedByName") ?? "");
  const signedByTitle = String(formData.get("signedByTitle") ?? "");
  await signProposal(proposalId, signedByName, signedByTitle || null);
  revalidatePath(`/proposals/${proposalId}`);
}

// --- lifecycle ---------------------------------------------------------
//
// Both return an ActionResult rather than throwing: a refused attestation
// and a stale status are things the person can fix, and Next.js redacts
// every error thrown out of a Server Action in production (see
// user-error.ts, and assistant-actions.ts for the same lesson learned the
// hard way).

async function actorFor(proposalId: string) {
  const user = await requireProposalAccess(proposalId);
  return {
    user,
    actor: {
      systemRole: user.systemRole,
      isSalesManager: user.isSalesManager,
      isDepartmentHead: user.isDepartmentHead,
    },
  };
}

export async function recordProposalStatusAction(
  proposalId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return catchUserError(async () => {
    const { user, actor } = await actorFor(proposalId);
    const toStatus = String(formData.get("toStatus") ?? "").trim() as ProposalStatus;
    if (!toStatus) throw new UserError("Pick a status.");

    await recordProposalStatus(proposalId, toStatus, {
      note: String(formData.get("note") ?? ""),
      byUserId: user.id,
      actor,
      managerConsulted: formData.get("managerConsulted") === "on",
      // Every one of these records something that happened in a client
      // conversation, and those get typed in after the fact. The date
      // the meeting happened is the useful one, not the date somebody
      // got round to logging it.
      at: parseWhen(formData, "at"),
    });
    revalidatePath(`/proposals/${proposalId}`);
    revalidatePath("/estimates", "layout");
  });
}

// The "updated costing requested" button: records what the client asked
// for, then opens the next version so the revised pricing has somewhere
// to land. The sent version is left exactly as it was.
export async function requestProposalRevisionsAction(
  proposalId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return catchUserError(async () => {
    const { user, actor } = await actorFor(proposalId);
    await requestProposalRevisions(proposalId, String(formData.get("note") ?? ""), user.id, {
      actor,
      managerConsulted: formData.get("managerConsulted") === "on",
    });
    revalidatePath(`/proposals/${proposalId}`);
    revalidatePath("/estimates", "layout");
  });
}
