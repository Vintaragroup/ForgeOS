// Who may move a proposal's status, and on whose authority.
//
// Two ways to have the standing:
//
//   - A manager moves it on their own authority. That means an admin, a
//     sales manager, or a department head -- the same people who can
//     already see a whole department's book rather than just their own.
//   - Anyone else may move it too, but has to say they discussed it with
//     their manager or the department head first. That attestation is
//     RECORDED on the event, not just checked and thrown away: three
//     weeks later the useful question is "who agreed to this", and a
//     validation that left no trace could not answer it.
//
// Access to the opportunity itself is a separate gate and stays where it
// already is (opportunityAccessWhere -- owner and collaborators). This
// only decides authority once someone is already allowed to be here.
//
// Deliberately NOT keyed on Opportunity.salesRepId. That field's own
// schema comment is explicit that it drives commission and is "never used
// for access control", and a rep who is not the owner or a collaborator
// cannot open the opportunity at all -- so granting authority through it
// would hand out a permission its holder could never reach.
//
// A leaf module: a pure predicate, no db import.

export interface ProposalActor {
  systemRole: string;
  isSalesManager: boolean;
  isDepartmentHead: boolean;
}

export function isProposalManager(actor: ProposalActor): boolean {
  return (
    actor.systemRole === "ADMIN" ||
    actor.systemRole === "SUPER_ADMIN" ||
    actor.isSalesManager ||
    actor.isDepartmentHead
  );
}

export interface ProposalAuthority {
  // False when this person needs no attestation -- they carry the
  // authority themselves.
  requiresManagerConsultation: boolean;
  // Whether the move may proceed at all, given what was attested.
  allowed: boolean;
  // Shown to the person when it may not.
  reason: string | null;
}

export function proposalAuthority(actor: ProposalActor, managerConsulted: boolean): ProposalAuthority {
  if (isProposalManager(actor)) {
    return { requiresManagerConsultation: false, allowed: true, reason: null };
  }
  if (!managerConsulted) {
    return {
      requiresManagerConsultation: true,
      allowed: false,
      reason:
        "Confirm you've discussed this with your manager or the department head before changing where the proposal stands.",
    };
  }
  return { requiresManagerConsultation: true, allowed: true, reason: null };
}
