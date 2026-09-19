import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { AgingChip } from "@/components/aging-chip";
import { isStale, STALE_FILTER_DAYS } from "@/lib/contact-aging";

// See opportunities/page.tsx's comment: without this, Next freezes this
// list at build-time DB contents instead of reading live on every request.
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  CLIENT_CONTACT: "Client contact",
  ACCOUNT_EXECUTIVE: "Account executive",
};

export default async function ContactsPage(props: PageProps<"/contacts">) {
  const params = await props.searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const sortByContacted = one(params.sort) === "contacted";
  const staleDays = STALE_FILTER_DAYS.find((d) => String(d) === one(params.stale));

  const all = await db.contact.findMany({
    where: { deletedAt: null },
    orderBy: sortByContacted ? [{ lastContactedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }] : { name: "asc" },
    include: { company: true },
  });
  // Account executives are Expo's own people -- "not contacted in N days"
  // is only meaningful for client contacts.
  const contacts = staleDays
    ? all.filter((c) => c.role === "CLIENT_CONTACT" && isStale(c.lastContactedAt, staleDays))
    : all;
  const selectClass = "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm";

  return (
    <div>
      <PageHeader title="Contacts" action={<LinkButton href="/contacts/new">New contact</LinkButton>} />

      <Card className="mb-4 p-4">
        <form className="flex flex-wrap items-end gap-3" action="/contacts">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Last contacted</span>
            <select name="stale" defaultValue={staleDays ? String(staleDays) : ""} className={selectClass}>
              <option value="">Any time</option>
              {STALE_FILTER_DAYS.map((d) => (
                <option key={d} value={d}>
                  Not in {d}+ days
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-neutral-700">Sort</span>
            <select name="sort" defaultValue={sortByContacted ? "contacted" : ""} className={selectClass}>
              <option value="">Name</option>
              <option value="contacted">Longest since contacted</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md bg-brand-black px-4 py-2 text-sm font-medium text-white hover:bg-brand-navy"
          >
            Apply
          </button>
          {(staleDays || sortByContacted) && (
            <Link href="/contacts" className="py-2 text-sm text-neutral-500 hover:text-neutral-900">
              Clear
            </Link>
          )}
        </form>
      </Card>

      <p className="mb-3 text-sm text-neutral-500">
        {staleDays ? `${contacts.length} of ${all.length} contacts.` : `${all.length} contacts.`} Last contacted comes from
        Salesmate.
      </p>

      {contacts.length === 0 ? (
        <EmptyState message={staleDays ? "No contacts match that filter." : "No contacts yet. Add a client contact or account executive."} />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {contacts.map((contact) => (
              <li key={contact.id}>
                <Link
                  href={`/contacts/${contact.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-neutral-50"
                >
                  <div className="min-w-0">
                    <div className="font-medium">
                      {contact.name}
                      {contact.title && <span className="font-normal text-neutral-500"> · {contact.title}</span>}
                    </div>
                    <div className="text-sm text-neutral-500">
                      {contact.company?.name ?? "No company"} · {contact.email ?? "no email"}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {contact.role === "CLIENT_CONTACT" && <AgingChip date={contact.lastContactedAt} emptyLabel="Not contacted" />}
                    <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
                      {ROLE_LABEL[contact.role]}
                    </span>
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
