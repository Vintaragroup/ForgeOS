// "Whose view of this department am I looking at?"
//
// An admin opening a department dashboard used to land on their own view,
// which for Graphics meant their own name over a shared board and for
// Sales meant an empty book -- an admin owns no Salesmate deals, so the
// Sales page greeted them with nothing waiting and no clients. Useless as
// a way of checking on a department.
//
// The department head is the right default: it is the fullest view of the
// department, and it is the one an admin actually wants when they click
// "Sales" or "Graphics" out of curiosity or to help.
//
// Viewing is READ-ONLY, always. Nothing here grants the ability to write
// as somebody else -- pages check `isSelf` before offering an action, the
// rule /sales already had (canAct = viewingSelf). An admin can see what
// Gabriella sees; they cannot assign a designer in her name.

import { db } from "@/lib/db";
import { canViewDepartmentOversight } from "@/lib/department-access";
import type { SystemRole } from "@/generated/prisma/enums";

export interface DepartmentMember {
  id: string;
  name: string;
  isDepartmentHead: boolean;
}

export interface DepartmentViewer {
  id: string;
  name: string;
  systemRole: SystemRole;
  departmentCode: string | null;
  // Required, not optional: canViewDepartmentOversight reads it, and an
  // undefined here would silently read as "not a head" for someone who is
  // one.
  isDepartmentHead: boolean;
}

export interface DepartmentView {
  // The person whose view is being rendered.
  viewedId: string;
  viewedName: string;
  // False when an admin is looking at somebody else -- every write must
  // be gated on this.
  isSelf: boolean;
  // Everyone the picker may offer. Empty when the viewer may not switch,
  // which is also how a page decides whether to render the picker at all.
  options: DepartmentMember[];
}

export async function listDepartmentMembers(departmentCode: string): Promise<DepartmentMember[]> {
  return db.user.findMany({
    where: { departmentCode, deletedAt: null },
    select: { id: true, name: true, isDepartmentHead: true },
    // Head first, then alphabetical: the head is the default and the most
    // common pick, so it should not be buried mid-list.
    orderBy: [{ isDepartmentHead: "desc" }, { name: "asc" }],
  });
}

// `requestedId` is whatever the URL asked for, and is not trusted: an id
// outside this department falls back to the default rather than rendering
// a stranger's view.
export function resolveDepartmentView(
  viewer: DepartmentViewer,
  members: DepartmentMember[],
  requestedId: string | null | undefined,
): DepartmentView {
  const maySwitch = canViewDepartmentOversight(viewer);
  if (!maySwitch) {
    return { viewedId: viewer.id, viewedName: viewer.name, isSelf: true, options: [] };
  }

  // The viewer is offered alongside the department, even when they are not
  // in it -- an admin still needs a way back to their own view.
  const options = members.some((m) => m.id === viewer.id)
    ? members
    : [...members, { id: viewer.id, name: `${viewer.name} (you)`, isDepartmentHead: false }];

  // Resolved against `options`, not `members`: an admin is not in the
  // department, so looking only at members meant ?as=<their own id> fell
  // through to the head and they could never get back to their own view.
  const requested = requestedId ? options.find((m) => m.id === requestedId) : undefined;
  // Falls back to the head, then to the viewer. A department with no head
  // set yet keeps the old behaviour rather than picking someone arbitrary
  // and presenting them as the department's face.
  const head = members.find((m) => m.isDepartmentHead);
  const viewedMember = requested ?? head;

  return {
    viewedId: viewedMember?.id ?? viewer.id,
    viewedName: viewedMember?.name ?? viewer.name,
    isSelf: (viewedMember?.id ?? viewer.id) === viewer.id,
    options,
  };
}
