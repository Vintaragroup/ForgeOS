import Image from "next/image";
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
      <div className="mb-8 flex flex-col items-center text-center">
        <Image
          src="/brand/expo-logo-white.png"
          alt="Expo Convention Contractors"
          width={224}
          height={76}
          priority
          className="h-14 w-auto"
        />
        <p className="mt-3 text-sm text-neutral-400">
          Estimating, proposals, and production — in one place.
        </p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
          Powered by ForgeOS
        </p>
      </div>

      <Card className="overflow-hidden p-0 shadow-xl">
        <div className="h-1.5 bg-gradient-to-r from-brand-teal via-brand-navy to-brand-tangerine" />
        <form action={loginAction} className="flex flex-col gap-4 p-8">
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
