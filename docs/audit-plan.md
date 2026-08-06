# ForgeOS — Phase 0 Audit Plan

## Objective

Produce a forensic, evidence-based inventory of `Reference/ORLANDO ESTIMATE.xlsm`
(~95 sheets, VBA-enabled) sufficient to design ForgeOS without redesigning or
"fixing" the workbook's business logic yet. No application code, no UI, no
rule redesign in this phase.

## Environment note

This filesystem (APFS, case-insensitive) treats `reference/` and `Reference/`
as the same directory, so the source workbook lives only in `Reference/` —
there is no separate immutable copy. Instead:

- `Reference/ORLANDO ESTIMATE.xlsm` is chmod'd `444` (read-only).
- A SHA-256 baseline is stored at `.workbook_hash_baseline.txt`.
- Every audit run re-hashes the file first and fails loudly on mismatch.
- All tooling opens the file in read-only mode and never calls `.save()`.

## Tooling approach

`tools/workbook_audit/` — pure Python, standard library + openpyxl only.

Two complementary readers, since neither alone is sufficient:

1. **openpyxl (`keep_vba=True`, read-only, `data_only=False`)** — sheet
   objects, cell formulas (as authored, not recalculated), merged cells,
   dimensions, visibility, defined names, data validations, basic
   protection flags.
2. **Raw ZIP/XML inspection** (`zipfile` + `xml.etree.ElementTree`) — for
   everything openpyxl omits or simplifies: `vbaProject.bin` presence/module
   list, external link targets (`xl/externalLinks/`), full sheet protection
   detail, print areas/`pageSetup`, tables (`xl/tables/`), conditional
   formatting, embedded images/shapes/drawings, sheet views (frozen panes,
   tab color), and workbook-level `calcPr` (iterative calc / volatile
   settings).

openpyxl **cannot evaluate formulas** — no calculation engine is used or
implied anywhere in these deliverables. Formula text is recorded verbatim.

## Deliverable sequence

1. `docs/audit-plan.md` — this file.
2. `tools/workbook_audit/` — reusable scanner producing raw structured data.
3. `artifacts/*.json` — machine-readable dump (inventory, formula catalog,
   named ranges, external links, VBA inventory).
4. `docs/workbook-inventory.md` — human-readable per-sheet summary, derived
   from the JSON, with probable purpose and classification.
5. `docs/workbook-dependency-map.md` — sheet-to-sheet formula reference
   graph, repeated template families, Mermaid diagrams.
6. `docs/business-rules.md` — material/labor/pricing calculation rules with
   confidence levels.
7. `docs/input-output-map.md` — cell/range classification.
8. `docs/workflow-map.md` — reconstructed lifecycle, workbook-evidenced vs.
   inferred.
9. `docs/data-model-v0.md` — proposed normalized entities.
10. `docs/migration-plan.md` — phased migration recommendation.
11. `docs/risk-register.md` — consolidated risk list.
12. `tests/workbook_audit/` — tests for the audit utility itself, plus
    validation checks (hash stability, sheet-count reconciliation, `#REF!`
    detection, structural-repeat detection).

## Sequencing rationale

Steps 2–3 are foundational (raw evidence extraction) and gate everything
else — the narrative docs (4–11) are written *from* the JSON artifacts, not
independently, so every claim in the Markdown is traceable to a scanned
fact. Business-rules and dependency-map require the formula catalog to
exist first. Data model and migration plan are written last since they
depend on understanding classification and workflow.

## Confidence levels used throughout

- **High** — directly observed in formula/XML/VBA source, unambiguous.
- **Medium** — pattern strongly suggests interpretation but naming or
  context is ambiguous.
- **Low** — inferred from structure alone (e.g., sheet name, layout) without
  corroborating formula/VBA evidence.

Every interpretive claim in the narrative docs will carry one of these
tags. Unresolved questions are collected rather than guessed at.

## Out of scope for Phase 0

- Any production/application code.
- UI design.
- Redesigning or normalizing business rules (only documenting them).
- Formula recalculation/evaluation.
- Modifying the source workbook.
