import sys
import warnings
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from tools.workbook_audit.hashcheck import WORKBOOK_PATH
from tools.workbook_audit.xml_reader import WorkbookXmlPackage
from tools.workbook_audit.openpyxl_reader import load_workbook


@pytest.fixture(scope="session")
def workbook_path():
    assert WORKBOOK_PATH.exists(), f"source workbook missing at {WORKBOOK_PATH}"
    return WORKBOOK_PATH


@pytest.fixture(scope="session")
def xml_pkg(workbook_path):
    return WorkbookXmlPackage(workbook_path)


@pytest.fixture(scope="session")
def wb(workbook_path):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return load_workbook(workbook_path)


@pytest.fixture(scope="session")
def raw_zip(workbook_path):
    return zipfile.ZipFile(workbook_path)
