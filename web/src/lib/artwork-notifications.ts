// One function per row of the artwork pipeline spec's notification matrix
// (Section 4) -- kept separate from artwork-order-service.ts so that file
// stays pure state-machine logic, and separate from the individual Server
// Action files so the actual email copy lives in exactly one place per
// notification rather than being duplicated at each call site.
//
// Every function that links a recipient back to their portal calls
// issuePortalInvite fresh, rather than trying to reuse an earlier one --
// only tokenHash is ever persisted (see ArtworkPortalInvite's schema
// comment), so the raw token from an earlier issuePortalInvite call is
// already gone by the time a LATER notification needs to link the same
// person again. Since tokens are durable and not single-use, having
// several valid invite rows accumulate per person over an order's
// lifecycle is harmless -- they all resolve to the same identity.
import { db } from "@/lib/db";
import { getAppBaseUrl, sendEmail } from "@/lib/email";
import { issuePortalInvite } from "@/lib/artwork-portal-auth";

async function clientPortalLink(artworkOrderId: string, email: string): Promise<string> {
  const { magicLinkToken } = await issuePortalInvite(artworkOrderId, "CLIENT", email);
  return `${getAppBaseUrl()}/client-portal/${magicLinkToken}`;
}

async function vendorPortalLink(artworkOrderId: string, email: string): Promise<string> {
  const { magicLinkToken } = await issuePortalInvite(artworkOrderId, "VENDOR", email);
  return `${getAppBaseUrl()}/vendor-portal/${magicLinkToken}`;
}

// "Account Rep"/"Art Dept" in the spec both resolve to internal Users on
// this Opportunity -- there's no distinct Art Dept role modeled (see
// OpportunityCollaborator's own schema comment), so both the owner and the
// assigned sales rep are notified, deduplicated. Matches the spec's own
// "fixed role... no standalone UI needed" framing for v1.
async function getInternalNotifyEmails(opportunityId: string): Promise<string[]> {
  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: { owner: { select: { email: true } }, salesRep: { select: { email: true } } },
  });
  return [...new Set([opportunity.owner?.email, opportunity.salesRep?.email].filter((e): e is string => !!e))];
}

// Row 1: Expo creates client record -> Client -> portal invite link.
export async function notifyClientInvited(artworkOrderId: string, email: string) {
  const link = await clientPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Your exhibitor artwork portal is ready",
    text: `You're invited to submit your show artwork through our portal:\n\n${link}\n\nThis link is yours to keep -- bookmark it, you'll use it throughout the process.`,
  });
}

// Row 2: order + artwork submitted -> Art Dept, Account Rep.
export async function notifyReviewersOfSubmission(opportunityId: string, jobCode: string) {
  const artworkOrderUrl = `${getAppBaseUrl()}/artwork`;
  for (const email of await getInternalNotifyEmails(opportunityId)) {
    await sendEmail({
      to: email,
      subject: `New artwork submission awaiting review (${jobCode})`,
      text: `A new artwork order (${jobCode}) has been submitted and is waiting on art review:\n\n${artworkOrderUrl}`,
    });
  }
}

// Row 3: Art dept rejects -> Client -> reason + resubmit CTA.
export async function notifyClientRejected(artworkOrderId: string, email: string, reason: string) {
  const link = await clientPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Your artwork submission needs changes",
    text: `Your artwork submission needs some changes before it can move forward:\n\n"${reason}"\n\nRevise and resubmit here:\n${link}`,
  });
}

// Row 5: Art dept accepts -> Client -> "artwork accepted" confirmation.
export async function notifyClientAccepted(artworkOrderId: string, email: string) {
  const link = await clientPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Your artwork has been accepted",
    text: `Good news -- your artwork has been accepted and is moving into production.\n\nTrack progress here:\n${link}`,
  });
}

// Row 6: Expo assigns vendor -> Vendor -- job number only, no client
// name/company, per the vendor-anonymity rule.
export async function notifyVendorAssigned(artworkOrderId: string, email: string, jobCode: string) {
  const link = await vendorPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: `New print-ready artwork ready in your portal (Job ${jobCode})`,
    text: `A new job (${jobCode}) is ready for you in the production portal:\n\n${link}`,
  });
}

// Row 7a: vendor uploads proof -> Account Rep (Expo) ONLY -- client is
// explicitly not notified yet at this point.
export async function notifyReviewersProofReady(opportunityId: string, jobCode: string) {
  const artworkOrderUrl = `${getAppBaseUrl()}/artwork`;
  for (const email of await getInternalNotifyEmails(opportunityId)) {
    await sendEmail({
      to: email,
      subject: `Proof ready for your review (${jobCode})`,
      text: `A vendor proof is ready for your review against the approved artwork before it can go to the client:\n\n${artworkOrderUrl}`,
    });
  }
}

// Row 7b: Expo confirms proof matches -> Client -> review + sign-off CTA.
export async function notifyClientProofReady(artworkOrderId: string, email: string) {
  const link = await clientPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Your proof is ready for review",
    text: `Your account manager has reviewed your proof and it matches your approved artwork. Please review and sign off:\n\n${link}`,
  });
}

// Row 8: a mismatch is flagged (by Expo, or rarely the client) -> Vendor --
// fully unified as an "Expo review note," never attributed to whichever
// party actually raised it, per the vendor-anonymity principle in this
// direction too.
export async function notifyVendorRevisionRequested(artworkOrderId: string, email: string, note: string) {
  const link = await vendorPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Revision requested on your proof",
    text: `Expo has requested a revision on your proof:\n\n"${note}"\n\nUpload a revised proof here:\n${link}`,
  });
}

// Row 8a: a 3rd revision round would be required -> Account Rep (Expo) --
// the auto-escalation alert.
export async function notifyReviewersEscalation(opportunityId: string, jobCode: string) {
  const artworkOrderUrl = `${getAppBaseUrl()}/artwork`;
  for (const email of await getInternalNotifyEmails(opportunityId)) {
    await sendEmail({
      to: email,
      subject: `Escalated: revision cap reached (${jobCode})`,
      text: `Job ${jobCode} has hit its 2-round revision cap and needs manual resolution before it can continue:\n\n${artworkOrderUrl}`,
    });
  }
}

// Row 9: production go-ahead -> Vendor. The matrix frames this as
// triggered by "client signs off," but the business rule (Section 5,
// "Production go-ahead ownership") makes Expo's own explicit go-ahead
// action the real trigger -- client sign-off alone never reaches the
// vendor. This function is called from THAT action, not from the client's
// sign-off action.
export async function notifyVendorGoAhead(artworkOrderId: string, email: string) {
  const link = await vendorPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Go-ahead to produce",
    text: `You're clear to produce -- the client has signed off and Expo has issued the go-ahead.\n\n${link}`,
  });
}

// Row 12: vendor marks shipped -> Account Rep, Client (Expo-branded).
export async function notifyShipped(opportunityId: string, artworkOrderId: string, jobCode: string, clientEmail: string) {
  for (const email of await getInternalNotifyEmails(opportunityId)) {
    await sendEmail({ to: email, subject: `Shipped to show (${jobCode})`, text: `Job ${jobCode} has shipped to the show.` });
  }
  const link = await clientPortalLink(artworkOrderId, clientEmail);
  await sendEmail({
    to: clientEmail,
    subject: "Your graphics have shipped",
    text: `Your graphics have shipped to the show.\n\nTrack status here:\n${link}`,
  });
}

// Row 13: Expo marks delivered -> Client.
export async function notifyClientDelivered(artworkOrderId: string, email: string) {
  const link = await clientPortalLink(artworkOrderId, email);
  await sendEmail({
    to: email,
    subject: "Delivered to your exhibit",
    text: `Your graphics have arrived and been delivered to your booth.\n\n${link}`,
  });
}
