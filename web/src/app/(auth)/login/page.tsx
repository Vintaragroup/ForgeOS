import { loginAction } from "./actions";
import { Button, Card, Field } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = params.next && params.next.startsWith("/") ? params.next : "/";

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">ForgeOS</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Estimating, proposals, and production — in one place.
        </p>
      </div>

      <Card className="p-8 shadow-sm">
        <form action={loginAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <Field label="Email" name="email" type="email" required />
          <Field label="Password" name="password" type="password" required />
          {params.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Incorrect email or password.
            </p>
          )}
          <div className="mt-2">
            <Button>Log in</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
