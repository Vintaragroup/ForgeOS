"""Workbook integrity: the audit must never let a modified file pass silently."""
import hashlib

import pytest

from tools.workbook_audit import hashcheck


def test_baseline_file_exists():
    assert hashcheck.BASELINE_PATH.exists()


def test_current_hash_matches_baseline():
    # This is the load-bearing safety check for the entire audit: if this
    # ever fails, the source workbook has been modified since the baseline
    # was recorded and no further analysis should be trusted.
    h = hashcheck.verify_unchanged()
    assert h == hashcheck.read_baseline()


def test_sha256_of_is_deterministic(tmp_path):
    f = tmp_path / "sample.bin"
    f.write_bytes(b"forgeos audit sample content")
    assert hashcheck.sha256_of(f) == hashlib.sha256(b"forgeos audit sample content").hexdigest()


def test_verify_unchanged_raises_on_tampered_copy(tmp_path, monkeypatch):
    tampered = tmp_path / "tampered.xlsm"
    tampered.write_bytes(b"not the real workbook")
    monkeypatch.setattr(hashcheck, "WORKBOOK_PATH", tampered)
    with pytest.raises(hashcheck.WorkbookIntegrityError):
        hashcheck.verify_unchanged()


def test_verify_unchanged_raises_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(hashcheck, "WORKBOOK_PATH", tmp_path / "does_not_exist.xlsm")
    with pytest.raises(hashcheck.WorkbookIntegrityError):
        hashcheck.verify_unchanged()
