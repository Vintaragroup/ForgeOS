import { notFound, redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { sendProposalAction, signProposalAction } from "../actions";
import { extractBranding, extractPaymentMethodNote } from "@/lib/proposal-branding";
import { taxRateLabel, TAX_ESTIMATE_DISCLAIMER } from "@/lib/tax-rate";
import { BRAND, BRAND_ADDRESS_LINES } from "@/lib/brand";
import { SERVICE_STYLE_CATEGORIES, SHOW_SERVICES_CATEGORIES } from "@/lib/line-item-category";
import {
  aggregateByCategory,
  bucketSubtotal,
  buildTopLevelCategoryViews,
  computeRentalAndServicesTotals,
  type AggregatedLineItem,
} from "@/lib/proposal-view-model";
import { Button, Card, Field, PageHeader } from "@/components/ui";

const SECTION_ACCENTS = [BRAND.navy, BRAND.teal, BRAND.tangerine, BRAND.tan];

// Intl.NumberFormat, not template-literal toFixed(2) -- see
// proposal-pdf.tsx's identical formatters for why (no thousands separator
// on totals over four digits otherwise).
const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const QTY_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function money(d: { toNumber(): number }): string {
  return CURRENCY_FORMATTER.format(d.toNumber());
}

function moneyFromNumber(n: number): string {
  return CURRENCY_FORMATTER.format(n);
}

function formatQtyNumber(n: number): string {
  return QTY_FORMATTER.format(n);
}

function ItemRow({ item }: { item: AggregatedLineItem }) {
  return (
    <tr className="border-t border-neutral-100">
      <td className="px-2 py-1.5">{item.description}</td>
      <td className="px-2 py-1.5 text-right">{formatQtyNumber(item.qty)}</td>
      <td className="px-2 py-1.5 text-right text-neutral-500">{item.unit ?? ""}</td>
      <td className={`px-2 py-1.5 text-right ${item.isClientOwned ? "italic text-neutral-500" : ""}`}>
        {item.isClientOwned ? "Client Owned" : moneyFromNumber(item.totalCost)}
      </td>
    </tr>
  );
}

// Every distinct aggregated item renders as its own row -- see
// proposal-pdf.tsx's ProposalPdfDocument (same rendering rules, same
// underlying data via proposal-view-model.ts) for why: cross-booth
// aggregation already does the summarizing, so a category never needs a
// second "rolled up" collapse on top of that.
function CategoryTable({ items }: { items: AggregatedLineItem[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-neutral-500">
          <th className="px-2 pb-1 font-normal">Description</th>
          <th className="px-2 pb-1 text-right font-normal">Qty</th>
          <th className="px-2 pb-1 text-right font-normal">Unit</th>
          <th className="px-2 pb-1 text-right font-normal">Total</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <ItemRow key={item.key} item={item} />
        ))}
      </tbody>
    </table>
  );
}

function ServiceTable({ items }: { items: AggregatedLineItem[] }) {
  return (
    <div className="flex flex-col">
      {items.map((item) => (
        <div key={item.key} className="flex items-center justify-between border-t border-neutral-100 px-2 py-1.5 text-sm">
          <span>{item.description}</span>
          <span className={item.isClientOwned ? "italic text-neutral-500" : "font-medium"}>
            {item.isClientOwned ? "Client Owned" : moneyFromNumber(item.totalCost)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default async function ProposalDetailPage(props: PageProps<"/proposals/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const proposal = await db.proposal.findFirst({
    where: { id, deletedAt: null },
    include: {
      template: true,
      estimateVersion: {
        include: {
          estimate: { include: { opportunity: { include: { company: true } }, taxRate: true } },
          // Base estimate sections only -- Option (alternates) pricing is
          // rendered separately once that UI exists (task #44).
          sections: { where: { optionId: null }, include: { lineItems: true } },
        },
      },
    },
  });
  if (!proposal) notFound();
  if (!(await canAccessOpportunity(user, proposal.estimateVersion.estimate.opportunityId))) notFound();

  const version = proposal.estimateVersion;
  const opportunity = version.estimate.opportunity;
  const sendWithId = sendProposalAction.bind(null, proposal.id);
  const signWithId = signProposalAction.bind(null, proposal.id);

  const { brandColor, logoUrl } = extractBranding(proposal.templateConfigSnapshot);
  const paymentMethodNote = extractPaymentMethodNote(proposal.templateConfigSnapshot);

  const buckets = aggregateByCategory(version.sections.filter((section) => section.lineItems.length > 0));
  const topLevelCategories = buildTopLevelCategoryViews(buckets);
  const { rentalTotal, servicesTotal, hasServiceSplit } = computeRentalAndServicesTotals(
    buckets,
    SHOW_SERVICES_CATEGORIES,
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Proposal — ${opportunity.showName}`}
        action={
          <div className="flex items-center gap-4 text-sm">
            <a
              href={`/proposals/${proposal.id}/pdf`}
              className="text-neutral-500 hover:text-neutral-900"
            >
              Download PDF
            </a>
            <Link href={`/estimates/${version.estimateId}`} className="text-neutral-500 hover:text-neutral-900">
              ← Back to estimate
            </Link>
          </div>
        }
      />

      <Card className="overflow-hidden p-0">
        <div
          className="h-1.5"
          style={{ backgroundColor: brandColor ?? "var(--brand-navy)" }}
        />
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <Image
                src="/brand/expo-logo-black.png"
                alt="Expo Convention Contractors"
                width={94}
                height={32}
                className="h-6 w-auto"
              />
              <div className="mt-1.5 text-[10px] leading-snug text-neutral-500">
                {BRAND_ADDRESS_LINES.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </div>
            <span className="text-xs font-semibold uppercase tracking-widest text-brand-teal">
              Proposal
            </span>
          </div>
          <div className="mb-6 flex items-center justify-between border-b border-neutral-200 pb-6">
            <div>
              {logoUrl && <img src={logoUrl} alt="" className="mb-2 h-8" />}
              <div className="text-sm text-neutral-500">Prepared for {opportunity.company.name}</div>
              {opportunity.company.billingAddress && (
                <div className="text-sm text-neutral-500">{opportunity.company.billingAddress}</div>
              )}
              <div className="font-display text-2xl tracking-wide">{opportunity.showName}</div>
            </div>
            <div className="text-right text-sm">
              <div className="text-neutral-500">Proposal date</div>
              <div className="font-medium">{proposal.createdAt.toISOString().slice(0, 10)}</div>
            </div>
          </div>

          {topLevelCategories.map(({ name: categoryName, ownItems, children, totalWithChildren }, categoryIndex) => {
            const accent = SECTION_ACCENTS[categoryIndex % SECTION_ACCENTS.length];
            const isServiceStyle = SERVICE_STYLE_CATEGORIES.has(categoryName);
            return (
              <div key={categoryName} className="mb-4">
                <div className="mb-1.5 flex items-center justify-between bg-brand-black px-2 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5" style={{ backgroundColor: accent }} />
                    <span className="text-xs font-semibold uppercase tracking-wide text-white">{categoryName}</span>
                  </div>
                  <span className="text-xs font-semibold text-white">{moneyFromNumber(totalWithChildren)}</span>
                </div>
                {isServiceStyle ? <ServiceTable items={ownItems} /> : <CategoryTable items={ownItems} />}
                {children.length > 0 && (
                  <div className="ml-3 flex flex-col gap-3">
                    {children.map((child) => (
                      <div key={child.name}>
                        <div className="mb-1 flex items-center justify-between bg-neutral-100 px-2 py-1">
                          <span className="text-[9px] font-semibold uppercase tracking-wide text-neutral-700">
                            {child.name}
                          </span>
                          <span className="text-[9px] font-semibold text-neutral-700">
                            {moneyFromNumber(bucketSubtotal(child.items))}
                          </span>
                        </div>
                        <CategoryTable items={child.items} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {version.grandTotal.toNumber() > 0 && (
            <div className="mb-2 flex flex-col items-end gap-0.5 text-sm text-neutral-500">
              {hasServiceSplit && (
                <>
                  <div className="flex gap-4">
                    <span>Rental components total</span>
                    <span className="w-24 text-right font-medium text-neutral-700">{moneyFromNumber(rentalTotal)}</span>
                  </div>
                  <div className="flex gap-4">
                    <span>Show services total</span>
                    <span className="w-24 text-right font-medium text-neutral-700">{moneyFromNumber(servicesTotal)}</span>
                  </div>
                </>
              )}
              {/* Not a computed tax amount -- see proposal-pdf.tsx's identical
                  line for why the taxable base is just the rental
                  components total, already computed above. */}
              <div className="flex gap-4">
                <span>Total taxable</span>
                <span className="w-24 text-right font-medium text-neutral-700">{moneyFromNumber(rentalTotal)}</span>
              </div>
              {version.estimate.taxRate && (
                <>
                  <div className="flex gap-4">
                    <span>
                      Estimated tax ({taxRateLabel(version.estimate.taxRate)},{" "}
                      {(version.estimate.taxRate.rate.toNumber() * 100).toFixed(2)}%)
                    </span>
                    <span className="w-24 text-right font-medium text-neutral-700">
                      {moneyFromNumber(rentalTotal * version.estimate.taxRate.rate.toNumber())}
                    </span>
                  </div>
                  <span className="max-w-xs text-right text-[11px] italic text-neutral-400">
                    {TAX_ESTIMATE_DISCLAIMER}
                  </span>
                </>
              )}
            </div>
          )}

          {paymentMethodNote && (
            <div className="mb-2 flex flex-col items-end gap-0.5 text-right text-xs text-neutral-500">
              <span className="font-semibold uppercase tracking-wide text-neutral-700">Payment Method</span>
              <span className="max-w-xs">{paymentMethodNote}</span>
            </div>
          )}

          <div className="flex justify-end border-t border-neutral-200 pt-4">
            <div className="text-right">
              <div className="text-sm text-neutral-500">Grand total</div>
              <div className="text-2xl font-semibold text-brand-navy">{money(version.grandTotal)}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Status</h2>
        <dl className="mb-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-neutral-500">Sent</dt>
            <dd>{proposal.sentAt ? proposal.sentAt.toISOString().slice(0, 16).replace("T", " ") : "Not sent"}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Signed</dt>
            <dd>
              {proposal.signedAt
                ? `${proposal.signedByName ?? "Unknown"}${proposal.signedByTitle ? `, ${proposal.signedByTitle}` : ""} — ${proposal.signedAt.toISOString().slice(0, 16).replace("T", " ")}`
                : "Not signed"}
            </dd>
          </div>
        </dl>
        {!proposal.sentAt && (
          <form action={sendWithId}>
            <Button>Send proposal</Button>
          </form>
        )}
        {proposal.sentAt && !proposal.signedAt && (
          <form action={signWithId} className="flex flex-wrap items-end gap-3">
            <Field label="Signer name" name="signedByName" required />
            <Field label="Title (optional)" name="signedByTitle" />
            <Button variant="secondary">Mark as signed</Button>
          </form>
        )}
      </Card>

      <p className="text-center text-[10px] font-medium uppercase tracking-widest text-neutral-400">
        Powered by ForgeOS
      </p>
    </div>
  );
}
