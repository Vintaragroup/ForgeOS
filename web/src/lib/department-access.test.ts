import { describe, expect, it } from "vitest";
import { canAccessArtworkOrdersViaDepartment, canViewDepartmentOversight } from "@/lib/department-access";

describe("canAccessArtworkOrdersViaDepartment", () => {
  it("grants access to a Graphics-department user", () => {
    expect(canAccessArtworkOrdersViaDepartment({ departmentCode: "GR" })).toBe(true);
  });

  it("denies a user in any other department", () => {
    expect(canAccessArtworkOrdersViaDepartment({ departmentCode: "EN" })).toBe(false);
    expect(canAccessArtworkOrdersViaDepartment({ departmentCode: "SL" })).toBe(false);
  });

  it("denies a user with no department set", () => {
    expect(canAccessArtworkOrdersViaDepartment({ departmentCode: null })).toBe(false);
  });
});

describe("canViewDepartmentOversight", () => {
  it("grants an admin regardless of department or head status", () => {
    expect(canViewDepartmentOversight({ departmentCode: null, isDepartmentHead: false, systemRole: "ADMIN" })).toBe(true);
    expect(
      canViewDepartmentOversight({ departmentCode: "EN", isDepartmentHead: false, systemRole: "SUPER_ADMIN" }),
    ).toBe(true);
  });

  it("grants a GR user who is a designated department head", () => {
    expect(canViewDepartmentOversight({ departmentCode: "GR", isDepartmentHead: true, systemRole: "EMPLOYEE" })).toBe(
      true,
    );
  });

  it("denies a regular GR staff member who isn't a designated head", () => {
    expect(canViewDepartmentOversight({ departmentCode: "GR", isDepartmentHead: false, systemRole: "EMPLOYEE" })).toBe(
      false,
    );
  });

  it("denies a designated head outside the GR department", () => {
    expect(canViewDepartmentOversight({ departmentCode: "SL", isDepartmentHead: true, systemRole: "EMPLOYEE" })).toBe(
      false,
    );
  });
});
