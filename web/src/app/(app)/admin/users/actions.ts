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

  const created = await db.user.create({
    data: {
      name,
      email,
      role,
      department,
      systemRole,
      passwordHash: await hashPassword(password),
    },
  });

  await logAdminAction({
    action: "user.create",
    detail: `Created ${email} with role ${systemRole}`,
    actorId: requester.id,
    targetUserId: created.id,
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

  const previous = await db.user.findFirst({ where: { id }, select: { systemRole: true } });

  await db.user.update({ where: { id }, data: { systemRole: newRole } });

  await logAdminAction({
    action: "user.role_change",
    detail: `Role changed from ${previous?.systemRole ?? "unknown"} to ${newRole}`,
    actorId: requester.id,
    targetUserId: id,
  });

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

  await logAdminAction({
    action: "user.deactivate",
    detail: target ? `Deactivated ${target.email}` : null,
    actorId: requester.id,
    targetUserId: id,
  });

  revalidatePath(`/admin/users/${id}`);
  revalidatePath("/admin/users");
  revalidatePath("/users");
}

// SUPER_ADMIN only, not requireAdmin like the profile/role/status actions
// above -- setting someone else's password outright (no current-password
// check, unlike account/actions.ts's self-service changePasswordAction)
// is a materially bigger blast radius, the same reasoning
// updateUserSystemRole already applies to granting roles. This is the
// same operation set-password.ts has always done from the host, just
// reachable from the UI now so a locked-out user doesn't need someone
// with terminal/database access to get back in. Logged to
// AdminAuditLog like every other admin mutation here, but the detail
// text never includes the password itself -- only that a reset
// happened, by whom, and for whom.
export async function resetUserPasswordAction(id: string, formData: FormData) {
  const requester = await requireSuperAdmin();

  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  if (newPassword.length < 8) throw new Error("Password must be at least 8 characters.");
  if (newPassword !== confirmPassword) throw new Error("New password and confirmation don't match.");

  const target = await db.user.findFirst({ where: { id, deletedAt: null } });
  if (!target) throw new Error("User not found.");

  const passwordHash = await hashPassword(newPassword);
  // Same passwordChangedAt bump as changePasswordAction and
  // set-password.ts -- invalidates every session the target user
  // currently has, not just a DB field update they'd never notice took
  // effect. Exactly the guarantee this feature exists for: whatever was
  // wrong with their old credential stops working the moment this runs.
  await db.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date() } });

  await logAdminAction({
    action: "user.password_reset",
    detail: `Password reset for ${target.email}`,
    actorId: requester.id,
    targetUserId: id,
  });

  revalidatePath(`/admin/users/${id}`);
}

export async function reactivateUser(id: string) {
  const requester = await requireAdmin();
  const target = await db.user.findFirst({ where: { id } });

  await db.user.update({ where: { id }, data: { deletedAt: null } });

  await logAdminAction({
    action: "user.reactivate",
    detail: target ? `Reactivated ${target.email}` : null,
    actorId: requester.id,
    targetUserId: id,
  });

  revalidatePath(`/admin/users/${id}`);
  revalidatePath("/admin/users");
  revalidatePath("/users");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

// B23: append-only trail for the actions above that change who can access
// ForgeOS or what they can do in it. See AdminAuditLog in schema.prisma.
function logAdminAction(entry: {
  action: string;
  detail: string | null;
  actorId: string;
  targetUserId: string;
}) {
  return db.adminAuditLog.create({ data: entry });
}

export async function getRequesterRole() {
  const user = await getCurrentUser();
  return user?.systemRole ?? null;
}
