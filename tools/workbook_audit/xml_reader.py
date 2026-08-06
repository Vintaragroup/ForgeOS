"""Raw ZIP/XML extraction for everything openpyxl omits or simplifies.

openpyxl gives a convenient object model but silently drops or normalizes
several things we need for a forensic audit: full external-link cache data,
workbook-level defined names that resolve to #REF!, calcPr (iterative /
volatile calc settings), table calculated-column formulas, threaded
comments, and raw sheet protection/print details in edge cases. This module
reads the package directly with zipfile + ElementTree.
"""
from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree as ET

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main",
    "xm": "http://schemas.microsoft.com/office/excel/2006/main",
}


def _q(tag: str) -> str:
    return f"{{{NS['m']}}}{tag}"


@dataclass
class SheetMeta:
    name: str
    sheet_id: str
    rel_id: str
    state: str  # visible | hidden | veryHidden
    target: Optional[str] = None  # worksheets/sheetN.xml


@dataclass
class DefinedName:
    name: str
    refers_to: str
    local_sheet_id: Optional[str] = None
    hidden: bool = False
    is_ref_error: bool = False


@dataclass
class ExternalLink:
    rel_id: str
    target: str
    target_mode: str
    sheet_names: list = field(default_factory=list)
    cached_sheets_with_errors: list = field(default_factory=list)
    cached_sheets_with_data: list = field(default_factory=list)


@dataclass
class TableDef:
    file: str
    id: str
    name: str
    display_name: str
    ref: str
    header_row_count: int
    totals_row_shown: bool
    columns: list = field(default_factory=list)  # (name, calculated_column_formula|None)


class WorkbookXmlPackage:
    """Thin read-only wrapper around the xlsm ZIP package."""

    def __init__(self, path: Path):
        self.path = path
        self._zip = zipfile.ZipFile(path, mode="r")

    def read(self, member: str) -> bytes:
        return self._zip.read(member)

    def read_text(self, member: str) -> str:
        return self.read(member).decode("utf-8")

    def exists(self, member: str) -> bool:
        return member in self._zip.namelist()

    def namelist(self):
        return self._zip.namelist()

    def close(self):
        self._zip.close()

    # ---- workbook.xml -----------------------------------------------

    def workbook_root(self) -> ET.Element:
        return ET.fromstring(self.read("xl/workbook.xml"))

    def sheets(self) -> list[SheetMeta]:
        root = self.workbook_root()
        out = []
        for el in root.find(_q("sheets")):
            out.append(
                SheetMeta(
                    name=el.get("name"),
                    sheet_id=el.get("sheetId"),
                    rel_id=el.get(f"{{{NS['r']}}}id"),
                    state=el.get("state", "visible"),
                )
            )
        rels = self.workbook_rels()
        for s in out:
            s.target = rels.get(s.rel_id)
        return out

    def workbook_rels(self) -> dict[str, str]:
        if not self.exists("xl/_rels/workbook.xml.rels"):
            return {}
        root = ET.fromstring(self.read("xl/_rels/workbook.xml.rels"))
        return {el.get("Id"): el.get("Target") for el in root}

    def defined_names(self) -> list[DefinedName]:
        root = self.workbook_root()
        el = root.find(_q("definedNames"))
        out = []
        if el is None:
            return out
        for dn in el.findall(_q("definedName")):
            refers_to = (dn.text or "").strip()
            out.append(
                DefinedName(
                    name=dn.get("name"),
                    refers_to=refers_to,
                    local_sheet_id=dn.get("localSheetId"),
                    hidden=dn.get("hidden") == "1",
                    is_ref_error="#REF!" in refers_to,
                )
            )
        return out

    def calc_pr(self) -> dict:
        root = self.workbook_root()
        el = root.find(_q("calcPr"))
        return dict(el.attrib) if el is not None else {}

    def has_vba_project(self) -> bool:
        return self.exists("xl/vbaProject.bin")

    # ---- external links -----------------------------------------------

    def external_links(self) -> list[ExternalLink]:
        out = []
        i = 1
        while self.exists(f"xl/externalLinks/externalLink{i}.xml"):
            root = ET.fromstring(self.read(f"xl/externalLinks/externalLink{i}.xml"))
            book = root.find(_q("externalBook"))
            rel_id = book.get(f"{{{NS['r']}}}id") if book is not None else None
            sheet_names_el = book.find(_q("sheetNames")) if book is not None else None
            sheet_names = (
                [sn.get("val") for sn in sheet_names_el.findall(_q("sheetName"))]
                if sheet_names_el is not None
                else []
            )
            target, target_mode = None, None
            rels_member = f"xl/externalLinks/_rels/externalLink{i}.xml.rels"
            if self.exists(rels_member):
                rroot = ET.fromstring(self.read(rels_member))
                rel = rroot.find(f"{{{NS['pr']}}}Relationship")
                if rel is not None:
                    target = rel.get("Target")
                    target_mode = rel.get("TargetMode", "Internal")
            sheet_data_set = book.find(_q("sheetDataSet")) if book is not None else None
            errs, has_data = [], []
            if sheet_data_set is not None:
                for sd in sheet_data_set.findall(_q("sheetData")):
                    sid = int(sd.get("sheetId"))
                    name = sheet_names[sid] if sid < len(sheet_names) else f"sheetId={sid}"
                    if sd.get("refreshError") == "1":
                        errs.append(name)
                    elif len(sd) > 0:
                        has_data.append(name)
            out.append(
                ExternalLink(
                    rel_id=rel_id,
                    target=target,
                    target_mode=target_mode,
                    sheet_names=sheet_names,
                    cached_sheets_with_errors=errs,
                    cached_sheets_with_data=has_data,
                )
            )
            i += 1
        return out

    # ---- tables -----------------------------------------------

    def tables(self) -> list[TableDef]:
        out = []
        i = 1
        while self.exists(f"xl/tables/table{i}.xml"):
            member = f"xl/tables/table{i}.xml"
            root = ET.fromstring(self.read(member))
            cols = []
            tc_el = root.find(_q("tableColumns"))
            if tc_el is not None:
                for c in tc_el.findall(_q("tableColumn")):
                    formula_el = c.find(_q("calculatedColumnFormula"))
                    cols.append((c.get("name"), formula_el.text if formula_el is not None else None))
            out.append(
                TableDef(
                    file=member,
                    id=root.get("id"),
                    name=root.get("name"),
                    display_name=root.get("displayName"),
                    ref=root.get("ref"),
                    header_row_count=int(root.get("headerRowCount", "1")),
                    totals_row_shown=root.get("totalsRowShown") == "1",
                    columns=cols,
                )
            )
            i += 1
        return out

    # ---- per-sheet raw XML (protection / print / autofilter / validations) --

    def sheet_xml_root(self, target: str) -> ET.Element:
        return ET.fromstring(self.read(f"xl/{target}"))

    def sheet_rels(self, sheet_file_index: int) -> dict[str, str]:
        member = f"xl/worksheets/_rels/sheet{sheet_file_index}.xml.rels"
        if not self.exists(member):
            return {}
        root = ET.fromstring(self.read(member))
        return {el.get("Id"): el.get("Type", "").rsplit("/", 1)[-1] for el in root}

    def sheet_detail(self, target: str) -> dict:
        """Protection, print settings, autofilter, tab color, panes read
        directly from the sheetN.xml, independent of openpyxl."""
        root = self.sheet_xml_root(target)
        detail = {}

        prot = root.find(_q("sheetProtection"))
        detail["protection"] = dict(prot.attrib) if prot is not None else None

        af = root.find(_q("autoFilter"))
        detail["autofilter_ref"] = af.get("ref") if af is not None else None

        pane_el = root.find(f"{_q('sheetViews')}/{_q('sheetView')}/{_q('pane')}")
        detail["frozen_panes"] = dict(pane_el.attrib) if pane_el is not None else None

        sheet_view_el = root.find(f"{_q('sheetViews')}/{_q('sheetView')}")
        detail["sheet_view"] = dict(sheet_view_el.attrib) if sheet_view_el is not None else None

        sheet_pr = root.find(_q("sheetPr"))
        tab_color_el = sheet_pr.find(_q("tabColor")) if sheet_pr is not None else None
        detail["tab_color"] = dict(tab_color_el.attrib) if tab_color_el is not None else None
        page_setup_props = sheet_pr.find(_q("pageSetUpPr")) if sheet_pr is not None else None
        detail["fit_to_page"] = (
            page_setup_props.get("fitToPage") == "1" if page_setup_props is not None else False
        )

        page_setup = root.find(_q("pageSetup"))
        detail["page_setup"] = dict(page_setup.attrib) if page_setup is not None else None

        print_options = root.find(_q("printOptions"))
        detail["print_options"] = dict(print_options.attrib) if print_options is not None else None

        dv_el = root.find(_q("dataValidations"))
        validations = []
        if dv_el is not None:
            for dv in dv_el.findall(_q("dataValidation")):
                f1 = dv.find(_q("formula1"))
                f2 = dv.find(_q("formula2"))
                validations.append(
                    {
                        "type": dv.get("type"),
                        "operator": dv.get("operator"),
                        "sqref": dv.get("sqref"),
                        "allowBlank": dv.get("allowBlank"),
                        "showErrorMessage": dv.get("showErrorMessage"),
                        "formula1": f1.text if f1 is not None else None,
                        "formula2": f2.text if f2 is not None else None,
                    }
                )
        # x14 extension data validations (extLst) — openpyxl explicitly warns
        # it drops these ("Data Validation extension is not supported").
        # Common for list validations added via newer Excel UI.
        ext_lst = root.find(_q("extLst"))
        if ext_lst is not None:
            for ext in ext_lst.findall(_q("ext")):
                x14_dvs = ext.find(f"{{{NS['x14']}}}dataValidations")
                if x14_dvs is None:
                    continue
                for dv in x14_dvs.findall(f"{{{NS['x14']}}}dataValidation"):
                    f1 = dv.find(f"{{{NS['x14']}}}formula1/{{{NS['xm']}}}f")
                    sqref = dv.find(f"{{{NS['xm']}}}sqref")
                    validations.append(
                        {
                            "type": dv.get("type"),
                            "operator": dv.get("operator"),
                            "sqref": sqref.text if sqref is not None else None,
                            "allowBlank": dv.get("allowBlank"),
                            "showErrorMessage": dv.get("showErrorMessage"),
                            "formula1": f1.text if f1 is not None else None,
                            "formula2": None,
                            "source": "x14_extension",
                        }
                    )
        detail["data_validations"] = validations

        merge_el = root.find(_q("mergeCells"))
        detail["merge_count_raw"] = int(merge_el.get("count", "0")) if merge_el is not None else 0

        cond_fmts = root.findall(_q("conditionalFormatting"))
        detail["conditional_formatting_count"] = len(cond_fmts)
        detail["conditional_formatting_ranges"] = [cf.get("sqref") for cf in cond_fmts]

        legacy_drawing = root.find(_q("legacyDrawing"))
        detail["has_legacy_drawing"] = legacy_drawing is not None

        drawing = root.find(_q("drawing"))
        detail["has_drawing"] = drawing is not None

        dim = root.find(_q("dimension"))
        detail["dimension_raw"] = dim.get("ref") if dim is not None else None

        return detail
