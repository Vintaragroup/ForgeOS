import { StatusChip } from "@/components/ui";

// A Hub/hanging-sign piece has no opportunity (see ArtworkOrder.showId's
// schema comment) -- shown as "PGA Hub — <show name>" in place of the
// usual "<company> — <deal name>" pairing every other order uses. Shared
// between /artwork's queue and the Graphics department dashboard's own
// order lists, which both render this exact identity block.
export function OrderIdentity({
  order,
}: {
  order: {
    opportunity: { company: { name: string }; showName: string; show: { name: string } | null } | null;
    show: { name: string } | null;
  };
}) {
  if (order.opportunity) {
    return (
      <>
        <span className="font-medium">{order.opportunity.company.name}</span>
        <span className="text-neutral-500">{order.opportunity.showName}</span>
        {order.opportunity.show && <StatusChip tone="neutral">{order.opportunity.show.name}</StatusChip>}
      </>
    );
  }
  return (
    <>
      <span className="font-medium">PGA Hub</span>
      {order.show && <span className="text-neutral-500">{order.show.name}</span>}
    </>
  );
}
