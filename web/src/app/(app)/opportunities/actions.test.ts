import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { NEW_COMPANY_VALUE } from "@/lib/opportunity-new-company";
import { createOpportunity } from "./actions";

afterEach(async () => {
  await db.stageChangeEvent.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// createOpportunity always ends by throwing Next's redirect signal --
// same NEXT_REDIRECT digest convention as (auth)/login/actions.test.ts's
// own identical helper.
async function attemptCreate(formData: FormData): Promise<string> {
  try {
    await createOpportunity(formData);
    throw new Error("createOpportunity resolved without redirecting");
  } catch (err) {
    const digest = (err as { digest?: string })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest;
    throw err;
  }
}

describe("createOpportunity", () => {
  it("creates the opportunity against an existing company when a real companyId is submitted", async () => {
    const company = await db.company.create({ data: { name: "Existing Co" } });
    const formData = new FormData();
    formData.set("companyId", company.id);
    formData.set("showName", "Test Show");

    await attemptCreate(formData);

    const opportunity = await db.opportunity.findFirstOrThrow({ where: { showName: "Test Show" } });
    expect(opportunity.companyId).toBe(company.id);
    expect(await db.company.count()).toBe(1); // no new company created
  });

  // The real gap this feature closes: no separate trip to /companies/new
  // needed just to create an opportunity for a client that doesn't exist
  // yet -- see company-field-with-create.tsx's own header comment.
  it("creates a new Company from newCompanyName when the '+ New client' sentinel is submitted", async () => {
    const formData = new FormData();
    formData.set("companyId", NEW_COMPANY_VALUE);
    formData.set("newCompanyName", "Brand New Client");
    formData.set("showName", "Test Show");

    await attemptCreate(formData);

    const company = await db.company.findFirstOrThrow({ where: { name: "Brand New Client" } });
    const opportunity = await db.opportunity.findFirstOrThrow({ where: { showName: "Test Show" } });
    expect(opportunity.companyId).toBe(company.id);
  });

  it("throws a clear error instead of creating a nameless company when newCompanyName is blank", async () => {
    const formData = new FormData();
    formData.set("companyId", NEW_COMPANY_VALUE);
    formData.set("newCompanyName", "   "); // whitespace-only, same as truly empty
    formData.set("showName", "Test Show");

    await expect(createOpportunity(formData)).rejects.toThrow("New client name is required");
    expect(await db.company.count()).toBe(0);
    expect(await db.opportunity.count()).toBe(0);
  });
});
