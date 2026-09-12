import { describe, expect, it } from "vitest";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";

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
