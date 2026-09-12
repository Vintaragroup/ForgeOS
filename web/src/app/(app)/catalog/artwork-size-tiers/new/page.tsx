import { createArtworkSizeTier } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewArtworkSizeTierPage() {
  return (
    <div>
      <PageHeader title="New artwork size tier" backHref="/catalog/artwork-size-tiers" backLabel="Artwork size tiers" />
      <Card className="p-6">
        <form action={createArtworkSizeTier} className="flex flex-col gap-4">
          <Field label="Label" name="label" placeholder="e.g. 10ft Backwall" required />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Width (in)" name="width" type="number" required />
            <Field label="Height (in)" name="height" type="number" required />
          </div>
          <Field label="Expo-produced fee ($)" name="expoProducedFee" type="number" required />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isStandard" defaultChecked />
            Offer this size to clients (unchecked = internal/legacy tier, hidden from the client portal picker)
          </label>
          <div>
            <Button>Create size tier</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
