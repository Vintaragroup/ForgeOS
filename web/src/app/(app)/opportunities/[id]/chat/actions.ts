"use server";

import { getCurrentUser } from "@/lib/auth";
import { sendMessage } from "@/lib/chat-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";

// Called directly from the floating ChatWidget client component (not via
// a <form action>) -- Server Actions can be imported and awaited from
// client code same as any async function, which is what lets the widget
// stay a single small overlay instead of a full page navigation. Returns
// plain data (or throws a client-friendly message) rather than
// redirecting/revalidating a route, since there's no page to redirect to.
export async function sendWidgetMessageAction(opportunityId: string, content: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error("Your session expired -- reload the page and sign in again.");

  const trimmed = content.trim();
  if (!trimmed) throw new Error("Message can't be empty.");

  try {
    const { assistantMessage } = await sendMessage(opportunityId, user.id, trimmed);
    return {
      id: assistantMessage.id,
      role: assistantMessage.role,
      content: assistantMessage.content,
      createdAt: assistantMessage.createdAt,
    };
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable chat.");
    }
    throw err; // RateLimitError's own message is already clear
  }
}
