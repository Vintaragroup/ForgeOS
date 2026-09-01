"use server";

import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { sendMessage } from "@/lib/chat-service";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { linkifyDocumentMentions } from "@/lib/citation";

// Called directly from the floating ChatWidget client component (not via
// a <form action>) -- Server Actions can be imported and awaited from
// client code same as any async function, which is what lets the widget
// stay a single small overlay instead of a full page navigation. Returns
// plain data (or throws a client-friendly message) rather than
// redirecting/revalidating a route, since there's no page to redirect to.
export async function sendWidgetMessageAction(opportunityId: string, content: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Your session expired -- reload the page and sign in again.");
  // The widget is reachable from the document viewer and the opportunity
  // page alike; both already gate access before rendering, but this
  // action is independently callable, so it self-checks too -- same
  // reasoning as every other action touching opportunity-scoped data.
  if (!(await canAccessOpportunity(user, opportunityId))) {
    throw new Error("You don't have access to this opportunity.");
  }

  const trimmed = content.trim();
  if (!trimmed) throw new Error("Message can't be empty.");

  try {
    const { assistantMessage, documentsDropped, lineItemsOmitted } = await sendMessage(opportunityId, user.id, trimmed);
    const documents = await db.document.findMany({
      where: { opportunityId, deletedAt: null },
      select: { id: true, filename: true },
    });
    // Both signals already computed by buildChatContext -- previously
    // thrown away here, leaving no way to tell a confident-but-wrong
    // answer apart from one that actually saw everything.
    const noticeParts: string[] = [];
    if (documentsDropped.length > 0) {
      noticeParts.push(`${documentsDropped.length} document(s) didn't fit and were left out: ${documentsDropped.join(", ")}`);
    }
    if (lineItemsOmitted > 0) {
      noticeParts.push(`${lineItemsOmitted} line item(s) didn't fit and were left out of this answer.`);
    }
    return {
      id: assistantMessage.id,
      role: assistantMessage.role,
      segments: linkifyDocumentMentions(assistantMessage.content, opportunityId, documents),
      notice: noticeParts.length > 0 ? noticeParts.join(" ") : null,
    };
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable chat.");
    }
    throw err; // RateLimitError's own message is already clear
  }
}
