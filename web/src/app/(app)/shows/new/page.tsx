import { createShow } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewShowPage() {
  return (
    <div>
      <PageHeader title="Start a show" backHref="/shows" backLabel="Shows" />
      <Card className="p-6">
        <form action={createShow} className="flex flex-col gap-4">
          <Field label="Show name" name="name" required placeholder="e.g. 2026 PGA Show" />
          <Field label="Venue" name="venue" />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Event start date" name="eventStartDate" type="date" />
            <Field label="Event end date" name="eventEndDate" type="date" />
          </div>
          <div>
            <Button>Start show</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
