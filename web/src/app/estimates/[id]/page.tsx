import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  addLineItemAction,
  addSectionAction,
  createFirstVersion,
  createNewVersionAction,
  deleteLineItemAction,
  lockVersionAction,
  updateEstimateDetails,
  updateMarginTargetAction,
} from "../actions";
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
    include: { sections: { orderBy: { sortOrder: "asc" }, include: { lineItems: true } } },
  });

  const currentVersion = versions.find((v) => v.isCurrent) ?? versions[0];
  const olderVersions = versions.filter((v) => v.id !== currentVersion?.id);

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
        <EstimateVersionCard estimateId={estimate.id} version={currentVersion} />
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
  include: { sections: { include: { lineItems: true } } };
}>;

function EstimateVersionCard({
  estimateId,
  version,
}: {
  estimateId: string;
  version: VersionWithSections;
}) {
  const updateMarginTargetWithIds = updateMarginTargetAction.bind(null, estimateId, version.id);
  const addSectionWithIds = addSectionAction.bind(null, estimateId, version.id);
  const lockVersionWithIds = lockVersionAction.bind(null, estimateId, version.id);
  const createNewVersionWithIds = createNewVersionAction.bind(null, estimateId, version.id);

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Version {version.versionNumber} {version.isLocked ? "· locked" : "· editing"}
        </h2>
        {version.isLocked ? (
          <form action={createNewVersionWithIds}>
            <Button variant="secondary">Create new version</Button>
          </form>
        ) : (
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
        <p className="mb-6 text-sm text-neutral-500">
          Margin target: {version.marginTargetPct.toFixed(1)}% (locked{" "}
          {version.lockedAt ? version.lockedAt.toISOString().slice(0, 16).replace("T", " ") : ""})
        </p>
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
                    return (
                      <tr key={li.id} className="border-t border-neutral-100">
                        <td className="py-1.5">{li.description}</td>
                        <td className="py-1.5">{li.department ?? ""}</td>
                        <td className="py-1.5">{li.lineType}</td>
                        <td className="py-1.5 text-right">{li.qty.toString()}</td>
                        <td className="py-1.5 text-right">{money(li.unitCost)}</td>
                        <td className="py-1.5 text-right">{money(li.totalCost)}</td>
                        {!version.isLocked && (
                          <td className="py-1.5 text-right">
                            <form action={deleteWithIds}>
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
              <AddLineItemForm estimateId={estimateId} versionId={version.id} sectionId={section.id} />
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
    </Card>
  );
}

function AddLineItemForm({
  estimateId,
  versionId,
  sectionId,
}: {
  estimateId: string;
  versionId: string;
  sectionId: string;
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
      <Button variant="secondary">Add line item</Button>
    </form>
  );
}
