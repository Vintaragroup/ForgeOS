# Historical job files (local only — never committed)

Drop real, populated job workbooks here to close out Phase 1's actual
exit criteria (`docs/migration-plan.md`): *"3+ historical, distinct real
job workbooks reproduce their known-good final numbers within rounding
tolerance."* Everything in this directory except this README is
gitignored — these are real client names, rates, and awarded prices, and
this repo is public. Same treatment as `Reference/ORLANDO ESTIMATE.xlsm`.

## Layout

One folder per job, named however you like (a job number is ideal). Mixed
file types are expected and fine — drop in whatever you have:

```
data/historical_jobs/
  2024-orlando-acme/
    estimate.xlsx           <- the populated workbook (required; .xlsm or .xlsx both work)
    ground_truth.md         <- what was actually invoiced/awarded (see below)
    supporting/
      signed_proposal.pdf   <- proposal PDF, signature page, etc.
      invoice.pdf
      booth_photo.jpg       <- production/install photos, if you have them
      quote_email.png       <- a screenshot, scanned doc, whatever exists
  2024-vegas-widgetco/
    estimate.xlsm
    ground_truth.md
    supporting/
      ...
  ...
```

Only the workbook is required for the pipeline itself to run — that's the
one file `tools/workbook_import/` actually parses and recalculates.
Everything else (PDFs, images, notes) is for establishing **ground
truth**: the real-world figure to check the workbook's numbers against.

## The workbook (`estimate.xlsm` or `estimate.xlsx`)

The populated estimate itself — same format/lineage as
`ORLANDO ESTIMATE.xlsm` (a filled-in copy of it, or a job built from that
template). **Both `.xlsm` and `.xlsx` work** — confirmed by running a
macro-free `.xlsx` copy through the full pipeline end-to-end (recalc,
import, diff harness, all 8 checks passed identically to the `.xlsm`
case). Name it whatever's natural; just point `--job` at it.

## Supporting documents (PDF / images)

These aren't parsed automatically by the pipeline — I'll read them
directly (I can open PDFs and images) to pull out the actual awarded
price, signed terms, or invoiced total, and write that into
`ground_truth.md` for you. If you'd rather just drop everything in
`supporting/` and let me extract the numbers myself once files are in
place, that's the easiest path — you don't need to fill out
`ground_truth.md` by hand.

## `ground_truth.md` (recommended, not required)

The synthetic fixture used so far has no independent "correct answer" to
check against — only internal consistency (does the workbook agree with
itself once recalculated). A **real** historical job is only a genuine
test if there's a known-good figure from outside the workbook to compare
against: the actual signed/awarded proposal total, or what was actually
invoiced. Plain text is fine, e.g.:

```
Job: 2024-orlando-acme
Awarded proposal total: $48,213.00
Gross margin (as sold): 42%
Source: signed proposal PDF, dated 2024-03-14
Notes: change order #1 added $1,200 after award — award total above
       excludes it.
```

Without this, the harness can still confirm the pipeline reads the job
correctly and the workbook's own arithmetic is internally consistent —
useful, but it's not the same claim as "matches what we actually charged
the client."

## Running the pipeline against a job here

```
python3 -m tools.workbook_import.run_phase1 \
  --job data/historical_jobs/2024-orlando-acme/estimate.xlsx \
  --name "2024-orlando-acme" \
  --real
```

Note: `run_phase1.py` currently only imports the `COMPONENT 10` and
`Flooring` sections by default (see `docs/phase1-findings.md` — this was
scoped narrowly for the synthetic-data pass). Once real jobs are here,
tell me which sections are actually populated in each one and I'll extend
`COMPONENT_SHEETS`/`CATEGORY_SHEETS` in `run_phase1.py` to match, and wire
the diff harness up through `Price Summary` and ` ESTIMATE` so it checks
the full chain, not just `COST SUMMARY`.
