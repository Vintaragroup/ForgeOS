"""Single documented entrypoint for the Phase 1 import + comparison harness.

Usage:
    python3 -m tools.workbook_import.run_phase1                 # synthetic fixture
    python3 -m tools.workbook_import.run_phase1 --job path.xlsm --name "..." --real

Pipeline: build/accept a populated job workbook -> recalculate it with
LibreOffice headless (tools/workbook_import/recalc.py, the first point a
computed value is trusted) -> import raw line items + COST SUMMARY
authoritative values into a staging SQLite DB (importer.py) -> diff our
independent recompute against the workbook's own values, stage by stage
(diff_harness.py).

Never touches Reference/ORLANDO ESTIMATE.xlsm.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tools.workbook_audit.hashcheck import REPO_ROOT
from tools.workbook_import import diff_harness, importer, schema
from tools.workbook_import.recalc import recalculate
from tools.workbook_import.synthetic_fixture import SYNTHETIC_JOB_NAME, build_synthetic_job

WORKDIR = REPO_ROOT / "artifacts" / "phase1_runs"
DB_PATH = REPO_ROOT / "artifacts" / "phase1_staging.db"

COMPONENT_SHEETS = ["COMPONENT 10"]
CATEGORY_SHEETS = ["Flooring"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", type=Path, default=None, help="Path to a populated job workbook (.xlsm). Defaults to a generated synthetic fixture.")
    ap.add_argument("--name", type=str, default=SYNTHETIC_JOB_NAME)
    ap.add_argument("--real", action="store_true", help="Mark this job as real (not synthetic) in the staging DB.")
    args = ap.parse_args()

    WORKDIR.mkdir(parents=True, exist_ok=True)

    if args.job is None:
        print("No --job given: building a synthetic populated fixture (see tools/workbook_import/synthetic_fixture.py)...")
        job_path = build_synthetic_job(WORKDIR / "synthetic_job.xlsm")
        is_synthetic = True
    else:
        job_path = args.job
        is_synthetic = not args.real

    print(f"Recalculating {job_path.name} via LibreOffice headless...")
    result = recalculate(job_path, WORKDIR / "recalculated")
    print(f"  -> {result.recalculated_path}")

    print("Creating staging DB...")
    conn = schema.create_db(DB_PATH)

    print(f"Importing sections: components={COMPONENT_SHEETS} categories={CATEGORY_SHEETS}")
    job_id, sections = importer.import_job(
        conn, job_path, result.recalculated_path,
        COMPONENT_SHEETS, CATEGORY_SHEETS, args.name, is_synthetic,
    )
    print(f"  job_id={job_id}, {len(sections)} section(s) imported")

    print("\nRunning diff harness...\n")
    results = diff_harness.run(conn, job_id, sections)
    all_pass = diff_harness.print_report(results)

    conn.close()

    print(f"\n{'ALL CHECKS PASSED' if all_pass else 'SOME CHECKS FAILED'} "
          f"({sum(r.within_tolerance for r in results)}/{len(results)})")
    print(f"Staging DB: {DB_PATH}")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
