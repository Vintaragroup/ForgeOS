import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrder } from "@/lib/opportunity-access";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { getPdfPageDimensionsInInches } from "@/lib/document-view-service";
import { Card, PageHeader, StatusChip, Field, SelectField, TextareaField, Button, ReadOnlyField, EmptyState } from "@/components/ui";
import { CopyLinkBanner } from "@/components/copy-link-banner";
import { PostShowPhotoUploadForm } from "@/components/post-show-photo-upload-form";
import { ActionForm } from "@/components/action-form";
import { ArtworkRoutingEditor } from "@/components/artwork-routing-editor";
import { REPRINT_REASONS, REPRINT_REASON_LABELS, isActualReprint, reprintReasonRequired } from "@/lib/artwork-reprint";
import { listShowSections, listSkids } from "@/lib/skid-service";
import { describeSection, sectionForBooth } from "@/lib/show-section";
import {
  PRODUCTION_STATUSES_BY_KIND,
  PRODUCTION_STATUS_LABELS,
  describeRouting,
  isFullyProduced,
  loadArtworkRouting,
  signShopOffices,
} from "@/lib/artwork-routing";
import {
  assignVendorAction,
  confirmProofMatchAction,
  finalizePostShowPhotoUploadAction,
  issueCustomQuoteAction,
  issueProductionGoAheadAction,
  markDeliveredAction,
  notifyClientOfDamageAction,
  recordAgingDecisionAction,
  recordPostShowDispositionAction,
  requestProofRevisionAction,
  resolveEscalationAction,
  reviewArtworkOrderAction,
  setProductionDetailAction,
  setProductionSpecAction,
  setRoutingAction,
  setHalfStatusAction,
  requestReprintAction,
  packOntoSkidAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "good" | "critical"> = {
  UNDER_ART_REVIEW: "info",
  EXPO_PROOF_CHECK: "info",
  PROOF_REVISION_REQUESTED: "warning",
  ESCALATED: "critical",
  REJECTED: "warning",
  DELIVERED_AT_SHOW: "good",
};

export default async function ArtworkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ artworkOrderId: string }>;
  searchParams: Promise<{ invite?: string }>;
}) {
  const { artworkOrderId } = await params;
  const { invite } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const order = await db.artworkOrder.findUnique({
    where: { id: artworkOrderId, deletedAt: null },
    include: {
      opportunity: { include: { company: true } },
      // Only set for a Hub/hanging-sign piece with no opportunity -- see
      // ArtworkOrder.showId's schema comment.
      show: { select: { id: true, name: true } },
      vendor: true,
      sizeTier: true,
      designer: { select: { name: true } },
      skid: { select: { id: true, code: true, labelColor: true, sentAt: true } },
      // Only set on a piece created by a Show rollover -- see
      // rolloverArtworkOrder's own comment in artwork-order-service.ts.
      rolledOverFrom: { select: { id: true, jobCode: true, graphicCode: true } },
      files: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) notFound();
  if (!(await canAccessArtworkOrder(user, order.opportunityId))) notFound();

  const vendors = await db.vendor.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } });
  const [routings, signShops] = await Promise.all([loadArtworkRouting(order.id), signShopOffices()]);
  // Skids belong to a show, and a piece reaches one either directly or
  // through its opportunity -- same two paths the Hub reads.
  const pieceShowId = order.showId ?? order.opportunity?.showId ?? null;
  const [skids, showSections] = pieceShowId
    ? await Promise.all([listSkids(pieceShowId), listShowSections(pieceShowId)])
    : [[], []];
  // Derived, never stored -- see show-section.ts.
  const floorSection = sectionForBooth(showSections, order.opportunity?.boothNumber ?? null);
  // Designers are internal staff in the DE ("Design") department -- see
  // department-home.ts's DEPARTMENT_LABELS for the code list. Falls back
  // to an empty list gracefully (just "Unassigned" in the dropdown) if no
  // one's been assigned to that department yet.
  const designers = await db.user.findMany({
    where: { departmentCode: "DE", deletedAt: null },
    orderBy: { name: "asc" },
  });
  const reviewWithId = reviewArtworkOrderAction.bind(null, order.id);
  const issueQuoteWithId = issueCustomQuoteAction.bind(null, order.id);
  const assignVendorWithId = assignVendorAction.bind(null, order.id);
  const setRoutingWithId = setRoutingAction.bind(null, order.id);
  const setHalfStatusWithId = setHalfStatusAction.bind(null, order.id);
  const requestReprintWithId = requestReprintAction.bind(null, order.id);
  const packOntoSkidWithId = packOntoSkidAction.bind(null, order.id);
  // REPRINT_REQUESTED is reachable from these three, per ARTWORK_TRANSITIONS.
  const canReprint = ["IN_PRODUCTION", "RECEIVED_FROM_VENDOR", "INSPECTED"].includes(order.status);
  const confirmMatchWithId = confirmProofMatchAction.bind(null, order.id);
  const requestRevisionWithId = requestProofRevisionAction.bind(null, order.id);
  const resolveEscalationWithId = resolveEscalationAction.bind(null, order.id);
  const issueGoAheadWithId = issueProductionGoAheadAction.bind(null, order.id);
  const markDeliveredWithId = markDeliveredAction.bind(null, order.id);
  const setProductionSpecWithId = setProductionSpecAction.bind(null, order.id);
  const setProductionDetailWithId = setProductionDetailAction.bind(null, order.id);
  const recordPostShowDispositionWithId = recordPostShowDispositionAction.bind(null, order.id);
  const notifyClientOfDamageWithId = notifyClientOfDamageAction.bind(null, order.id);
  const recordAgingDecisionWithId = recordAgingDecisionAction.bind(null, order.id);
  const finalizePostShowPhotoUploadWithId = finalizePostShowPhotoUploadAction.bind(null, order.id);
  const postShowPhotos = order.files.filter((f) => f.kind === "POST_SHOW_CONDITION_PHOTO");

  const clientArtworkFile = order.files.find((f) => f.kind === "CLIENT_ARTWORK");
  const latestProof = [...order.files].reverse().find((f) => f.kind === "PROOF");
  const overdue = order.status === "EXPO_PROOF_CHECK" && order.slaDueAt != null && order.slaDueAt < new Date();

  // File-measured dims are read live (not persisted) purely to prefill the
  // Production spec form below -- once Expo saves a spec, customWidth/
  // customHeight on the order itself becomes the source of truth and this
  // measurement is no longer consulted for display.
  let measuredDims: { widthIn: number; heightIn: number } | null = null;
  if (clientArtworkFile) {
    try {
      const { bytes } = await getArtworkFileBytes(clientArtworkFile.id);
      measuredDims = await getPdfPageDimensionsInInches(bytes, 1);
    } catch {
      measuredDims = null;
    }
  }
  const hasProductionSpec = order.customWidth != null || order.customHeight != null || order.bleedIn != null;
  const specDefaults = {
    widthIn: order.customWidth?.toString() ?? (measuredDims ? measuredDims.widthIn.toFixed(2) : ""),
    heightIn: order.customHeight?.toString() ?? (measuredDims ? measuredDims.heightIn.toFixed(2) : ""),
    bleedIn: order.bleedIn?.toString() ?? "",
  };

  return (
    <>
      <PageHeader
        title={
          <>
            {order.jobCode}
            <StatusChip tone={STATUS_TONE[order.status] ?? "neutral"}>{order.status.replaceAll("_", " ")}</StatusChip>
            {overdue && <StatusChip tone="critical">SLA overdue</StatusChip>}
          </>
        }
        backHref="/artwork"
        backLabel="Artwork queue"
      />

      <div className="flex flex-col gap-6">
        {invite && <CopyLinkBanner link={invite} />}

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Order</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {order.opportunity ? (
              <>
                <ReadOnlyField label="Client" value={order.opportunity.company.name} />
                <ReadOnlyField
                  label="Show"
                  value={
                    <Link href={`/opportunities/${order.opportunityId}`} className="hover:underline">
                      {order.opportunity.showName}
                    </Link>
                  }
                />
              </>
            ) : (
              // A Show-owned Hub/hanging-sign piece has no client -- see
              // ArtworkOrder.showId's schema comment.
              <>
                <ReadOnlyField label="Client" value="PGA Hub" />
                <ReadOnlyField
                  label="Show"
                  value={
                    order.show ? (
                      <Link href={`/shows/${order.show.id}`} className="hover:underline">
                        {order.show.name}
                      </Link>
                    ) : (
                      "—"
                    )
                  }
                />
              </>
            )}
            <ReadOnlyField
              label="Size"
              value={
                order.sizeTier
                  ? order.sizeTier.width != null && order.sizeTier.height != null
                    ? `${order.sizeTier.label} (${order.sizeTier.width}"×${order.sizeTier.height}")`
                    : order.sizeTier.label
                  : order.customSizeRequested
                    ? "Custom"
                    : "—"
              }
            />
            <ReadOnlyField label="Vendor" value={order.vendor?.name ?? "Not yet assigned"} />
            <ReadOnlyField
              label="Expo-produced art"
              value={order.wantsExpoProducedArt ? `Yes${order.expoProducedFee ? ` — $${order.expoProducedFee}` : ""}` : "No"}
            />
            <ReadOnlyField label="Revision round" value={`${order.revisionRound} of ${2}`} />
            <ReadOnlyField label="Graphic code" value={order.graphicCode} />
            <ReadOnlyField label="Finishing details" value={order.finishingDetails} />
            <ReadOnlyField label="Art due" value={order.artDueDate ? order.artDueDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null} />
            <ReadOnlyField label="Floor section" value={floorSection ? describeSection(floorSection) : null} />
            <ReadOnlyField label="In hand by" value={order.inHandDate ? order.inHandDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null} />
            <ReadOnlyField
              label="Existing graphics status"
              value={order.existingGraphicsStatus ? order.existingGraphicsStatus.replaceAll("_", " ") : null}
            />
            <ReadOnlyField label="Sizes verified" value={order.verifiedSizes ? "Yes" : "No"} />
            <ReadOnlyField label="Designer" value={order.designer?.name} />
            {order.rolledOverFrom && (
              <ReadOnlyField
                label="Rolled over from"
                value={
                  <Link href={`/artwork/${order.rolledOverFrom.id}`} className="hover:underline">
                    {order.rolledOverFrom.graphicCode ?? order.rolledOverFrom.jobCode}
                  </Link>
                }
              />
            )}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Production detail</h2>
          <p className="mb-3 text-xs text-neutral-500">
            Filled in and corrected by Graphics during production -- material/qty were previously only editable by
            the client pre-submission; this covers the same fields plus the rest of the production record.
          </p>
          <form action={setProductionDetailWithId} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Material" name="material" defaultValue={order.material ?? ""} />
              <Field label="Qty" name="qty" type="number" defaultValue={String(order.qty)} />
              <Field label="Graphic code" name="graphicCode" defaultValue={order.graphicCode ?? ""} placeholder="e.g. A1" />
              <Field label="Finishing details" name="finishingDetails" defaultValue={order.finishingDetails ?? ""} placeholder="e.g. SEG" />
              <Field
                label="Art due"
                name="artDueDate"
                type="date"
                defaultValue={order.artDueDate ? order.artDueDate.toISOString().slice(0, 10) : ""}
              />
              <Field
                label="In hand by"
                name="inHandDate"
                type="date"
                defaultValue={order.inHandDate ? order.inHandDate.toISOString().slice(0, 10) : ""}
              />
              <SelectField
                label="Order type"
                name="orderType"
                defaultValue={order.orderType ?? ""}
                options={[
                  { value: "", label: "Not set" },
                  { value: "EXHIBITOR", label: "Exhibitor booth" },
                  { value: "SHOW_MANAGEMENT", label: "Show management" },
                  { value: "SITE", label: "Show site" },
                ]}
              />
              <SelectField
                label="Existing graphics status"
                name="existingGraphicsStatus"
                defaultValue={order.existingGraphicsStatus ?? ""}
                options={[
                  { value: "", label: "— unset —" },
                  { value: "NEW_IMAGE", label: "New image" },
                  { value: "EXISTING", label: "Existing" },
                  { value: "DAMAGED", label: "Damaged" },
                  { value: "NOT_EXISTING", label: "Not existing" },
                ]}
              />
              <SelectField
                label="Designer"
                name="designerId"
                defaultValue={order.designerId ?? ""}
                options={[{ value: "", label: "Unassigned" }, ...designers.map((d) => ({ value: d.id, label: d.name }))]}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="verifiedSizes" defaultChecked={order.verifiedSizes} className="h-4 w-4 rounded border-neutral-300" />
              Sizes verified
            </label>
            <div>
              <Button variant="secondary">Save production detail</Button>
            </div>
          </form>
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Production spec</h2>
          {measuredDims && (
            <p className="mb-3 text-xs text-neutral-500">
              Measured from the uploaded artwork file: {measuredDims.widthIn.toFixed(2)}&quot; × {measuredDims.heightIn.toFixed(2)}&quot;
              {!hasProductionSpec && " — prefilled below."}
            </p>
          )}
          <form action={setProductionSpecWithId} className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <Field label="Width (in)" name="widthIn" type="number" defaultValue={specDefaults.widthIn} />
            </div>
            <div className="w-32">
              <Field label="Height (in)" name="heightIn" type="number" defaultValue={specDefaults.heightIn} />
            </div>
            <div className="w-32">
              <Field label="Bleed (in)" name="bleedIn" type="number" defaultValue={specDefaults.bleedIn} />
            </div>
            <Button variant="secondary">Save production spec</Button>
          </form>
        </Card>

        {order.customSizeRequested && !order.customQuoteAcceptedAt && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Custom size quote</h2>
            {order.customQuoteAmount ? (
              <p className="text-sm text-neutral-500">
                Quote of ${order.customQuoteAmount.toString()} issued -- awaiting client acceptance before they can
                submit.
              </p>
            ) : (
              <form action={issueQuoteWithId} className="flex flex-wrap items-end gap-3">
                <div className="w-48">
                  <Field label="Quote amount ($)" name="amount" type="number" required />
                </div>
                <Button variant="secondary">Issue quote</Button>
              </form>
            )}
          </Card>
        )}

        {order.status === "UNDER_ART_REVIEW" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Document review</h2>
            {clientArtworkFile ? (
              <p className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <Link
                  href={`/artwork/${order.id}/files/${clientArtworkFile.id}?inline=1`}
                  target="_blank"
                  className="text-neutral-900 underline"
                >
                  View submitted artwork ({clientArtworkFile.filename})
                </Link>
                <Link
                  href={`/artwork/${order.id}/proof-sheet?fileId=${clientArtworkFile.id}`}
                  target="_blank"
                  className="text-neutral-900 underline"
                >
                  View proof sheet
                </Link>
              </p>
            ) : (
              <p className="mb-4 text-sm text-neutral-500">No artwork file found on this order.</p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <form action={reviewWithId}>
                <input type="hidden" name="decision" value="approve" />
                <Button>Approve</Button>
              </form>
              <form action={reviewWithId} className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="decision" value="reject" />
                <div className="flex-1">
                  <TextareaField label="Rejection reason" name="reason" rows={1} />
                </div>
                <Button variant="danger">Reject</Button>
              </form>
            </div>
          </Card>
        )}

        {pieceShowId && (
          <Card className="p-6">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Packing</h2>
            <p className="mb-4 text-sm text-neutral-600">
              {order.skid
                ? `On ${order.skid.code}${order.skid.labelColor ? ` (${order.skid.labelColor} label)` : ""}${
                    order.packedAt ? `, packed ${order.packedAt.toLocaleDateString()}` : ""
                  }`
                : "Not packed yet."}
            </p>
            {skids.filter((s) => !s.sentAt).length === 0 && !order.skid ? (
              <EmptyState message="No skid is open for this show -- add one on the show page first." />
            ) : (
              <ActionForm action={packOntoSkidWithId} className="flex flex-wrap items-end gap-3">
                <SelectField
                  label="Skid"
                  name="skidId"
                  defaultValue={order.skidId ?? ""}
                  options={[
                    { value: "", label: "— not packed —" },
                    ...skids
                      .filter((s) => !s.sentAt || s.id === order.skidId)
                      .map((s) => ({
                        value: s.id,
                        label: `${s.code}${s.labelColor ? ` (${s.labelColor})` : ""}${s.sentAt ? " — sent" : ""}`,
                      })),
                  ]}
                />
                <Button variant="secondary">Save</Button>
              </ActionForm>
            )}
          </Card>
        )}

        {(canReprint || order.reprintReason) && (
          <Card className="p-6">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Reprint</h2>
            {order.reprintReason && (
              <p className="mb-4 text-sm text-neutral-600">
                {REPRINT_REASON_LABELS[order.reprintReason]}
                {order.reprintNote ? ` — ${order.reprintNote}` : ""}
                {!isActualReprint(order.reprintReason) && " (recorded as added work, not a re-run)"}
              </p>
            )}
            {canReprint && (
              <ActionForm action={requestReprintWithId} className="flex flex-col gap-3">
                <SelectField
                  label="Why is this being reprinted?"
                  name="reprintReason"
                  required
                  defaultValue={order.reprintReason ?? ""}
                  options={[
                    { value: "", label: "Select a reason…" },
                    ...REPRINT_REASONS.filter((r) => r !== "NEW_ORDER_UPSELL").map((r) => ({
                      value: r,
                      label: REPRINT_REASON_LABELS[r],
                    })),
                  ]}
                />
                <Field label="What happened?" name="reprintNote" defaultValue={order.reprintNote ?? ""} />
                {reprintReasonRequired(order.orderType) && (
                  <p className="text-xs text-neutral-500">Site prints must always record a reason.</p>
                )}
                <div>
                  <Button variant="secondary">Send back for reprint</Button>
                </div>
              </ActionForm>
            )}
          </Card>
        )}

        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Production routing</h2>
          <p className="mb-1 text-sm text-neutral-600">{describeRouting(routings)}</p>
          {routings.length > 0 && (
            <p className="mb-4 text-xs text-neutral-500">
              {isFullyProduced(routings)
                ? "Every half is in."
                : "Still outstanding — a piece isn't done until both halves are."}
            </p>
          )}

          {routings.length > 0 && (
            <ul className="mb-6 divide-y divide-neutral-200 rounded-md border border-neutral-200">
              {routings.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <span className="text-sm">
                    {r.kind === "EXPO_IN_HOUSE"
                      ? `Expo${r.office ? ` (${r.office.name})` : ""}`
                      : r.kind === "VENDOR"
                        ? (r.vendor?.name ?? "Unknown shop")
                        : "AM/PM coordinating"}
                  </span>
                  <ActionForm action={setHalfStatusWithId} className="flex items-center gap-2">
                    <input type="hidden" name="routingId" value={r.id} />
                    <select
                      name="status"
                      defaultValue={r.productionStatus}
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
                    >
                      {PRODUCTION_STATUSES_BY_KIND[r.kind].map((st) => (
                        <option key={st} value={st}>
                          {PRODUCTION_STATUS_LABELS[st]}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:border-neutral-500">
                      Update
                    </button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <ArtworkRoutingEditor
            action={setRoutingWithId}
            offices={signShops}
            vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
            current={routings.map((r) => ({ kind: r.kind, vendorId: r.vendorId, officeCode: r.officeCode }))}
          />
        </Card>

        {order.status === "ACCEPTED" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Vendor assignment</h2>
            {vendors.length === 0 ? (
              <EmptyState message="No vendors in the catalog yet -- add one before assigning this job." />
            ) : (
              <form action={assignVendorWithId} className="flex flex-wrap items-end gap-3">
                <div className="min-w-64">
                  <SelectField
                    label="Approved vendor"
                    name="vendorId"
                    required
                    options={[{ value: "", label: "Select a vendor…" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
                  />
                </div>
                <Button variant="secondary">Assign &amp; notify</Button>
              </form>
            )}
          </Card>
        )}

        {order.status === "EXPO_PROOF_CHECK" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Proof review — round {order.revisionRound + 1} of {2}
            </h2>
            <p className="mb-2 text-xs text-neutral-500">
              Client cannot see this proof until you clear it here.
              {order.slaDueAt && ` SLA: check due by ${order.slaDueAt.toLocaleString()}.`}
            </p>
            {latestProof && clientArtworkFile ? (
              <div className="mb-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
                <Link
                  href={`/artwork/${order.id}/files/${latestProof.id}?inline=1`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  View proof ({latestProof.filename})
                </Link>
                <Link
                  href={`/artwork/${order.id}/files/${clientArtworkFile.id}?inline=1`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  View approved artwork
                </Link>
                <Link
                  href={`/artwork/${order.id}/proof-sheet?fileId=${latestProof.id}`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  View proof sheet
                </Link>
                <Link
                  href={`/artwork/${order.id}/proof-diff`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  Automated visual diff
                </Link>
                <Link
                  href={`/artwork/${order.id}/annotate?fileId=${latestProof.id}`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  Annotate proof
                </Link>
                <Link
                  href={`/artwork/${order.id}/annotate?fileId=${clientArtworkFile.id}`}
                  target="_blank"
                  className="rounded-md border border-neutral-200 px-3 py-2 text-center hover:border-neutral-400"
                >
                  Annotate approved artwork
                </Link>
              </div>
            ) : (
              <p className="mb-4 text-sm text-neutral-500">Missing a proof or approved-artwork file to compare.</p>
            )}
            <div className="flex flex-col gap-3">
              <form action={confirmMatchWithId}>
                <Button>✔ Matches approved artwork — release to client</Button>
              </form>
              <form action={requestRevisionWithId} className="flex flex-col gap-2">
                <TextareaField
                  label="Mismatch note (relayed to vendor as an &quot;Expo review note&quot;)"
                  name="note"
                  rows={2}
                  required
                />
                <Button variant="danger">✘ Request revision</Button>
              </form>
            </div>
          </Card>
        )}

        {order.status === "ESCALATED" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Escalated — revision cap (2) reached
            </h2>
            <p className="mb-4 text-sm text-neutral-500">
              This job needs manual resolution before it can re-enter the proof cycle. This note is visible only to
              this opportunity&apos;s owner, collaborators, and admins.
            </p>
            <form action={resolveEscalationWithId} className="flex flex-col gap-3">
              <Field label="Who was contacted" name="contactedWho" required />
              <SelectField
                label="Outcome"
                name="outcome"
                required
                options={[
                  { value: "", label: "Select an outcome…" },
                  { value: "revised quote issued", label: "Revised quote issued" },
                  { value: "client cancelled", label: "Client cancelled" },
                  { value: "held at original price", label: "Held at original price" },
                ]}
              />
              <TextareaField label="Note" name="note" rows={3} />
              <Button variant="secondary">Log &amp; reset revision count</Button>
            </form>
          </Card>
        )}

        {order.status === "PROOF_APPROVED" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Production go-ahead</h2>
            <p className="mb-4 text-sm text-neutral-500">
              The client has signed off. Only Expo can issue the final go-ahead to the vendor.
            </p>
            <form action={issueGoAheadWithId}>
              <Button>Issue go-ahead to vendor</Button>
            </form>
          </Card>
        )}

        {order.status === "SHIPPED_TO_SHOW" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Delivery</h2>
            <p className="mb-4 text-sm text-neutral-500">
              Vendor has marked this shipped. Only Expo marks delivery, since Expo has show-site visibility.
            </p>
            <form action={markDeliveredWithId}>
              <Button>Mark arrived / delivered to booth</Button>
            </form>
          </Card>
        )}

        {order.status === "DELIVERED_AT_SHOW" && (
          <Card className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Post-show</h2>
            <p className="mb-3 text-xs text-neutral-500">
              What physically happened to this piece after the show -- re-recordable, so a mis-entered condition can
              be corrected later. For a Damaged condition or a Damaged-beyond-repair discard, upload a reference
              photo below first -- the form won&apos;t accept either without at least one on file.
            </p>

            {postShowPhotos.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {postShowPhotos.map((f) => (
                  <span key={f.id} className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-600">
                    📷 {f.filename}
                  </span>
                ))}
              </div>
            )}
            <div className="mb-5 max-w-md">
              <PostShowPhotoUploadForm
                artworkOrderId={order.id}
                photoCount={postShowPhotos.length}
                finalizeUpload={finalizePostShowPhotoUploadWithId}
              />
            </div>

            <ActionForm action={recordPostShowDispositionWithId} className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-48">
                  <SelectField
                    label="Post-show status"
                    name="postShowStatus"
                    required
                    defaultValue={order.postShowStatus ?? ""}
                    options={[
                      { value: "", label: "Select a status…" },
                      { value: "NOT_RECEIVED", label: "Not received" },
                      { value: "EXPO_STORAGE", label: "Expo storage" },
                      { value: "SHIP_TO_CLIENT", label: "Ship to client" },
                      { value: "DISCARDED", label: "Discarded" },
                    ]}
                  />
                </div>
                <div className="min-w-48">
                  <SelectField
                    label="Condition"
                    name="postShowCondition"
                    defaultValue={order.postShowCondition === "PRODUCT" ? "" : (order.postShowCondition ?? "")}
                    options={[
                      { value: "", label: "— unset —" },
                      { value: "NEW", label: "New — first time in storage" },
                      { value: "OK_TO_REUSE", label: "Ok to reuse" },
                      { value: "AGING", label: "Aging — still usable, showing wear" },
                      { value: "DAMAGED", label: "Damaged" },
                      { value: "DIRTY", label: "Dirty" },
                    ]}
                  />
                </div>
                <div className="min-w-48">
                  <SelectField
                    label="Discard reason"
                    name="postShowDiscardReason"
                    defaultValue={order.postShowDiscardReason ?? ""}
                    options={[
                      { value: "", label: "— only if Discarded —" },
                      { value: "DAMAGED_BEYOND_REPAIR", label: "Damaged beyond repair" },
                      { value: "CLIENT_APPROVED_DISPOSAL", label: "Client approved disposal" },
                      { value: "AGED_OUT", label: "Aged out (replacement made)" },
                    ]}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-64 flex-1">
                  <Field
                    label="Approved by"
                    name="postShowDisposalApprovedBy"
                    defaultValue={order.postShowDisposalApprovedBy ?? ""}
                    placeholder="Client contact name -- only for client-approved disposal"
                  />
                </div>
              </div>
              <TextareaField
                label="Note"
                name="postShowConditionNote"
                rows={3}
                defaultValue={order.postShowConditionNote ?? ""}
                placeholder="What's going on with this piece? Required for Damaged, Aging, or any discard reason."
              />
              <div>
                <Button variant="secondary">Save</Button>
              </div>
            </ActionForm>
            {order.postShowRecordedAt && (
              <p className="mt-3 text-xs text-neutral-400">Last recorded {order.postShowRecordedAt.toLocaleString()}.</p>
            )}

            {order.postShowCondition === "DAMAGED" && (
              <form action={notifyClientOfDamageWithId} className="mt-4 border-t border-neutral-200 pt-4">
                <p className="mb-2 text-xs text-neutral-500">
                  Graphics was already notified automatically when this was recorded. Notifying the client is a
                  separate, deliberate step -- only do it once you&apos;re ready for them to hear about it.
                </p>
                <Button variant="secondary">Notify client about this damage</Button>
              </form>
            )}

            {order.postShowCondition === "AGING" && (
              <div className="mt-4 border-t border-neutral-200 pt-4">
                <p className="mb-2 text-xs text-neutral-500">
                  Sales was already notified automatically. Once they&apos;ve heard back from the client:
                </p>
                <div className="flex flex-wrap gap-3">
                  <form action={recordAgingDecisionWithId}>
                    <input type="hidden" name="decision" value="KEEP_IN_CIRCULATION" />
                    <Button variant="secondary">Keep in circulation</Button>
                  </form>
                  <form action={recordAgingDecisionWithId}>
                    <input type="hidden" name="decision" value="MARK_FOR_REPLACEMENT" />
                    <Button variant="secondary">Mark for replacement</Button>
                  </form>
                </div>
              </div>
            )}
          </Card>
        )}

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Files</h2>
          {order.files.length === 0 ? (
            <EmptyState message="No files uploaded yet." />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {order.files.map((f) => (
                <li key={f.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                  <span>
                    {f.filename}{" "}
                    <span className="text-neutral-400">
                      (
                      {f.kind === "PROOF"
                        ? `proof round ${f.round}`
                        : f.kind === "POST_SHOW_CONDITION_PHOTO"
                          ? "post-show condition photo"
                          : "client artwork"}
                      )
                    </span>
                    {f.previewable === false && (
                      <span className="ml-2">
                        <StatusChip tone="warning">Preview unavailable</StatusChip>
                      </span>
                    )}
                  </span>
                  <Link href={`/artwork/${order.id}/files/${f.id}`} className="text-neutral-900 hover:underline">
                    Download →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Activity</h2>
          {order.events.length === 0 ? (
            <EmptyState message="No activity yet." />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {order.events.map((e) => (
                <li key={e.id} className="rounded-md bg-neutral-50 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{e.action.replaceAll("_", " ")}</span>
                    <span className="text-xs text-neutral-400">{e.createdAt.toLocaleString()}</span>
                  </div>
                  <div className="text-xs text-neutral-500">
                    {e.actorType} {e.fromStatus ? `${e.fromStatus} → ${e.toStatus}` : e.toStatus}
                  </div>
                  {e.note && <div className="mt-1 text-neutral-700">{e.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
