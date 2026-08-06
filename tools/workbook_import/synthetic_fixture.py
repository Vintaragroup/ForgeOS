"""Builds a synthetic, clearly-fictional populated job workbook from the
Reference/ template, for exercising the Phase 1 importer + diff harness
before real historical job workbooks are available (see docs/migration-plan.md
Phase 1). Every value below is invented for testing and does not describe
any real client, job, or rate.

Never writes to Reference/ — always operates on a fresh copy.
"""
from __future__ import annotations

from pathlib import Path

import openpyxl

from tools.workbook_audit.hashcheck import WORKBOOK_PATH

SYNTHETIC_JOB_NAME = "SYNTHETIC TEST JOB — NOT A REAL CLIENT"


def build_synthetic_job(out_path: Path) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    wb = openpyxl.load_workbook(WORKBOOK_PATH, keep_vba=True)

    sp = wb["Start Page"]
    sp["C13"] = SYNTHETIC_JOB_NAME
    sp["C15"] = "T-0001"
    sp["D40"] = 1   # Flooring component quantity
    sp["D63"] = 2   # drives COMPONENT 10's own quantity (B6)

    # -- Flooring (category band) synthetic direct materials + labor hours --
    # NOTE: Flooring has two separate material blocks -- "RENTAL COMPONENT
    # PRICES" (cols B-E, a client-facing rental price list) and "DIRECT
    # MATERIALS PER COMPONENT" (cols G-J, the actual cost input COST
    # SUMMARY!D8 reads via J11). Only the latter feeds COST SUMMARY.
    fl = wb["Flooring"]
    fl["H10"] = 20          # direct-materials qty (col H)
    fl["I10"] = 3.5         # direct-materials unit cost (col I) -> J10 = 70
    fl["H16"] = 6           # DE hours per unit
    fl["H17"] = 3           # EN hours per unit

    # -- COMPONENT 10 (component band) synthetic material + labor --
    c10 = wb["COMPONENT 10"]
    c10["B10"] = 4
    c10["C10"] = 25.0      # -> D10 = 100
    c10["G10"] = 8         # DE hours -> I10 = 8 * COMPONENT 1!H10 (66.15)
    c10["G11"] = 3         # EN hours -> I11 = 3 * COMPONENT 1!H11 (58.8)

    wb.save(out_path)
    return out_path


if __name__ == "__main__":
    import sys

    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("synthetic_job.xlsm")
    path = build_synthetic_job(dest)
    print(f"Wrote synthetic job workbook: {path}")
