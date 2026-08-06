# ForgeOS Data Model v0 (Proposed)

Status: **proposal only** — no schema is being built in this phase. Every
entity below cites the workbook evidence it is derived from
(`docs/business-rules.md`, `docs/workbook-dependency-map.md`,
`docs/workflow-map.md`, `docs/input-output-map.md`) and flags where the
workbook provides no evidence at all (the CRM-shell entities), which
carries more design risk since it isn't grounded in observed behavior.

General conventions assumed for every entity unless noted otherwise:
- `id` (UUID), `tenant_id` (FK), `created_at`/`updated_at`, `created_by`/`updated_by`.
- Multi-tenant from day one (`tenant_id` on every row) — the workbook has
  no concept of tenancy (it's one company's single file), so this is a
  ForgeOS-native requirement, not something migrated from the workbook.
- Soft-delete (`deleted_at`) rather than hard delete, given the audit
  requirements below.

---

## Company

**Purpose:** the client/exhibitor organization (billing entity).
**Key fields:** name, billing_address, industry (optional).
**Relationships:** has many `Contact`, `Opportunity`, `Project`.
**Workbook source:** `Start Page!B3:B8` ("BILLING COMPANY", "ADDRESS 1/2")
— currently just free-text fields on the job-setup sheet, not a
normalized/reusable company record. No evidence the workbook ever reuses a
company across two different estimate files.
**Tenant ownership:** scoped to the fabrication company (ForgeOS tenant).
**Versioning:** none needed (mutable record).
**Audit:** standard create/update audit event.

## Contact

**Purpose:** an individual at a `Company` (client contact, or the fabricator's own account executive).
**Key fields:** name, phone, email, role (`client_contact` | `account_executive`).
**Relationships:** belongs to `Company` (client contacts) or is a `User` (internal AEs).
**Workbook source:** `Start Page!B6:B8` (client contact name/cell/email);
`DATA!B24:F33` (internal account-executive directory, looked up via
`VLOOKUP` from `Start Page!C30`) — see `docs/input-output-map.md` §2.
**Tenant ownership:** tenant-scoped.
**Versioning:** none.
**Audit:** standard.

## Opportunity

**Purpose:** a pre-estimate sales pipeline record (show, booth, target dates) before it's worth building a full estimate.
**Key fields:** company_id, show_name, booth_number, target_move_in/out, stage.
**Relationships:** has many `Estimate`; converts to `Project` on win.
**Workbook source:** **none** — `docs/workflow-map.md` confirms the
workbook has no lead/opportunity concept; `Start Page` already assumes a
named show/booth. This entity is a pure ForgeOS addition to close the gap
identified in the workflow map, not a migration of existing structure.
**Tenant ownership:** tenant-scoped.
**Versioning:** none (pipeline stage changes are logged via AuditEvent, not versioned).
**Audit:** stage-change history required (sales reporting).

## Project

**Purpose:** the won/active job once an estimate is approved — the parent of `WorkOrder`, `Shipment`, production tracking.
**Key fields:** opportunity_id, job_number, status, show_dates.
**Relationships:** has one approved `Estimate` (+ history of all versions), has many `WorkOrder`, `Shipment`, `Task`.
**Workbook source:** implied by `Start Page!B14 "JOB #"` and the `WORK
ORDER` timeline (`docs/workflow-map.md`), but the workbook itself has no
single "Project" record distinct from the estimate file — one workbook
*is* one project. ForgeOS should make this an explicit entity so a
project's estimate history, work orders, and actuals are queryable
together.
**Tenant ownership:** tenant-scoped.
**Versioning:** none (status transitions via AuditEvent).
**Audit:** full status-change history required (this is the operational
system of record once a job is won).

## Estimate

**Purpose:** the priced proposal-in-progress for an opportunity/project.
**Key fields:** opportunity_id, budget, tax_city (drives `Cities` table lookup — business-rules.md Rule 11), status.
**Relationships:** has many `EstimateVersion`; has many `Option`.
**Workbook source:** ` ESTIMATE` sheet + everything feeding it (Start
Page, category sheets, COST SUMMARY, Price Summary) — see
`docs/workbook-dependency-map.md` §3.
**Tenant ownership:** tenant-scoped.
**Versioning:** the parent record is stable; **all pricing detail lives on
`EstimateVersion`** (see below) — this is the single most important
structural correction ForgeOS must make relative to the workbook, which
has no version concept at all (each estimate is one mutable file,
"current state" only).
**Audit:** version-creation events; no field-level audit needed on the
parent (immutable identity fields only).

## EstimateVersion

**Purpose:** an immutable snapshot of one priced estimate (equivalent to "the workbook as it was on send date").
**Key fields:** estimate_id, version_number, margin_target_pct (per business-rules.md Rule 6 — this is a per-version, per-line editable input, not a system constant), grand_total, gross_margin_pct, is_current.
**Relationships:** has many `EstimateSection`; has one `Proposal` (optional, generated from this version).
**Workbook source:** the workbook has no direct analog — this entity
*is* ForgeOS's fix for the reproducibility gap flagged throughout
`docs/business-rules.md` and `docs/risk-register.md` (a workbook's
formulas can be edited after a proposal was sent, with no record of what
was actually priced/approved). `Price Summary!E135 "APPROVED PRICE TO
CUSTOMER"` is the closest workbook concept — it implies exactly one
version is ever treated as "the" approved one, worth preserving as
`is_current`/`is_approved`.
**Tenant ownership:** tenant-scoped (via Estimate).
**Versioning:** IS the versioning mechanism — never mutated after creation.
**Audit:** creation event captures who/when/from-what-prior-version.

## EstimateSection

**Purpose:** a named grouping within an estimate version (materials, labor, rentals, show services, logistics — the workbook's per-category sheets).
**Key fields:** estimate_version_id, name, sort_order, section_type (`component` | `category` | `fee` — see business-rules.md Rule 3 re: the 5 repurposed slots).
**Relationships:** has many `LineItem`.
**Workbook source:** `COMPONENT n` sheets, category sheets (Flooring,
Structure, Furniture, Accessories, AV, Hanging Sign, Cross Rental *), and
the 5 special slots (DESIGN TIME 22…PACKING 26). Recommend modeling the
special slots as `section_type='fee'` rather than a separate entity,
matching the workbook's own (if informal) choice to reuse the component
template for them.
**Tenant ownership:** tenant-scoped (via EstimateVersion).
**Versioning:** immutable once its parent EstimateVersion is created.
**Audit:** none beyond parent.

## LineItem

**Purpose:** one priced row — a material, a labor hour block, or a fee.
**Key fields:** section_id, line_type (`material` | `labor` | `fee`),
description, qty, unit_cost, department (for labor — see business-rules.md
Rule 1's 15-department list), total_cost.
**Relationships:** belongs to `EstimateSection`; optionally references a `Material`, `LaborRate`, or `RentalItem`.
**Workbook source:** `COMPONENT n!A9:I<last>` (MATERIAL/QTY/UNIT
COST/TOTAL COST + DEPARTMENT/HOURS/RATE/LABOR COST columns) — see
business-rules.md Rules 1–2. Direct, high-confidence mapping.
**Tenant ownership:** tenant-scoped (via section).
**Versioning:** immutable once its parent EstimateVersion is created.
**Audit:** none beyond parent.

## Component

**Purpose:** a reusable, named build/material assembly definition (independent of any one estimate) — e.g. a standard rental structure element.
**Key fields:** name, default_materials (JSON or child rows), default_labor_hours_by_department.
**Relationships:** `LineItem`s may reference a `Component` as their template origin.
**Workbook source:** `COMPONENT n` sheets are **per-estimate instances**,
not a reusable catalog — the workbook has no separate component *library*;
every job starts its 44 component slots blank. This entity is a proposed
ForgeOS improvement (build once, reuse across estimates) with **no
direct workbook precedent** — flag as Low confidence / design decision,
not a migration.
**Tenant ownership:** tenant-scoped (shared catalog across a tenant's estimates).
**Versioning:** simple updated_at; no strict versioning needed (a catalog item, not a legal document).
**Audit:** standard.

## Material

**Purpose:** a catalog material/SKU with a current unit cost.
**Key fields:** name, unit, current_unit_cost, category.
**Relationships:** referenced by `LineItem`.
**Workbook source:** `COMPONENT n!A10:C<last>` material rows are
free-text + a typed unit cost per job — **no material catalog exists in
the workbook** (confirmed: material columns have far lower formula
density than labor columns, per `docs/input-output-map.md` §1, i.e.
they're re-typed by hand every time). Proposed net-new entity to
eliminate this repeated manual entry.
**Tenant ownership:** tenant-scoped.
**Versioning:** track unit_cost history for cost-trend reporting (goal #8).
**Audit:** standard + cost-change history.

## LaborRate

**Purpose:** the rate ($/hr) for a labor department or city/market.
**Key fields:** rate_type (`department` | `city_market`), department_code (DE/EN/PM/HA/GR/CC/EF/ME/…, matching business-rules.md Rule 1's 15 codes), city, rate, effective_date.
**Relationships:** referenced by `LineItem` (department rates) or by show-services pricing (city rates).
**Workbook source:** two distinct, currently-disconnected sources —
`COMPONENT 1!H10:H25` (department rates, hardcoded and fan-out-copied to
43 other sheets, business-rules.md Rule 1) and `LABOR RATES` (city-keyed
table, ~85 cities, apparently unreferenced by any live formula,
business-rules.md Rule 10). **Recommend unifying both into one
`LaborRate` table with `rate_type` discriminator** and retiring the
copy-by-formula pattern entirely — this single change removes an entire
class of drift risk identified in the audit.
**Tenant ownership:** tenant-scoped.
**Versioning:** `effective_date` history required — rate changes over time must not silently alter historical EstimateVersions (which snapshot their own copy of the rate at line-item creation).
**Audit:** standard + change history.

## RentalItem

**Purpose:** standard rental inventory catalog (frames, slatwalls, doors, stem lights, shelves, pedestals, hanging-sign hardware) with flat prices.
**Key fields:** name, unit_price, price_derivation_note (free text, to preserve things like business-rules.md Rule 9's embedded `(35*2)*1.25` derivation instead of losing it).
**Relationships:** referenced by `LineItem`.
**Workbook source:** `Standard Cost Sheet` — direct, high-confidence mapping.
**Tenant ownership:** tenant-scoped.
**Versioning:** price history required.
**Audit:** standard + price-change history.

## Vendor

**Purpose:** external supplier for purchased materials/services (purchasing/work-order phase).
**Key fields:** name, contact_info, category.
**Relationships:** referenced by `WorkOrder` purchasing lines.
**Workbook source:** **none found.** No vendor/supplier table exists
anywhere in the 95 sheets — all costs are either internal labor rates or
flat catalog prices. This is a gap the workbook simply doesn't cover (the
brief's goal #6 "purchasing" has no workbook precedent at all). Flag as a
pure net-new capability for ForgeOS, not a migration.
**Tenant ownership:** tenant-scoped.
**Versioning:** none.
**Audit:** standard.

## Proposal

**Purpose:** the client-facing generated document for an EstimateVersion.
**Key fields:** estimate_version_id, template_id, sent_at, signed_at.
**Relationships:** belongs to `EstimateVersion`; uses a `ProposalTemplate`.
**Workbook source:** `PROPOSAL` sheet (691 formulas, 347 merged cells,
print area — see workbook-inventory.md). One monolithic
formatted-for-print sheet per job; no template *reuse* mechanism (each
copy of the workbook has its own baked-in PROPOSAL layout).
**Tenant ownership:** tenant-scoped.
**Versioning:** immutable once sent (`sent_at` locks it); re-sends create a new `Proposal` row against a new/same `EstimateVersion`.
**Audit:** sent/viewed/signed event history — this is exactly the
reproducibility gap called out in `docs/workflow-map.md`'s "Key finding."

## ProposalTemplate

**Purpose:** reusable branded template (ForgeOS goal #3), decoupled from any one proposal instance.
**Key fields:** name, branding_config, layout_config.
**Relationships:** used by many `Proposal`.
**Workbook source:** **none** — the workbook's `PROPOSAL` sheet is a
single hardcoded layout baked into the file itself, not a reusable
template applied to data. Pure net-new ForgeOS capability.
**Tenant ownership:** tenant-scoped.
**Versioning:** template versioning recommended (so old proposals render as originally sent even if the template is later edited) — snapshot the rendered template config onto `Proposal` at send time.
**Audit:** standard.

## Option

**Purpose:** an alternate/upgrade pricing path within one estimate (e.g. "Option 3: upgraded flooring").
**Key fields:** estimate_version_id, name, delta_line_items or full alternate `EstimateSection` set.
**Relationships:** belongs to `EstimateVersion`.
**Workbook source:** `OPTION (1)`–`OPTION (10)` sheets (structurally
identical to COMPONENT sheets, business-rules.md/workflow-map.md), rolled
up in `Price Summary!116:126` ("OPTION 1:"… "OPTIONS TOTAL:"). Direct,
high-confidence mapping. Note: the workbook's separate `PRICE OPTIONS`
sheet (broken, business-rules.md Rule 7) is a *different* concept — a
margin-tier calculator, not a client-facing alternate — do not conflate
the two when naming ForgeOS entities.
**Tenant ownership:** tenant-scoped (via EstimateVersion).
**Versioning:** immutable once its parent EstimateVersion is created.
**Audit:** none beyond parent.

## ChangeOrder

**Purpose:** a post-approval modification to project scope/cost.
**Key fields:** project_id, description, materials_labor_lines, status.
**Relationships:** belongs to `Project`; optionally references the originating `Estimate`.
**Workbook source:** `CHANGE ORDER` sheet, header literally `"ESTIMATE -
Short Form"` — see `docs/workflow-map.md`. **Important divergence:** the
workbook authors each change order as an independent from-scratch
mini-estimate rather than a diff against the original. Recommend ForgeOS
still store it as a diff (for reporting/audit clarity) but confirm with
the business whether standalone re-pricing is a deliberate practice worth
preserving as a UX option.
**Tenant ownership:** tenant-scoped.
**Versioning:** each change order is itself a small immutable
approved-or-not record; sequence them per project.
**Audit:** full status history required (this directly affects
contracted price — goal #4).

## WorkOrder

**Purpose:** the internal production/build authorization once a proposal is signed.
**Key fields:** project_id, timeline (deposit/production-meeting/artwork-deadline/balance-due/install dates — see workflow-map.md), status.
**Relationships:** belongs to `Project`; has many `Task`, `Shipment`.
**Workbook source:** `WORK ORDER` sheet — the clearest workflow evidence
in the workbook (explicit timeline labels). Direct, high-confidence
mapping.
**Tenant ownership:** tenant-scoped.
**Versioning:** none (mutable operational record with audit trail).
**Audit:** full status/date-change history required.

## Task

**Purpose:** a discrete production/logistics action item (design, engineering, packing, crating, install, etc.).
**Key fields:** work_order_id, task_type (mapping to business-rules.md Rule 1's department codes and Rule 3's special slots), assigned_to, due_date, status.
**Relationships:** belongs to `WorkOrder`.
**Workbook source:** the 5 repurposed COMPONENT slots (DESIGN TIME 22,
ENGINEERING 23, ESTIMATING 24, PRESET 25, PACKING 26) plus the dedicated
logistics sheets (PACKING, SKIDS, CRATING, ENG. DRAWINGS) are the closest
workbook analogs, but none of them model a *task* with an owner/due
date/status — they're still just cost line items. Proposed ForgeOS
addition to make production tracking (goal #6) actually operational
rather than cost-only.
**Tenant ownership:** tenant-scoped.
**Versioning:** none.
**Audit:** status-change history.

## Shipment

**Purpose:** trucking/load-out tracking for a project.
**Key fields:** work_order_id, carrier, load_list, ship_date, tracking_ref.
**Relationships:** belongs to `WorkOrder`.
**Workbook source:** `TRUCKING & LOAD LIST` (hidden) — but this sheet's
own data appears to depend on the **broken external link** (see
`docs/workbook-dependency-map.md` §4); its self-contained content within
this file is thin. Treat workbook evidence here as Low confidence.
**Tenant ownership:** tenant-scoped.
**Versioning:** none.
**Audit:** status/date-change history.

## Invoice

**Purpose:** the billing document sent to the client.
**Key fields:** project_id, estimate_version_id, line_items, amount, status, actual_vs_estimated (goal #7).
**Relationships:** belongs to `Project`; references `EstimateVersion`.
**Workbook source:** `INVOICE ` / `INVOICE REQUEST` sheets, reading from
`Price Summary` (which itself has both `ESTIMATED COST` and `ACTUAL
INCURRED` column headers — see input-output-map.md §5). Direct mapping,
Medium-High confidence.
**Tenant ownership:** tenant-scoped.
**Versioning:** immutable once issued; corrections create a new Invoice or credit memo, not an edit.
**Audit:** full audit trail (financial document).

## CostActual

**Purpose:** actual incurred cost per line item, for estimate-vs-actual reporting (goal #7).
**Key fields:** line_item_id (or work_order task), actual_cost, recorded_at, source.
**Relationships:** references `LineItem`/`Task`.
**Workbook source:** `Price Summary!E6/F6 "ESTIMATED COST"/"ACTUAL
INCURRED"` headers confirm the *concept* exists, but no populated actual
data was found in the sampled cells — likely filled in manually per job
and not structurally distinct from the estimate columns. This is
effectively a placeholder in the workbook; ForgeOS should treat it as a
net-new structured capability built to match the workbook's stated intent
rather than a rich migration source.
**Tenant ownership:** tenant-scoped.
**Versioning:** append-only (multiple actuals can accrue over a project's life).
**Audit:** standard (who recorded it, when).

## Attachment

**Purpose:** files (artwork, signed proposals, drawings) attached to an estimate/project/work order.
**Key fields:** owner_type, owner_id, file_ref, uploaded_by.
**Relationships:** polymorphic association to Estimate/Project/WorkOrder/ChangeOrder.
**Workbook source:** `xl/media/*` (12 embedded images — logos, likely a
signature/decoration on Start Page and PROPOSAL) and
`WORK ORDER!C15 "PRODUCTION READY ARTWORK... via designshop FTP or
WeTransfer"` — confirms artwork is handled *outside* the workbook
entirely (an external FTP/file-transfer process), so this entity is a
genuine gap-fill, not a migration of workbook data.
**Tenant ownership:** tenant-scoped.
**Versioning:** keep all uploaded versions, mark current.
**Audit:** upload/delete history.

## User

**Purpose:** internal ForgeOS user (estimator, account executive, production staff).
**Key fields:** name, email, role, department (matching business-rules.md Rule 1 department codes where relevant).
**Relationships:** referenced by nearly every entity as `created_by`/`assigned_to`.
**Workbook source:** `Start Page!C30 "ACCOUNT EXECUTIVE"`, `C35
"ESTIMATOR"` (static initials, e.g. `"CW"`) — free text, not a real user
directory (aside from the `DATA!B24:F33` AE contact lookup). No
authentication/authorization concept exists in a spreadsheet, obviously —
this entity is entirely ForgeOS-native.
**Tenant ownership:** tenant-scoped (or cross-tenant if ForgeOS is used by staffing agencies — TBD).
**Versioning:** none.
**Audit:** standard.

## AuditEvent

**Purpose:** the append-only log of who did what, when, across every other entity — the structural fix for the reproducibility gap identified throughout this audit (see `docs/workflow-map.md`'s "Key finding" and `docs/risk-register.md`).
**Key fields:** entity_type, entity_id, action, actor_id, timestamp, diff/snapshot.
**Relationships:** polymorphic reference to any entity.
**Workbook source:** **none.** The workbook has zero audit trail — no
sheet, cell comment, or metadata tracks who changed a rate or when a
price was approved (`docProps/core.xml` only records the single
last-modified author/timestamp for the whole file). This is the single
most consequential gap the workbook leaves for ForgeOS to close, and is
listed as a top risk in `docs/risk-register.md`.
**Tenant ownership:** tenant-scoped.
**Versioning:** is itself the versioning/audit mechanism — append-only, never mutated.
**Audit:** N/A (it is the audit log).

---

## Cross-cutting notes

- **Versioning is the single biggest structural gap.** The workbook has
  exactly one mutable "current state" per file; every editable business
  fact (rates, margins, line items) can change with zero record of the
  prior value. `EstimateVersion` + `AuditEvent` together are the proposed
  fix and should be treated as non-negotiable in any implementation phase,
  not a nice-to-have.
- **Tenant isolation** has no workbook precedent at all (it's a
  single-company file) — this is purely a ForgeOS platform requirement,
  flagged as a risk-register item to confirm scope (multi-tenant SaaS vs.
  single-company internal tool) before schema work begins.
- **Entities with no workbook precedent** (Opportunity, Component-as-catalog,
  Material-as-catalog, Vendor, ProposalTemplate, Task, User,
  AuditEvent) are ForgeOS's actual value-add over "digitize the
  spreadsheet" — but because they're not grounded in observed workbook
  behavior, they carry more design risk and should be validated with the
  business before Phase 2 implementation.
