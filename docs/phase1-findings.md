# ForgeOS — Phase 1 Findings

Status: **tooling built and validated end-to-end; exit criteria not yet
met** (needs real historical job workbooks — see "What's still blocked"
below). This document records what Phase 1 investigation resolved, what
it built, and what's left.

## What changed since Phase 0

Phase 0 (`docs/audit-plan.md`) was deliberately read-only — no formula was
ever evaluated, only its text. Phase 1 introduces the first calculation
engine this project trusts: LibreOffice headless
(`tools/workbook_import/recalc.py`), verified by hand before being wrapped
in code (see the "Repair path CONFIRMED" evidence in
`docs/business-rules.md` Rule 7) to actually force recalculation rather
than re-save stale cached values.

## Two Phase 0 open questions resolved

### R18 closed: COST SUMMARY does not double-count

Phase 0 flagged an "unresolved calculation duplication" — `COST SUMMARY`
appeared to roll up costs through two separate mechanisms and it was
unclear whether they represented the same underlying cost counted twice.

Full cell-tracing (no recalculation needed — this was a static-formula
question) found **two structurally identical but semantically distinct
row bands**, each with its own `MATERIALS` / `LABOR $` / `OVERHEAD` /
`TOTAL` header set:

- **Category band** (rows ~8–20): one row per rental/category sheet
  (Flooring, Structure, Furniture, …), feeding `Price Summary!B5`.
- **Component band** (rows ~22–70): one row per `COMPONENT` sheet,
  feeding `Price Summary!B27`.

These represent two different kinds of estimate content — standard rental
inventory versus custom-fabricated components — never referencing each
other's totals. See `docs/business-rules.md` Rule 5 for the full trace.

### R1 downgraded: PRICE OPTIONS is mechanically repairable

Phase 0 found `PRICE OPTIONS` almost entirely broken (`#REF!` in 1,068
formulas) with no clear path forward. Phase 1 traced the pattern
(`'COST SUMMARY'!#REF!` always paired with a same-row `A`/`B` reference
and a divide-by-quantity) to `COST SUMMARY`'s live `AD` column
(`TOTAL COST = materials + labor$ + overhead`), then **tested the repair
empirically**: patched a scratch copy's row 33 to point at
`COST SUMMARY!A33`/`B33`/`AD33`, entered synthetic material and labor
values, recalculated with LibreOffice, and got fully consistent output —
margin % (0.60) and cost-ratio % (0.40) summed to exactly 1.0.

**The mechanical brokenness is fixed and verified. The business question
— what the 43/57…65/35 tiers and the `×1.075` multiplier mean — is still
open** and needs stakeholder input before this sheet's output is trusted.

## One new finding: OVERHEAD is silently dead workbook-wide

Not previously in the Phase 0 risk register. `COST SUMMARY`'s `OVERHEAD`
column (`AB`) has **no formula at all** in the category band (every
`AB8:AB13` cell is blank) and in the component band every row's formula
(e.g. `AB24`) ends in an unconditional `*0` — the computed expression is
multiplied by zero regardless of inputs. `TOTAL COST` (`AD`) therefore
never includes a real overhead allocation in either band, despite the
column being labeled and structurally present.

Logged as **R19** in `docs/risk-register.md`, currently ranked the #2
open risk (after R9, no version control) — every historical estimate's
recorded "total cost" is understated by whatever overhead allocation was
meant to apply.

## Pipeline built and validated

`tools/workbook_import/` — a new package, deliberately separate from the
read-only `tools/workbook_audit/`:

1. **`recalc.py`** — LibreOffice headless wrapper.
2. **`synthetic_fixture.py`** — builds a clearly-fictional populated job
   workbook from the audited template (no real historical workbooks were
   available this pass — see below).
3. **`schema.py`** — a narrow staging schema (job / estimate_section /
   line_item / rollup_check), shaped directly around the confirmed
   category-vs-component band structure.
4. **`importer.py`** — reads a recalculated workbook's raw line items,
   independently recomputes each section's material and labor totals per
   `docs/business-rules.md` Rules 1–2, and resolves each section's
   `COST SUMMARY` row dynamically from the Phase 0 formula catalog
   (`artifacts/formula_catalog.json`) rather than hardcoding row numbers.
5. **`diff_harness.py`** — compares the independent recompute against the
   workbook's own authoritative values, per section, localizing any
   mismatch instead of only checking a grand total.

**Result on the synthetic fixture: 8/8 checks pass** across both a
component section (`COMPONENT 10`) and a category section (`Flooring`) —
material totals, labor totals, the `E+Z+AB=AD` identity, and the R19
zero-overhead confirmation all matched within $0.01.

A real bug was caught and fixed *during* this build, before it ever
produced a false result: the importer initially read category sheets'
client-facing `RENTAL COMPONENT PRICES` block (columns B–E) instead of
the `DIRECT MATERIALS PER COMPONENT` block (columns G–J) that
`COST SUMMARY` actually consumes — two visually similar but functionally
distinct blocks on the same sheet. Caught by checking the formula catalog
before trusting the first plausible-looking column layout.

44 tests pass workbook-wide (32 from Phase 0 + 12 new), including
regression guards for the R18 and R19 findings and an end-to-end pipeline
test that runs a real LibreOffice recalculation (not mocked).

## What's still blocked

Phase 1's actual exit criteria per `docs/migration-plan.md` — **"3+
historical, distinct real job workbooks reproduce their known-good final
numbers within rounding tolerance"** — has not been met. This pass used
synthetic data by design (see prior conversation turn): no real populated
historical job workbooks were available. The pipeline is built and proven
against a controlled scenario; it has not been proven against real
business data, which is a different and stronger claim.

**To close Phase 1:**
1. Obtain 3+ real, populated historical job workbooks.
2. Run each through `tools/workbook_import/run_phase1.py --job <path> --real`.
3. Extend `COMPONENT_SHEETS`/`CATEGORY_SHEETS` in `run_phase1.py` to cover
   every populated section in those jobs (currently only `COMPONENT 10`
   and `Flooring` are wired — mechanical to extend, same pattern).
4. Extend the diff harness up through `Price Summary` and ` ESTIMATE`
   grand totals (currently stops at `COST SUMMARY`).
5. Compare each job's ForgeOS-recomputed grand total against the actual
   known-good figure the business already has for that historical job
   (the proposal total that was really sent) — the synthetic run has no
   such external ground truth to check against, only internal
   consistency.

## Recommendation before Phase 3

Resolve R19 (silent zero overhead) with the business before Phase 3 locks
in the cost engine — decide whether ForgeOS should (a) faithfully
reproduce zero overhead to match historical numbers, or (b) implement a
real overhead allocation the workbook only ever stubbed out. This materially
changes every job's computed margin and should not be decided unilaterally
by the migration.
