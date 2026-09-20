// The shape every department assistant shares, kept separate from the
// registry that lists them.
//
// Not a style choice: the registry imports each department's context
// builder, and every builder needs these types and the answer-only
// instruction. With both in one file that's a cycle -- and it fails at
// runtime, not at build time (a real page render died with "Cannot access
// 'ANSWER_ONLY_INSTRUCTIONS' before initialization" while the unit tests
// passed, because tests happened to import the modules in the other
// order). A leaf module both sides import cannot cycle.

import type { CitationTarget } from "@/lib/ai/citation-tokens";

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
}

export interface DepartmentAssistant {
  departmentCode: string;
  label: string;
  // One line under the thread list: what this assistant can and can't do.
  description: string;
  // Shown in an empty thread -- the fastest way to teach someone what
  // their assistant is for. Static on purpose: the landing page renders
  // these, and building a whole context just to suggest four questions
  // would run every one of that department's queries on page load.
  suggestions: string[];
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
