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
    <div className="mx-auto max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">ForgeOS</h1>
      <Card className="p-6">
        <form action={loginAction} className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <Field label="Email" name="email" type="email" required />
          <Field label="Password" name="password" type="password" required />
          {params.error && (
            <p className="text-sm text-red-600">Incorrect email or password.</p>
          )}
          <Button>Log in</Button>
        </form>
      </Card>
    </div>
  );
}
