# ForgeOS Workbook — Business Rules

Every rule below is grounded in formulas or cell values read directly from
`Reference/ORLANDO ESTIMATE.xlsm` via `tools/workbook_audit/scan.py`
(no recalculation performed — formula text and static values only). Cell
references are exact. Confidence levels: **High** = directly observed and
internally consistent; **Medium** = observed but with an ambiguity or
inconsistency; **Low** = inferred from naming/structure without a
confirming formula.

---

## Rule 1 — Labor cost = hours × department rate, single-sourced from COMPONENT 1

**Location:** every `COMPONENT N` sheet, columns F–I, rows 10–25 (departments), e.g. `COMPONENT 1!I10`.

**Formula:**
```
COMPONENT 1!H10  = 66.15                          (hardcoded rate, DESIGN dept.)
COMPONENT 1!I10  = G10*H10                          (hours × rate = labor cost)
COMPONENT N!H10  = SUM('COMPONENT 1'!H10)   for N = 2..49  (rate copied by formula)
```

**Interpretation:** There is one 15-row department rate table (DESIGN,
ENGINEERING & PURCHASING, PROJECT MANAGEMENT, HANDLING, GRAPHICS, CNC,
EXHIBIT FABRICATION, METAL, ESTIMATING, LAMINATING/PAINTING, ELECTRICAL,
CRATES, ASSEMBLY, SHIPPING, WAREHOUSE), hardcoded as static numbers **only
on `COMPONENT 1`**. Every other component sheet (2–49, plus the 5
special slots) re-derives its own copy of the same 15 rates via
`=SUM('COMPONENT 1'!H<row>)` — a `SUM()` around a single cell, functionally
equivalent to a direct reference but an unusual idiom (possibly the
artifact of a "sum across sheets" formula that was later trimmed to one
sheet).

**Upstream inputs:** none — these are static constants, not derived from
Start Page or any input sheet.

**Downstream outputs:** every COMPONENT sheet's labor total; from there,
`MATERIALS B-DOWN`, `COST SUMMARY` (labor-hours-by-department columns
G–N and beyond), and ultimately `Price Summary` / `PROPOSAL`.

**Edge cases / anomalies:**
- Because the rate table lives on a *component* sheet rather than a
  dedicated rates sheet (`Base` or `LABOR RATES`), it is one accidental
  overwrite away from silently corrupting every dependent estimate — there
  is no protection on `COMPONENT 1` (`protection.sheet_protected: false`
  per `artifacts/workbook_inventory.json`).
- Confirmed identical across sampled sheets (1, 2, 5, 10, 20, 30, 49); not
  exhaustively diffed across all 44 — flagged for Phase 1 tooling to
  verify no sheet has manually overridden the formula with a static value.

**Confidence:** High (rate mechanism); Medium (that no sheet has drifted —
not exhaustively checked).

**Open question:** Is `COMPONENT 1`'s dual role (both "the first line
item" and "the master rate table") intentional, or should rates have lived
in `Base`/`LABOR RATES` from the start?

---

## Rule 2 — Direct material cost = quantity × unit cost (per component)

**Location:** every `COMPONENT N` sheet, columns A–D, rows 10+.

**Formula:** `COMPONENT 1!D10 = B10*C10` (QTY × UNIT COST = TOTAL COST),
repeated per material line under the `DIRECT MATERIALS PER COMPONENT`
header (row 8).

**Interpretation:** Straightforward extension; no markup applied at this
stage. `B9:D9` header row confirms columns: MATERIAL | QTY | UNIT COST |
TOTAL COST.

**Upstream inputs:** `B10`/`C10` are open user-entry cells (Low formula
density observed on materials columns vs. labor columns — most COMPONENT
sheets have their materials rows blank until an estimator fills them in).

**Downstream outputs:** feeds `MATERIALS B-DOWN` (Rule 4) and the `D` sum
into `COST SUMMARY`'s material columns.

**Confidence:** High.

---

## Rule 3 — Five template slots (22–26) are repurposed for non-material line types

**Location:** sheet names `DESIGN TIME 22`, `ENGINEERING 23`,
`ESTIMATING 24`, `PRESET 25`, `PACKING 26`, positioned inside the
otherwise-contiguous `COMPONENT 1`–`49` naming sequence.

**Evidence:** These five sheets carry the same `COMPONENT PRICING`
structural template (labor/material blocks) as ordinary COMPONENT sheets,
but read from and feed into the COMPONENT family in a fixed chain:
`COMPONENT_FAMILY → PACKING 26 → PRESET 25 → ESTIMATING 24 → ENGINEERING 23
→ DESIGN TIME 22 → COMPONENT_FAMILY` (96 formulas per link, from
`artifacts/formula_catalog.json`).

**Interpretation:** These appear to be fee/labor "meta-line-items" (design
time, engineering time, an estimating fee, a "preset" bucket, and packing)
that piggyback on the same template mechanism as physical components,
rather than being modeled as a distinct sheet type.

**Downstream outputs:** `MATERIALS B-DOWN` and `COST SUMMARY` both read
these five sheets by name specifically (not just as part of the generic
COMPONENT range), confirming they are treated as first-class inputs to
the cost rollup, not incidental.

**Confidence:** Medium — the chain and structural similarity are directly
observed (High); the *intent* (why these five specific slots) is inferred.

**Open question:** Should ForgeOS's data model treat these as a `LineItem`
subtype (`kind: fee | design_time | engineering | packing`) distinct from
material `Component`, or keep them structurally identical with a type tag?
Recommend the latter, matching the workbook's own modeling choice.

---

## Rule 4 — MATERIALS B-DOWN rolls up quantity-weighted component cost

**Location:** `MATERIALS B-DOWN` (hidden sheet), row 7 onward.

**Formula:** `MATERIALS B-DOWN!B7 = 'COMPONENT 1'!B10 * 'COMPONENT 1'!$B$6`
— repeated per COMPONENT sheet across columns (C7 → COMPONENT 2, D7 →
COMPONENT 3, …).

**Interpretation:** `$B$6` on each COMPONENT sheet is labeled
`COMPONENT QUANTITY:` and defaults to `='Start Page'!D54` (= 1). So this
rule is: **(material qty on the component's own row) × (how many of this
component are being built)** — a per-unit-cost-times-build-count
expansion, done once per component sheet rather than per material line
(only row 10 sampled; needs confirmation this pattern repeats for every
material row, not just the first).

**Downstream outputs:** `MATERIALS SUMMARY`.

**Confidence:** Medium — mechanism for row 7 confirmed; full-sheet pattern
(does every material row 10–N get the same treatment) not exhaustively
verified.

---

## Rule 5 — Cost Summary rolls up by *category*, not by component

**Location:** `COST SUMMARY`, rows 8+ (one row per category sheet:
Flooring, Structure, Furniture, …).

**Formula:**
```
D8 = Flooring!J11                                    (unit direct-material cost)
E8 = B8*D8                                            (qty × unit = total DM)
G8 = Flooring!$H$16 * 'COST SUMMARY'!B8               (DE dept. hours × qty)
H8 = Flooring!$H$17 * 'COST SUMMARY'!B8               (EN dept.)
... (continues through all department columns)
```

**Interpretation:** Despite the workbook's COMPONENT-centric structure
elsewhere (Rules 1–4), `COST SUMMARY`'s primary rollup is organized by the
10 **category** sheets (Flooring, Structure, Furniture, Accessories, AV,
Hanging Sign, 4× Cross Rental), each contributing one row of direct
material cost and per-department labor hours. A **second block** further
down `COST SUMMARY` (not fully traced in this pass — see open question)
is responsible for the 965 formula references into the COMPONENT family
seen in the dependency map.

**Downstream outputs:** `Price Summary`, `PRICE OPTIONS` (broken, Rule 7).

**Confidence:** Medium — rows 8–9 pattern confirmed directly; the
COMPONENT-referencing block lower in the sheet was located via the
dependency graph but not manually traced cell-by-cell in this pass.

**Open question:** Reconcile the two rollup mechanisms — does
`COST SUMMARY` double-count if both the category-row block and the
component-referencing block ultimately represent the same underlying
component costs? High priority for Phase 1 (needs a live-Excel
recalculation to check, since we cannot evaluate formulas here).

---

## Rule 6 — Price is computed by margin gross-up, not markup

**Location:** `Price Summary`, e.g. `D7`; also `D125` (option pricing
block).

**Formula:**
```
Price Summary!D7   = (Flooring!$E$41/((100-$C$5)/100))*Base!B23
Price Summary!D125 = ((('COST SUMMARY'!AD114/'COST SUMMARY'!B114)/((100-'Price Summary'!$J$125)/100)))*Base!B23
Price Summary!J130 = +(E130-H130)/E130          ("GROSS MARGIN" label, row 131)
```

**Interpretation:** Sell price is derived as `cost / ((100 − margin%) /
100)`, i.e. a **margin gross-up**, confirmed by the `J130` formula being
literally labeled `GROSS MARGIN` and computing `(sell − cost) / sell`. This
is mathematically different from a markup (`cost × (1 + markup%)`) and the
two are easy to conflate when reimplementing — using the wrong one silently
changes realized margin. `Base!B23` (= 1.03, see Rule 8) is applied as an
additional multiplier on top of the gross-up in both formulas shown.

Per-row margin target is a **user-editable literal** in column `J`
(e.g. `J125 = 51`, meaning 51%) — this is a legitimate estimator input,
not a hardcoded system constant.

**Downstream outputs:** `E130`/`H130` grand totals, feeding `PROPOSAL` and
`WORK ORDER`.

**Confidence:** High.

---

## Rule 7 — PRICE OPTIONS margin-tier engine is broken (all `#REF!`)

**Location:** `PRICE OPTIONS` (hidden), essentially the entire sheet —
1,068 formulas of the family:
```
D33 = (((('COST SUMMARY'!#REF!/B33)/43)*57)+('COST SUMMARY'!#REF!/B33))*1.075
```

**Interpretation:** This was intended to compute pricing under fixed
labor/OT percentage-split tiers (43/57, 50/50, 54/46, 60/40, 65/35 —
plausibly straight-time/overtime hour splits) with a flat `1.075`
multiplier (7.5% — sales tax? card fee? undocumented) layered on. Every
formula's `'COST SUMMARY'!<cell>` reference has decayed to `#REF!`,
meaning a row/column was deleted from `COST SUMMARY` at some point after
`PRICE OPTIONS` was authored, and the sheet was never repaired (or is
intentionally retired but left in place).

**Confidence:** High that it is broken (365 workbook-wide `#REF!`
formulas, the large majority on this sheet). Low confidence on business
intent behind the specific percentage tiers and the `1.075` constant —
no adjacent label was found identifying it.

**Recommendation:** Do not port this sheet's formulas as-is into ForgeOS's
estimate engine. Treat it as a **documented but non-authoritative**
historical rule pending stakeholder confirmation of intent (see
`docs/risk-register.md`).

---

## Rule 8 — Two rate "surcharge" constants live on the hidden `Base` sheet

**Location:** `Base!B22`, `Base!B23`.

**Values:**
```
Base!A22 = "Rental Cost"                                          B22 = 0.2
Base!A23 = "Proffessional Services\n4% of Grand Total"            B23 = 1.03
```

**Interpretation:** `B22` (0.20) is referenced as a straight rate
multiplier (e.g. `Price Summary!H7 = Flooring!E42*Base!B22`) — a 20%
factor applied to some rental-related base amount. `B23` (1.03) is used as
a `×1.03` multiplier in the gross-up formulas (Rule 6) — but its label says
**"4% of Grand Total,"** while `1.03` corresponds to a **3%** add-on, not
4%. This is a genuine label/value mismatch: either the label is stale
(rate was changed from 4% to 3% without updating the comment) or the value
was fat-fingered. Either way it is a hardcoded, unlabeled-in-formula
constant referenced from at least `Price Summary` and (transitively)
`PRICE OPTIONS`.

**Confidence:** High that the mismatch exists; Low confidence on which of
label/value is the "correct" intended one — needs a business-side answer.

---

## Rule 9 — Standard Cost Sheet: flat hardcoded rental price list, including an embedded derivation

**Location:** `Standard Cost Sheet` (hidden), rows 3–15+.

**Sample values:** `FLOORING - PER SQUARE FOOT = 4.90`,
`FRAMES = 100`, `SLATWALLS = 250`, and notably:
```
A15 = "WAREHOUSE LABOR (PULL&PREP) / HR"
C15 = =(35*2)*1.25
```

**Interpretation:** Most rows are flat hardcoded prices for standard
rental inventory (frames, slatwalls, doors, stem lights, shelves,
pedestals, hanging-sign hardware). `C15` is the one formula on the sheet,
and it embeds its own derivation in-place ($35 base × 2 × 1.25 markup)
rather than referencing named rate cells — meaning the *reasoning* behind
the $87.50 result is only preserved as long as this exact formula string
survives; copy-pasting the value elsewhere loses the derivation entirely.

**Confidence:** High (values and formula directly observed). Medium on
business meaning of the ×2 and ×1.25 factors (not labeled).

---

## Rule 10 — Two independent, non-cross-referenced labor rate systems

**Location:** `LABOR RATES` (city-keyed table, ~85 US cities, e.g.
`Huntsville, AL = 107`, `Little Rock, AR = 107`) vs. the department-rate
table on `COMPONENT 1` (Rule 1).

**Interpretation:** `LABOR RATES` is a flat, single-value-per-city table
with no formulas at all (`formula_count: 0` per
`artifacts/workbook_inventory.json`) — every value is a hardcoded number.
No formula anywhere in the 22,138-formula catalog references this sheet
by name, meaning **either it is unused by any live calculation, or it is
consumed only manually** (an estimator looks up the city rate and types it
in elsewhere) or via the broken external link (`RATES` sheet in the
external master workbook, itself uncached — see dependency map §4). This
is architecturally distinct from the internal department-rate system
(Rule 1) — one is likely "what we bill for on-site union/show labor by
market," the other is "our internal shop labor cost by department" — and
the workbook keeps no explicit link between the two.

**Confidence:** Medium — the *absence* of a formula reference is High
confidence (directly measured), but the interpretation of *why* (dead
data vs. manual lookup vs. broken external link) is Low confidence.

---

## Rule 11 — Sales tax table has a self-referencing / mismatched-table formula

**Location:** `DATA` sheet, Excel Table `Cities` (columns B:C, e.g.
`Miami / 0.07`, `Orlando / 0.065`, `Anaheim / 0.0875`, `Las Vegas / 0.08`)
with a calculated column `Number`.

**Formula:** `Cities[Number] = +Cities13[[#This Row],[Tax Rates]]*100`

**Interpretation:** The `Cities` table's own calculated column formula
references a *different* table object, `Cities13` (a second Excel Table
occupying the adjacent column D, holding the same tax-rate values). It
happens to produce a correct-looking result only because `Cities13` is
row-aligned with `Cities` — but the formula does not reference its own
table's `[Tax Rates]` column. This is a copy/paste artifact (very likely
`Cities13` was the original table before being split/renamed to `Cities`)
and is fragile: reordering either table would silently desynchronize the
percentage column from its source rate.

**Confidence:** High (formula text directly observed).

---

## Summary table

| # | Rule | Location | Confidence |
|---|---|---|---|
| 1 | Labor cost = hours × dept. rate, single-sourced from COMPONENT 1 | COMPONENT 1–49 | High |
| 2 | Material cost = qty × unit cost | COMPONENT 1–49 | High |
| 3 | Slots 22–26 repurposed as fee/labor line types | DESIGN TIME 22…PACKING 26 | Medium |
| 4 | Materials rollup = qty × build-count | MATERIALS B-DOWN | Medium |
| 5 | Cost Summary rolls up by category (+ unverified component block) | COST SUMMARY | Medium |
| 6 | Price = cost / ((100-margin%)/100) — gross-up, not markup | Price Summary | High |
| 7 | Margin-tier engine broken (#REF!) | PRICE OPTIONS | High (broken) / Low (intent) |
| 8 | "4%" label vs. 1.03 (3%) value mismatch | Base!B23 | High (mismatch) / Low (which is right) |
| 9 | Flat rental prices + one embedded-derivation formula | Standard Cost Sheet | High |
| 10 | Two disconnected labor-rate systems (city vs. department) | LABOR RATES vs. COMPONENT 1 | Medium |
| 11 | Tax table references wrong-but-aligned sibling table | DATA / Cities table | High |

## Unresolved questions carried to risk register

1. Does `COST SUMMARY`'s component-referencing block (965 formulas, not
   traced cell-by-cell) double-count against its category-row block
   (Rule 5)?
2. What does `PRICE OPTIONS`' 43/57 … 65/35 tier system and `×1.075`
   represent, and is the sheet meant to be fixed or retired (Rule 7)?
3. Is `Base!B23` supposed to be 1.03 or 1.04 (Rule 8)?
4. Is `LABOR RATES` (Rule 10) live data feeding a manual process, or
   vestigial?
5. Full material-row pattern in `MATERIALS B-DOWN` (Rule 4) beyond row 7
   not exhaustively verified.
