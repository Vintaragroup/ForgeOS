"""End-to-end Phase 1 pipeline test: recalculate -> import -> diff, on the
synthetic fixture. This is the automated version of the manual PRICE
OPTIONS repair probe documented in docs/business-rules.md Rule 7, and the
regression guard for the pipeline docs/migration-plan.md Phase 1
describes."""
from tools.workbook_import import diff_harness, importer, schema


def test_full_pipeline_all_checks_pass(tmp_path, synthetic_job_recalculated):
    job_path, recalculated_path = synthetic_job_recalculated
    conn = schema.create_db(tmp_path / "staging.db")

    job_id, sections = importer.import_job(
        conn, job_path, recalculated_path,
        component_sheets=["COMPONENT 10"],
        category_sheets=["Flooring"],
        job_name="pytest synthetic job",
        is_synthetic=True,
    )
    assert len(sections) == 2

    results = diff_harness.run(conn, job_id, sections)
    assert len(results) == 8  # 4 checks x 2 sections
    failed = [r for r in results if not r.within_tolerance]
    assert not failed, f"unexpected mismatches: {failed}"
    conn.close()


def test_overhead_is_confirmed_zero_everywhere(tmp_path, synthetic_job_recalculated):
    """Regression guard for risk-register.md R19."""
    job_path, recalculated_path = synthetic_job_recalculated
    conn = schema.create_db(tmp_path / "staging.db")
    job_id, sections = importer.import_job(
        conn, job_path, recalculated_path,
        component_sheets=["COMPONENT 10"], category_sheets=["Flooring"],
        job_name="pytest synthetic job", is_synthetic=True,
    )
    for sec in sections:
        assert (sec["source_total_overhead"] or 0.0) == 0.0
    conn.close()


def test_component_and_category_sections_never_share_a_cost_summary_row(tmp_path, synthetic_job_recalculated):
    """Regression guard for risk-register.md R18 (resolved: the two bands
    are distinct, never duplicated)."""
    job_path, recalculated_path = synthetic_job_recalculated
    conn = schema.create_db(tmp_path / "staging.db")
    job_id, sections = importer.import_job(
        conn, job_path, recalculated_path,
        component_sheets=["COMPONENT 10"], category_sheets=["Flooring"],
        job_name="pytest synthetic job", is_synthetic=True,
    )
    rows_by_type = {s["section_type"]: s["cost_summary_row"] for s in sections}
    assert rows_by_type["component"] != rows_by_type["category"]
    conn.close()
