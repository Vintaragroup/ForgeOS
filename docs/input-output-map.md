# ForgeOS Workbook — Input/Output Map

Classifying every one of the workbook's tens of thousands of cells
individually is not meaningful (most are either blank template cells or
mechanical row-repeats of a pattern already captured once). Instead this
map classifies representative **fields and ranges** — enough to derive
ForgeOS's input forms and read-only displays — grounded in cells actually
read from the workbook. Full per-formula detail remains available in
`artifacts/formula_catalog.json` for anything not covered here.

Categories (per audit brief): **user input**, **lookup/reference data**,
**calculated value**, **internal control**, **document output**, **suspected
obsolete field**.

## 1. User input

| Field | Location | Evidence | Confidence |
|---|---|---|---|
| Billing company / address / client contact / cell / email | `Start Page!C3:C8` | Blank cells beside static labels in `B3:B8`; no formula | High |
| Arrival date/time, job dates, booth #/size/type, budget, show name/city/venue | `Start Page!C9:C26` | Same pattern; `C18` has a data-validation dropdown (`In-line,Corner,Island,Peninsula,Other`), `C19`(budget) feeds ` ESTIMATE!` and `COMPONENT n!D7` | High |
| Account executive | `Start Page!C30` | Static text value (an employee name, redacted here), drives the lookup in Rule below | High |
| Component quantities | `Start Page!D40:D59+` (one row per rental/cross-rental/custom component) | Static integers, default `1`; `D54` is specifically the cell every `COMPONENT n!$B$6` ("COMPONENT QUANTITY:") reads from | High |
| Component material qty / unit cost | `COMPONENT n!B10:C<last>` (materials block) | Mostly blank in the template; formula density on these columns is far lower than the labor block, confirming they're meant to be typed per job | Medium |
| Component labor hours | `COMPONENT n!G10:G<last>` ("HOURS" column) | Blank by default in template; `H` (rate) is pre-filled per Rule 1 in business-rules.md, `G` is not | Medium |
| Per-option margin target | `Price Summary!J116:J125` (e.g. `J125=51`) | Literal numbers, no formula, directly consumed by the gross-up formula in the same row | High |
| Data-validated dropdown fields | `Start Page!C17/C18`, `CHANGE ORDER` (4 validations), `SUPPLEMENTAL` (1), ` ESTIMATE` (2), `PROPOSAL` (1), `Price Summary` (1) — see `artifacts/workbook_inventory.json` per-sheet `data_validations` | Explicit `<dataValidation type="list">` in XML | High |

## 2. Lookup / reference data

| Field | Location | Evidence | Confidence |
|---|---|---|---|
| Account-executive contact directory | `DATA!B24:F33`, consumed via `Start Page!C31:C34 = VLOOKUP($C$30, DATA!$B$24:$F$33, {2,3,4,5}, FALSE)` | Direct VLOOKUP formula | High |
| Department labor rates | `COMPONENT 1!H10:H25` (see business-rules.md Rule 1) | Static hardcoded numbers, propagated to sibling sheets | High |
| Rental cost factor / "Professional Services" factor | `Base!B22`, `Base!B23` | Static values with adjacent text labels | High |
| City sales-tax table | `DATA` Excel Table `Cities` (`B4:C11`) | Static rate values 0.065–0.095 per city | High |
| City labor-rate table | `LABOR RATES!B4:B89`ish (one row per US city) | Static values, no formulas anywhere in the sheet | High |
| Standard rental item prices | `Standard Cost Sheet!C4:C15+` | Static prices, one embedded-derivation formula (Rule 9) | High |
| External "MASTER" workbook rate/job data | `xl/externalLinks/externalLink1.xml` cached sheets | 9 of 11 cached sheets flagged `refreshError="1"` — treat as **unreliable reference data**, not a source of truth, until re-linked or replaced | High (that it's broken) |

## 3. Calculated value

| Field | Location | Evidence | Confidence |
|---|---|---|---|
| Component labor cost | `COMPONENT n!I<row> = G<row>*H<row>` | Direct formula | High |
| Component material cost | `COMPONENT n!D<row> = B<row>*C<row>` | Direct formula | High |
| Category direct-material & labor rollup | `COST SUMMARY!D8:N9+` | Direct formula (business-rules.md Rule 5) | High |
| Sell price (margin gross-up) | `Price Summary!D7`, `D125`, etc. | Direct formula (Rule 6) | High |
| Grand total / gross margin | `Price Summary!E130`, `H130`, `J130`, `J135` | Direct formula, `J130`/`J131` explicitly labeled "GROSS MARGIN" | High |
| `TODAY()` timestamp cells | `COMPONENT 1!I4`, `COST SUMMARY!AD4`, `Price Summary!E3`, others | Volatile formula — recalculates on every open; not a stored fact (relevant for reproducibility, see risk register) | High |

## 4. Internal control

| Field | Location | Evidence | Confidence |
|---|---|---|---|
| Sheet visibility flags (27 hidden sheets) | `xl/workbook.xml` `<sheet state="hidden">` | Used to hide working/reference sheets from the end user without protecting them from edits | High |
| Sheet protection (no password) | `SUPPLEMENTAL`, `PRICE OPTIONS` | `sheetProtection` element present, `password` hash absent — soft "don't touch" guard only | High |
| `codeName` VBA hooks | every worksheet's `<sheetPr codeName="SheetN">` | Only `Sheet3` (→ `Start Page`) has live code (a floating calendar popup on date cells); all other 94 modules are boilerplate with no executable statements — see `artifacts/vba_inventory.json` | High |
| `calcPr` workbook calc settings | `xl/workbook.xml` `<calcPr calcId="191029"/>` | No iterative-calculation flag set — confirms no intentional circular-reference design; any circularity found would be accidental | High |
| Print area / print titles definedNames | 6 sheets (see workbook-inventory.md) | Formatting/output control, not business data | High |

## 5. Document output

| Field | Location | Evidence | Confidence |
|---|---|---|---|
| Client proposal | `PROPOSAL` (visible, print area `$A$1:$I$396`) | 691 formulas, largest merge count (347) — heavily formatted for print/PDF | High |
| Estimate detail | ` ESTIMATE` (visible) | 662 formulas; feeds PROPOSAL | High |
| Price summary (internal + client-reconcile) | `Price Summary` (print area `$A$1:$H$115`) | Contains both `ESTIMATED COST` and an `ACTUAL INCURRED` column header (`D6`/`E6`) — this sheet appears to double as the estimate-vs-actual comparison surface, relevant to ForgeOS goal #7 | Medium |
| Work order | `WORK ORDER` (hidden, print area `$A$1:$H$312`) | Large sheet (312 rows), hidden from normal navigation but has a defined print area — likely printed on demand during production, not during estimating | Medium |
| Change order | `CHANGE ORDER` (visible) | 88 formulas, 4 data validations — an editable document, not a pure output | Medium |
| Invoice / Invoice request | `INVOICE `, `INVOICE REQUEST` (both hidden, both have print areas) | Terminal documents in the lifecycle | High |

## 6. Suspected obsolete fields

| Field | Location | Evidence | Confidence |
|---|---|---|---|
| `BoothNumber`, `Exhibitor`, `ShowName` named ranges | Workbook-scoped defined names | All three resolve to `#REF!` — the cells/ranges they once pointed to have been deleted; nothing in the formula catalog references these names, so they are pure dead weight | High |
| Entire `PRICE OPTIONS` sheet | Hidden, protected | 1,068 of its formulas are `#REF!`; see business-rules.md Rule 7. Structurally present and still hidden/protected as if in use, but computes nothing correctly | High |
| `LABOR RATES` city table | Visible sheet, zero formula references anywhere in the workbook | Either consumed manually (copy-paste by an estimator) or genuinely orphaned; cannot distinguish from static analysis alone | Medium |
| `Cities13` table | `DATA` sheet | Only consumer is `Cities`'s calculated column, which appears to be a copy/paste-drift bug (Rule 11) rather than an intentional dependency — `Cities13` may be a leftover from before the `Cities` table was split out | Medium |
| `[1]TRUCKING & LOAD LIST` external reference | `TRUCKING & LOAD LIST` sheet | Points at an external workbook whose cache is stale/broken for most sheets; unclear if still actively maintained | Low |

## Recommendation for ForgeOS input forms

Use §1 (User input) directly as the shape of the `Estimate`/`Component`
creation forms; §2 (Lookup/reference) becomes seed data for `LaborRate`,
`Vendor`/rate config, and tax tables in the normalized schema (see
`docs/data-model-v0.md`); §6 should **not** be migrated as live data — flag
for manual business-side review before deciding whether to port, fix, or
drop.
