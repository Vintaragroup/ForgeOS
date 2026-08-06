import pytest

from tools.workbook_import import recalc


def test_find_soffice_raises_when_missing(monkeypatch):
    monkeypatch.setattr(recalc.shutil, "which", lambda name: None)
    with pytest.raises(recalc.RecalcError):
        recalc._find_soffice()


def test_recalculate_never_mutates_source(synthetic_job_recalculated):
    """The core safety property of this module: --convert-to always
    writes a NEW file, never touches the input."""
    job_path, recalculated_path = synthetic_job_recalculated
    assert recalculated_path != job_path
    assert recalculated_path.exists()
    assert recalculated_path.suffix == ".xlsx"


def test_recalculate_actually_recalculates_not_just_resaves(synthetic_job_recalculated):
    """Regression guard for the exact behavior manually verified before
    this module was written (docs/business-rules.md Rule 7): confirms a
    formula's cached result reflects the synthetic input, not a stale or
    blank cache."""
    _, recalculated_path = synthetic_job_recalculated
    values = recalc.read_values(recalculated_path, [
        ("COMPONENT 10", "I10"),  # = G10*H10 = 8 hours * 66.15 rate
    ])
    assert values[("COMPONENT 10", "I10")] == pytest.approx(529.2, abs=0.01)
