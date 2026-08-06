"""Stage-by-stage comparison harness (docs/migration-plan.md Phase 1).

For each imported section, checks that our independent recompute (raw
line items x the section's own quantity, per docs/business-rules.md
Rules 1-2 and 5) matches the workbook's own authoritative COST SUMMARY
values -- localizing any mismatch to a specific stage rather than only
checking a final grand total.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

TOLERANCE = 0.01  # dollars; formulas here are plain arithmetic, not iterative, so this is generous


@dataclass
class CheckResult:
    stage: str
    sheet: str
    cell: str
    label: str
    imported_value: float
    recalculated_value: float
    abs_diff: float
    within_tolerance: bool


def check_section(sec: dict) -> list[CheckResult]:
    qty = sec["quantity"] or 0
    results = []

    expected_material = sec["imported_material_total"] * qty
    results.append(_cmp(sec, "expected material (imported x qty)", expected_material,
                         sec["source_total_direct_material"], "material"))

    expected_labor = sec["imported_labor_total"] * qty
    results.append(_cmp(sec, "expected labor (imported x qty)", expected_labor,
                         sec["source_total_labor_cost"], "labor"))

    # Identity check: does AD (TOTAL) actually equal E+Z+AB, as its own
    # formula claims (docs/business-rules.md Rule 5)?
    identity_expected = (
        (sec["source_total_direct_material"] or 0)
        + (sec["source_total_labor_cost"] or 0)
        + (sec["source_total_overhead"] or 0)
    )
    results.append(_cmp(sec, "TOTAL identity (E+Z+AB)", identity_expected,
                         sec["source_total_cost"], "total"))

    # Confirms risk-register.md R19: overhead should be exactly 0.
    results.append(_cmp(sec, "overhead is zero (R19)", 0.0,
                         sec["source_total_overhead"] or 0.0, "overhead"))

    return results


def _cmp(sec: dict, label: str, imported: float, recalculated: float, kind: str) -> CheckResult:
    imported = imported or 0.0
    recalculated = recalculated or 0.0
    diff = abs(imported - recalculated)
    return CheckResult(
        stage=sec["section_type"],
        sheet=sec["sheet_name"],
        cell=f"COST SUMMARY row {sec['cost_summary_row']} ({kind})",
        label=label,
        imported_value=imported,
        recalculated_value=recalculated,
        abs_diff=diff,
        within_tolerance=diff <= TOLERANCE,
    )


def run(conn: sqlite3.Connection, job_id: int, sections: list[dict]) -> list[CheckResult]:
    all_results = []
    cur = conn.cursor()
    for sec in sections:
        for r in check_section(sec):
            all_results.append(r)
            cur.execute(
                "INSERT INTO rollup_check "
                "(job_id, stage, sheet, cell, label, imported_value, recalculated_value, abs_diff, within_tolerance) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (job_id, r.stage, r.sheet, r.cell, r.label, r.imported_value,
                 r.recalculated_value, r.abs_diff, int(r.within_tolerance)),
            )
    conn.commit()
    return all_results


def print_report(results: list[CheckResult]) -> bool:
    all_pass = True
    for r in results:
        status = "PASS" if r.within_tolerance else "FAIL"
        if not r.within_tolerance:
            all_pass = False
        print(f"[{status}] {r.sheet:<14} {r.label:<32} imported={r.imported_value:>10.2f}  "
              f"recalculated={r.recalculated_value:>10.2f}  diff={r.abs_diff:.4f}")
    return all_pass
