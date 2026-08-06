import pytest

from tools.workbook_import.importer import find_cost_summary_row


def test_find_cost_summary_row_component():
    assert find_cost_summary_row("COMPONENT 10", "A") == 33


def test_find_cost_summary_row_category():
    assert find_cost_summary_row("Flooring", "D") == 8


def test_find_cost_summary_row_raises_for_unknown_sheet():
    with pytest.raises(LookupError):
        find_cost_summary_row("NOT A REAL SHEET", "A")
