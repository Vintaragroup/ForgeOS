"""LibreOffice headless recalculation — the first point in ForgeOS where a
computed (not just authored) formula value is trusted.

Everything in tools/workbook_audit/ is deliberately read-only and never
evaluates a formula (per docs/audit-plan.md). This module is the
Phase 1 boundary the migration plan calls for: a clearly separate piece
of tooling, used only on copies of *populated job workbooks* (never on
the audited Reference/ template), that drives a real spreadsheet engine
to get an authoritative computed value.

Verified manually before this module was written (see docs/business-rules.md
Rule 7's "Phase 1 update"): `soffice --headless --convert-to xlsx` does
force a full recalculation, not just a re-save of stale cached values —
confirmed by writing a known input, converting, and checking the
dependent formula's cached result changed accordingly.
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class RecalcError(RuntimeError):
    pass


@dataclass
class RecalcResult:
    source_path: Path
    recalculated_path: Path
    stdout: str


def _find_soffice() -> str:
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise RecalcError(
            "soffice not found on PATH. Install with: brew install --cask libreoffice"
        )
    return exe


def recalculate(workbook_path: Path, out_dir: Path, timeout: int = 120) -> RecalcResult:
    """Recalculate `workbook_path` (a populated job workbook — never the
    read-only audit source) via LibreOffice headless, writing a
    recalculated .xlsx into out_dir. Never modifies workbook_path itself;
    LibreOffice is invoked with --convert-to, which always writes a new
    file."""
    workbook_path = Path(workbook_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    soffice = _find_soffice()

    proc = subprocess.run(
        [
            soffice,
            "--headless",
            "--norestore",
            "--convert-to", "xlsx",
            "--outdir", str(out_dir),
            str(workbook_path),
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RecalcError(
            f"soffice exited {proc.returncode}\nstdout: {proc.stdout}\nstderr: {proc.stderr}"
        )

    recalculated_path = out_dir / (workbook_path.stem + ".xlsx")
    if not recalculated_path.exists():
        raise RecalcError(
            f"soffice reported success but no output file at {recalculated_path}\n"
            f"stdout: {proc.stdout}"
        )
    return RecalcResult(
        source_path=workbook_path,
        recalculated_path=recalculated_path,
        stdout=proc.stdout,
    )


def read_values(recalculated_path: Path, refs: list[tuple[str, str]]) -> dict[tuple[str, str], object]:
    """Read authoritative computed values for a list of (sheet, cell) refs
    from a recalculated workbook. Uses data_only=True deliberately — this
    is the one place in the whole project where reading a cached formula
    result, rather than its formula text, is the intended behavior."""
    import openpyxl

    wb = openpyxl.load_workbook(recalculated_path, data_only=True, read_only=True)
    out = {}
    for sheet, cell in refs:
        out[(sheet, cell)] = wb[sheet][cell].value
    return out


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("Usage: python3 -m tools.workbook_import.recalc <path-to-populated-workbook.xlsm>")
        sys.exit(1)
    path = Path(sys.argv[1])
    result = recalculate(path, path.parent / "_recalc_out")
    print(f"Recalculated: {result.recalculated_path}")
