# Historical job files (local only — never committed)

Drop real, populated job workbooks here to close out Phase 1's actual
exit criteria (`docs/migration-plan.md`): *"3+ historical, distinct real
job workbooks reproduce their known-good final numbers within rounding
tolerance."* Everything in this directory except this README is
gitignored — these are real client names, rates, and awarded prices, and
this repo is public. Same treatment as `Reference/ORLANDO ESTIMATE.xlsm`.

## Layout

One folder per job, named however you like (a job number is ideal):

```
data/historical_jobs/
  2024-orlando-acme/
    estimate.xlsm          <- the populated workbook (required)
    ground_truth.md        <- what was actually invoiced/awarded (see below)
    supporting/            <- optional: signed proposal, invoice PDFs, etc.
  2024-vegas-widgetco/
    estimate.xlsm
    ground_truth.md
  ...
```

Only `estimate.xlsm` is required for the pipeline to run. Anything else
you drop in a job folder (PDFs, notes, screenshots) is fine — the tooling
only reads `estimate.xlsm` and, optionally, `ground_truth.md`.

## `estimate.xlsm`

The populated workbook itself — same format/lineage as
`ORLANDO ESTIMATE.xlsm` (a filled-in copy of it, or a job built from that
template). This is what `tools/workbook_import/run_phase1.py` recalculates
and imports.

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
  --job data/historical_jobs/2024-orlando-acme/estimate.xlsm \
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
