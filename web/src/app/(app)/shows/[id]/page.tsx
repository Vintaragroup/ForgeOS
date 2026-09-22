import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { assignOpportunityToShowAction, createShowSectionAction, createSkidAction, deleteShow, deleteShowSectionAction, markSkidSentAction, rolloverShowAction, updateShow } from "../actions";
import { ActionForm } from "@/components/action-form";
import { listShowSections, listSkids } from "@/lib/skid-service";
import { describeSection } from "@/lib/show-section";
import { inviteToArtworkPortalAction } from "@/app/(app)/opportunities/[id]/artwork-actions";
import { Button, Card, EmptyState, Field, PageHeader, SelectField, StatusBanner, StatusChip } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export const dynamic = "force-dynamic";

export default async function ShowDetailPage(props: PageProps<"/shows/[id]">) {
  const { id } = await props.params;
  const { rolledOverOpportunities, rolledOverPieces } = await props.searchParams;
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
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";

  const [skids, sections] = await Promise.all([listSkids(show.id), listShowSections(show.id)]);
  const createSkidWithId = createSkidAction.bind(null, show.id);
  const markSkidSentWithId = markSkidSentAction.bind(null, show.id);
  const createSectionWithId = createShowSectionAction.bind(null, show.id);

  const unassignedOpportunities = await db.opportunity.findMany({
    where: { deletedAt: null, showId: null, ...opportunityAccessWhere(user) },
    orderBy: { updatedAt: "desc" },
    select: { id: true, showName: true, company: { select: { name: true } } },
  });

  const users = await db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } });

  // Rollover sources -- every OTHER show that actually has something to
  // roll over: a client Opportunity OR a Hub/hanging-sign piece with no
  // opportunity (see ArtworkOrder.showId's own comment -- rolloverShow
  // handles both, so the picker has to offer both too, not just the
  // opportunity case). A show with neither would just be a no-op
  // selection. Soonest-event-first, same ordering convention the Graphics
  // dashboard's own show pickers already use.
  const rolloverSourceShows = await db.show.findMany({
    where: {
      deletedAt: null,
      id: { not: show.id },
      OR: [{ opportunities: { some: { deletedAt: null } } }, { artworkOrders: { some: { deletedAt: null } } }],
    },
    orderBy: { eventStartDate: { sort: "asc", nulls: "last" } },
    select: { id: true, name: true },
  });

  const updateShowWithId = updateShow.bind(null, show.id);
  const deleteShowWithId = deleteShow.bind(null, show.id);
  const assignWithId = assignOpportunityToShowAction.bind(null, show.id);
  const rolloverWithId = rolloverShowAction.bind(null, show.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={show.name} backHref="/shows" backLabel="Shows" />

      {rolledOverOpportunities !== undefined && rolledOverPieces !== undefined && (
        <StatusBanner kind="success">
          Rolled over {rolledOverOpportunities} client{rolledOverOpportunities === "1" ? "" : "s"} and{" "}
          {rolledOverPieces} graphic piece{rolledOverPieces === "1" ? "" : "s"} into this show.
        </StatusBanner>
      )}

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
          <SelectField
            label="Escalation contact"
            name="escalationContactId"
            defaultValue={show.escalationContactId ?? ""}
            options={[
              { value: "", label: "— none (use each opportunity's own owner/sales rep) —" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
          <p className="-mt-2 text-xs text-neutral-500">
            When set, this person alone is notified if any artwork order under this show escalates --
            instead of each opportunity&apos;s own owner and sales rep.
          </p>
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
        {/* deleteShow already calls requireAdmin(), so this was safe -- but
            it rendered for everyone, and Graphics users now reach this page
            to manage skids. A red button that only throws is worse than no
            button. */}
        {isAdmin && (
          <ConfirmForm
            action={deleteShowWithId}
            confirmMessage="Delete this show? Its client opportunities stay, just unlinked from it."
            className="mt-4 border-t border-neutral-200 pt-4"
          >
            <Button variant="danger">Delete show</Button>
          </ConfirmForm>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Clients ({show.opportunities.length})
        </h2>
        {/* No "must be Won" gate here (unlike a standalone opportunity's own
            page) -- see canStartArtworkOnboarding's own comment: every
            opportunity listed below is already linked to THIS show, and a
            show existing at all is itself the "already won" signal for the
            whole event, regardless of any individual exhibitor's own
            estimating-pipeline stage. */}
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

      <Card className="p-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Floor sections</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Stretches of show floor by booth number, used to group graphics for an Expo Lead. A piece isn&apos;t assigned
          to one &mdash; its section follows from its booth number, so re-drawing a boundary re-files everything in it
          at once. Ranges can&apos;t overlap.
        </p>
        {sections.length === 0 ? (
          <EmptyState message="No sections drawn for this show." />
        ) : (
          <ul className="mb-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {sections.map((section) => (
              <li key={section.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{describeSection(section)}</span>
                  {section.lead && <span className="text-neutral-500"> · lead {section.lead.name}</span>}
                </span>
                <ConfirmForm
                  action={deleteShowSectionAction.bind(null, show.id, section.id)}
                  confirmMessage={`Remove ${section.name}? Nothing is deleted with it -- sections are derived, so the graphics just stop being grouped.`}
                >
                  <Button variant="secondary">Remove</Button>
                </ConfirmForm>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={createSectionWithId} className="flex flex-wrap items-end gap-3" resetOnSuccess>
          <Field label="Name" name="name" placeholder="Section 1" required />
          <Field label="First booth" name="boothStart" type="number" placeholder="100" required />
          <Field label="Last booth" name="boothEnd" type="number" placeholder="699" required />
          <Button variant="secondary">Add section</Button>
        </ActionForm>
      </Card>

      <Card className="p-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Skids</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Crates of finished graphics. The code is whatever the sign shop wrote on the label, and the colour is how
          it&apos;s told apart on a dock. A skid can&apos;t be sent empty, and nothing can be packed onto one that has
          already left.
        </p>
        {skids.length === 0 ? (
          <EmptyState message="No skids yet for this show." />
        ) : (
          <ul className="mb-4 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {skids.map((skid) => (
              <li key={skid.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{skid.code}</span>
                  {skid.labelColor && <span className="text-neutral-500"> · {skid.labelColor} label</span>}
                  <span className="text-neutral-500">
                    {" "}
                    · {skid._count.artworkOrders} piece{skid._count.artworkOrders === 1 ? "" : "s"}
                  </span>
                </span>
                {skid.sentAt ? (
                  <StatusChip tone="good">Sent {skid.sentAt.toLocaleString()}</StatusChip>
                ) : (
                  <ActionForm action={markSkidSentWithId}>
                    <input type="hidden" name="skidId" value={skid.id} />
                    <Button variant="secondary">Mark sent</Button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={createSkidWithId} className="flex flex-wrap items-end gap-3" resetOnSuccess>
          <Field label="Skid code" name="code" placeholder="Item A" required />
          <Field label="Label colour" name="labelColor" placeholder="orange" />
          <Button variant="secondary">Add skid</Button>
        </ActionForm>
      </Card>

      <Card className="p-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Roll over clients from a previous show
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          For a returning show occurrence -- creates a new client + graphics set here for every company on the
          source show, pre-filled from their prior pieces (material, vendor, dimensions, finishing) and marked as
          reusing existing artwork. Nothing is sent to a client automatically; inviting them to the Artwork Portal
          is still its own separate step per client, same as always. Safe to run more than once -- a client already
          rolled over here won&apos;t be duplicated.
        </p>
        {rolloverSourceShows.length === 0 ? (
          <p className="text-sm text-neutral-500">No other show with clients on it exists yet to roll over from.</p>
        ) : (
          <ConfirmForm
            action={rolloverWithId}
            confirmMessage="Roll over every client and graphic piece from the selected show into this one? This creates new draft records -- it doesn't send anything to clients."
            className="flex flex-wrap items-end gap-3"
          >
            <div className="min-w-64">
              <SelectField
                label="Source show"
                name="sourceShowId"
                options={[
                  { value: "", label: "Select a show…" },
                  ...rolloverSourceShows.map((s) => ({ value: s.id, label: s.name })),
                ]}
                required
              />
            </div>
            <Button variant="secondary">Roll over clients</Button>
          </ConfirmForm>
        )}
      </Card>
    </div>
  );
}
