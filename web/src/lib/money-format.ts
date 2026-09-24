// Money the way a re-cost is read: what it was, what it becomes, and the
// difference between them.
//
// A lone figure on a re-cost screen is ambiguous in the way that costs
// the most. "$8,640" against a row could be what it costs now, what it
// will cost, or what is coming off -- and an estimator working down a
// list of ninety-six of them should never have to work out which.
//
// A leaf module: pure functions, no db import.

export function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// A unit price keeps its cents. Rounding $6.75 to "$7" beside a quantity
// shows a different number than the one being written.
export function unitPrice(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export function signedMoney(amount: number): string {
  // A true minus sign, not a hyphen -- these sit in columns beside each
  // other and a hyphen reads as a dash.
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${sign}${money(Math.abs(amount))}`;
}

// "$8,640 → $0 (−$8,640)".
//
// The delta is redundant against the two figures and worth the space
// anyway: it is the number an estimator is adding up in their head, and
// the one the gap at the top of the screen is made of.
export function moneyChange(before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return `${money(before)} (no change)`;
  return `${money(before)} → ${money(after)} (${signedMoney(delta)})`;
}

// When only one side is known -- a removal has no "after" price, new
// scope has no "before". Says which side is missing rather than printing
// a zero that looks like a real number.
export function moneyChangeOrNull(before: number | null, after: number | null): string {
  if (before !== null && after !== null) return moneyChange(before, after);
  if (before !== null) return `${money(before)} → removed (${signedMoney(-before)})`;
  if (after !== null) return `new (${signedMoney(after)})`;
  return "—";
}
