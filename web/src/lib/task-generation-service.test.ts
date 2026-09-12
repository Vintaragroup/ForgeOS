import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLineItem, addSection, createEstimateVersion, createNewVersionFromLocked, lockEstimateVersion } from "@/lib/estimate-service";
import { convertOpportunityToProject, startWorkOrder } from "@/lib/project-service";
import { generateTasksFromEstimate } from "@/lib/task-generation-service";

afterEach(async () => {
  await db.task.deleteMany();
  await db.workOrder.deleteMany();
  await db.project.deleteMany();
  await db.laborRate.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.category.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeProjectWithWorkOrder() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show", stage: "WON" } });
  const project = await convertOpportunityToProject(opportunity.id);
  const workOrder = await startWorkOrder(project.id);
  return { opportunity, project, workOrder };
}

async function makeCategory(name: string) {
  return db.category.create({ data: { name, key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") } });
}

describe("generateTasksFromEstimate", () => {
  it("is a no-op when the opportunity has no locked estimate version yet", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    await createEstimateVersion(estimate.id); // never locked

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result).toEqual({ created: 0, updated: 0, unassignedCount: 0 });
    expect(await db.task.count()).toBe(0);
  });

  it("resolves a graphics-category line item to the GR department", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result).toEqual({ created: 1, updated: 0, unassignedCount: 0 });

    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id }, include: { lineItems: true } });
    expect(task.departmentCode).toBe("GR");
    expect(task.lineItems).toHaveLength(1);
    expect(task.lineItems[0].description).toBe("SEG graphic panel");
  });

  it("uses a real LaborRate department name in the task description when one exists", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    await db.laborRate.create({
      data: { rateType: "DEPARTMENT", departmentCode: "GR", departmentName: "Graphics", rate: 61.25 },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    await generateTasksFromEstimate(project.id, workOrder.id);

    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id, departmentCode: "GR" } });
    expect(task.description).toBe("Graphics scope");
  });

  it("an explicit LineItem.department wins outright over the category mapping", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Labor");
    await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Install crew",
      qty: 1,
      unitCost: 1000,
      category: category.name,
      department: "AS", // Assembly -- not derivable from category alone
    });
    await lockEstimateVersion(version.id);

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result.created).toBe(1);

    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id } });
    expect(task.departmentCode).toBe("AS");
  });

  it("an audio_visual-category line item (no matching shop department) lands in the unassigned bucket", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Audio/Visual");
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "LED video wall",
      qty: 1,
      unitCost: 5000,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result).toEqual({ created: 1, updated: 0, unassignedCount: 1 });

    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id } });
    expect(task.departmentCode).toBeNull();
    expect(task.description).toBe("Unassigned scope -- needs department/vendor review");
  });

  it("a change-order-copied line item with category: null resolves consistently through resolveEffectiveCategory (falls back to the unassigned bucket, not a crash or a guess)", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const v1 = await createEstimateVersion(estimate.id);
    const section = await addSection(v1.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(v1.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(v1.id);
    // createNewVersionFromLocked deliberately does not copy `category`
    // forward. resolveEffectiveCategory (the same function the rest of
    // the app trusts for this) falls back to "Other" with no `category`
    // and no groupLabel/buildType signal to recompose from -- exactly
    // like the client-facing proposal view would render it -- so this
    // real case correctly lands in the "needs review" bucket rather than
    // crashing or silently inventing a department that isn't there.
    const v2 = await createNewVersionFromLocked(v1.id);
    await lockEstimateVersion(v2.id);

    const copiedItem = await db.lineItem.findFirstOrThrow({ where: { section: { estimateVersionId: v2.id } } });
    expect(copiedItem.category).toBeNull(); // sanity check the premise

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result).toEqual({ created: 1, updated: 0, unassignedCount: 1 });
    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id } });
    expect(task.departmentCode).toBeNull();
  });

  it("running twice in a row produces zero duplicate tasks and doesn't touch already-linked items", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const first = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(first).toEqual({ created: 1, updated: 0, unassignedCount: 0 });

    const second = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(second).toEqual({ created: 0, updated: 0, unassignedCount: 0 }); // nothing left unclaimed

    expect(await db.task.count({ where: { workOrderId: workOrder.id } })).toBe(1);
  });

  it("a second run appends newly-unclaimed items to the same existing department task rather than creating a duplicate", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel A",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    // A second item added while the version is still unlocked (a locked
    // version can never gain a new line item -- assertUnlocked), simulating
    // one that a coordinator later un-links from wherever it first landed,
    // still needing (re-)assignment when the second run happens.
    const itemB = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel B",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const first = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(first).toEqual({ created: 1, updated: 0, unassignedCount: 0 });
    await db.lineItem.update({ where: { id: itemB.id }, data: { taskId: null } });

    const second = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(second).toEqual({ created: 0, updated: 1, unassignedCount: 0 });

    expect(await db.task.count({ where: { workOrderId: workOrder.id } })).toBe(1);
    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id }, include: { lineItems: true } });
    expect(task.lineItems).toHaveLength(2);
  });

  it("does not re-group or move a line item a coordinator already linked by hand", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    const item = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const manualTask = await db.task.create({ data: { workOrderId: workOrder.id, description: "Handled personally" } });
    await db.lineItem.update({ where: { id: item.id }, data: { taskId: manualTask.id } });

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result).toEqual({ created: 0, updated: 0, unassignedCount: 0 });

    const reloaded = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloaded.taskId).toBe(manualTask.id); // untouched
  });

  it("a manually-created task sharing a department code but different wording is not silently reused", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    // A coordinator's own manually-typed task that happens to share the
    // GR department code -- must not absorb generateTasksFromEstimate's
    // own items just because departmentCode matches; only a task with
    // this function's own canonical description counts as "the same one."
    await db.task.create({ data: { workOrderId: workOrder.id, description: "Ask vendor about rush pricing", departmentCode: "GR" } });

    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result.created).toBe(1); // a NEW task, not appended to the manual one

    expect(await db.task.count({ where: { workOrderId: workOrder.id, departmentCode: "GR" } })).toBe(2);
  });

  it("groups items across multiple sections into one task per department, not one task per section", async () => {
    const { project, workOrder } = await makeProjectWithWorkOrder();
    const estimate = await db.estimate.create({ data: { opportunityId: project.opportunityId } });
    const version = await createEstimateVersion(estimate.id);
    const sectionA = await addSection(version.id, { name: "LEFT TOWER", sectionType: "COMPONENT" });
    const sectionB = await addSection(version.id, { name: "RIGHT TOWER", sectionType: "COMPONENT" });
    const category = await makeCategory("Graphics");
    await addLineItem(version.id, sectionA.id, {
      lineType: "MATERIAL",
      description: "Left tower graphic",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await addLineItem(version.id, sectionB.id, {
      lineType: "MATERIAL",
      description: "Right tower graphic",
      qty: 1,
      unitCost: 500,
      category: category.name,
    });
    await lockEstimateVersion(version.id);

    const result = await generateTasksFromEstimate(project.id, workOrder.id);
    expect(result).toEqual({ created: 1, updated: 0, unassignedCount: 0 });

    const task = await db.task.findFirstOrThrow({ where: { workOrderId: workOrder.id }, include: { lineItems: true } });
    expect(task.lineItems).toHaveLength(2);
  });

  it("rejects a workOrderId that belongs to a different project", async () => {
    const { project: projectA } = await makeProjectWithWorkOrder();
    const { workOrder: workOrderB } = await makeProjectWithWorkOrder();

    await expect(generateTasksFromEstimate(projectA.id, workOrderB.id)).rejects.toThrow();
  });
});
