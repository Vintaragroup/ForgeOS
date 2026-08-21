import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createSession, hashPassword, verifyPassword } from "@/lib/auth";
import { resetMockCookies } from "@/test/setup";
import { deactivateUser, resetUserPasswordAction, updateUserSystemRole } from "./actions";

beforeEach(() => {
  resetMockCookies();
});

afterEach(async () => {
  await db.adminAuditLog.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(systemRole: "EMPLOYEE" | "ADMIN" | "SUPER_ADMIN", password = "original password") {
  return db.user.create({
    data: {
      name: "Test User",
      email: `${randomUUID()}@test.com`,
      systemRole,
      passwordHash: await hashPassword(password),
    },
  });
}

// resetUserPasswordAction and updateUserSystemRole both read the caller
// via getCurrentUser() -> cookies(), so "act as" here means putting a real
// signed session cookie in the mocked jar first, the same way the actual
// login flow does -- not just passing a role string around.
async function actAs(user: { id: string }) {
  await createSession(user.id);
}

function resetPasswordForm(newPassword: string, confirmPassword = newPassword) {
  const formData = new FormData();
  formData.set("newPassword", newPassword);
  formData.set("confirmPassword", confirmPassword);
  return formData;
}

describe("resetUserPasswordAction", () => {
  it("requires super admin access", async () => {
    const admin = await makeUser("ADMIN");
    const target = await makeUser("EMPLOYEE");
    await actAs(admin);

    await expect(resetUserPasswordAction(target.id, resetPasswordForm("new password 123"))).rejects.toThrow(
      "Super admin access required",
    );
  });

  it("rejects an unauthenticated caller", async () => {
    const target = await makeUser("EMPLOYEE");

    await expect(resetUserPasswordAction(target.id, resetPasswordForm("new password 123"))).rejects.toThrow(
      "Super admin access required",
    );
  });

  it("rejects a password shorter than 8 characters", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("EMPLOYEE");
    await actAs(superAdmin);

    await expect(resetUserPasswordAction(target.id, resetPasswordForm("short"))).rejects.toThrow(
      "at least 8 characters",
    );
  });

  it("rejects a mismatched confirmation", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("EMPLOYEE");
    await actAs(superAdmin);

    await expect(
      resetUserPasswordAction(target.id, resetPasswordForm("new password 123", "something else entirely")),
    ).rejects.toThrow("don't match");
  });

  it("rejects a target user that doesn't exist", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    await actAs(superAdmin);

    await expect(resetUserPasswordAction("nonexistent-id", resetPasswordForm("new password 123"))).rejects.toThrow(
      "User not found",
    );
  });

  it("rejects a soft-deleted target user", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("EMPLOYEE");
    await db.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    await actAs(superAdmin);

    await expect(resetUserPasswordAction(target.id, resetPasswordForm("new password 123"))).rejects.toThrow(
      "User not found",
    );
  });

  // This is the exact bug that prompted this feature: verifying the new
  // password actually authenticates afterward, not just that a DB write
  // happened.
  it("sets a new password that verifies, and bumps passwordChangedAt to invalidate old sessions", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("EMPLOYEE", "the old password");
    const before = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    await actAs(superAdmin);

    await resetUserPasswordAction(target.id, resetPasswordForm("brand new password 123"));

    const after = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await verifyPassword("brand new password 123", after.passwordHash!)).toBe(true);
    expect(await verifyPassword("the old password", after.passwordHash!)).toBe(false);
    expect(after.passwordChangedAt?.getTime()).toBeGreaterThan(before.passwordChangedAt?.getTime() ?? 0);
  });

  it("writes an audit log entry that never contains the new password", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("EMPLOYEE");
    await actAs(superAdmin);

    await resetUserPasswordAction(target.id, resetPasswordForm("super secret value 123"));

    const entry = await db.adminAuditLog.findFirstOrThrow({
      where: { action: "user.password_reset", targetUserId: target.id },
    });
    expect(entry.actorId).toBe(superAdmin.id);
    expect(entry.detail).toContain(target.email);
    expect(entry.detail).not.toContain("super secret value 123");
  });
});

describe("updateUserSystemRole", () => {
  it("requires super admin access -- a plain admin cannot change roles", async () => {
    const admin = await makeUser("ADMIN");
    const target = await makeUser("EMPLOYEE");
    await actAs(admin);

    const formData = new FormData();
    formData.set("systemRole", "ADMIN");
    await expect(updateUserSystemRole(target.id, formData)).rejects.toThrow("Super admin access required");
  });

  it("prevents a super admin from removing their own super admin access", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    await actAs(superAdmin);

    const formData = new FormData();
    formData.set("systemRole", "ADMIN");
    await expect(updateUserSystemRole(superAdmin.id, formData)).rejects.toThrow(
      "can't remove your own super admin access",
    );
  });

  // Note on this "invariant": the count(remainingSuperAdmins === 0) branch
  // in updateUserSystemRole is actually unreachable via any legitimate
  // caller. The only way `id`'s demotion could zero out every OTHER super
  // admin is if `requester` itself isn't one of the remaining -- but
  // requireSuperAdmin() guarantees requester IS a super admin, and the
  // self-demotion guard immediately above already blocks id === requester.id.
  // So a different requester demoting `id` always leaves at least requester
  // themselves in the "remaining" count. This test documents that a demotion
  // between two super admins succeeds and correctly leaves exactly one
  // (the requester) -- not that the dead branch fires, which it can't.
  it("allows demoting one of two super admins, leaving the other in place", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const secondSuperAdmin = await makeUser("SUPER_ADMIN");
    await actAs(secondSuperAdmin);

    const formData = new FormData();
    formData.set("systemRole", "EMPLOYEE");
    await updateUserSystemRole(superAdmin.id, formData);

    const updated = await db.user.findUniqueOrThrow({ where: { id: superAdmin.id } });
    expect(updated.systemRole).toBe("EMPLOYEE");
    const remaining = await db.user.count({ where: { systemRole: "SUPER_ADMIN", deletedAt: null } });
    expect(remaining).toBe(1);
  });

  it("allows a super admin to promote another user and logs it", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("EMPLOYEE");
    await actAs(superAdmin);

    const formData = new FormData();
    formData.set("systemRole", "ADMIN");
    await updateUserSystemRole(target.id, formData);

    const updated = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.systemRole).toBe("ADMIN");
    const entry = await db.adminAuditLog.findFirstOrThrow({
      where: { action: "user.role_change", targetUserId: target.id },
    });
    expect(entry.actorId).toBe(superAdmin.id);
  });
});

describe("deactivateUser", () => {
  it("prevents a user from deactivating their own account", async () => {
    const admin = await makeUser("ADMIN");
    await actAs(admin);

    await expect(deactivateUser(admin.id)).rejects.toThrow("can't deactivate your own account");
  });

  it("prevents deactivating the last remaining super admin", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const admin = await makeUser("ADMIN");
    await actAs(admin);

    await expect(deactivateUser(superAdmin.id)).rejects.toThrow("At least one super admin must remain active");
  });

  it("allows deactivating a super admin when another one remains", async () => {
    const superAdminA = await makeUser("SUPER_ADMIN");
    const superAdminB = await makeUser("SUPER_ADMIN");
    await actAs(superAdminB);

    await deactivateUser(superAdminA.id);

    const updated = await db.user.findUniqueOrThrow({ where: { id: superAdminA.id } });
    expect(updated.deletedAt).not.toBeNull();
  });
});
