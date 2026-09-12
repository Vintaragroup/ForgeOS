import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { assignOpportunityToShowAction, deleteShow, updateShow } from "../actions";
import { inviteToArtworkPortalAction } from "@/app/(app)/opportunities/[id]/artwork-actions";
import { Button, Card, EmptyState, Field, PageHeader, SelectField, StatusChip } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export const dynamic = "force-dynamic";

export default async function ShowDetailPage(props: PageProps<"/shows/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) notFound();

  const show = await db.show.findFirst({
    where: { id, deletedAt: null },
    include: {
      opportunities: {
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        include: {
          company: { include: { contacts: { where: { deletedAt: null, email: { not: null } } } } },
          artworkOrders: { where: { deletedAt: null }, select: { id: true, status: true, jobCode: true }, take: 1 },
        },
      },
    },
  });
  if (!show) notFound();

  const unassignedOpportunities = await db.opportunity.findMany({
    where: { deletedAt: null, showId: null, ...opportunityAccessWhere(user) },
    orderBy: { updatedAt: "desc" },
    select: { id: true, showName: true, company: { select: { name: true } } },
  });

  const updateShowWithId = updateShow.bind(null, show.id);
  const deleteShowWithId = deleteShow.bind(null, show.id);
  const assignWithId = assignOpportunityToShowAction.bind(null, show.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={show.name} backHref="/shows" backLabel="Shows" />

      <Card className="p-6">
        <form action={updateShowWithId} className="flex flex-col gap-4">
          <Field label="Show name" name="name" defaultValue={show.name} required />
          <Field label="Venue" name="venue" defaultValue={show.venue ?? ""} />
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Event start date"
              name="eventStartDate"
              type="date"
              defaultValue={show.eventStartDate?.toISOString().slice(0, 10)}
            />
            <Field
              label="Event end date"
              name="eventEndDate"
              type="date"
              defaultValue={show.eventEndDate?.toISOString().slice(0, 10)}
            />
          </div>
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteShowWithId}
          confirmMessage="Delete this show? Its client opportunities stay, just unlinked from it."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete show</Button>
        </ConfirmForm>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Clients ({show.opportunities.length})
        </h2>
        {show.opportunities.length === 0 ? (
          <EmptyState message="No clients assigned to this show yet." />
        ) : (
          <ul className="flex flex-col gap-3">
            {show.opportunities.map((opp) => {
              const artworkOrder = opp.artworkOrders[0];
              const inviteWithId = inviteToArtworkPortalAction.bind(null, opp.id);
              return (
                <li key={opp.id} className="rounded-md border border-neutral-200 p-4">
                  <div className="flex items-center justify-between">
                    <Link href={`/opportunities/${opp.id}`} className="font-medium hover:underline">
                      {opp.company.name} — {opp.showName}
                    </Link>
                    <StatusChip tone="neutral">{opp.stage}</StatusChip>
                  </div>
                  <div className="mt-3">
                    {artworkOrder ? (
                      <Link href={`/artwork/${artworkOrder.id}`} className="text-sm text-neutral-900 underline">
                        Artwork: {artworkOrder.jobCode} — {artworkOrder.status.replaceAll("_", " ")}
                      </Link>
                    ) : opp.stage !== "WON" ? (
                      <p className="text-sm text-neutral-500">Artwork onboarding opens once this deal is Won.</p>
                    ) : opp.company.contacts.length === 0 ? (
                      <p className="text-sm text-neutral-500">
                        No contact with an email on file for {opp.company.name} -- add one before inviting.
                      </p>
                    ) : (
                      <form action={inviteWithId} className="flex flex-wrap items-end gap-3">
                        <div className="min-w-56">
                          <SelectField
                            label="Client contact"
                            name="contactId"
                            options={[
                              { value: "", label: "Select a contact…" },
                              ...opp.company.contacts.map((c) => ({ value: c.id, label: `${c.name} (${c.email})` })),
                            ]}
                            required
                          />
                        </div>
                        <Button variant="secondary">Invite to Artwork Portal</Button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Assign an existing opportunity</h2>
        {unassignedOpportunities.length === 0 ? (
          <p className="text-sm text-neutral-500">No unassigned opportunities available.</p>
        ) : (
          <form action={assignWithId} className="flex flex-wrap items-end gap-3">
            <div className="min-w-64">
              <SelectField
                label="Opportunity"
                name="opportunityId"
                options={[
                  { value: "", label: "Select an opportunity…" },
                  ...unassignedOpportunities.map((o) => ({ value: o.id, label: `${o.company.name} — ${o.showName}` })),
                ]}
                required
              />
            </div>
            <Button variant="secondary">Assign</Button>
          </form>
        )}
        <p className="mt-4 text-sm text-neutral-500">
          Or{" "}
          <Link href={`/opportunities/new?showId=${show.id}`} className="text-neutral-900 underline">
            add a new client
          </Link>{" "}
          directly under this show.
        </p>
      </Card>
    </div>
  );
}
