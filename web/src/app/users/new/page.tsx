import { createUser } from "../actions";
import { Button, Card, Field, PageHeader } from "@/components/ui";

export default function NewUserPage() {
  return (
    <div>
      <PageHeader title="New user" />
      <Card className="p-6">
        <form action={createUser} className="flex flex-col gap-4">
          <Field label="Name" name="name" required />
          <Field label="Email" name="email" type="email" required />
          <Field label="Role" name="role" placeholder="Estimator, Account Executive, ..." />
          <Field label="Department" name="department" />
          <Field
            label="Password"
            name="password"
            type="password"
            required
            placeholder="At least 8 characters"
          />
          <div>
            <Button>Create user</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
