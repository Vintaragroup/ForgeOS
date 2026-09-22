"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireArtworkOrderAccess } from "@/lib/opportunity-access";
import { setProductionDetail, transitionArtworkOrder } from "@/lib/artwork-order-service";
import { notifyVendorGoAhead } from "@/lib/artwork-notifications";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";

// The two things a producer working the Graphics queue does often enough
// that opening the piece to do them is the slow path.
//
// Deliberately NOT a general "advance this order" action. Most steps in
// ARTWORK_TRANSITIONS either happen automatically (SUBMITTED and
// PROOF_SUBMITTED are routed on by the system, not by a person), belong to
// the vendor or client portal, or need someone to actually look at the
// artwork before deciding -- approving art, checking a proof, resolving an
// escalation. Putting those behind a one-click dashboard button would make
// it easy to advance a piece nobody had looked at.
//
// Both return an ActionResult rather than throwing, so a validation
// failure reads as a message on the row instead of a generic production
// error boundary -- see user-error.ts.

export async function assignDesignerAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return catchUserError(async () => {
    const artworkOrderId = String(formData.get("artworkOrderId") ?? "").trim();
    if (!artworkOrderId) throw new UserError("Missing the piece to assign.");
    const user = await requireArtworkOrderAccess(artworkOrderId);

    // "" is a real choice here (Unassign), so an empty value maps to null
    // rather than being rejected as missing.
    const raw = String(formData.get("designerId") ?? "").trim();
    const designerId = raw === "" ? null : raw;
    if (designerId) {
      // A designerId submitted from a form is not trusted to be someone
      // this picker would actually have offered.
      const designer = await db.user.findFirst({
        where: { id: designerId, departmentCode: "DE", deletedAt: null },
        select: { id: true },
      });
      if (!designer) throw new UserError("That person isn't in the Design department.");
    }

    await setProductionDetail(artworkOrderId, { designerId }, { type: "EXPO", userId: user.id });
    revalidatePath("/departments/graphics");
    revalidatePath(`/artwork/${artworkOrderId}`);
  });
}

// Same operation as the artwork detail page's own "Issue go-ahead to
// vendor" (issueProductionGoAheadAction), reachable from the queue row.
// It emails the vendor, so it is behind a confirm step in the UI rather
// than being a bare one-click button.
export async function issueGoAheadFromDashboardAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return catchUserError(async () => {
    const artworkOrderId = String(formData.get("artworkOrderId") ?? "").trim();
    if (!artworkOrderId) throw new UserError("Missing the piece to send.");
    const user = await requireArtworkOrderAccess(artworkOrderId);

    // Re-checked here, not just in the UI: the row that rendered this
    // button may be a stale render of a piece someone else has since
    // moved on.
    const order = await db.artworkOrder.findUniqueOrThrow({
      where: { id: artworkOrderId },
      select: { status: true },
    });
    if (order.status !== "PROOF_APPROVED") {
      throw new UserError("This piece is no longer waiting on a go-ahead -- reload to see where it is now.");
    }

    await transitionArtworkOrder(artworkOrderId, "PRODUCTION_GO_AHEAD", "ISSUE_GO_AHEAD", {
      type: "EXPO",
      userId: user.id,
    });
    const invite = await db.artworkPortalInvite.findFirst({
      where: { artworkOrderId, role: "VENDOR" },
      orderBy: { createdAt: "desc" },
      select: { email: true },
    });
    if (invite?.email) await notifyVendorGoAhead(artworkOrderId, invite.email);

    revalidatePath("/departments/graphics");
    revalidatePath(`/artwork/${artworkOrderId}`);
  });
}
