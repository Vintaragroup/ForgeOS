import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  addAttachmentAction,
  addLineItemAction,
  addOptionAction,
  addOptionSectionAction,
  addSectionAction,
  approveVersionAction,
  confirmDraftLineItemAction,
  createFirstVersion,
  createNewVersionAction,
  deleteLineItemAction,
  generateProposalAction,
  lockVersionAction,
  recordCostActualAction,
  updateEstimateDetails,
  updateMarginTargetAction,
} from "../actions";
import { commitImportAction, previewImportAction, updateLineItemUnitCostAction } from "./import-actions";
import { computeOptionTotal } from "@/lib/estimate-service";
import { previewPricingImport } from "@/lib/pricing-import-service";
import { computeActualTotal, computeDepartmentVariance, computeLineItemVariance } from "@/lib/cost-actual-service";
import { createChangeOrderAction } from "../../change-orders/actions";
import { Button, Card, Field, Notice, PageHeader, SelectField } from "@/components/ui";

const SECTION_TYPE_OPTIONS = [
  { value: "COMPONENT", label: "Component" },
  { value: "CATEGORY", label: "Category" },
  { value: "FEE", label: "Fee" },
];

const LINE_TYPE_OPTIONS = [
  { value: "MATERIAL", label: "Material" },
  { value: "LABOR", label: "Labor" },
  { value: "FEE", label: "Fee" },
];

function money(d: { toFixed(n: number): string }): string {
  return `$${d.toFixed(2)}`;
}

export default async function EstimateDetailPage(props: PageProps<"/estimates/[id]">) {
  const { id } = await props.params;
  const { importDocumentId: importDocumentIdParam } = await props.searchParams;
  const importDocumentId = Array.isArray(importDocumentIdParam) ? importDocumentIdParam[0] : importDocumentIdParam;
  const estimate = await db.estimate.findFirst({
    where: { id, deletedAt: null },
    include: { opportunity: { include: { company: true } } },
  });
  if (!estimate) notFound();

  const versions = await db.estimateVersion.findMany({
    where: { estimateId: estimate.id },
    orderBy: { versionNumber: "desc" },
    include: {
      sections: {
        where: { optionId: null },
        orderBy: { sortOrder: "asc" },
        include: { lineItems: { include: { costActuals: true } } },
      },
      options: {
        orderBy: { sortOrder: "asc" },
        include: { sections: { orderBy: { sortOrder: "asc" }, include: { lineItems: true } } },
      },
      approvedBy: true,
      proposals: { orderBy: { createdAt: "desc" } },
      changeOrdersAsBase: { orderBy: { createdAt: "desc" } },
    },
  });

  const currentVersion = versions.find((v) => v.isCurrent) ?? versions[0];
  const olderVersions = versions.filter((v) => v.id !== currentVersion?.id);

  const [users, proposalTemplates, attachments, pricingScheduleDocuments] = await Promise.all([
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.proposalTemplate.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.attachment.findMany({
      where: { estimateId: estimate.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { uploadedBy: true },
    }),
    db.document.findMany({
      where: { opportunityId: estimate.opportunityId, documentType: "PRICING_SCHEDULE", deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const addAttachmentWithId = addAttachmentAction.bind(null, estimate.id);
  const updateEstimateDetailsWithId = updateEstimateDetails.bind(null, estimate.id);
  const createFirstVersionWithId = createFirstVersion.bind(null, estimate.id);
  const previewImportWithId = previewImportAction.bind(null, estimate.id);

  const canImport = !!currentVersion && !currentVersion.isLocked;
  const importPreview =
    canImport && importDocumentId ? await previewPricingImport(importDocumentId).catch((err: Error) => err) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Estimate — ${estimate.opportunity.showName}`}
        action={
          <Link href={`/opportunities/${estimate.opportunity.id}`} className="text-sm text-neutral-500 hover:text-neutral-900">
            ← {estimate.opportunity.company.name}
          </Link>
        }
      />

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Details
        </h2>
        <form action={updateEstimateDetailsWithId} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Budget ($)"
              name="budget"
              type="number"
              defaultValue={estimate.budget?.toString() ?? ""}
            />
            <Field label="Tax city" name="taxCity" defaultValue={estimate.taxCity ?? ""} />
          </div>
          <div>
            <Button>Save details</Button>
          </div>
        </form>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Attachments
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          Design files (pull sheets, artwork) referenced by filename or an external link -- ForgeOS doesn&apos;t
          host files yet, matching how artwork already moves via FTP/WeTransfer outside the workbook.
        </p>
        {attachments.length > 0 && (
          <ul className="mb-4 flex flex-col gap-1 text-sm">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                <span>{a.fileRef}</span>
                <span className="text-neutral-500">{a.uploadedBy?.name ?? "unknown"}</span>
              </li>
            ))}
          </ul>
        )}
        <form action={addAttachmentWithId} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="File reference" name="fileRef" placeholder="e.g. pull-sheet-v1.pdf or a WeTransfer link" required />
          </div>
          <div className="w-48">
            <SelectField
              label="Uploaded by"
              name="uploadedById"
              options={[{ value: "", label: "— unspecified —" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
            />
          </div>
          <Button variant="secondary">Add attachment</Button>
        </form>
      </Card>

      {canImport && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Import from document
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Parses a Pricing Schedule spreadsheet (uploaded on the Opportunity&apos;s Documents card) straight
            into draft line items with qty/unit already filled in — Unit Rate starts at $0, pending review.
          </p>
          {pricingScheduleDocuments.length === 0 ? (
            <Notice
              message="No pricing-schedule documents uploaded yet."
              actionHref={`/opportunities/${estimate.opportunity.id}`}
              actionLabel="Go to Opportunity"
            />
          ) : (
            <form action={previewImportWithId} className="flex items-end gap-3">
              <div className="flex-1">
                <SelectField
                  label="Document"
                  name="documentId"
                  defaultValue={importDocumentId ?? ""}
                  options={pricingScheduleDocuments.map((d) => ({ value: d.id, label: d.filename }))}
                />
              </div>
              <Button variant="secondary">Preview import</Button>
            </form>
          )}

          {importPreview instanceof Error && (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {importPreview.message}
            </p>
          )}

          {importPreview && !(importPreview instanceof Error) && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-sm text-neutral-700">
                <span className="font-medium">{importPreview.rows.length}</span> line items across{" "}
                <span className="font-medium">{importPreview.categories.length}</span> categories in{" "}
                <span className="font-medium">{importPreview.filename}</span> ({importPreview.sheetName}).
              </p>
              <div className="mb-4 max-h-64 overflow-y-auto rounded-md border border-neutral-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-neutral-50">
                    <tr className="text-left text-neutral-500">
                      <th className="px-2 py-1.5 font-normal">Category</th>
                      <th className="px-2 py-1.5 font-normal">Description</th>
                      <th className="px-2 py-1.5 text-right font-normal">Unit</th>
                      <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.rows.map((row) => (
                      <tr key={row.rowNumber} className="border-t border-neutral-100">
                        <td className="px-2 py-1 text-neutral-500">{row.category}</td>
                        <td className="max-w-[24rem] truncate px-2 py-1" title={row.description}>
                          {row.description.split("\n")[0]}
                        </td>
                        <td className="px-2 py-1 text-right">{row.unit}</td>
                        <td className="px-2 py-1 text-right">{row.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <form action={commitImportAction.bind(null, estimate.id, currentVersion!.id, importPreview.documentId)}>
                <Button>
                  Commit {importPreview.rows.length} draft line items
                </Button>
              </form>
            </div>
          )}
        </Card>
      )}

      {!currentVersion ? (
        <Card className="p-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Version 1
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            No estimate version yet. Start one to begin adding sections and line items.
          </p>
          <form action={createFirstVersionWithId}>
            <Button>Start version 1</Button>
          </form>
        </Card>
      ) : (
        <EstimateVersionCard
          estimateId={estimate.id}
          version={currentVersion}
          users={users}
          proposalTemplates={proposalTemplates}
          attachments={attachments}
        />
      )}

      {olderVersions.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Earlier versions
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {olderVersions.map((v) => (
              <li key={v.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                <span>
                  Version {v.versionNumber} {v.isLocked ? "· locked" : "· unlocked"}
                </span>
                <span className="font-medium">{money(v.grandTotal)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

type VersionWithSections = Prisma.EstimateVersionGetPayload<{
  include: {
    sections: { include: { lineItems: { include: { costActuals: true } } } };
    options: { include: { sections: { include: { lineItems: true } } } };
    approvedBy: true;
    proposals: true;
    changeOrdersAsBase: true;
  };
}>;

function EstimateVersionCard({
  estimateId,
  version,
  users,
  proposalTemplates,
  attachments,
}: {
  estimateId: string;
  version: VersionWithSections;
  users: { id: string; name: string }[];
  proposalTemplates: { id: string; name: string }[];
  attachments: { id: string; fileRef: string }[];
}) {
  const updateMarginTargetWithIds = updateMarginTargetAction.bind(null, estimateId, version.id);
  const addSectionWithIds = addSectionAction.bind(null, estimateId, version.id);
  const addOptionWithIds = addOptionAction.bind(null, estimateId, version.id);
  const lockVersionWithIds = lockVersionAction.bind(null, estimateId, version.id);
  const createNewVersionWithIds = createNewVersionAction.bind(null, estimateId, version.id);
  const approveVersionWithIds = approveVersionAction.bind(null, estimateId, version.id);
  const generateProposalWithIds = generateProposalAction.bind(null, estimateId, version.id);
  const createChangeOrderWithIds = createChangeOrderAction.bind(null, estimateId, version.id);

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Version {version.versionNumber} {version.isLocked ? "· locked" : "· editing"}
        </h2>
        {version.isLocked && !version.isApproved && (
          <form action={createNewVersionWithIds}>
            <Button variant="secondary">Create new version</Button>
          </form>
        )}
        {!version.isLocked && (
          <form action={lockVersionWithIds}>
            <Button variant="secondary">Lock version</Button>
          </form>
        )}
      </div>

      <div className="mb-6 grid grid-cols-3 gap-4 rounded-md bg-neutral-50 p-4 text-sm">
        <div>
          <div className="text-neutral-500">Total cost</div>
          <div className="text-lg font-semibold">{money(version.totalCost)}</div>
        </div>
        <div>
          <div className="text-neutral-500">Grand total</div>
          <div className="text-lg font-semibold text-brand-navy">{money(version.grandTotal)}</div>
        </div>
        <div>
          <div className="text-neutral-500">Gross margin</div>
          <div className="text-lg font-semibold">{version.grossMarginPct.toFixed(1)}%</div>
        </div>
      </div>

      {version.isLocked && <VarianceByDepartment sections={version.sections} />}

      {version.isLocked ? (
        <>
          <p className="mb-4 text-sm text-neutral-500">
            Margin target: {version.marginTargetPct.toFixed(1)}% (locked{" "}
            {version.lockedAt ? version.lockedAt.toISOString().slice(0, 16).replace("T", " ") : ""})
          </p>

          <div className="mb-6 rounded-md border border-neutral-200 p-4">
            {!version.isApproved ? (
              users.length === 0 ? (
                <Notice
                  message="Approving a version needs an approver on file, and there are no users yet."
                  actionHref="/admin/users/new"
                  actionLabel="Add a user"
                />
              ) : (
                <form action={approveVersionWithIds} className="flex items-end gap-3">
                  <div className="w-56">
                    <SelectField
                      label="Approved by"
                      name="approvedById"
                      required
                      options={users.map((u) => ({ value: u.id, label: u.name }))}
                    />
                  </div>
                  <Button variant="secondary">Approve version</Button>
                </form>
              )
            ) : (
              <>
                <p className="mb-3 text-sm text-neutral-500">
                  Approved by {version.approvedBy?.name ?? "unknown"}
                  {version.approvedAt
                    ? ` on ${version.approvedAt.toISOString().slice(0, 16).replace("T", " ")}`
                    : ""}
                </p>
                {proposalTemplates.length === 0 ? (
                  <Notice
                    message="Generating a proposal needs a branded template, and there are no templates yet."
                    actionHref="/catalog/proposal-templates/new"
                    actionLabel="Add a template"
                  />
                ) : (
                  <form action={generateProposalWithIds} className="flex items-end gap-3">
                    <div className="w-56">
                      <SelectField
                        label="Proposal template"
                        name="templateId"
                        required
                        options={proposalTemplates.map((t) => ({ value: t.id, label: t.name }))}
                      />
                    </div>
                    <Button variant="secondary">Generate proposal</Button>
                  </form>
                )}
                {version.proposals.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-1 border-t border-neutral-200 pt-3 text-sm">
                    {version.proposals.map((p) => (
                      <li key={p.id} className="flex items-center justify-between">
                        <Link href={`/proposals/${p.id}`} className="text-neutral-900 hover:underline">
                          Proposal {p.id.slice(0, 8)}
                        </Link>
                        <span className="text-neutral-500">
                          {p.signedAt ? "Signed" : p.sentAt ? "Sent" : "Draft"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <form action={createChangeOrderWithIds} className="mt-4 flex items-end gap-3 border-t border-neutral-200 pt-3">
                  <div className="flex-1">
                    <Field
                      label="Start a change order"
                      name="description"
                      placeholder="What's changing? e.g. Upgrade flooring"
                      required
                    />
                  </div>
                  <Button variant="secondary">Start change order</Button>
                </form>
                {version.changeOrdersAsBase.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-1 border-t border-neutral-200 pt-3 text-sm">
                    {version.changeOrdersAsBase.map((co) => (
                      <li key={co.id} className="flex items-center justify-between">
                        <Link href={`/change-orders/${co.id}`} className="text-neutral-900 hover:underline">
                          {co.description}
                        </Link>
                        <span className="text-neutral-500">{co.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <form action={updateMarginTargetWithIds} className="mb-6 flex items-end gap-3">
          <div className="w-40">
            <Field
              label="Margin target (%)"
              name="marginTargetPct"
              type="number"
              defaultValue={version.marginTargetPct.toString()}
              required
            />
          </div>
          <Button variant="secondary">Update margin</Button>
        </form>
      )}

      <div className="flex flex-col gap-6">
        {version.sections.map((section) => (
          <div key={section.id} className="border-t border-neutral-200 pt-4">
            <h3 className="mb-3 font-medium">
              {section.name}{" "}
              <span className="text-xs font-normal uppercase text-neutral-400">
                {section.sectionType}
              </span>
            </h3>
            {section.lineItems.length > 0 && (
              <div className="mb-1 overflow-x-auto rounded-md border border-neutral-200">
              <table className="w-full min-w-[38rem] text-sm">
                <thead>
                  <tr className="text-left text-neutral-500">
                    <th className="pb-1 font-normal">Description</th>
                    <th className="pb-1 font-normal">Dept</th>
                    <th className="pb-1 font-normal">Type</th>
                    <th className="pb-1 text-right font-normal">Qty</th>
                    <th className="pb-1 text-right font-normal">Unit cost</th>
                    <th className="pb-1 text-right font-normal">Est. total</th>
                    {version.isLocked && (
                      <>
                        <th className="pb-1 text-right font-normal">Actual</th>
                        <th className="pb-1 text-right font-normal">Variance</th>
                      </>
                    )}
                    {!version.isLocked && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {section.lineItems.map((li) => {
                    const deleteWithIds = deleteLineItemAction.bind(null, estimateId, li.id);
                    const confirmWithIds = confirmDraftLineItemAction.bind(null, estimateId, li.id);
                    const updateUnitCostWithIds = updateLineItemUnitCostAction.bind(
                      null,
                      estimateId,
                      version.id,
                      li.id,
                    );
                    const actualCost = version.isLocked ? computeActualTotal(li.costActuals) : null;
                    const variance = actualCost !== null ? actualCost.minus(li.totalCost) : null;
                    return (
                      <tr key={li.id} className="border-t border-neutral-100">
                        <td className="py-1.5">
                          {li.description}
                          {li.isDraft && (
                            <span className="ml-2 rounded-full bg-brand-tan px-2 py-0.5 text-xs text-amber-900">
                              draft
                            </span>
                          )}
                        </td>
                        <td className="py-1.5">{li.department ?? ""}</td>
                        <td className="py-1.5">{li.lineType}</td>
                        <td className="py-1.5 text-right">{li.qty.toString()}</td>
                        <td className="py-1.5 text-right">
                          {!version.isLocked && li.isDraft ? (
                            <form action={updateUnitCostWithIds} className="flex items-center justify-end gap-1">
                              <input
                                type="number"
                                name="unitCost"
                                step="any"
                                defaultValue={li.unitCost.toString()}
                                className="w-20 rounded border border-neutral-300 px-1.5 py-0.5 text-right text-sm outline-none focus:border-neutral-500"
                              />
                              <button className="text-xs text-neutral-500 hover:underline">save</button>
                            </form>
                          ) : (
                            money(li.unitCost)
                          )}
                        </td>
                        <td className="py-1.5 text-right">{money(li.totalCost)}</td>
                        {version.isLocked && actualCost !== null && variance !== null && (
                          <>
                            <td className="py-1.5 text-right">{money(actualCost)}</td>
                            <td
                              className={`py-1.5 text-right ${variance.isPositive() ? "text-red-600" : variance.isNegative() ? "text-green-600" : ""}`}
                            >
                              {variance.isPositive() ? "+" : ""}
                              {money(variance)}
                            </td>
                          </>
                        )}
                        {!version.isLocked && (
                          <td className="py-1.5 text-right whitespace-nowrap">
                            {li.isDraft && (
                              <form action={confirmWithIds} className="inline">
                                <button className="mr-2 text-xs text-neutral-700 hover:underline">confirm</button>
                              </form>
                            )}
                            <form action={deleteWithIds} className="inline">
                              <button className="text-xs text-red-500 hover:underline">remove</button>
                            </form>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            )}
            {version.isLocked && section.lineItems.length > 0 && (
              <p className="mb-3 text-xs text-neutral-400 sm:hidden">
                ← Scroll the table for Actual &amp; Variance
              </p>
            )}
            {version.isLocked && section.lineItems.length > 0 && (
              <div className="mb-3 flex flex-col gap-2">
                {section.lineItems.map((li) => (
                  <RecordActualForm key={li.id} estimateId={estimateId} lineItem={li} users={users} />
                ))}
              </div>
            )}
            {!version.isLocked && (
              <AddLineItemForm
                estimateId={estimateId}
                versionId={version.id}
                sectionId={section.id}
                attachments={attachments}
              />
            )}
          </div>
        ))}
      </div>

      {!version.isLocked && (
        <form action={addSectionWithIds} className="mt-6 flex items-end gap-3 border-t border-neutral-200 pt-4">
          <div className="flex-1">
            <Field label="New section name" name="name" placeholder="e.g. COMPONENT 1" required />
          </div>
          <div className="w-48">
            <SelectField label="Type" name="sectionType" defaultValue="COMPONENT" options={SECTION_TYPE_OPTIONS} />
          </div>
          <Button variant="secondary">Add section</Button>
        </form>
      )}

      {(version.options.length > 0 || !version.isLocked) && (
        <div className="mt-8 border-t-2 border-neutral-200 pt-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Options (alternates)
          </h3>
          <div className="flex flex-col gap-6">
            {version.options.map((option) => (
              <OptionCard key={option.id} estimateId={estimateId} versionId={version.id} option={option} isLocked={version.isLocked} />
            ))}
          </div>
          {!version.isLocked && (
            <form action={addOptionWithIds} className="mt-6 flex items-end gap-3">
              <div className="flex-1">
                <Field label="New option name" name="name" placeholder="e.g. Option 1: Upgraded flooring" required />
              </div>
              <Button variant="secondary">Add option</Button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}

function OptionCard({
  estimateId,
  versionId,
  option,
  isLocked,
}: {
  estimateId: string;
  versionId: string;
  option: VersionWithSections["options"][number];
  isLocked: boolean;
}) {
  const addOptionSectionWithIds = addOptionSectionAction.bind(null, estimateId, versionId, option.id);
  const optionTotal = computeOptionTotal(option.sections);

  return (
    <div className="rounded-md border border-dashed border-neutral-300 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-medium">{option.name}</h4>
        <span className="text-sm font-medium text-neutral-700">{money(optionTotal)}</span>
      </div>
      {option.sections.map((section) => (
        <div key={section.id} className="mb-3">
          <h5 className="mb-2 text-sm text-neutral-500">{section.name}</h5>
          {section.lineItems.length > 0 && (
            <table className="mb-2 w-full text-sm">
              <tbody>
                {section.lineItems.map((li) => (
                  <tr key={li.id} className="border-t border-neutral-100">
                    <td className="py-1.5">{li.description}</td>
                    <td className="py-1.5 text-right">{li.qty.toString()}</td>
                    <td className="py-1.5 text-right">{money(li.unitCost)}</td>
                    <td className="py-1.5 text-right">{money(li.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!isLocked && <AddLineItemForm estimateId={estimateId} versionId={versionId} sectionId={section.id} />}
        </div>
      ))}
      {!isLocked && (
        <form action={addOptionSectionWithIds} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="New section name" name="name" placeholder="e.g. COMPONENT 1" required />
          </div>
          <div className="w-40">
            <SelectField label="Type" name="sectionType" defaultValue="COMPONENT" options={SECTION_TYPE_OPTIONS} />
          </div>
          <Button variant="secondary">Add section</Button>
        </form>
      )}
    </div>
  );
}

// migration-plan.md Phase 6 scope: "variance reporting ... by
// department/category/job." Department comes from LineItem.department;
// "job" is this estimate itself, so the whole card already scopes to it.
function VarianceByDepartment({
  sections,
}: {
  sections: {
    lineItems: {
      id: string;
      description: string;
      department: string | null;
      totalCost: Prisma.Decimal;
      costActuals: { actualCost: Prisma.Decimal }[];
    }[];
  }[];
}) {
  const rows = computeLineItemVariance(sections.flatMap((s) => s.lineItems));
  const hasActuals = rows.some((r) => r.actualCost.toNumber() !== 0);
  if (!hasActuals) return null;

  const byDept = computeDepartmentVariance(rows);

  return (
    <div className="mb-6 rounded-md border border-neutral-200 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Variance by department
      </h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-neutral-500">
            <th className="pb-1 font-normal">Department</th>
            <th className="pb-1 text-right font-normal">Estimated</th>
            <th className="pb-1 text-right font-normal">Actual</th>
            <th className="pb-1 text-right font-normal">Variance</th>
          </tr>
        </thead>
        <tbody>
          {byDept.map((d) => (
            <tr key={d.department} className="border-t border-neutral-100">
              <td className="py-1.5">{d.department}</td>
              <td className="py-1.5 text-right">{money(d.estimatedCost)}</td>
              <td className="py-1.5 text-right">{money(d.actualCost)}</td>
              <td
                className={`py-1.5 text-right ${d.variance.isPositive() ? "text-red-600" : d.variance.isNegative() ? "text-green-600" : ""}`}
              >
                {d.variance.isPositive() ? "+" : ""}
                {money(d.variance)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordActualForm({
  estimateId,
  lineItem,
  users,
}: {
  estimateId: string;
  lineItem: { id: string; description: string };
  users: { id: string; name: string }[];
}) {
  const recordActualWithIds = recordCostActualAction.bind(null, estimateId, lineItem.id);
  return (
    <form action={recordActualWithIds} className="flex flex-wrap items-end gap-3 rounded-md bg-neutral-50 p-3 text-sm">
      <span className="pb-2 text-neutral-500">{lineItem.description}:</span>
      <div className="w-28">
        <Field label="Actual cost ($)" name="actualCost" type="number" required />
      </div>
      <div className="w-40">
        <Field label="Source" name="source" placeholder="e.g. Vendor invoice #123" />
      </div>
      <div className="w-40">
        <SelectField
          label="Recorded by"
          name="recordedById"
          options={[{ value: "", label: "— unspecified —" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
        />
      </div>
      <Button variant="secondary">Record actual</Button>
    </form>
  );
}

function AddLineItemForm({
  estimateId,
  versionId,
  sectionId,
  attachments = [],
}: {
  estimateId: string;
  versionId: string;
  sectionId: string;
  attachments?: { id: string; fileRef: string }[];
}) {
  const addLineItemWithIds = addLineItemAction.bind(null, estimateId, versionId, sectionId);
  return (
    <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3">
      <div className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Add line item
      </div>
      <form action={addLineItemWithIds} className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <div className="col-span-2 sm:order-2 sm:flex-1 sm:min-w-[10rem]">
          <Field label="Description" name="description" required />
        </div>
        <div className="sm:order-1 sm:w-36">
          <SelectField label="Type" name="lineType" defaultValue="MATERIAL" options={LINE_TYPE_OPTIONS} />
        </div>
        <div className="sm:order-3 sm:w-24">
          <Field label="Dept" name="department" placeholder="EF" />
        </div>
        <div className="sm:order-4 sm:w-24">
          <Field label="Qty" name="qty" type="number" defaultValue="1" required />
        </div>
        <div className="sm:order-5 sm:w-28">
          <Field label="Unit cost ($)" name="unitCost" type="number" required />
        </div>
        {attachments.length > 0 && (
          <>
            <div className="col-span-2 sm:order-6 sm:w-40 sm:col-span-1">
              <SelectField
                label="From attachment"
                name="attachmentId"
                options={[{ value: "", label: "— none —" }, ...attachments.map((a) => ({ value: a.id, label: a.fileRef }))]}
              />
            </div>
            <label className="col-span-2 flex items-center gap-1.5 pb-2 text-sm text-neutral-700 sm:order-7 sm:col-span-1">
              <input type="checkbox" name="isDraft" /> Draft
            </label>
          </>
        )}
        <div className="col-span-2 sm:order-8">
          <Button variant="secondary">Add line item</Button>
        </div>
      </form>
    </div>
  );
}
