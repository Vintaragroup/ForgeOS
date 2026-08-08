import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment: without this, Next freezes this
// list at build-time DB contents instead of reading live on every request.
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  CLIENT_CONTACT: "Client contact",
  ACCOUNT_EXECUTIVE: "Account executive",
};

export default async function ContactsPage() {
  const contacts = await db.contact.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    include: { company: true },
  });

  return (
    <div>
      <PageHeader
        title="Contacts"
        action={<LinkButton href="/contacts/new">New contact</LinkButton>}
      />
      {contacts.length === 0 ? (
        <EmptyState message="No contacts yet. Add a client contact or account executive." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {contacts.map((contact) => (
              <li key={contact.id}>
                <Link
                  href={`/contacts/${contact.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">{contact.name}</div>
                    <div className="text-sm text-neutral-500">
                      {contact.company?.name ?? "No company"} · {contact.email ?? "no email"}
                    </div>
                  </div>
                  <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
                    {ROLE_LABEL[contact.role]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
