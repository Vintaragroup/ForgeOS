import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  deactivateUser,
  reactivateUser,
  updateUserProfile,
  updateUserSystemRole,
} from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
};

export default async function AdminUserDetailPage(props: PageProps<"/admin/users/[id]">) {
  const { id } = await props.params;
  const [user, requester] = await Promise.all([
    db.user.findUnique({ where: { id } }),
    getCurrentUser(),
  ]);
  if (!user) notFound();

  const canManageRole = requester?.systemRole === "SUPER_ADMIN";
  const isSelf = requester?.id === user.id;

  const updateProfileWithId = updateUserProfile.bind(null, user.id);
  const updateRoleWithId = updateUserSystemRole.bind(null, user.id);
  const deactivateWithId = deactivateUser.bind(null, user.id);
  const reactivateWithId = reactivateUser.bind(null, user.id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={user.name} />

      <Card className="p-6">
        <form action={updateProfileWithId} className="flex flex-col gap-4">
          <Field label="Name" name="name" defaultValue={user.name} required />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-neutral-700">Email</span>
            <span className="text-sm text-neutral-600">{user.email}</span>
          </div>
          <Field
            label="Job title"
            name="role"
            defaultValue={user.role ?? ""}
            placeholder="Estimator, Account Executive, ..."
          />
          <Field label="Department" name="department" defaultValue={user.department ?? ""} />
          <div>
            <Button>Save changes</Button>
          </div>
        </form>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Access level
        </h2>
        {canManageRole ? (
          <form action={updateRoleWithId} className="flex items-end gap-3">
            <div className="w-56">
              <SelectField
                label="Role"
                name="systemRole"
                defaultValue={user.systemRole}
                options={[
                  { value: "EMPLOYEE", label: "Employee" },
                  { value: "ADMIN", label: "Admin" },
                  { value: "SUPER_ADMIN", label: "Super admin" },
                ]}
              />
            </div>
            <Button variant="secondary">Update role</Button>
          </form>
        ) : (
          <p className="text-sm text-neutral-500">
            {ROLE_LABELS[user.systemRole] ?? user.systemRole} — only a super admin can change
            access levels.
          </p>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Account status
        </h2>
        {user.deletedAt ? (
          <>
            <p className="mb-3 text-sm text-neutral-500">
              Deactivated {user.deletedAt.toISOString().slice(0, 10)}. They can&apos;t log in.
            </p>
            <form action={reactivateWithId}>
              <Button variant="secondary">Reactivate</Button>
            </form>
          </>
        ) : isSelf ? (
          <p className="text-sm text-neutral-500">You can&apos;t deactivate your own account.</p>
        ) : (
          <form action={deactivateWithId}>
            <Button variant="danger">Deactivate</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
