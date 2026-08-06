# tools/workbook_import

Phase 1 tooling: read-only workbook_audit/'s counterpart, but this
package is explicitly where recalculated (not just authored) formula
values are trusted, per `docs/migration-plan.md` Phase 1. Kept as a
separate package from `tools/workbook_audit/` on purpose.

## Setup

```
brew install --cask libreoffice     # provides the `soffice` CLI
pip install -r tools/workbook_audit/requirements.txt   # openpyxl, olefile
```

## Run the Phase 1 pipeline

```
python3 -m tools.workbook_import.run_phase1
```

With no arguments, builds a synthetic populated job (clearly labeled as
fictional — see `synthetic_fixture.py`) from the audited template,
recalculates it with LibreOffice headless, imports its `COMPONENT 10` and
`Flooring` sections into a staging SQLite DB, and diffs an independent
recompute of each section's totals (per `docs/business-rules.md` Rules
1-2) against the workbook's own `COST SUMMARY` values.

Against a real populated job workbook:

```
python3 -m tools.workbook_import.run_phase1 --job /path/to/real_job.xlsm --name "Job 1234" --real
```

## Run the tests

```
python3 -m pytest tests/workbook_import/ -v
```

Real LibreOffice recalculation runs as part of these tests (no mocking of
`soffice`) — they take a few seconds longer than `tests/workbook_audit/`
as a result.

## Module layout

- `recalc.py` — LibreOffice headless wrapper. Verified (see
  `docs/business-rules.md` Rule 7) that `--convert-to` forces a real
  recalculation, not a re-save of stale cached values.
- `synthetic_fixture.py` — builds a clearly-fictional populated job
  workbook for testing before real historical jobs are available.
- `schema.py` — staging SQLite schema, a narrow first-cut of
  `docs/data-model-v0.md` scoped to exactly what Phase 1 needs.
- `importer.py` — reads a recalculated workbook's raw line items,
  independently recomputes section totals, and pairs them with
  `COST SUMMARY`'s own authoritative values. Resolves each section's
  `COST SUMMARY` row dynamically from the Phase 0 formula catalog rather
  than hardcoding row numbers.
- `diff_harness.py` — stage-by-stage comparison, localizing any mismatch
  rather than only checking a final grand total.
- `run_phase1.py` — single documented entrypoint tying the above together.

## Known limitations (by design, this pass)

- Only `COMPONENT 10` and `Flooring` are wired end-to-end. Extending to
  every component/category sheet, and up through `Price Summary` /
  ` ESTIMATE`, is mechanical (same pattern) but not yet done — see
  `docs/phase1-findings.md`.
- No real historical job workbooks have been imported yet (only the
  synthetic fixture). Phase 1's actual exit criteria (3+ real jobs
  reproducing known-good totals) is still open pending those files.
