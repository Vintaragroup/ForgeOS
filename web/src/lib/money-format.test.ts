import { describe, expect, it } from "vitest";
import { money, moneyChange, moneyChangeOrNull, signedMoney, unitPrice } from "@/lib/money-format";

describe("moneyChange", () => {
  // The shape every figure on the re-cost screen now takes: what it was,
  // what it becomes, and the difference an estimator is adding up.
  it("shows what it was, what it becomes, and the difference", () => {
    expect(moneyChange(8640, 0)).toBe("$8,640 → $0 (−$8,640)");
    expect(moneyChange(2000, 2500)).toBe("$2,000 → $2,500 (+$500)");
  });

  // "$43,849 → $43,849 (+$0)" is three ways of saying nothing happened.
  it("says so plainly when nothing moved", () => {
    expect(moneyChange(43849, 43849)).toBe("$43,849 (no change)");
  });
});

describe("moneyChangeOrNull", () => {
  it("names the missing side rather than printing a zero", () => {
    expect(moneyChangeOrNull(1224, null)).toBe("$1,224 → removed (−$1,224)");
    expect(moneyChangeOrNull(null, 900)).toBe("new (+$900)");
    expect(moneyChangeOrNull(null, null)).toBe("—");
  });

  it("falls through to the full form when both sides are known", () => {
    expect(moneyChangeOrNull(100, 40)).toBe("$100 → $40 (−$60)");
  });
});

describe("signedMoney", () => {
  it("uses a minus sign rather than a hyphen", () => {
    expect(signedMoney(-500)).toBe("−$500");
    expect(signedMoney(500)).toBe("+$500");
    expect(signedMoney(0)).toBe("$0");
  });
});

describe("money and unitPrice", () => {
  it("rounds a total and keeps a unit price's cents", () => {
    expect(money(6.75)).toBe("$7");
    expect(unitPrice(6.75)).toBe("$6.75");
  });
});
