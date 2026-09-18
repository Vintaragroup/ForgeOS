import { describe, expect, it } from "vitest";
import { catchUserError, UserError } from "@/lib/user-error";

describe("catchUserError", () => {
  it("returns undefined when the wrapped action succeeds", async () => {
    expect(await catchUserError(async () => "ignored")).toBeUndefined();
  });

  it("converts a UserError into a returned { error } with its message", async () => {
    const result = await catchUserError(async () => {
      throw new UserError("A note is required.");
    });
    expect(result).toEqual({ error: "A note is required." });
  });

  it("rethrows anything that isn't a UserError, so it still reaches the error boundary", async () => {
    await expect(
      catchUserError(async () => {
        throw new Error("connection refused at 10.0.0.1");
      }),
    ).rejects.toThrow("connection refused");
  });
});
