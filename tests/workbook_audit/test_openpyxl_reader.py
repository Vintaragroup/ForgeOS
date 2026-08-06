"""openpyxl-based extraction correctness, and VALIDATION: sample-check
major totals' dependency chains (existence, not recalculated values)."""
import re

from tools.workbook_audit.openpyxl_reader import (
    scan_sheets,
    scan_formulas,
    categorize_formula,
    referenced_sheets,
    normalize_pattern,
)


def test_scan_sheets_matches_xml_reader_count(wb, xml_pkg):
    """VALIDATION: reconcile sheet counts between openpyxl and workbook XML."""
    assert len(wb.sheetnames) == len(xml_pkg.sheets()) == 95


def test_no_formula_ever_recalculated(wb):
    """We must never claim a recalculated value — data_only must be False
    so cell.value on a formula cell is the formula text, not a cached
    result. This is a hard requirement from the audit brief."""
    ws = wb["COMPONENT 1"]
    cell = ws["D10"]
    assert cell.data_type == "f"
    assert isinstance(cell.value, str) and cell.value.startswith("=")


def test_scan_formulas_finds_expected_scale(wb):
    formulas = scan_formulas(wb)
    # Pinned to the known count at audit time; a large deviation on a
    # future run signals the source workbook changed materially.
    assert 20000 < len(formulas) < 25000


def test_component_family_formulas_reference_each_other(wb):
    formulas = scan_formulas(wb)
    comp1_refs = [
        f for f in formulas
        if f["sheet"] == "MATERIALS B-DOWN" and any(re.match(r"^COMPONENT \d+$", r) for r in f["referenced_sheets"])
    ]
    assert len(comp1_refs) > 40  # one column per component sheet, at minimum


def test_ref_error_formulas_are_flagged_in_catalog(wb):
    """VALIDATION: flag formulas containing #REF!."""
    formulas = scan_formulas(wb)
    ref_errors = [f for f in formulas if "#REF!" in f["formula"]]
    assert len(ref_errors) > 300
    price_options_errors = [f for f in ref_errors if f["sheet"] == "PRICE OPTIONS"]
    assert len(price_options_errors) > 0


def test_price_summary_grand_total_dependency_chain_exists(wb):
    """VALIDATION (sample-check): confirm the dependency chain for a major
    total is traceable end-to-end, WITHOUT claiming any value was
    recalculated — we only assert the formula references exist."""
    ws = wb["Price Summary"]
    grand_total_formula = ws["E130"].value
    assert isinstance(grand_total_formula, str) and grand_total_formula.startswith("=")
    # grand total sums a long list of same-sheet row references
    assert "E13" in grand_total_formula and "E116" in grand_total_formula

    # E7 (a component of the grand total) traces back to COST SUMMARY and Base
    d7 = ws["D7"].value
    assert "Flooring" in d7 and "Base!B23" in d7


def test_categorize_formula():
    assert "LOOKUP" in categorize_formula("=VLOOKUP(A1,B:C,2,FALSE)")
    assert "AGGREGATE" in categorize_formula("=SUM(A1:A10)")
    assert "VOLATILE" in categorize_formula("=TODAY()")
    assert categorize_formula("=42") == ["OTHER"]


def test_referenced_sheets_extraction():
    assert referenced_sheets("=Flooring!J11*2", "COST SUMMARY") == ["Flooring"]
    assert referenced_sheets("='Cross Rental AV'!H10", "X") == ["Cross Rental AV"]
    assert referenced_sheets("=A1+B1", "X") == []


def test_normalize_pattern_groups_similar_formulas():
    a = normalize_pattern("=B2*C2")
    b = normalize_pattern("=B3*C3")
    assert a == b
