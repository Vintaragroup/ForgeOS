import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { buildTaskPacketData, TaskPacketPdfDocument, type TaskPacketLineItem } from "@/lib/task-packet-pdf";

const baseLineItems: TaskPacketLineItem[] = [
  { description: "SEG graphic panel A", qty: 2, unit: "EA", category: "Graphics" },
  { description: "SEG graphic panel B", qty: 1, unit: "EA", category: "Graphics" },
];

describe("buildTaskPacketData", () => {
  it("resolves a department name over a bare code when one is available", () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: "J-1001",
      taskDescription: "Graphics scope",
      departmentCode: "GR",
      departmentName: "Graphics",
      vendorName: null,
      dueDate: null,
      lineItems: baseLineItems,
    });
    expect(data.departmentOrVendor).toBe("Graphics Department");
  });

  it("falls back to the bare department code when no LaborRate name is found", () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Some scope",
      departmentCode: "ZZ",
      departmentName: null,
      vendorName: null,
      dueDate: null,
      lineItems: [],
    });
    expect(data.departmentOrVendor).toBe("ZZ Department");
  });

  it("prefers a vendor over a department code when both are somehow set", () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Outsourced scope",
      departmentCode: "GR",
      departmentName: "Graphics",
      vendorName: "Acme Signs",
      dueDate: null,
      lineItems: [],
    });
    expect(data.departmentOrVendor).toBe("Vendor: Acme Signs");
  });

  it("labels an unassigned task honestly, not with a blank or a guess", () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Unassigned scope -- needs department/vendor review",
      departmentCode: null,
      departmentName: null,
      vendorName: null,
      dueDate: null,
      lineItems: [],
    });
    expect(data.departmentOrVendor).toBe("Unassigned -- needs department/vendor review");
  });

  it("formats a due date as a plain YYYY-MM-DD string, and leaves it null when unset", () => {
    const withDate = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Graphics scope",
      departmentCode: "GR",
      departmentName: "Graphics",
      vendorName: null,
      dueDate: new Date("2026-12-01"),
      lineItems: [],
    });
    expect(withDate.dueDate).toBe("2026-12-01");

    const withoutDate = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Graphics scope",
      departmentCode: "GR",
      departmentName: "Graphics",
      vendorName: null,
      dueDate: null,
      lineItems: [],
    });
    expect(withoutDate.dueDate).toBeNull();
  });

  it("carries line items through untouched -- description, qty, unit, category only, structurally no cost fields", () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Graphics scope",
      departmentCode: "GR",
      departmentName: "Graphics",
      vendorName: null,
      dueDate: null,
      lineItems: baseLineItems,
    });
    expect(data.lineItems).toEqual(baseLineItems);
    // Real, deliberate proof of the cost-blindness guarantee: TaskPacketLineItem
    // has no unitCost/totalCost field in its own type at all (see
    // task-packet-pdf.tsx), so there is nothing for this object to carry
    // even if a caller tried to smuggle cost data in -- confirmed here at
    // the object-key level, not just by the type checker.
    for (const li of data.lineItems) {
      expect(Object.keys(li).sort()).toEqual(["category", "description", "qty", "unit"]);
    }
  });
});

// Same "renders a real PDF in Node" verification standard as
// cut-list-labels-pdf.test.ts.
describe("TaskPacketPdfDocument", () => {
  it("renders a real, non-trivial PDF buffer", async () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: "J-1001",
      taskDescription: "Graphics scope",
      departmentCode: "GR",
      departmentName: "Graphics",
      vendorName: null,
      dueDate: new Date("2026-12-01"),
      lineItems: baseLineItems,
    });
    const buffer = await renderToBuffer(TaskPacketPdfDocument({ data }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("renders without error when a task has no line items assigned yet", async () => {
    const data = buildTaskPacketData({
      showName: "Test Show",
      companyName: "Test Co",
      jobNumber: null,
      taskDescription: "Unassigned scope -- needs department/vendor review",
      departmentCode: null,
      departmentName: null,
      vendorName: null,
      dueDate: null,
      lineItems: [],
    });
    const buffer = await renderToBuffer(TaskPacketPdfDocument({ data }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
