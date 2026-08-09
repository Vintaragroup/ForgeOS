import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { changePasswordAction } from "./actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const params = await searchParams;

  return (
    <div>
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
    </div>
  );
}
