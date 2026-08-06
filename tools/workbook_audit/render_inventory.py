"""Render docs/workbook-inventory.md from artifacts/workbook_inventory.json.

Usage:
    python3 -m tools.workbook_audit.render_inventory

Regenerates only the auto-generated table section of the doc (between the
AUTO-GENERATED markers); hand-written narrative above/below is preserved
verbatim. Run this after re-running scan.py if the workbook changes.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INVENTORY_JSON = REPO_ROOT / "artifacts" / "workbook_inventory.json"
DOC_PATH = REPO_ROOT / "docs" / "workbook-inventory.md"

START_MARKER = "<!-- AUTO-GENERATED TABLE START — regenerate with: python3 -m tools.workbook_audit.render_inventory -->"
END_MARKER = "<!-- AUTO-GENERATED TABLE END -->"


def esc(v) -> str:
    if v is None:
        return ""
    return str(v).replace("|", "\\|").replace("\n", " ")


def render_table(inventory: list[dict]) -> str:
    lines = [
        "| # | Sheet | Visibility | Used Range | Formulas | Merges | Tables | Validations | Protected | Print Area | Classification | Probable Purpose |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for s in inventory:
        lines.append(
            "| {order} | {name} | {vis} | {rng} | {fc} | {mc} | {tbl} | {dv} | {prot} | {pa} | {cls} | {purpose} |".format(
                order=s["order"] + 1,
                name=esc(s["name"]),
                vis=s["visibility"],
                rng=esc(s["used_range"]),
                fc=s["formula_count"],
                mc=s["merged_cell_count"],
                tbl=esc(", ".join(s["tables"])) or "—",
                dv=len(s["data_validations"]),
                prot="Y" if s["protection"]["sheet_protected"] else "",
                pa="Y" if s["print_area"] else "",
                cls=s["classification"],
                purpose=esc(s["probable_purpose"]),
            )
        )
    return "\n".join(lines)


def main():
    inventory = json.loads(INVENTORY_JSON.read_text())
    table = render_table(inventory)

    doc = DOC_PATH.read_text()
    start = doc.index(START_MARKER) + len(START_MARKER)
    end = doc.index(END_MARKER)
    new_doc = doc[:start] + "\n\n" + table + "\n\n" + doc[end:]
    DOC_PATH.write_text(new_doc)
    print(f"Rendered {len(inventory)} sheets into {DOC_PATH}")


if __name__ == "__main__":
    main()
