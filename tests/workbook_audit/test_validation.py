"""Explicit checks from the audit brief's VALIDATION section that don't
fit naturally under a single reader module."""
import re
import subprocess
import sys
from pathlib import Path

from tools.workbook_audit.hashcheck import REPO_ROOT, WORKBOOK_PATH


def test_detect_structurally_repeated_sheet_families(xml_pkg):
    """VALIDATION: detect sheets that are structurally repeated."""
    sheets = xml_pkg.sheets()
    component_sheets = [s for s in sheets if re.match(r"^COMPONENT \d+$", s.name)]
    option_sheets = [s for s in sheets if re.match(r"^OPTION \(\d+\)$", s.name)]
    assert len(component_sheets) == 44
    assert len(option_sheets) == 10

    # structural repetition confirmed by identical dimension shape prefix,
    # not just name pattern
    dims = set()
    for s in component_sheets:
        detail = xml_pkg.sheet_detail(s.target)
        dims.add(detail["dimension_raw"])
    # allow some variance (a few sheets have extra rows) but the family
    # should overwhelmingly share a small number of shapes, not be 44
    # unique one-off layouts
    assert len(dims) < len(component_sheets) / 2


def test_no_iterative_calculation_flag_set(xml_pkg):
    """VALIDATION-adjacent: confirms no intentional circular-formula design
    (risk-register.md R10)."""
    calc_pr = xml_pkg.calc_pr()
    assert calc_pr.get("iterate") != "1"


def test_workbook_hash_identical_before_and_after_full_scan():
    """End-to-end VALIDATION: running the full scan must not touch the
    source file. Runs the real scan.py entrypoint as a subprocess so this
    test also doubles as a smoke test of the documented rerun command."""
    from tools.workbook_audit.hashcheck import sha256_of

    before = sha256_of(WORKBOOK_PATH)
    result = subprocess.run(
        [sys.executable, "-m", "tools.workbook_audit.scan"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    after = sha256_of(WORKBOOK_PATH)
    assert result.returncode == 0, result.stderr
    assert before == after, "scan.py must never modify the source workbook"
    assert "OK — source workbook unchanged" in result.stdout


def test_scan_redacts_real_employee_names_from_generated_artifacts():
    """Regression guard: this repo is public, and artifacts/workbook_inventory.json
    is generated (not hand-authored), so a one-off manual redaction gets
    silently overwritten the next time scan.py runs -- exactly what
    happened once already (see tools/workbook_audit/scan.py's
    REDACT_NAMES). Runs scan.py fresh, then asserts no real name survives
    in the file it writes."""
    from tools.workbook_audit.scan import REDACT_NAMES

    result = subprocess.run(
        [sys.executable, "-m", "tools.workbook_audit.scan"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr

    inventory_text = (REPO_ROOT / "artifacts" / "workbook_inventory.json").read_text()
    for real_name in REDACT_NAMES:
        assert real_name not in inventory_text, f"unredacted name leaked into artifacts: {real_name!r}"
