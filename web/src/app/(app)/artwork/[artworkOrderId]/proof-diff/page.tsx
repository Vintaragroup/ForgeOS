// Automated first-pass signal alongside the EXPO_PROOF_CHECK card's
// existing manual "View proof" / "View approved artwork" links -- a real
// page (not a raw image route) since the useful output here is a message
// or a percentage *plus* an image, not the image alone.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrder } from "@/lib/opportunity-access";
import { getArtworkFileBytes } from "@/lib/artwork-file-service";
import { diffArtworkPages } from "@/lib/artwork-image-diff";
import { Card, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ProofDiffPage({
  params,
}: {
  params: Promise<{ artworkOrderId: string }>;
}) {
  const { artworkOrderId } = await params;
  const user = await getCurrentUser();
  if (!user) notFound();

  const order = await db.artworkOrder.findUnique({
    where: { id: artworkOrderId, deletedAt: null },
    include: { files: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } } },
  });
  if (!order) notFound();
  if (!(await canAccessArtworkOrder(user, order.opportunityId))) notFound();

  const clientArtworkFile = order.files.find((f) => f.kind === "CLIENT_ARTWORK");
  const latestProof = [...order.files].reverse().find((f) => f.kind === "PROOF");

  const result =
    clientArtworkFile && latestProof
      ? await (async () => {
          const [{ bytes: proofBytes }, { bytes: approvedBytes }] = await Promise.all([
            getArtworkFileBytes(latestProof.id),
            getArtworkFileBytes(clientArtworkFile.id),
          ]);
          return diffArtworkPages(proofBytes, approvedBytes, 1);
        })()
      : { skipped: true as const, reason: "Missing a proof or approved-artwork file to compare." };

  return (
    <>
      <PageHeader title={`${order.jobCode} — automated visual diff`} backHref={`/artwork/${order.id}`} backLabel="Order" />
      <Card className="p-6">
        {result.skipped ? (
          <p className="text-sm text-neutral-600">{result.reason}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-600">
              <span className="text-2xl font-semibold text-neutral-900">{result.diffPercent.toFixed(1)}%</span> of pixels
              differ between the proof and the approved artwork. This is an automated first-pass signal -- review the
              highlighted areas below, not a substitute for the manual comparison.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element -- a live-generated data: URL, not an optimizable static asset */}
            <img src={result.diffImageDataUrl} alt="Pixel diff between proof and approved artwork" className="max-w-full rounded-md border border-neutral-200" />
          </div>
        )}
      </Card>
    </>
  );
}
