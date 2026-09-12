import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const shows = await db.show.findMany({
    where: { deletedAt: null },
    orderBy: { eventStartDate: "desc" },
    include: { _count: { select: { opportunities: true } } },
  });

  return (
    <div>
      <PageHeader title="Shows" action={<LinkButton href="/shows/new">Start a show</LinkButton>} />
      {shows.length === 0 ? (
        <EmptyState message="No shows yet. Start one when Expo is the general contractor for a whole show, not just fabricator for one exhibitor." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {shows.map((show) => (
              <li key={show.id}>
                <Link
                  href={`/shows/${show.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">{show.name}</div>
                    {show.venue && <div className="text-sm text-neutral-500">{show.venue}</div>}
                  </div>
                  <div className="text-sm text-neutral-500">
                    {show._count.opportunities} client{show._count.opportunities === 1 ? "" : "s"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
