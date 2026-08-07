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
  updateEstimateDetails,
  updateMarginTargetAction,
} from "../actions";
import { computeOptionTotal } from "@/lib/estimate-service";
import { createChangeOrderAction } from "../../change-orders/actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

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
  const estimate = await db.estimate.findFirst({
    where: { id, deletedAt: null },
    include: { opportunity: { include: { company: true } } },
  });
  if (!estimate) notFound();

  const versions = await db.estimateVersion.findMany({
    where: { estimateId: estimate.id },
    orderBy: { versionNumber: "desc" },
    include: {
      sections: { where: { optionId: null }, orderBy: { sortOrder: "asc" }, include: { lineItems: true } },
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

  const [users, proposalTemplates, attachments] = await Promise.all([
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.proposalTemplate.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.attachment.findMany({
      where: { estimateId: estimate.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { uploadedBy: true },
    }),
  ]);

  const addAttachmentWithId = addAttachmentAction.bind(null, estimate.id);
  const updateEstimateDetailsWithId = updateEstimateDetails.bind(null, estimate.id);
  const createFirstVersionWithId = createFirstVersion.bind(null, estimate.id);

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
    sections: { include: { lineItems: true } };
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
          <div className="text-lg font-semibold">{money(version.grandTotal)}</div>
        </div>
        <div>
          <div className="text-neutral-500">Gross margin</div>
          <div className="text-lg font-semibold">{version.grossMarginPct.toFixed(1)}%</div>
        </div>
      </div>

      {version.isLocked ? (
        <>
          <p className="mb-4 text-sm text-neutral-500">
            Margin target: {version.marginTargetPct.toFixed(1)}% (locked{" "}
            {version.lockedAt ? version.lockedAt.toISOString().slice(0, 16).replace("T", " ") : ""})
          </p>

          <div className="mb-6 rounded-md border border-neutral-200 p-4">
            {!version.isApproved ? (
              users.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  No users yet — add one on the <Link href="/users" className="underline">Users</Link> page
                  before approving.
                </p>
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
                  <p className="text-sm text-neutral-500">
                    No proposal templates yet — add one in the{" "}
                    <Link href="/catalog/proposal-templates/new" className="underline">Catalog</Link> before
                    generating a proposal.
                  </p>
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
              <table className="mb-3 w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-500">
                    <th className="pb-1 font-normal">Description</th>
                    <th className="pb-1 font-normal">Dept</th>
                    <th className="pb-1 font-normal">Type</th>
                    <th className="pb-1 text-right font-normal">Qty</th>
                    <th className="pb-1 text-right font-normal">Unit cost</th>
                    <th className="pb-1 text-right font-normal">Total</th>
                    {!version.isLocked && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {section.lineItems.map((li) => {
                    const deleteWithIds = deleteLineItemAction.bind(null, estimateId, li.id);
                    const confirmWithIds = confirmDraftLineItemAction.bind(null, estimateId, li.id);
                    return (
                      <tr key={li.id} className="border-t border-neutral-100">
                        <td className="py-1.5">
                          {li.description}
                          {li.isDraft && (
                            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                              draft
                            </span>
                          )}
                        </td>
                        <td className="py-1.5">{li.department ?? ""}</td>
                        <td className="py-1.5">{li.lineType}</td>
                        <td className="py-1.5 text-right">{li.qty.toString()}</td>
                        <td className="py-1.5 text-right">{money(li.unitCost)}</td>
                        <td className="py-1.5 text-right">{money(li.totalCost)}</td>
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
    <form action={addLineItemWithIds} className="flex flex-wrap items-end gap-3 rounded-md bg-neutral-50 p-3">
      <div className="w-36">
        <SelectField label="Type" name="lineType" defaultValue="MATERIAL" options={LINE_TYPE_OPTIONS} />
      </div>
      <div className="flex-1 min-w-[10rem]">
        <Field label="Description" name="description" required />
      </div>
      <div className="w-24">
        <Field label="Dept" name="department" placeholder="EF" />
      </div>
      <div className="w-24">
        <Field label="Qty" name="qty" type="number" defaultValue="1" required />
      </div>
      <div className="w-28">
        <Field label="Unit cost ($)" name="unitCost" type="number" required />
      </div>
      {attachments.length > 0 && (
        <>
          <div className="w-40">
            <SelectField
              label="From attachment"
              name="attachmentId"
              options={[{ value: "", label: "— none —" }, ...attachments.map((a) => ({ value: a.id, label: a.fileRef }))]}
            />
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-neutral-700">
            <input type="checkbox" name="isDraft" /> Draft
          </label>
        </>
      )}
      <Button variant="secondary">Add line item</Button>
    </form>
  );
}
