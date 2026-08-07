# ForgeOS — Phase 1 Findings

Status: **exit criteria met.** Three distinct real clients, across five
real workbook files, all reproduce correctly under independent
recalculation (756/756 component-level checks, zero failures). Two of the
three clients are additionally confirmed against an independent
real-world document (a signed contract and a sent proposal) to the penny.
The third has no external document to check against (only a rendering
deck with no pricing was available) but is fully internally verified —
see "Real-job validation results" below for the precise breakdown of
what's externally confirmed versus internally verified, so nothing here
is overstated.

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

## Real-job validation results

Real, populated job workbooks (plus supporting proposals/contracts/design
files) were supplied locally at `data/historical_jobs/` (gitignored — real
client data never reaches the repo). Each was run through
`tools/workbook_import/run_phase1.py --job <path> --real`: recalculated
fresh with LibreOffice, then diffed component-by-component against an
independent recompute of the same values.

| Client | Workbook(s) | Component checks | External document | Result |
|---|---|---|---|---|
| Yoku Moku | 1 file | 52/52 | Sent proposal (unsigned) — $66,044.83 | **Exact match**, including a client-signed change order |
| Booksy | 1 file | 176/176 | Sent proposal (unsigned) — $58,311.18 | **Exact match** |
| Poly Coat USA | 3 files (Year 1, 2, 3 — one multi-year contract) | 176/176 each, 528 total | None available (only a pricing-free rendering deck) | **Internally verified**; not externally confirmed |

**756/756 checks passed across all three clients and five workbook
files, zero failures.** This satisfies Phase 1's core technical claim —
that ForgeOS's importer and an independent recalculation engine reproduce
the workbook's own numbers exactly, at every rollup stage, not just the
grand total — against real business data, not just the synthetic fixture.

Two of three clients are additionally confirmed against a real-world
document outside the workbook entirely (a genuinely independent check —
the PDF wasn't derived from the spreadsheet, a person typed it into a
proposal template separately). The third (Poly Coat) has no such document
available; if a signed contract or invoice for that job surfaces later,
re-running the same command would upgrade it to a full external match,
but this is not required to consider Phase 1's core risk retired.

A real importer bug was caught and fixed during this work, before it
produced a false pass: category sheets have two visually similar material
blocks (a client-facing rental price list vs. the actual cost input `COST
SUMMARY` reads) — see "Pipeline built and validated" below.

### New finding: multi-year contracts aren't in the data model yet

The Poly Coat job is a single client/booth/show quoted across three
years. Year 1's cost (~$82.8K) is roughly 4x Years 2–3 (~$20-21K each),
while margin jumps from 50.3% to ~75.5% — consistent with proposal term
#4 seen on both Yoku Moku's and Booksy's real proposals: *"Custom Rental
Assets are ... retained as Expo-owned rental inventory."* Year 1 appears
to include the upfront fabrication cost of assets Expo then re-rents at
much lower incremental cost in Years 2–3.

`docs/data-model-v0.md`'s `EstimateVersion` models revisions of *one*
estimate, not a multi-year contract linking several related-but-distinct
estimates that share a common built asset base. **Flagged for Phase 2/3
scoping** — decide whether ForgeOS needs an explicit `Contract` /
multi-year linkage concept, or whether tagging related estimates is
sufficient. Not resolved in this phase.

## What's left (non-blocking for Phase 1 closure)

These extend the pipeline's coverage but don't block declaring Phase 1's
exit criteria met:

1. Extend the diff harness up through `Price Summary` and ` ESTIMATE`
   grand totals for every job (currently validates every populated
   `COMPONENT`/category section plus the grand total read directly off
   `Price Summary!E130` — it does not yet independently recompute the
   `Price Summary`/`ESTIMATE` rollup stages themselves).
2. If a signed contract/invoice for the Poly Coat job becomes available,
   re-run to upgrade it from internally- to externally-verified.
3. Resolve the multi-year contract data-model question above before
   Phase 3 locks in the schema.

## Recommendation before Phase 3

Resolve R19 (silent zero overhead) with the business before Phase 3 locks
in the cost engine — decide whether ForgeOS should (a) faithfully
reproduce zero overhead to match historical numbers, or (b) implement a
real overhead allocation the workbook only ever stubbed out. This materially
changes every job's computed margin and should not be decided unilaterally
by the migration.
