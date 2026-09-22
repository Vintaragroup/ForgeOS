// One assistant per department, declared in one place.
//
// The department landing pages are the same page with different content
// (components/dashboard-shell.tsx); their assistants work the same way.
// A department declares what its assistant knows and may cite; everything
// else -- threads, access, rate limiting, citation rendering, cost
// recording -- is shared (assistant-service.ts). Adding Graphics later is
// a context builder plus an entry here, not a migration and not a second
// chat implementation.
//
// Deliberately NOT pre-filling every department with a guessed context:
// an unregistered department returns a clear "not set up yet" rather than
// an assistant that confidently answers from nothing.

import { buildSalesAssistantContext, SALES_SUGGESTIONS } from "@/lib/ai/sales-assistant-context";
import { buildGraphicsAssistantContext, GRAPHICS_SUGGESTIONS } from "@/lib/ai/graphics-assistant-context";
import type { AssistantUser, DepartmentAssistant } from "@/lib/ai/assistant-contract";

// Re-exported so callers have one import for "the assistant system".
export type { AssistantContext, AssistantUser, DepartmentAssistant } from "@/lib/ai/assistant-contract";
export { ANSWER_ONLY_INSTRUCTIONS } from "@/lib/ai/assistant-contract";

const ASSISTANTS: DepartmentAssistant[] = [
  {
    departmentCode: "SL",
    label: "Sales",
    description: "Knows your clients, deals, scheduled work and contact history. Answers and links -- it can't change anything.",
    suggestions: SALES_SUGGESTIONS,
    buildContext: buildSalesAssistantContext,
  },
  {
    departmentCode: "GR",
    label: "Graphics",
    description:
      "Knows the live production board: what's late, what each shop owes, and whose move every piece is. Answers and links -- it can't change anything.",
    suggestions: GRAPHICS_SUGGESTIONS,
    buildContext: buildGraphicsAssistantContext,
  },
];

export function getDepartmentAssistant(departmentCode: string): DepartmentAssistant | null {
  return ASSISTANTS.find((a) => a.departmentCode === departmentCode) ?? null;
}

export function listDepartmentAssistants(): DepartmentAssistant[] {
  return [...ASSISTANTS];
}

// Which assistants a person may open: their own department's, and every
// department's if they're an admin (admins already see everything).
export function assistantsForUser(user: AssistantUser): DepartmentAssistant[] {
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  if (isAdmin) return listDepartmentAssistants();
  return ASSISTANTS.filter((a) => a.departmentCode === user.departmentCode);
}

export function canUseAssistant(user: AssistantUser, departmentCode: string): boolean {
  return assistantsForUser(user).some((a) => a.departmentCode === departmentCode);
}
