import { getCurrentUser } from "@/lib/auth";

// The proxy (src/proxy.ts) already guarantees "logged in" for every route.
// This layer adds "logged in AND admin" for everything under /admin --
// checked fresh on every request (a Server Component, not cached), same
// as Server Actions re-checking via requireAdmin() in src/lib/auth.ts.
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await getCurrentUser();
  const isAdmin = user?.systemRole === "ADMIN" || user?.systemRole === "SUPER_ADMIN";

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-600">
        You don&apos;t have access to this page. Admin access is required.
      </div>
    );
  }

  return <>{children}</>;
}
