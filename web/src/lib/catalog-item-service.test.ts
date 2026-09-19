import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addCatalogItemAlias,
  createCatalogItem,
  normalizeTagName,
  removeCatalogItemAlias,
  retireCatalogItem,
  searchCatalogItems,
  updateCatalogItem,
} from "@/lib/catalog-item-service";
import { UserError } from "@/lib/user-error";
import { clearTestCatalog } from "@/test/catalog-fixtures";

beforeEach(async () => {
  for (const [code, name] of [
    ["FUR", "Furniture"],
    ["ACC", "Accessories"],
    ["WSG", "Wood & Sheet Goods"],
  ]) {
    await db.catalogCategory.create({ data: { code, name } });
  }
  await db.office.create({ data: { code: "MIA", name: "Miami" } });
});

afterEach(async () => {
  await clearTestCatalog();
  await db.office.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("createCatalogItem / updateCatalogItem", () => {
  it("assigns the next number on create, and an update -- even a category move -- never changes it", async () => {
    const first = await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa", unitPrice: 450 });
    const second = await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Armchair", unitPrice: 150 });
    expect([first.catalogNumber, second.catalogNumber]).toEqual(["R-FUR-0001", "R-FUR-0002"]);

    const updated = await updateCatalogItem(first.id, { categoryCode: "ACC", name: "Sofa, white", unitPrice: 475 });
    expect(updated.catalogNumber).toBe("R-FUR-0001");
    expect(updated.categoryCode).toBe("ACC");
    expect(updated.name).toBe("Sofa, white");
    expect(updated.itemType).toBe("RENTAL");
  });

  it("rejects a missing name, missing category, or missing price with a UserError the form can show", async () => {
    await expect(createCatalogItem("RENTAL", { categoryCode: "FUR", name: "  ", unitPrice: 1 })).rejects.toThrow(
      /Name is required/,
    );
    await expect(createCatalogItem("RENTAL", { categoryCode: "ZZZ", name: "Sofa", unitPrice: 1 })).rejects.toThrow(
      /Pick a category/,
    );
    await expect(createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa" })).rejects.toBeInstanceOf(UserError);
    await expect(createCatalogItem("MATERIAL", { categoryCode: "WSG", name: "Plywood" })).rejects.toThrow(
      /costs us/,
    );
    await expect(
      createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa", unitPrice: -5 }),
    ).rejects.toThrow(/non-negative/);
    // Nothing half-created, and no number burned by the failures.
    expect(await db.catalogItem.count()).toBe(0);
    expect((await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa", unitPrice: 1 })).catalogNumber).toBe(
      "R-FUR-0001",
    );
  });

  it("only allows cut-list stock setup on a material", async () => {
    await expect(
      createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa", unitPrice: 1, materialType: "SHEET" }),
    ).rejects.toThrow(/only applies to materials/);
    const plywood = await createCatalogItem("MATERIAL", {
      categoryCode: "WSG",
      name: "3/4 Plywood",
      unitCost: 62.5,
      materialType: "SHEET",
      stockWidth: 48,
      stockLength: 96,
    });
    expect(plywood.catalogNumber).toBe("M-WSG-0001");
    expect(plywood.stockWidth?.toString()).toBe("48");
  });

  it("normalizes tags and replaces the whole set on update", async () => {
    const item = await createCatalogItem("RENTAL", {
      categoryCode: "FUR",
      name: "Sofa",
      unitPrice: 450,
      tags: ["FR Rated", "fr-rated", " Standard_Rate "],
    });
    const tagsOf = async () =>
      (await db.catalogItemTag.findMany({ where: { catalogItemId: item.id }, include: { tag: true } }))
        .map((t) => t.tag.name)
        .sort();
    expect(await tagsOf()).toEqual(["fr-rated", "standard-rate"]);

    await updateCatalogItem(item.id, { categoryCode: "FUR", name: "Sofa", unitPrice: 450, tags: ["ada"] });
    expect(await tagsOf()).toEqual(["ada"]);
    expect(normalizeTagName("  A/V  Rental! ")).toBe("a-v-rental");
  });
});

describe("aliases", () => {
  it("adds an office alias, refuses duplicates and the item's own name, and removes only its own", async () => {
    const carpet = await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Premium Carpet", unitPrice: 5.7 });
    const sofa = await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa", unitPrice: 450 });

    const alias = await addCatalogItemAlias(carpet.id, { alias: "FR Carpet", officeCode: "MIA", source: "MIA sheet" });
    expect(alias).toMatchObject({ normalizedAlias: "carpet", officeCode: "MIA" });

    await expect(addCatalogItemAlias(carpet.id, { alias: "fr  carpet!" })).rejects.toThrow(/already an alias/);
    await expect(addCatalogItemAlias(carpet.id, { alias: "premium carpets" })).rejects.toThrow(/own name/);
    await expect(addCatalogItemAlias(carpet.id, { alias: "  " })).rejects.toBeInstanceOf(UserError);

    // Wrong item id: a no-op, not a cross-item delete.
    await removeCatalogItemAlias(sofa.id, alias.id);
    expect(await db.catalogItemAlias.count()).toBe(1);
    await removeCatalogItemAlias(carpet.id, alias.id);
    expect(await db.catalogItemAlias.count()).toBe(0);
  });
});

describe("searchCatalogItems", () => {
  it("finds by exact number, number prefix, name, alias, tag, and filters -- and hides retired items", async () => {
    const sofa = await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Sofa - White", unitPrice: 450, tags: ["fr-rated"] });
    const chair = await createCatalogItem("RENTAL", { categoryCode: "FUR", name: "Accent Chair", unitPrice: 150 });
    const plywood = await createCatalogItem("MATERIAL", { categoryCode: "WSG", name: "Birch Plywood", unitCost: 62 });
    await addCatalogItemAlias(chair.id, { alias: "Lounge seat" });

    const numbers = async (search: Parameters<typeof searchCatalogItems>[0]) =>
      (await searchCatalogItems(search)).map((i) => i.catalogNumber);

    expect(await numbers({ q: "r-fur-0001" })).toEqual([sofa.catalogNumber]);
    expect(await numbers({ q: "R-FUR" })).toEqual([sofa.catalogNumber, chair.catalogNumber]);
    expect(await numbers({ q: "plywood" })).toEqual([plywood.catalogNumber]);
    expect(await numbers({ q: "lounge" })).toEqual([chair.catalogNumber]);
    expect(await numbers({ q: "fr rated" })).toEqual([sofa.catalogNumber]);
    expect(await numbers({ tag: "FR Rated" })).toEqual([sofa.catalogNumber]);
    expect(await numbers({ itemType: "MATERIAL" })).toEqual([plywood.catalogNumber]);
    expect(await numbers({ categoryCode: "FUR", q: "chair" })).toEqual([chair.catalogNumber]);
    // Punctuation-only query mustn't turn into "match every tagged item".
    expect(await numbers({ q: "$" })).toEqual([]);

    await retireCatalogItem(sofa.id);
    expect(await numbers({ q: "R-FUR" })).toEqual([chair.catalogNumber]);
  });
});
