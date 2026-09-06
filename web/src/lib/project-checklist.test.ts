import { describe, expect, it } from "vitest";
import { buildProjectChecklist, type ProjectChecklistInput } from "@/lib/project-checklist";

function baseInput(overrides: Partial<ProjectChecklistInput> = {}): ProjectChecklistInput {
  return {
    projectId: "proj1",
    jobNumber: "J-1001",
    workOrder: {
      depositDueDate: new Date("2026-08-15"),
      productionMeetingDate: new Date("2026-08-20"),
      artworkDeadlineDate: new Date("2026-12-01"),
      balanceDueDate: new Date("2026-12-10"),
    },
    ...overrides,
  };
}

describe("buildProjectChecklist", () => {
  it("returns nothing once the job number is set and every production date is filled in", () => {
    expect(buildProjectChecklist(baseInput())).toEqual([]);
  });

  it("flags a missing job number", () => {
    const items = buildProjectChecklist(baseInput({ jobNumber: null }));
    expect(items.map((i) => i.id)).toContain("missing-job-number");
  });

  it("flags that the work order hasn't been started yet, and checks nothing else until it has", () => {
    const items = buildProjectChecklist(baseInput({ workOrder: null }));
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("start-work-order");
  });

  it("counts missing production dates once a work order exists, with correct pluralization", () => {
    const oneMissing = buildProjectChecklist(
      baseInput({ workOrder: { depositDueDate: null, productionMeetingDate: new Date(), artworkDeadlineDate: new Date(), balanceDueDate: new Date() } }),
    );
    const item = oneMissing.find((i) => i.id === "work-order-dates-incomplete");
    expect(item?.label).toBe("Fill in 1 missing production date on the work order.");

    const fourMissing = buildProjectChecklist(
      baseInput({ workOrder: { depositDueDate: null, productionMeetingDate: null, artworkDeadlineDate: null, balanceDueDate: null } }),
    );
    const item4 = fourMissing.find((i) => i.id === "work-order-dates-incomplete");
    expect(item4?.label).toBe("Fill in 4 missing production dates on the work order.");
  });

  it("can flag both a missing job number and missing production dates at once", () => {
    const items = buildProjectChecklist(
      baseInput({ jobNumber: null, workOrder: { depositDueDate: null, productionMeetingDate: new Date(), artworkDeadlineDate: new Date(), balanceDueDate: new Date() } }),
    );
    expect(items.map((i) => i.id)).toEqual(["missing-job-number", "work-order-dates-incomplete"]);
  });
});
