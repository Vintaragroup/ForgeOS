"""Phase 1 staging schema — a first-cut, intentionally narrow slice of
docs/data-model-v0.md, scoped to exactly what the Phase 1 import +
comparison harness needs. Not a production schema: no tenant_id, no
versioning, no audit trail (those are Phase 2+ concerns per
docs/migration-plan.md). This exists purely to prove the workbook's
numbers can be captured faithfully and cross-checked against a real
recalculation.

Reflects the confirmed two-band structure of COST SUMMARY (see
docs/business-rules.md Rule 5): every job has estimate_sections of type
'category' (Flooring, Structure, ...) or 'component' (COMPONENT 1-49),
each structurally identical (materials / labor / overhead / total),
never double-counted against each other.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DDL = """
CREATE TABLE job (
    id INTEGER PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    recalculated_file TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    job_name TEXT,
    is_synthetic INTEGER NOT NULL DEFAULT 0
);

-- One row per COST SUMMARY row: either a category sheet (Flooring, ...)
-- or a COMPONENT sheet. section_type distinguishes the two confirmed
-- bands from business-rules.md Rule 5; they are never summed together
-- into each other, only both into the job total.
CREATE TABLE estimate_section (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    section_type TEXT NOT NULL CHECK (section_type IN ('category', 'component')),
    sheet_name TEXT NOT NULL,           -- e.g. 'Flooring' or 'COMPONENT 10'
    cost_summary_row INTEGER NOT NULL,  -- the row in COST SUMMARY this section occupies
    quantity REAL,
    total_direct_material REAL,         -- COST SUMMARY!E<row>
    total_labor_cost REAL,              -- COST SUMMARY!Z<row>
    total_overhead REAL,                -- COST SUMMARY!AB<row> -- expect 0 everywhere, see risk-register R19
    total_cost REAL                     -- COST SUMMARY!AD<row> = E+Z+AB
);

-- Raw material/labor lines, imported verbatim from a component or
-- category sheet's own material/labor block -- never recomputed here.
CREATE TABLE line_item (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES estimate_section(id),
    line_type TEXT NOT NULL CHECK (line_type IN ('material', 'labor')),
    row_number INTEGER,
    description TEXT,        -- material name, or department name/code
    qty REAL,                -- material qty, or labor hours
    unit_cost REAL,           -- material unit cost, or department rate
    total_cost REAL           -- as read from the sheet's own total column -- not qty*unit_cost recomputed
);

-- One row per (stage, cell) comparison the diff harness performed:
-- imported_value is what our importer staged from the source workbook's
-- OWN cached/typed values; recalculated_value is what LibreOffice
-- computed fresh. See diff_harness.py.
CREATE TABLE rollup_check (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    stage TEXT NOT NULL,      -- 'component' | 'category' | 'cost_summary' | 'price_summary' | 'estimate'
    sheet TEXT NOT NULL,
    cell TEXT NOT NULL,
    label TEXT,
    imported_value REAL,
    recalculated_value REAL,
    abs_diff REAL,
    within_tolerance INTEGER  -- 1 / 0
);
"""


def create_db(path: Path) -> sqlite3.Connection:
    path = Path(path)
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.executescript(DDL)
    conn.commit()
    return conn
