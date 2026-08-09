import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getUserAiUsageSummary } from "@/lib/ai/ai-usage-service";
import { changePasswordAction } from "./actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const FEATURE_LABELS: Record<string, string> = {
  DOCUMENT_SUMMARY: "Document analysis",
  DRAWING_SUMMARY: "Drawing analysis",
  SCOPE_LINE_ITEMS: "Scope line-item proposals",
  CHAT: "Chat",
};

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const { totals, byFeature } = await getUserAiUsageSummary(user.id);
  const totalCalls = totals._count._all;
  const totalTokens = totals._sum.totalTokens ?? 0;
  const totalCostUsd = totals._sum.estimatedCostUsd?.toNumber() ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Account" />
      <Card className="max-w-md p-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Change password
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          Signed in as {user.name} ({user.email})
        </p>
        <form action={changePasswordAction} className="flex flex-col gap-4">
          <Field label="Current password" name="currentPassword" type="password" required />
          <Field label="New password" name="newPassword" type="password" required />
          <Field label="Confirm new password" name="confirmPassword" type="password" required />
          {params.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {params.error}
            </p>
          )}
          {params.success && (
            <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              Password updated.
            </p>
          )}
          <div>
            <Button>Update password</Button>
          </div>
        </form>
      </Card>

      <Card className="max-w-md p-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Your AI usage
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          {totalCalls} call{totalCalls === 1 ? "" : "s"} · {totalTokens.toLocaleString()} tokens · ~
          {fmtUsd(totalCostUsd)} estimated
        </p>
        {byFeature.length === 0 ? (
          <p className="text-sm text-neutral-400">No AI features used yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {byFeature.map((f) => (
              <li key={f.feature} className="flex items-center justify-between">
                <span className="text-neutral-600">{FEATURE_LABELS[f.feature] ?? f.feature}</span>
                <span className="text-neutral-500">
                  {f._count._all} call{f._count._all === 1 ? "" : "s"} · ~
                  {fmtUsd(f._sum.estimatedCostUsd?.toNumber() ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
