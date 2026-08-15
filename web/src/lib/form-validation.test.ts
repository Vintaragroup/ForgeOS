import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseFormData } from "@/lib/form-validation";

const Schema = z.object({
  description: z.any().transform((v) => String(v ?? "").trim()).pipe(z.string().min(1, "Description is required")),
  qty: z.coerce.number({ error: "Qty must be a number" }).min(1, "Qty must be at least 1"),
  flag: z.any().optional().transform((v) => v === "on"),
});

describe("parseFormData", () => {
  it("returns the parsed, coerced data for valid input", () => {
    const formData = new FormData();
    formData.set("description", "  Panel  ");
    formData.set("qty", "3");
    formData.set("flag", "on");

    expect(parseFormData(formData, Schema)).toEqual({ description: "Panel", qty: 3, flag: true });
  });

  it("treats a missing checkbox field as false, matching formData.get(x) === \"on\"", () => {
    const formData = new FormData();
    formData.set("description", "Panel");
    formData.set("qty", "1");
    // flag intentionally omitted -- an unchecked checkbox never appears in FormData.

    expect(parseFormData(formData, Schema).flag).toBe(false);
  });

  it("throws a plain Error with the first schema issue's message on invalid input, not a raw ZodError", () => {
    const formData = new FormData();
    formData.set("description", "");
    formData.set("qty", "1");

    expect(() => parseFormData(formData, Schema)).toThrow("Description is required");
    try {
      parseFormData(formData, Schema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toHaveProperty("issues"); // not a ZodError leaking through
    }
  });

  it("rejects a qty that isn't a finite number", () => {
    const formData = new FormData();
    formData.set("description", "Panel");
    formData.set("qty", "not-a-number");

    expect(() => parseFormData(formData, Schema)).toThrow("Qty must be a number");
  });

  it("rejects a qty below the minimum", () => {
    const formData = new FormData();
    formData.set("description", "Panel");
    formData.set("qty", "0");

    expect(() => parseFormData(formData, Schema)).toThrow("Qty must be at least 1");
  });
});
