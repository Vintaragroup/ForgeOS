"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireArtworkOrderAccess } from "@/lib/opportunity-access";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { markSkidSent } from "@/lib/skid-service";
import { setProductionDetail, transitionArtworkOrder } from "@/lib/artwork-order-service";
import { setHalfProductionStatus } from "@/lib/artwork-routing";
import type { ArtworkProductionStatus } from "@/generated/prisma/enums";
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

// Move ONE half of a piece along, from the shop-floor row. The whole point
// of per-half status is that the vendor coming back doesn't touch what the
// sign shop is doing, so this never writes the other half -- see
// setHalfProductionStatus's own comment.
export async function setHalfStatusFromDashboardAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return catchUserError(async () => {
    const routingId = String(formData.get("routingId") ?? "").trim();
    const status = String(formData.get("productionStatus") ?? "").trim();
    if (!routingId) throw new UserError("Missing the production half to update.");
    if (!status) throw new UserError("Pick a status.");

    // Access is checked against the routing's OWN order, looked up here
    // rather than taken from the form -- a routingId is not something the
    // browser should be able to pair with an arbitrary order id.
    const routing = await db.artworkOrderRouting.findUnique({
      where: { id: routingId },
      select: { artworkOrderId: true },
    });
    if (!routing) throw new UserError("That production half no longer exists.");
    await requireArtworkOrderAccess(routing.artworkOrderId);

    await setHalfProductionStatus(routingId, status as ArtworkProductionStatus);
    revalidatePath("/departments/graphics");
    revalidatePath(`/artwork/${routing.artworkOrderId}`);
  });
}

// A crate physically leaves. markSkidSent does the real checking (already
// sent, nothing packed on it), so this only establishes who is asking --
// a skid is show-scoped, not opportunity-scoped, so access is the
// department grant rather than requireArtworkOrderAccess.
export async function markSkidSentFromDashboardAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  return catchUserError(async () => {
    const skidId = String(formData.get("skidId") ?? "").trim();
    if (!skidId) throw new UserError("Missing the skid to send.");

    const user = await getCurrentUser();
    if (!user) throw new Error("Not authenticated");
    const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
    if (!isAdmin && !canAccessArtworkOrdersViaDepartment(user)) {
      throw new UserError("Only Graphics can mark a skid as sent.");
    }

    await markSkidSent(skidId);
    revalidatePath("/departments/graphics");
    revalidatePath("/shows");
  });
}
