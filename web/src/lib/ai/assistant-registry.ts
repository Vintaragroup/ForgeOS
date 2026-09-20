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

import type { CitationTarget } from "@/lib/ai/citation-tokens";
import { buildSalesAssistantContext } from "@/lib/ai/sales-assistant-context";

export interface AssistantUser {
  id: string;
  name: string;
  systemRole: string;
  departmentCode: string | null;
  isSalesManager: boolean;
}

export interface AssistantContext {
  // Facts the model is given, already scoped to this person.
  systemPrompt: string;
  // What it may cite, by token (see citation-tokens.ts).
  citations: CitationTarget[];
  // Shown in the widget when a thread is empty -- the fastest way to
  // teach someone what their assistant is actually for.
  suggestions: string[];
}

export interface DepartmentAssistant {
  departmentCode: string;
  label: string;
  // One line under the thread list: what this assistant can and can't do.
  description: string;
  buildContext(user: AssistantUser): Promise<AssistantContext>;
}

// Answer-only for v1 (agreed 2026-09-20): the assistant explains and
// points, and every change still happens on a real page with its own
// checks. Written here rather than in each builder so no department can
// quietly ship a writing assistant by forgetting the instruction.
export const ANSWER_ONLY_INSTRUCTIONS = [
  "You answer questions and point people to the right page. You cannot change anything, send anything, or take action.",
  "If asked to do something, say what you'd do and link to where they can do it.",
  "Answer only from the facts given to you. If something isn't there, say you don't have it -- never invent a client,",
  "deal, number, or date.",
].join(" ");

const ASSISTANTS: DepartmentAssistant[] = [
  {
    departmentCode: "SL",
    label: "Sales",
    description: "Knows your clients, deals, scheduled work and contact history. Answers and links -- it can't change anything.",
    buildContext: buildSalesAssistantContext,
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
