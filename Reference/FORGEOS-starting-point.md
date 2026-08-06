We are beginning development of ForgeOS, an operating platform for experiential production, exhibits, events, and fabrication.

SOURCE WORKBOOK
/mnt/data/ORLANDO ESTIMATE.xlsm

PRODUCT GOAL
Convert the workbook’s business logic into a modern application supporting:

1. Lightweight CRM: companies, contacts, opportunities, activities, tasks, files, and notes.
2. Estimate creation: components, materials, labor, rentals, show services, logistics, markups, taxes, options, and contingencies.
3. Polished proposal generation with reusable branded templates.
4. Estimate revisions, alternates, approvals, and change orders.
5. Project conversion and lightweight project tracking.
6. Work orders, purchasing, production, packing, trucking, installation, and closeout.
7. Estimated-versus-actual cost and margin reporting.
8. Historical project data that can later support AI-assisted estimating and risk detection.

IMPORTANT
The workbook is the current source of truth, but it is not automatically a perfect specification. Preserve its terminology and document anomalies instead of silently “fixing” them.

This is an audit and architecture phase only. Do not build the production application yet.

WORKBOOK SAFETY

* Treat the original .xlsm as immutable.
* Never overwrite or resave it.
* Copy it into reference/ before analysis.
* It contains VBA/macros and Excel features that may not be fully supported by Python libraries.
* Use openpyxl with keep_vba=True for inspection only.
* Also inspect the unzipped XLSM/XML package directly when needed.
* Do not assume openpyxl can evaluate formulas.
* Record formulas exactly as written.
* Identify external links, named ranges, hidden sheets, validations, tables, formulas, macros, controls, images, shapes, print areas, and protection settings.
* Clearly distinguish formula logic, presentation logic, user inputs, static reference data, and macro behavior.

KNOWN SCALE
The workbook has approximately 95 sheets. Major areas include:

* Start Page
* DATA / Base
* ESTIMATE
* PROPOSAL
* CHANGE ORDER
* Price Summary
* PRICE OPTIONS
* COMPONENT and OPTION templates
* MATERIALS B-DOWN / MATERIALS SUMMARY
* LABOR RATES
* COST SUMMARY
* WORK ORDER
* INVOICE / INVOICE REQUEST
* production notes, show services, packing, skids, crating, trucking, and load lists

FIRST TASK
Create a repeatable, read-only workbook-analysis utility and generate these deliverables:

docs/workbook-inventory.md

* Every worksheet in workbook order
* Visibility state
* Used range
* Formula count
* Merged cells
* tables, validations, filters, print settings, and protections
* probable business purpose
* classification: input, reference, calculation, output, template, or workflow

docs/workbook-dependency-map.md

* Sheet-to-sheet formula dependencies
* Named ranges
* external workbook links
* repeated template families
* major calculation flows
* Mermaid diagrams where useful

docs/business-rules.md
For every material calculation:

* rule name
* workbook location
* exact formula or VBA source
* business interpretation
* upstream inputs
* downstream outputs
* edge cases
* confidence level
* unresolved questions

docs/input-output-map.md
Classify important cells/ranges as:

* user input
* lookup/reference data
* calculated value
* internal control
* document output
* suspected obsolete field

docs/workflow-map.md
Reconstruct the likely lifecycle:
lead → opportunity → estimate → proposal → revision/options → approval → change order → project/work order → production/logistics → invoice → closeout.

Separate what is directly supported by the workbook from inferred workflow.

docs/data-model-v0.md
Propose normalized entities and relationships, including:
Company, Contact, Opportunity, Project, Estimate, EstimateVersion, EstimateSection, LineItem, Component, Material, LaborRate, RentalItem, Vendor, Proposal, ProposalTemplate, Option, ChangeOrder, WorkOrder, Task, Shipment, Invoice, CostActual, Attachment, User, and AuditEvent.

For each entity include:

* purpose
* key fields
* relationships
* workbook source
* tenant ownership
* versioning requirements
* audit requirements

docs/migration-plan.md
Recommend an incremental migration that keeps Excel available during validation:

* Phase 0: forensic workbook audit
* Phase 1: read-only workbook importer and comparison harness
* Phase 2: CRM and opportunity shell
* Phase 3: native estimate engine
* Phase 4: proposal and approval workflow
* Phase 5: project, production, and logistics tracking
* Phase 6: actual-cost reporting and AI assistance

docs/risk-register.md
Include risks involving:

* VBA behavior
* unsupported Excel features
* hidden assumptions
* circular or volatile formulas
* duplicated logic
* hardcoded rates
* formula inconsistencies
* external links
* workbook protection
* rounding
* taxes and markups
* version control
* estimate reproducibility
* tenant data isolation
* document fidelity

artifacts/workbook_inventory.json
Machine-readable workbook structure.

artifacts/formula_catalog.json
For each formula:

* sheet
* cell
* formula
* referenced sheets/ranges where determinable
* formula category
* repeated-pattern identifier

artifacts/named_ranges.json
artifacts/external_links.json
artifacts/vba_inventory.json

ANALYSIS TOOLING
Create scripts under tools/workbook_audit/ with a single documented command to rerun the audit. Prefer Python standard libraries plus openpyxl. Parse the XLSM as a ZIP/XML package where openpyxl omits information.

Do not install large dependencies unless necessary. Document any dependency added.

VALIDATION

* Confirm the original workbook hash before and after analysis is identical.
* Reconcile sheet counts between openpyxl and workbook XML.
* Flag formulas containing #REF! or external references.
* Detect sheets that are structurally repeated.
* Sample-check major totals and their dependency chains.
* Do not claim formula results were recalculated unless an actual Excel-compatible calculation engine was used.
* Create tests for the audit utility.

WORKING STYLE

* Be evidence-driven and concise.
* Do not guess silently.
* Assign confidence levels.
* Preserve exact workbook terminology.
* Prefer structured artifacts over long narrative.
* Do not begin UI implementation.
* Do not redesign the business rules yet.
* Stop after producing the audit, architecture recommendations, test results, and a prioritized list of unresolved questions.

Start by inspecting the repository and source file, then create a short execution plan in docs/audit-plan.md and proceed without waiting for confirmation.