"use server";

import { db } from "@/lib/db";
import { hashPassword, requireAdmin, requireSuperAdmin, getCurrentUser } from "@/lib/auth";
import { SystemRole } from "@/generated/prisma/enums";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const VALID_SYSTEM_ROLES: SystemRole[] = ["SUPER_ADMIN", "ADMIN", "EMPLOYEE"];

const ASSIGNABLE_BY_ADMIN = "EMPLOYEE";

// Server-side re-check, not just a hidden/disabled <select> in the UI --
// an ADMIN caller gets silently downgraded to EMPLOYEE regardless of what
// was submitted, rather than trusting the client. Only SUPER_ADMIN can
// grant ADMIN or SUPER_ADMIN.
export async function createAdminUser(formData: FormData) {
  const requester = await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = emptyToNull(formData.get("role"));
  const department = emptyToNull(formData.get("department"));
  const requestedSystemRole = String(formData.get("systemRole") ?? ASSIGNABLE_BY_ADMIN);

  if (!name || !email) throw new Error("Name and email are required");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  const systemRole =
    requester.systemRole === "SUPER_ADMIN" &&
    (requestedSystemRole === "ADMIN" || requestedSystemRole === "SUPER_ADMIN")
      ? requestedSystemRole
      : ASSIGNABLE_BY_ADMIN;

  await db.user.create({
    data: {
      name,
      email,
      role,
      department,
      systemRole,
      passwordHash: await hashPassword(password),
    },
  });

  revalidatePath("/admin/users");
  revalidatePath("/users");
  redirect("/admin/users");
}

export async function updateUserProfile(id: string, formData: FormData) {
  await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Name is required");

  await db.user.update({
    where: { id },
    data: {
      name,
      role: emptyToNull(formData.get("role")),
      department: emptyToNull(formData.get("department")),
    },
  });

  revalidatePath(`/admin/users/${id}`);
  revalidatePath("/admin/users");
  revalidatePath("/users");
}

// Only SUPER_ADMIN can grant/revoke ADMIN or SUPER_ADMIN -- an ADMIN caller
// is rejected outright rather than silently downgraded, since (unlike
// createAdminUser) there's no safe default to fall back to here.
export async function updateUserSystemRole(id: string, formData: FormData) {
  const requester = await requireSuperAdmin();
  const submittedRole = String(formData.get("systemRole") ?? "");
  if (!VALID_SYSTEM_ROLES.includes(submittedRole as SystemRole)) {
    throw new Error("Invalid role");
  }
  const newRole = submittedRole as SystemRole;

  if (id === requester.id && newRole !== "SUPER_ADMIN") {
    throw new Error("You can't remove your own super admin access.");
  }

  if (newRole !== "SUPER_ADMIN") {
    const remainingSuperAdmins = await db.user.count({
      where: { systemRole: "SUPER_ADMIN", deletedAt: null, id: { not: id } },
    });
    if (remainingSuperAdmins === 0) {
      throw new Error("At least one super admin must remain.");
    }
  }

  await db.user.update({ where: { id }, data: { systemRole: newRole } });
  revalidatePath(`/admin/users/${id}`);
  revalidatePath("/admin/users");
}

export async function deactivateUser(id: string) {
  const requester = await requireAdmin();
  if (id === requester.id) throw new Error("You can't deactivate your own account.");

  const target = await db.user.findFirst({ where: { id, deletedAt: null } });
  if (target?.systemRole === "SUPER_ADMIN") {
    const remainingSuperAdmins = await db.user.count({
      where: { systemRole: "SUPER_ADMIN", deletedAt: null, id: { not: id } },
    });
    if (remainingSuperAdmins === 0) {
      throw new Error("At least one super admin must remain active.");
    }
  }

  await db.user.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath(`/admin/users/${id}`);
  revalidatePath("/admin/users");
  revalidatePath("/users");
}

export async function reactivateUser(id: string) {
  await requireAdmin();
  await db.user.update({ where: { id }, data: { deletedAt: null } });
  revalidatePath(`/admin/users/${id}`);
  revalidatePath("/admin/users");
  revalidatePath("/users");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

export async function getRequesterRole() {
  const user = await getCurrentUser();
  return user?.systemRole ?? null;
}
