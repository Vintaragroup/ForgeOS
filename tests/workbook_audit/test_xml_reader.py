"""Raw ZIP/XML extraction correctness, and the brief's explicit VALIDATION
checks: sheet-count reconciliation, #REF!/external-reference flagging."""
import re


def test_sheet_count_matches_known_scale(xml_pkg):
    # Brief states "approximately 95 sheets" — pin the exact count so a
    # future workbook revision that adds/removes sheets is caught.
    sheets = xml_pkg.sheets()
    assert len(sheets) == 95


def test_sheet_count_reconciles_with_worksheet_xml_parts(xml_pkg, raw_zip):
    """VALIDATION: reconcile sheet counts between the <sheets> manifest in
    workbook.xml and the actual worksheets/*.xml parts present in the ZIP."""
    sheets = xml_pkg.sheets()
    worksheet_files = [n for n in raw_zip.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)]
    assert len(sheets) == len(worksheet_files)
    # every sheet's declared target must actually exist in the package
    for s in sheets:
        assert xml_pkg.exists(f"xl/{s.target}"), f"{s.name} declares missing target {s.target}"


def test_visibility_states_are_known_values(xml_pkg):
    sheets = xml_pkg.sheets()
    assert {s.state for s in sheets} <= {"visible", "hidden", "veryHidden"}
    hidden = [s for s in sheets if s.state == "hidden"]
    visible = [s for s in sheets if s.state == "visible"]
    assert len(hidden) == 27
    assert len(visible) == 68


def test_defined_names_flags_ref_errors(xml_pkg):
    """VALIDATION: flag formulas/names containing #REF!."""
    names = xml_pkg.defined_names()
    assert len(names) == 10
    ref_errors = [n for n in names if n.is_ref_error]
    assert {n.name for n in ref_errors} == {"BoothNumber", "Exhibitor", "ShowName"}
    for n in ref_errors:
        assert n.refers_to == "#REF!"


def test_external_links_detected_and_flagged(xml_pkg):
    """VALIDATION: flag formulas containing ... external references."""
    links = xml_pkg.external_links()
    assert len(links) == 1
    link = links[0]
    assert link.target_mode == "External"
    assert "MASTER" in link.target
    # the majority of cached sheets in the external link are stale/broken
    assert len(link.cached_sheets_with_errors) > len(link.cached_sheets_with_data)


def test_tables_parsed(xml_pkg):
    tables = xml_pkg.tables()
    names = {t.name for t in tables}
    assert names == {"Cities", "Cities13", "Table5", "Table7", "Payment", "Table9"}


def test_cities_table_calculated_column_references_sibling_table(xml_pkg):
    """Documents a known anomaly (business-rules.md Rule 11) rather than
    'fixing' it — regression guard in case the source file is ever edited."""
    tables = {t.name: t for t in xml_pkg.tables()}
    cities = tables["Cities"]
    formulas = dict(cities.columns)
    assert "Cities13" in (formulas.get("Number") or "")


def test_sheet_detail_reads_data_validations(xml_pkg):
    sheets = {s.name: s for s in xml_pkg.sheets()}
    detail = xml_pkg.sheet_detail(sheets["Start Page"].target)
    assert len(detail["data_validations"]) >= 2
    assert any(dv["type"] == "list" for dv in detail["data_validations"])
