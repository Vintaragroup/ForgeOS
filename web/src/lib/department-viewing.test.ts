import { describe, expect, it } from "vitest";
import { resolveDepartmentView, type DepartmentMember, type DepartmentViewer } from "@/lib/department-viewing";

const HEAD: DepartmentMember = { id: "gabriella", name: "Gabriella", isDepartmentHead: true };
const MEMBER: DepartmentMember = { id: "producer", name: "Pat Producer", isDepartmentHead: false };
const MEMBERS = [HEAD, MEMBER];

function viewer(overrides: Partial<DepartmentViewer> = {}): DepartmentViewer {
  return { id: "ryan", name: "Ryan", systemRole: "SUPER_ADMIN" as const, departmentCode: null, isDepartmentHead: false, ...overrides };
}

describe("who an admin lands on", () => {
  it("defaults to the department head, not to themselves", () => {
    // The whole point: an admin opening Sales used to get their own empty
    // book, and Graphics used to get their own name over a shared board.
    const view = resolveDepartmentView(viewer(), MEMBERS, null);
    expect(view.viewedId).toBe("gabriella");
    expect(view.viewedName).toBe("Gabriella");
    expect(view.isSelf).toBe(false);
  });

  it("honours an explicit pick", () => {
    const view = resolveDepartmentView(viewer(), MEMBERS, "producer");
    expect(view.viewedName).toBe("Pat Producer");
    expect(view.isSelf).toBe(false);
  });

  it("lets them get back to their own view", () => {
    const view = resolveDepartmentView(viewer(), MEMBERS, "ryan");
    expect(view.viewedId).toBe("ryan");
    expect(view.isSelf).toBe(true);
  });

  it("offers itself as an option even though the admin is not in the department", () => {
    const view = resolveDepartmentView(viewer(), MEMBERS, null);
    expect(view.options.map((o) => o.id)).toContain("ryan");
    expect(view.options.find((o) => o.id === "ryan")?.name).toBe("Ryan (you)");
  });

  it("does not duplicate an admin who IS in the department", () => {
    const inDept = viewer({ id: "gabriella", name: "Gabriella", departmentCode: "GR" });
    const view = resolveDepartmentView(inDept, MEMBERS, null);
    expect(view.options.filter((o) => o.id === "gabriella")).toHaveLength(1);
  });
});

describe("an id the URL asked for that shouldn't be honoured", () => {
  it("ignores someone outside the department rather than rendering their view", () => {
    const view = resolveDepartmentView(viewer(), MEMBERS, "someone-in-sales");
    expect(view.viewedId).toBe("gabriella");
  });

  it("ignores an id that doesn't exist", () => {
    expect(resolveDepartmentView(viewer(), MEMBERS, "nonsense").viewedId).toBe("gabriella");
  });
});

describe("a department with no head set", () => {
  it("leaves the admin on their own view rather than picking someone arbitrary", () => {
    // Presenting a random member as the department's face would be worse
    // than showing the admin what they already had.
    const view = resolveDepartmentView(viewer(), [MEMBER], null);
    expect(view.viewedId).toBe("ryan");
    expect(view.isSelf).toBe(true);
    // The picker still lists them, so the admin can choose deliberately.
    expect(view.options.map((o) => o.id)).toEqual(["producer", "ryan"]);
  });

  it("leaves an empty department on the viewer", () => {
    const view = resolveDepartmentView(viewer(), [], null);
    expect(view.viewedId).toBe("ryan");
    expect(view.isSelf).toBe(true);
  });
});

describe("who may switch at all", () => {
  it("pins an ordinary member to themselves and offers no picker", () => {
    const member = viewer({ id: "producer", name: "Pat Producer", systemRole: "EMPLOYEE" as const, departmentCode: "GR" });
    const view = resolveDepartmentView(member, MEMBERS, "gabriella");
    expect(view.viewedId).toBe("producer");
    expect(view.isSelf).toBe(true);
    // No options means the page renders no picker.
    expect(view.options).toEqual([]);
  });

  it("lets a department head look across their own department", () => {
    const head = viewer({ id: "gabriella", name: "Gabriella", systemRole: "EMPLOYEE" as const, departmentCode: "GR", isDepartmentHead: true });
    const view = resolveDepartmentView(head, MEMBERS, "producer");
    expect(view.viewedName).toBe("Pat Producer");
    expect(view.options.length).toBeGreaterThan(0);
  });

  it("never reports isSelf false without a real switch", () => {
    // isSelf gates every write, so it must never be false just because a
    // head happens to be the default.
    const head = viewer({ id: "gabriella", name: "Gabriella", systemRole: "EMPLOYEE" as const, departmentCode: "GR", isDepartmentHead: true });
    expect(resolveDepartmentView(head, MEMBERS, null).isSelf).toBe(true);
  });
});
