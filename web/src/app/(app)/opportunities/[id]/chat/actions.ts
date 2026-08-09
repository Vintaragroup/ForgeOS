"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { sendMessage } from "@/lib/chat-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";

export async function sendMessageAction(opportunityId: string, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const content = String(formData.get("content") ?? "").trim();
  if (!content) throw new Error("Message can't be empty.");

  try {
    await sendMessage(opportunityId, user.id, content);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable chat.");
    }
    throw err; // RateLimitError's own message is already clear
  }

  revalidatePath(`/opportunities/${opportunityId}/chat`);
}
