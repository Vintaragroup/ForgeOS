// A second, narrower access axis alongside opportunity-access.ts's
// owner/collaborator/admin model -- kept in its own file for the same
// reason artwork-portal-auth.ts stayed separate from session.ts: this is a
// genuinely different kind of grant (department membership, not a per-
// opportunity relationship), not a bolt-on to the existing one.
//
// Deliberately scoped to ONE resource type (ArtworkOrder) for now, not a
// general "give department members opportunity access" rule -- see the
// department-access plan's own "Scope" section for why: a department grant
// must never leak into resources a department-scoped user shouldn't see
// (cost/margin on the wider Opportunity/Estimate), and ArtworkOrder is the
// one resource type this codebase has actually verified is safe to expose
// that way (no cost fields anywhere in its data model or its portal
// selectors). Extending this to Task/other departments needs the same
// verification for whatever page grants that access, not just adding
// another department code here.

export interface DepartmentUser {
  departmentCode: string | null;
}

export function canAccessArtworkOrdersViaDepartment(user: DepartmentUser): boolean {
  return user.departmentCode === "GR";
}
