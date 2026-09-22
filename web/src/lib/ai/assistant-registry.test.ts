import { describe, expect, it } from "vitest";
import {
  assistantsForUser,
  canUseAssistant,
  getDepartmentAssistant,
  listDepartmentAssistants,
  type AssistantUser,
} from "@/lib/ai/assistant-registry";
import { ANSWER_ONLY_INSTRUCTIONS } from "@/lib/ai/assistant-contract";

function user(overrides: Partial<AssistantUser> = {}): AssistantUser {
  return { id: "u1", name: "Someone", systemRole: "USER", departmentCode: null, isSalesManager: false, ...overrides };
}

describe("the registry", () => {
  it("has Graphics registered", () => {
    const gr = getDepartmentAssistant("GR");
    expect(gr?.label).toBe("Graphics");
    expect(gr?.suggestions.length).toBeGreaterThan(0);
  });

  it("gives every assistant a description and some suggestions", () => {
    for (const a of listDepartmentAssistants()) {
      expect(a.description, `${a.departmentCode} has no description`).toBeTruthy();
      expect(a.suggestions.length, `${a.departmentCode} suggests nothing`).toBeGreaterThan(0);
    }
  });

  it("says a department with no assistant has none, rather than inventing one", () => {
    // An unregistered department must return null so the caller can say
    // "not set up yet" -- not an assistant answering from nothing.
    expect(getDepartmentAssistant("WH")).toBeNull();
    expect(getDepartmentAssistant("")).toBeNull();
  });
});

describe("who may open which assistant", () => {
  it("gives a Graphics person the Graphics one and nothing else", () => {
    const gr = user({ departmentCode: "GR" });
    expect(assistantsForUser(gr).map((a) => a.departmentCode)).toEqual(["GR"]);
    expect(canUseAssistant(gr, "GR")).toBe(true);
    expect(canUseAssistant(gr, "SL")).toBe(false);
  });

  it("does not let a Sales person open the Graphics one", () => {
    expect(canUseAssistant(user({ departmentCode: "SL" }), "GR")).toBe(false);
  });

  it("gives an admin all of them", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      const admin = user({ systemRole: role, departmentCode: null });
      expect(assistantsForUser(admin).length).toBe(listDepartmentAssistants().length);
      expect(canUseAssistant(admin, "GR")).toBe(true);
    }
  });

  it("gives someone with no department nothing", () => {
    expect(assistantsForUser(user({ departmentCode: null }))).toEqual([]);
  });
});

describe("the answer-only posture", () => {
  it("is stated once, centrally, so no department can ship a writing assistant by forgetting it", () => {
    expect(ANSWER_ONLY_INSTRUCTIONS).toMatch(/cannot change anything/i);
    expect(ANSWER_ONLY_INSTRUCTIONS).toMatch(/never invent/i);
  });
});
