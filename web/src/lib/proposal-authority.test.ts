import { describe, expect, it } from "vitest";
import { isProposalManager, proposalAuthority, type ProposalActor } from "@/lib/proposal-authority";

function actor(overrides: Partial<ProposalActor> = {}): ProposalActor {
  return { systemRole: "EMPLOYEE", isSalesManager: false, isDepartmentHead: false, ...overrides };
}

describe("who carries the authority themselves", () => {
  it("counts admins, sales managers and department heads", () => {
    expect(isProposalManager(actor({ systemRole: "ADMIN" }))).toBe(true);
    expect(isProposalManager(actor({ systemRole: "SUPER_ADMIN" }))).toBe(true);
    expect(isProposalManager(actor({ isSalesManager: true }))).toBe(true);
    expect(isProposalManager(actor({ isDepartmentHead: true }))).toBe(true);
  });

  it("does not count an ordinary employee", () => {
    expect(isProposalManager(actor())).toBe(false);
  });

  it("lets a manager move it without attesting to anything", () => {
    const result = proposalAuthority(actor({ isSalesManager: true }), false);
    expect(result.allowed).toBe(true);
    expect(result.requiresManagerConsultation).toBe(false);
    expect(result.reason).toBeNull();
  });
});

describe("a rep moving it", () => {
  it("is refused until they confirm they discussed it", () => {
    const result = proposalAuthority(actor(), false);
    expect(result.allowed).toBe(false);
    expect(result.requiresManagerConsultation).toBe(true);
    expect(result.reason).toMatch(/discussed this with your manager/i);
  });

  it("is allowed once they do", () => {
    const result = proposalAuthority(actor(), true);
    expect(result.allowed).toBe(true);
    expect(result.requiresManagerConsultation).toBe(true);
  });

  it("still reports that the attestation was required, so it gets recorded", () => {
    // requiresManagerConsultation stays true on the allowed path: the
    // caller writes it onto the event, and "a manager did this" must not
    // look identical to "a rep said they'd checked".
    expect(proposalAuthority(actor(), true).requiresManagerConsultation).toBe(true);
    expect(proposalAuthority(actor({ systemRole: "ADMIN" }), true).requiresManagerConsultation).toBe(false);
  });
});
