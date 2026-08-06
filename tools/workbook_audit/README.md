# tools/workbook_audit

Read-only forensic analysis tooling for `Reference/ORLANDO ESTIMATE.xlsm`.
See `docs/audit-plan.md` for methodology and rationale.

## Setup

```
pip install -r tools/workbook_audit/requirements.txt
```

## Run the full audit

```
python3 -m tools.workbook_audit.scan
python3 -m tools.workbook_audit.render_inventory   # regenerate docs/workbook-inventory.md's table
```

Writes `artifacts/workbook_inventory.json`, `artifacts/formula_catalog.json`,
`artifacts/named_ranges.json`, `artifacts/external_links.json`,
`artifacts/vba_inventory.json`, and decompiled VBA source for any module
with real code under `artifacts/vba_modules/`.

The source workbook's SHA-256 is verified against `.workbook_hash_baseline.txt`
before and after every run; the scan aborts if it doesn't match.

## Run the tests

```
python3 -m pytest tests/workbook_audit/ -v
```

## Module layout

- `hashcheck.py` — integrity verification (never let the audit touch the source file).
- `xml_reader.py` — raw ZIP/XML parsing for what openpyxl omits or drops (external links, table calculated-column formulas, x14 data-validation extensions, raw protection/print/autofilter detail).
- `openpyxl_reader.py` — cell/formula walk via openpyxl (`keep_vba=True`, `data_only=False` — formulas are never evaluated, only read as authored).
- `vba_reader.py` — VBA project extraction: `olefile` (the one added dependency, see `requirements.txt`) opens the OLE container in `xl/vbaProject.bin`; MS-OVBA "Compressed Container" decompression is implemented directly here (stdlib only) rather than pulling in `oletools`.
- `scan.py` — orchestrator / single documented entrypoint.
- `render_inventory.py` — renders `artifacts/workbook_inventory.json` into the table in `docs/workbook-inventory.md`.
