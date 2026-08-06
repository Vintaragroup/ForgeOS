import sqlite3

import pytest

from tools.workbook_import import schema


def test_create_db_has_expected_tables(tmp_path):
    conn = schema.create_db(tmp_path / "staging.db")
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = {row[0] for row in cur.fetchall()}
    assert {"job", "estimate_section", "line_item", "rollup_check"} <= tables
    conn.close()


def test_create_db_is_idempotent(tmp_path):
    path = tmp_path / "staging.db"
    schema.create_db(path).close()
    conn = schema.create_db(path)  # should not error on re-create
    conn.execute("SELECT 1")
    conn.close()


def test_estimate_section_type_constraint(tmp_path):
    conn = schema.create_db(tmp_path / "staging.db")
    conn.execute(
        "INSERT INTO job (source_file, source_hash, recalculated_file, imported_at) VALUES (?,?,?,?)",
        ("x", "hash", "y", "now"),
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO estimate_section (job_id, section_type, sheet_name, cost_summary_row) "
            "VALUES (1, 'bogus_type', 'Flooring', 8)"
        )
    conn.close()
