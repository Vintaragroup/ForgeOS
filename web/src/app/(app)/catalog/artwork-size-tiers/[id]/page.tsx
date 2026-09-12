import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteArtworkSizeTier, updateArtworkSizeTier } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export default async function ArtworkSizeTierDetailPage(props: PageProps<"/catalog/artwork-size-tiers/[id]">) {
  const { id } = await props.params;
  const tier = await db.artworkSizeTier.findFirst({ where: { id, deletedAt: null } });
  if (!tier) notFound();

  const updateWithId = updateArtworkSizeTier.bind(null, tier.id);
  const deleteWithId = deleteArtworkSizeTier.bind(null, tier.id);

  return (
    <div>
      <PageHeader title={tier.label} backHref="/catalog/artwork-size-tiers" backLabel="Artwork size tiers" />
      <Card className="p-6">
        <form action={updateWithId} className="flex flex-col gap-4">
          <Field label="Label" name="label" defaultValue={tier.label} required />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Width (in)" name="width" type="number" defaultValue={tier.width?.toString() ?? ""} required />
            <Field label="Height (in)" name="height" type="number" defaultValue={tier.height?.toString() ?? ""} required />
          </div>
          <Field
            label="Expo-produced fee ($)"
            name="expoProducedFee"
            type="number"
            defaultValue={tier.expoProducedFee.toString()}
            required
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isStandard" defaultChecked={tier.isStandard} />
            Offer this size to clients (unchecked = internal/legacy tier, hidden from the client portal picker)
          </label>
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteWithId}
          confirmMessage="Delete this size tier? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete size tier</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
