"""Single documented entrypoint for the ForgeOS workbook audit.

Usage:
    python3 -m tools.workbook_audit.scan

Reads Reference/ORLANDO ESTIMATE.xlsm read-only (verifying its SHA-256
against .workbook_hash_baseline.txt before and after), and writes:

    artifacts/workbook_inventory.json
    artifacts/formula_catalog.json
    artifacts/named_ranges.json
    artifacts/external_links.json
    artifacts/vba_inventory.json
    artifacts/vba_modules/<ModuleName>.bas   (decompiled VBA source, for
                                               citation from docs/business-rules.md)

No cell values are recalculated; formula text is recorded exactly as
authored. See docs/audit-plan.md for methodology and docs/*.md for the
narrative deliverables built from this JSON.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from tools.workbook_audit.hashcheck import WORKBOOK_PATH, verify_unchanged, WorkbookIntegrityError
from tools.workbook_audit.xml_reader import WorkbookXmlPackage
from tools.workbook_audit.openpyxl_reader import load_workbook, scan_sheets, scan_formulas
from tools.workbook_audit.vba_reader import extract_vba

ARTIFACTS_DIR = REPO_ROOT / "artifacts"
VBA_MODULES_DIR = ARTIFACTS_DIR / "vba_modules"

SHEET_TYPE_HEURISTICS = [
    (re.compile(r"^COMPONENT \d+$"), "template", "COMPONENT template"),
    (re.compile(r"^OPTION \(\d+\)$"), "template", "OPTION template"),
    (re.compile(r"^Cross Rental"), "reference", "Cross-rental reference sheet"),
]


def classify_sheet(name: str, formula_count: int, state: str, table_names: list[str]) -> tuple[str, str]:
    """Return (classification, probable_purpose) — Low/Medium confidence
    heuristic based on sheet name + structure; refined manually in
    docs/workbook-inventory.md."""
    for pattern, cls, purpose in SHEET_TYPE_HEURISTICS:
        if pattern.match(name):
            return cls, purpose
    n = name.strip().upper()
    if n in ("DATA", "BASE"):
        return "reference", "Hidden lookup/reference data feeding dropdowns and rates"
    if "SUMMARY" in n or n == "COST SUMMARY":
        return "calculation", "Rollup/aggregation of upstream sheets"
    if n in ("ESTIMATE", "PROPOSAL", "CHANGE ORDER", "WORK ORDER", "INVOICE", "INVOICE REQUEST", "PRICE OPTIONS", "PRICE SUMMARY"):
        return "output", "Client- or ops-facing document output"
    if n == "START PAGE":
        return "input", "Primary job-setup user input form"
    if n in ("LABOR RATES", "RATES"):
        return "reference", "Rate table"
    if table_names:
        return "reference", "Contains structured table(s), likely lookup data"
    if formula_count == 0 and state == "visible":
        return "input", "No formulas; likely a manual-entry sheet"
    if formula_count > 0:
        return "calculation", "Formula-driven working sheet"
    return "workflow", "Purpose not yet determined from structure alone"


def build_workbook_inventory(xml_pkg: WorkbookXmlPackage, oxl_sheets, wb) -> list[dict]:
    xml_sheets_by_name = {s.name: s for s in xml_pkg.sheets()}
    inventory = []
    for oxl in oxl_sheets:
        xml_meta = xml_sheets_by_name.get(oxl.name)
        detail = xml_pkg.sheet_detail(xml_meta.target) if xml_meta else {}
        classification, purpose = classify_sheet(oxl.name, oxl.formula_count, oxl.sheet_state, oxl.table_names)
        inventory.append(
            {
                "order": oxl.index,
                "name": oxl.name,
                "sheet_id_xml": xml_meta.sheet_id if xml_meta else None,
                "visibility": oxl.sheet_state,
                "used_range": oxl.dimensions,
                "used_range_raw_dimension_tag": detail.get("dimension_raw"),
                "max_row": oxl.max_row,
                "max_col": oxl.max_col,
                "formula_count": oxl.formula_count,
                "merged_cell_count": len(oxl.merged_ranges),
                "merged_cells": oxl.merged_ranges,
                "tables": oxl.table_names,
                "table_calculated_columns": [
                    {"table": t.name, "column": c[0], "formula": c[1]}
                    for t in xml_pkg.tables()
                    if t.name in oxl.table_names
                    for c in t.columns
                    if c[1]
                ],
                "data_validations": detail.get("data_validations", []),
                "autofilter_ref": oxl.autofilter_ref or detail.get("autofilter_ref"),
                "conditional_formatting_count": oxl.conditional_formatting_count,
                "conditional_formatting_ranges": detail.get("conditional_formatting_ranges", []),
                "print_area": oxl.print_area,
                "print_page_setup": detail.get("page_setup"),
                "print_options": detail.get("print_options"),
                "fit_to_page": detail.get("fit_to_page"),
                "protection": {
                    "sheet_protected": oxl.protection_enabled,
                    "password_hash_present": oxl.protection_password_hash_present,
                    "raw_attributes": detail.get("protection"),
                },
                "frozen_panes": oxl.freeze_panes,
                "tab_color": detail.get("tab_color"),
                "comment_count": oxl.comment_count,
                "hyperlink_count": oxl.hyperlink_count,
                "has_drawing_or_image": detail.get("has_drawing", False) or oxl.image_or_shape_present,
                "classification": classification,
                "classification_confidence": "Low",
                "probable_purpose": purpose,
            }
        )
    return inventory


def build_repeated_pattern_families(formula_catalog: list[dict]) -> dict:
    by_pattern = defaultdict(set)
    for f in formula_catalog:
        by_pattern[f["pattern_id"]].add(f["sheet"])
    repeated = {
        pid: sorted(sheets)
        for pid, sheets in by_pattern.items()
        if len(sheets) > 1 or sum(1 for f in formula_catalog if f["pattern_id"] == pid) > 3
    }
    return repeated


def main():
    print(f"Verifying workbook hash before analysis...")
    verify_unchanged()
    print("  OK.")

    ARTIFACTS_DIR.mkdir(exist_ok=True)
    VBA_MODULES_DIR.mkdir(exist_ok=True)

    print("Loading via openpyxl (keep_vba=True, data_only=False)...")
    wb = load_workbook(WORKBOOK_PATH)
    oxl_sheets = scan_sheets(wb)
    formula_catalog = scan_formulas(wb)

    print("Parsing raw ZIP/XML package...")
    xml_pkg = WorkbookXmlPackage(WORKBOOK_PATH)

    print("Building workbook_inventory.json...")
    inventory = build_workbook_inventory(xml_pkg, oxl_sheets, wb)
    (ARTIFACTS_DIR / "workbook_inventory.json").write_text(json.dumps(inventory, indent=2, default=str))

    print("Writing formula_catalog.json...")
    (ARTIFACTS_DIR / "formula_catalog.json").write_text(json.dumps(formula_catalog, indent=2, default=str))

    print("Writing named_ranges.json...")
    named_ranges = [asdict(dn) for dn in xml_pkg.defined_names()]
    (ARTIFACTS_DIR / "named_ranges.json").write_text(json.dumps(named_ranges, indent=2, default=str))

    print("Writing external_links.json...")
    ext_links = [asdict(e) for e in xml_pkg.external_links()]
    (ARTIFACTS_DIR / "external_links.json").write_text(json.dumps(ext_links, indent=2, default=str))

    print("Extracting VBA project (olefile + custom MS-OVBA decompression)...")
    z = zipfile.ZipFile(WORKBOOK_PATH)
    # map worksheet name -> VBA codeName, per xl/worksheets/sheetN.xml <sheetPr codeName=...>
    xml_sheets = xml_pkg.sheets()
    codename_to_sheetname = {}
    for s in xml_sheets:
        raw = xml_pkg.read_text(f"xl/{s.target}")
        m = re.search(r'<sheetPr[^>]*codeName="([^"]+)"', raw)
        codename = m.group(1) if m else f"Sheet{s.target.rsplit('sheet',1)[-1].split('.')[0]}"
        codename_to_sheetname[codename] = s.name

    vba_modules = extract_vba(z.read)
    vba_inventory = []
    for m in vba_modules:
        worksheet_name = codename_to_sheetname.get(m.name, "ThisWorkbook" if m.name == "ThisWorkbook" else None)
        has_code = m.line_count > 9  # first 9 lines are always Attribute boilerplate
        vba_inventory.append(
            {
                "module_name": m.name,
                "worksheet_name": worksheet_name,
                "module_type": m.module_type,
                "line_count": m.line_count,
                "has_executable_code": has_code,
                "auto_triggers_present": m.referenced_names,
            }
        )
        if has_code:
            (VBA_MODULES_DIR / f"{m.name}.bas").write_text(m.source)
    (ARTIFACTS_DIR / "vba_inventory.json").write_text(json.dumps(vba_inventory, indent=2))

    print("\n--- Summary ---")
    print(f"Sheets scanned: {len(inventory)}")
    print(f"Formulas cataloged: {len(formula_catalog)}")
    print(f"Named ranges (incl. print areas): {len(named_ranges)}")
    print(f"  of which #REF! errors: {sum(1 for n in named_ranges if n['is_ref_error'])}")
    print(f"External link workbooks: {len(ext_links)}")
    print(f"VBA modules: {len(vba_inventory)} (with executable code: {sum(1 for v in vba_inventory if v['has_executable_code'])})")

    print("\nVerifying workbook hash after analysis...")
    verify_unchanged()
    print("  OK — source workbook unchanged.")


if __name__ == "__main__":
    try:
        main()
    except WorkbookIntegrityError as e:
        print(f"ABORTED: {e}", file=sys.stderr)
        sys.exit(1)
