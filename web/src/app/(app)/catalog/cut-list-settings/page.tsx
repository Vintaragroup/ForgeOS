import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCutListSettings } from "@/lib/cut-list-settings-service";
import { updateCutListSettingsAction } from "./actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default async function CutListSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const settings = await getCutListSettings();

  return (
    <div>
      <PageHeader title="Cut list settings" backHref="/catalog" backLabel="Catalog" />
      <Card className="p-6">
        <p className="mb-4 text-sm text-neutral-500">
          Shop-wide defaults for the cut-list nesting engine and the layout editor. A material&apos;s own kerf (set
          on that material&apos;s catalog page) always overrides the default kerf below -- this is only what a
          material falls back to until it has a real value of its own.
        </p>
        <form action={updateCutListSettingsAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-4">
            <Field
              label="Default kerf (in)"
              name="defaultKerf"
              type="number"
              defaultValue={settings.defaultKerf.toString()}
              required
            />
            <Field
              label="Minimum remnant size (in)"
              name="minRemnantDimension"
              type="number"
              defaultValue={settings.minRemnantDimension.toString()}
              required
            />
            <Field
              label="Drag grid snap (in)"
              name="dragGridSnap"
              type="number"
              defaultValue={settings.dragGridSnap.toString()}
              required
            />
          </div>
          <p className="text-xs text-neutral-400">
            Minimum remnant size: how small a leftover scrap has to be before it&apos;s not worth tracking as
            reusable stock. Drag grid snap: how finely a part snaps when manually repositioned on the cutting
            diagram.
          </p>
          <div>
            <Button>Save settings</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
