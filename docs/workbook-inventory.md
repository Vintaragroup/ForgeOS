# ForgeOS Workbook — Sheet Inventory

Source: `artifacts/workbook_inventory.json`, produced by
`python3 -m tools.workbook_audit.scan`. The table below is auto-rendered
from that JSON via `python3 -m tools.workbook_audit.render_inventory` —
re-run both after any change to the source workbook. Classification
confidence is **Low** unless separately confirmed in
`docs/business-rules.md` or `docs/workbook-dependency-map.md` — it is a
name/structure heuristic, not a manual review of every sheet.

## Summary

- **95 sheets total**: 68 visible, 27 hidden (no `veryHidden` sheets found).
- **22,138 formulas** workbook-wide (`artifacts/formula_catalog.json`).
- **1,036 merged-cell ranges** across all sheets.
- **Classification split:** 54 template (the COMPONENT/OPTION families),
  26 calculation, 7 reference, 7 output, 1 input (Start Page). The
  remaining sheets not falling cleanly into these buckets are marked
  `workflow` pending manual review — see the table.
- **Only one sheet uses an Excel Table object:** `DATA` (6 tables — Cities,
  Cities13, Table5, Table7, Payment, Table9; see `docs/business-rules.md`
  Rule 11 for an anomaly in the Cities table's calculated column).
- **Data validation** (dropdown lists / input rules) found on 6 sheets:
  Start Page (4), SUPPLEMENTAL (1), CHANGE ORDER (4), ` ESTIMATE` (2),
  PROPOSAL (1), Price Summary (1).
- **Sheet protection enabled** on only 2 sheets: `SUPPLEMENTAL` and
  `PRICE OPTIONS` (the latter is also the sheet with the broken `#REF!`
  formulas — see `docs/business-rules.md` Rule 7). No password hashes were
  found on either (protection without a password — trivially removable,
  more a "don't accidentally overtype this" guard than real protection).
- **Print areas defined** on 6 sheets (`INVOICE `, `INVOICE REQUEST`,
  `Price Summary`, `PROPOSAL`, `Start Page`, `WORK ORDER`) — these are
  the workbook's document-output sheets, consistent with their
  `output` classification.
- **Sheet names contain leading/trailing spaces** in several places verbatim
  in the workbook (` ESTIMATE`, `LABOR RATES `, `PMC `, `INVOICE `) —
  preserved exactly as-is per the audit brief; do not "clean up" these
  names when building the data model without confirming nothing depends
  on the exact string.

## Classification legend

- **input** — primarily manual data entry, few/no formulas.
- **reference** — hidden lookup/rate/config data consumed by other sheets.
- **calculation** — formula-driven working sheet, not a final document.
- **output** — client- or ops-facing document (has a print area / is meant
  to be printed or exported).
- **template** — one instance of a repeated family (COMPONENT N, OPTION (N)).
- **workflow** — purpose not yet confidently determined from structure
  alone; needs manual review.

<!-- AUTO-GENERATED TABLE START — regenerate with: python3 -m tools.workbook_audit.render_inventory -->

| # | Sheet | Visibility | Used Range | Formulas | Merges | Tables | Validations | Protected | Print Area | Classification | Probable Purpose |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | DATA | hidden | A1:J33 | 8 | 0 | Cities, Cities13, Table5, Table7, Payment, Table9 | 0 |  |  | reference | Hidden lookup/reference data feeding dropdowns and rates |
| 2 | Base | hidden | A1:K29 | 0 | 0 | — | 0 |  |  | reference | Hidden lookup/reference data feeding dropdowns and rates |
| 3 | Start Page | visible | A1:S140 | 4 | 14 | — | 4 |  | Y | input | Primary job-setup user input form |
| 4 | PRODUCTION NOTES | visible | A1:J50 | 3 | 8 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 5 | SUPPLEMENTAL | visible | A1:F44 | 41 | 10 | — | 1 | Y |  | calculation | Formula-driven working sheet |
| 6 | CHANGE ORDER | visible | A1:O71 | 88 | 6 | — | 4 |  |  | output | Client- or ops-facing document output |
| 7 |  ESTIMATE | visible | A1:O257 | 662 | 5 | — | 2 |  |  | output | Client- or ops-facing document output |
| 8 | PROPOSAL | visible | A1:L399 | 691 | 347 | — | 1 |  | Y | output | Client- or ops-facing document output |
| 9 | Price Summary | visible | A1:AP142 | 521 | 14 | — | 1 |  | Y | calculation | Rollup/aggregation of upstream sheets |
| 10 | Flooring | visible | A1:L51 | 88 | 12 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 11 | Structure | visible | A1:K51 | 97 | 10 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 12 | Furniture | visible | A1:M120 | 162 | 9 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 13 | Accessories | visible | A1:K69 | 94 | 9 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 14 | AV | visible | A1:K55 | 101 | 9 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 15 | Hanging Sign | visible | A1:S69 | 104 | 10 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 16 | Cross Rental Furniture | hidden | A1:N51 | 88 | 11 | — | 0 |  |  | reference | Cross-rental reference sheet |
| 17 | Cross Rental AV | hidden | A1:N51 | 88 | 11 | — | 0 |  |  | reference | Cross-rental reference sheet |
| 18 | Cross Rental TBD 1 | hidden | A1:N51 | 88 | 11 | — | 0 |  |  | reference | Cross-rental reference sheet |
| 19 | Cross Rental TBD 2 | hidden | A1:N51 | 88 | 11 | — | 0 |  |  | reference | Cross-rental reference sheet |
| 20 | LABOR RATES  | visible | A1:E135 | 0 | 6 | — | 0 |  |  | reference | Rate table |
| 21 | Show Services | visible | A1:O87 | 42 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 22 | PMC  | hidden | A1:I44 | 23 | 51 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 23 | INVOICE REQUEST | hidden | A1:K88 | 15 | 19 | — | 0 |  | Y | output | Client- or ops-facing document output |
| 24 | INVOICE  | hidden | A1:R90 | 21 | 36 | — | 0 |  | Y | output | Client- or ops-facing document output |
| 25 | COMPONENT 1 | visible | A1:N82 | 122 | 5 | — | 0 |  |  | template | COMPONENT template |
| 26 | COMPONENT 2 | visible | A1:AT61 | 225 | 3 | — | 0 |  |  | template | COMPONENT template |
| 27 | COMPONENT 3 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 28 | COMPONENT 4 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 29 | COMPONENT 5 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 30 | COMPONENT 6 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 31 | COMPONENT 7 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 32 | COMPONENT 8 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 33 | COMPONENT 9 | visible | A1:AT76 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 34 | COMPONENT 10 | visible | A1:AT61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 35 | COMPONENT 11 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 36 | COMPONENT 12 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 37 | COMPONENT 13 | visible | A1:J61 | 212 | 3 | — | 0 |  |  | template | COMPONENT template |
| 38 | COMPONENT 14 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 39 | COMPONENT 15 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 40 | COMPONENT 16 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 41 | COMPONENT 17 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 42 | COMPONENT 18 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 43 | COMPONENT 19 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 44 | COMPONENT 20 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 45 | COMPONENT 21 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 46 | DESIGN TIME 22 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 47 | ENGINEERING 23 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 48 | ESTIMATING 24 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 49 | PRESET 25 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 50 | PACKING 26 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 51 | COMPONENT 27 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 52 | COMPONENT 28 | visible | A1:J61 | 221 | 3 | — | 0 |  |  | template | COMPONENT template |
| 53 | COMPONENT 29 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 54 | COMPONENT 30 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 55 | COMPONENT 31 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 56 | COMPONENT 32 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 57 | COMPONENT 33 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 58 | COMPONENT 34 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 59 | COMPONENT 35 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 60 | COMPONENT 36 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 61 | COMPONENT 37 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 62 | COMPONENT 38 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 63 | COMPONENT 39 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 64 | COMPONENT 40 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 65 | MATERIALS B-DOWN | hidden | A1:AI56 | 1672 | 1 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 66 | COMPONENT 41 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 67 | COMPONENT 42 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 68 | COMPONENT 43 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 69 | COMPONENT 44 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 70 | COMPONENT 45 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 71 | COMPONENT 46 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 72 | COMPONENT 47 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 73 | COMPONENT 48 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 74 | COMPONENT 49 | visible | A1:J61 | 223 | 3 | — | 0 |  |  | template | COMPONENT template |
| 75 | OPTION (1) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 76 | OPTION (2) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 77 | OPTION (3) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 78 | OPTION (4) | hidden | A1:N61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 79 | OPTION (5) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 80 | OPTION (6) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 81 | OPTION (7) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 82 | OPTION (8) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 83 | OPTION (9) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 84 | OPTION (10) | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | template | OPTION template |
| 85 | PACKING | hidden | A1:J61 | 223 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 86 | SKIDS | visible | A1:J61 | 125 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 87 | ENG. DRAWINGS | hidden | A1:J61 | 220 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 88 | CRATING | visible | A1:J61 | 115 | 3 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 89 | TRUCKING & LOAD LIST | hidden | A1:E21 | 14 | 8 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 90 | MATERIALS SUMMARY | visible | A1:I78 | 228 | 5 | — | 0 |  |  | calculation | Rollup/aggregation of upstream sheets |
| 91 | COST SUMMARY | visible | A1:AF117 | 1867 | 39 | — | 0 |  |  | calculation | Rollup/aggregation of upstream sheets |
| 92 | WORK ORDER | hidden | A1:K312 | 160 | 152 | — | 0 |  | Y | output | Client- or ops-facing document output |
| 93 | Standard Cost Sheet | hidden | A1:C57 | 1 | 0 | — | 0 |  |  | calculation | Formula-driven working sheet |
| 94 | PRICE OPTIONS | hidden | A1:AK52 | 1271 | 8 | — | 0 | Y |  | output | Client- or ops-facing document output |
| 95 | Hanging Sign Coverup | hidden | A1:K74 | 80 | 10 | — | 0 |  |  | calculation | Formula-driven working sheet |

<!-- AUTO-GENERATED TABLE END -->

## Notes on specific sheets

- **`DATA`** and **`Base`** (both hidden, both classified `reference`) hold
  the workbook's lookup lists and rate constants respectively — see
  `docs/business-rules.md` Rules 8 and 11.
- **`PRICE OPTIONS`** (hidden, protected) — its formula content is entirely
  broken (`#REF!`); see `docs/business-rules.md` Rule 7. Classification
  heuristic still labels it `calculation` since it *is* formula-driven,
  despite being non-functional.
- **`Standard Cost Sheet`** (hidden) — flat rental price list, see
  `docs/business-rules.md` Rule 9.
- **`Cross Rental Furniture`, `Cross Rental AV`, `Cross Rental TBD 1`,
  `Cross Rental TBD 2`** (all hidden) — structurally identical to the
  category sheets (Flooring, Structure, …) but for cross-rented inventory;
  "TBD 1"/"TBD 2" naming suggests placeholder categories never assigned a
  real name.
- **`PMC `** (hidden, trailing space in name) — likely "Project Management
  Costing" or similar based on its formula references to Start Page and
  ` ESTIMATE`; not confidently classified. Flagged `workflow`.
