"""Workbook integrity checking — never let the audit touch the source file.

The source workbook is expected at Reference/ORLANDO ESTIMATE.xlsm (this
filesystem is case-insensitive, so `reference/` and `Reference/` are the
same directory). A SHA-256 baseline is stored once and re-checked on every
run; any mismatch aborts the audit rather than proceeding on a possibly
modified file.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKBOOK_PATH = REPO_ROOT / "Reference" / "ORLANDO ESTIMATE.xlsm"
BASELINE_PATH = REPO_ROOT / ".workbook_hash_baseline.txt"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_baseline() -> str:
    text = BASELINE_PATH.read_text().strip()
    # format: "<hash>  <path>"
    return text.split()[0]


class WorkbookIntegrityError(RuntimeError):
    pass


def verify_unchanged() -> str:
    """Return the current hash if it matches baseline; raise otherwise."""
    if not WORKBOOK_PATH.exists():
        raise WorkbookIntegrityError(f"Source workbook not found at {WORKBOOK_PATH}")
    if not BASELINE_PATH.exists():
        raise WorkbookIntegrityError(
            f"No baseline hash recorded at {BASELINE_PATH}. "
            "Refusing to proceed without a known-good baseline."
        )
    current = sha256_of(WORKBOOK_PATH)
    baseline = read_baseline()
    if current != baseline:
        raise WorkbookIntegrityError(
            f"Workbook hash mismatch!\n  baseline: {baseline}\n  current:  {current}\n"
            "The source file may have been modified. Aborting."
        )
    return current


if __name__ == "__main__":
    h = verify_unchanged()
    print(f"OK: workbook hash unchanged ({h})")
