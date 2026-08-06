import sys
import warnings
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from tools.workbook_import.recalc import recalculate
from tools.workbook_import.synthetic_fixture import build_synthetic_job


@pytest.fixture(scope="session")
def synthetic_job_recalculated(tmp_path_factory):
    """Builds the synthetic fixture once per test session and recalculates
    it via LibreOffice headless -- this is real spreadsheet execution, not
    a mock, so it's scoped to session to avoid repeated ~seconds-long
    soffice invocations."""
    workdir = tmp_path_factory.mktemp("phase1_test")
    job_path = build_synthetic_job(workdir / "synthetic_job.xlsm")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        result = recalculate(job_path, workdir / "recalc_out")
    return job_path, result.recalculated_path
