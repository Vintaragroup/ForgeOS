import { createAdminUser } from "../actions";
import { getCurrentUser } from "@/lib/auth";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewAdminUserPage() {
  const requester = await getCurrentUser();
  const canGrantAdmin = requester?.systemRole === "SUPER_ADMIN";

  return (
    <div>
      <PageHeader title="New user" backHref="/admin/users" backLabel="Users" />
      <Card className="p-6">
        <form action={createAdminUser} className="flex flex-col gap-4">
          <Field label="Name" name="name" required />
          <Field label="Email" name="email" type="email" required />
          <Field
            label="Password"
            name="password"
            type="password"
            required
            placeholder="At least 8 characters"
          />
          <Field label="Job title" name="role" placeholder="Estimator, Account Executive, ..." />
          <Field label="Department" name="department" />
          {canGrantAdmin ? (
            <SelectField
              label="Access level"
              name="systemRole"
              defaultValue="EMPLOYEE"
              options={[
                { value: "EMPLOYEE", label: "Employee" },
                { value: "ADMIN", label: "Admin" },
                { value: "SUPER_ADMIN", label: "Super admin" },
              ]}
            />
          ) : (
            <p className="text-sm text-neutral-500">
              New users you create are Employees. Ask a super admin to grant admin access.
            </p>
          )}
          <div>
            <Button>Create user</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
