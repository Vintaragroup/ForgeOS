import { describe, expect, it } from "vitest";
import { canTransitionProposal, PROPOSAL_TRANSITIONS } from "@/lib/proposal-service";
import type { ProposalStatus } from "@/generated/prisma/enums";

describe("PROPOSAL_TRANSITIONS", () => {
  it("covers every status", () => {
    const all: ProposalStatus[] = ["DRAFT", "SENT", "UNDER_REVIEW", "REVISIONS_REQUESTED", "SIGNED", "DECLINED"];
    for (const s of all) expect(PROPOSAL_TRANSITIONS[s], s).toBeDefined();
  });

  it("lets a client sign straight off the sent copy, with no review step recorded", () => {
    // The happy path: not every deal has a recorded review or meeting.
    expect(canTransitionProposal("SENT", "SIGNED")).toBe(true);
  });

  it("does not let a proposal be signed before it was sent", () => {
    expect(canTransitionProposal("DRAFT", "SIGNED")).toBe(false);
    expect(canTransitionProposal("DRAFT", "UNDER_REVIEW")).toBe(false);
  });

  it("keeps a revision request open rather than terminal", () => {
    // The revised proposal is a NEW row -- this one can still be signed
    // or declined, because a client can come back to what they were sent.
    expect(canTransitionProposal("REVISIONS_REQUESTED", "SIGNED")).toBe(true);
    expect(canTransitionProposal("REVISIONS_REQUESTED", "DECLINED")).toBe(true);
  });

  it("treats signed and declined as final", () => {
    expect(PROPOSAL_TRANSITIONS.SIGNED).toEqual([]);
    expect(PROPOSAL_TRANSITIONS.DECLINED).toEqual([]);
    expect(canTransitionProposal("SIGNED", "REVISIONS_REQUESTED")).toBe(false);
    expect(canTransitionProposal("DECLINED", "SENT")).toBe(false);
  });

  it("never lets a proposal be re-sent -- a re-send is a new Proposal row", () => {
    // Proposals are immutable once sent (generateProposal makes a new one).
    for (const from of Object.keys(PROPOSAL_TRANSITIONS) as ProposalStatus[]) {
      if (from === "DRAFT") continue;
      expect(canTransitionProposal(from, "SENT"), from).toBe(false);
    }
  });

  it("does not allow a proposal to go back to DRAFT from anywhere", () => {
    for (const from of Object.keys(PROPOSAL_TRANSITIONS) as ProposalStatus[]) {
      expect(canTransitionProposal(from, "DRAFT"), from).toBe(false);
    }
  });
});
