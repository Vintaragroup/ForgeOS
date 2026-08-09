import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getThreadMessages } from "@/lib/chat-service";
import { sendMessageAction } from "./actions";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OpportunityChatPage(props: PageProps<"/opportunities/[id]/chat">) {
  const { id } = await props.params;
  const opportunity = await db.opportunity.findFirst({ where: { id, deletedAt: null } });
  if (!opportunity) notFound();

  const messages = await getThreadMessages(id);
  const sendMessageWithId = sendMessageAction.bind(null, id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref={`/opportunities/${id}`}
        backLabel={opportunity.showName}
        title={`Chat — ${opportunity.showName}`}
      />

      <Card className="p-6">
        <p className="mb-4 text-sm text-neutral-500">
          Answers only from this opportunity&apos;s uploaded documents and current estimate — nothing outside
          it. Verify anything important against the source document before relying on it.
        </p>

        {messages.length === 0 ? (
          <EmptyState message="No messages yet. Ask about the opportunity's documents or its current estimate." />
        ) : (
          <ul className="mb-4 flex flex-col gap-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={`max-w-[42rem] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "ml-auto bg-brand-black text-white"
                    : "bg-neutral-100 text-neutral-900"
                }`}
              >
                {m.content}
              </li>
            ))}
          </ul>
        )}

        <form action={sendMessageWithId} className="flex items-end gap-3 border-t border-neutral-200 pt-4">
          <div className="flex-1">
            <label htmlFor="content" className="sr-only">
              Message
            </label>
            <textarea
              id="content"
              name="content"
              required
              rows={2}
              placeholder="Ask about this opportunity's documents or estimate…"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            />
          </div>
          <Button>Send</Button>
        </form>
      </Card>
    </div>
  );
}
