import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { deleteCompany, updateCompany } from "../actions";
import { taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { Button, Card, Field, PageHeader, SelectField, StatusChip } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";
import { AgingChip } from "@/components/aging-chip";
import { LocalTimestamp } from "@/components/local-timestamp";
import { EMPTY_AGING, loadCompanyAging } from "@/lib/company-aging";

const DEAL_STATUS_TONE: Record<string, "good" | "critical" | "info" | "neutral"> = { Won: "good", Lost: "critical", Open: "info" };

function money(value: { toString(): string } | null) {
  if (value == null) return "—";
  return Number(value.toString()).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default async function CompanyDetailPage(props: PageProps<"/companies/[id]">) {
  const { id } = await props.params;
  const [company, taxRates, agingById] = await Promise.all([
    db.company.findFirst({
      where: { id, deletedAt: null },
      include: {
        contacts: { where: { deletedAt: null }, orderBy: [{ lastContactedAt: { sort: "desc", nulls: "last" } }, { name: "asc" }] },
        opportunities: { where: { deletedAt: null } },
        salesmateCompanies: { where: { removedAt: null }, orderBy: { lastCommunicationAt: { sort: "desc", nulls: "last" } } },
        clientTouches: { orderBy: { occurredAt: "desc" }, take: 12, include: { contact: { select: { name: true } } } },
        salesmateActivities: {
          where: { removedAt: null, isCompleted: false },
          orderBy: { dueAt: "asc" },
          include: { owner: { select: { name: true } } },
        },
        salesmateDeals: {
          where: { removedAt: null },
          orderBy: [{ salesmateCreatedAt: { sort: "desc", nulls: "last" } }],
          include: { contact: { select: { name: true } } },
        },
      },
    }),
    db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
    loadCompanyAging([id]),
  ]);
  if (!company) notFound();
  const aging = agingById.get(company.id) ?? EMPTY_AGING;
  // Usually one; more when Salesmate holds duplicates of this client. The
  // most recently active record supplies the details shown.
  const salesmate = company.salesmateCompanies[0] ?? null;
  const otherSalesmateNames = company.salesmateCompanies.slice(1).map((m) => m.name);

  const updateCompanyWithId = updateCompany.bind(null, company.id);
  const deleteCompanyWithId = deleteCompany.bind(null, company.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={company.name} backHref="/companies" backLabel="Companies" />

      <Card className="p-6">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Last contacted</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AgingChip date={aging.lastContacted?.at} />
              {aging.lastContacted && (
                <span className="text-sm text-neutral-600">
                  {[
                    aging.lastContacted.mode,
                    aging.lastContacted.contactName && `with ${aging.lastContacted.contactName}`,
                    aging.lastContacted.by && `by ${aging.lastContacted.by}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </div>
          </div>
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Last worked with</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AgingChip
                date={aging.lastWorkedWith?.at}
                emptyLabel={aging.wonWithoutShowDate > 0 ? "Won jobs, no show dates" : "No won jobs"}
              />
              {aging.lastWorkedWith && <span className="text-sm text-neutral-600">{aging.lastWorkedWith.label}</span>}
            </div>
          </div>
        </div>
        <div className="mt-4 border-t border-neutral-200 pt-4 text-sm text-neutral-600">
          {salesmate ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-neutral-900">Salesmate</span>
              {salesmate.type && <StatusChip tone={salesmate.type === "Customer" ? "info" : "neutral"}>{salesmate.type}</StatusChip>}
              {salesmate.ownerName && <span>Owner: {salesmate.ownerName}</span>}
              {salesmate.phone && <span>{salesmate.phone}</span>}
              {salesmate.website && (
                <a
                  href={/^https?:\/\//i.test(salesmate.website) ? salesmate.website : `https://${salesmate.website}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-navy hover:underline"
                >
                  {salesmate.website.replace(/^https?:\/\//i, "")}
                </a>
              )}
              {salesmate.name !== company.name && <span className="text-neutral-400">(as &ldquo;{salesmate.name}&rdquo;)</span>}
              {otherSalesmateNames.length > 0 && (
                <span className="text-neutral-400">
                  also {otherSalesmateNames.map((n) => `“${n}”`).join(", ")} in Salesmate
                </span>
              )}
            </div>
          ) : (
            <span className="text-neutral-500">
              Not linked to Salesmate yet -- no last-contacted date or deal history.{" "}
              <Link href="/admin/integrations/salesmate" className="underline">
                Link it
              </Link>{" "}
              (admins).
            </span>
          )}
        </div>
      </Card>

      <Card className="p-6">
        <form action={updateCompanyWithId} className="flex flex-col gap-4">
          <Field label="Company name" name="name" defaultValue={company.name} required />
          <Field
            label="Billing address"
            name="billingAddress"
            defaultValue={company.billingAddress ?? ""}
          />
          <Field label="Industry" name="industry" defaultValue={company.industry ?? ""} />
          <SelectField
            label="Default tax jurisdiction"
            name="taxRateId"
            defaultValue={company.taxRateId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...taxRates.map((t) => ({ value: t.id, label: taxRateOptionLabel(t) })),
            ]}
          />
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteCompanyWithId}
          confirmMessage="Delete this company? This can't be undone."
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete company</Button>
        </ConfirmForm>
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Contacts</h2>
        {company.contacts.length === 0 ? (
          <p className="text-sm text-neutral-500">No contacts yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {company.contacts.map((c) => (
                <li key={c.id}>
                  <Link href={`/contacts/${c.id}`} className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-neutral-50">
                    <span>
                      {c.name}
                      {c.title && <span className="text-sm text-neutral-500"> · {c.title}</span>}
                      <span className="text-sm text-neutral-500"> — {c.email ?? "no email"}</span>
                    </span>
                    <AgingChip date={c.lastContactedAt} emptyLabel="Not contacted" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Opportunities</h2>
        {company.opportunities.length === 0 ? (
          <p className="text-sm text-neutral-500">No opportunities yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {company.opportunities.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/opportunities/${o.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                  >
                    <span>{o.showName}</span>
                    <span className="text-sm text-neutral-500">{o.stage}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Contact history</h2>
          <p className="mb-3 text-sm text-neutral-500">
            Each communication ForgeOS has seen since it started recording. Reps log contact in Salesmate; this fills in
            from there, so there&apos;s no history before the sync began.
          </p>
          {company.clientTouches.length === 0 ? (
            <p className="text-sm text-neutral-500">No contact recorded yet.</p>
          ) : (
            <Card>
              <ul className="divide-y divide-neutral-200">
                {company.clientTouches.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                    <span>
                      {t.mode ?? "Contact"}
                      {t.contact ? ` with ${t.contact.name}` : ""}
                      {t.byName ? <span className="text-neutral-500"> · by {t.byName}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      <LocalTimestamp iso={t.occurredAt} timeStyle={undefined} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div>
          <h2 className="mb-1 text-lg font-semibold">Scheduled</h2>
          <p className="mb-3 text-sm text-neutral-500">
            Open calls and meetings in Salesmate. Past-due ones may simply never have been ticked off.
          </p>
          {company.salesmateActivities.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing scheduled.</p>
          ) : (
            <Card>
              <ul className="divide-y divide-neutral-200">
                {company.salesmateActivities.slice(0, 12).map((a) => {
                  const overdue = a.dueAt ? a.dueAt < new Date() : false;
                  return (
                    <li key={a.salesmateId} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate">{a.title}</span>
                        <span className="text-xs text-neutral-500">
                          {a.type}
                          {a.owner ? ` · ${a.owner.name}` : ""}
                        </span>
                      </span>
                      {a.dueAt && (
                        <span className={`shrink-0 text-xs ${overdue ? "text-amber-700" : "text-neutral-500"}`}>
                          <LocalTimestamp iso={a.dueAt} timeStyle={undefined} />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold">Salesmate deal history</h2>
        <p className="mb-3 text-sm text-neutral-500">Read-only, synced daily from Salesmate.</p>
        {company.salesmateDeals.length === 0 ? (
          <p className="text-sm text-neutral-500">{salesmate ? "No deals in Salesmate." : "Not linked to Salesmate."}</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Deal</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Pipeline · stage</th>
                  <th className="px-4 py-2 text-right">Value</th>
                  <th className="px-4 py-2">Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {company.salesmateDeals.map((d) => (
                  <tr key={d.salesmateId}>
                    <td className="px-4 py-2">
                      {d.title}
                      {d.contact && <div className="text-xs text-neutral-500">{d.contact.name}</div>}
                    </td>
                    <td className="px-4 py-2">
                      <StatusChip tone={DEAL_STATUS_TONE[d.status] ?? "neutral"}>{d.status}</StatusChip>
                    </td>
                    <td className="px-4 py-2 text-neutral-600">{[d.pipeline, d.stage].filter(Boolean).join(" · ")}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(d.value)}</td>
                    <td className="px-4 py-2 text-neutral-600">{d.ownerName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}
