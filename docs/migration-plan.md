# ForgeOS Migration Plan (Proposed)

Principle throughout: **Excel stays the system of record until each phase
is independently validated against it.** Nothing in this plan proposes
cutting over before a phase's outputs have been reconciled against the
workbook for a real, historical job.

## Phase 0 — Forensic workbook audit (this phase)

**Status: complete**, produced by `tools/workbook_audit/` (see
`docs/audit-plan.md`). Deliverables: `docs/workbook-inventory.md`,
`docs/workbook-dependency-map.md`, `docs/business-rules.md`,
`docs/input-output-map.md`, `docs/workflow-map.md`, this
`docs/data-model-v0.md`, `docs/risk-register.md`, and machine-readable
`artifacts/*.json`.

**Known gaps carried forward** (see `docs/risk-register.md` for full
list): `COST SUMMARY`'s dual rollup mechanism not fully reconciled (Rule
5), `PRICE OPTIONS` broken and of unclear disposition (Rule 7), external
link data unverifiable (dependency-map §4). None of these block Phase 1,
but all three should be resolved with business-side input before Phase 3
(native estimate engine) locks in calculation logic.

## Phase 1 — Read-only workbook importer + comparison harness

**Status: tooling built and validated; exit criteria not yet met.** Full
detail in `docs/phase1-findings.md`.

**Goal:** prove ForgeOS can read a *populated* estimate workbook (not just
this template) and reproduce its numbers, before writing a single line of
new business logic.

**Scope:**
- [x] Extend the tooling with a sibling package, `tools/workbook_import/`
  (kept separate from the read-only `tools/workbook_audit/` on purpose),
  to import a *filled-in* copy of this workbook into a staging database —
  a narrow first-cut of `docs/data-model-v0.md` scoped to exactly what
  the comparison harness needs.
- [x] Stood up LibreOffice headless as the Excel-compatible calculation
  engine (`tools/workbook_import/recalc.py`) — verified by hand that
  `--convert-to` forces real recalculation, not a re-save of stale cached
  values, before wrapping it in code. This is the first point in the
  project where a recalculated value is trusted.
- [x] Built a diff/comparison harness (`diff_harness.py`): for a given
  job workbook, asserts an independent recompute of each section's
  totals matches the workbook's own `COST SUMMARY` values, localizing
  any mismatch to a specific stage. Currently wired through `COST
  SUMMARY` for one component and one category section; extending to
  every section and up through `Price Summary`/`ESTIMATE` is mechanical
  (same pattern) but not yet done.
- [x] Tested against the two known-broken areas: `PRICE OPTIONS`'s
  `#REF!` cells were traced to `COST SUMMARY`'s live `AD` (total cost)
  column and the repair was **verified empirically** by patching a
  scratch copy and recalculating — see `docs/business-rules.md` Rule 7.
  `COST SUMMARY`'s suspected double-count (R18) was **resolved as a
  false alarm** — two intentional, non-overlapping rollup bands, not a
  duplication — see Rule 5. One new finding surfaced in the process:
  `OVERHEAD` is silently zeroed workbook-wide (R19).
- [ ] **Not yet done:** run against real historical job workbooks. This
  pass used a synthetic, clearly-fictional fixture
  (`tools/workbook_import/synthetic_fixture.py`) since none were
  available — see `docs/phase1-findings.md` for what's needed to close
  the gap.

**Exit criteria (not yet met):** 3+ historical, distinct real job
workbooks reproduce their known-good final numbers (proposal total,
margin) within rounding tolerance, with every intermediate rollup stage
individually verified. The pipeline that will do this is built and
passing 12/12 tests against synthetic data; it has not yet been proven
against real business data, which is a different and stronger claim.

## Phase 2 — CRM and opportunity shell

**Goal:** stand up `Company`, `Contact`, `Opportunity`, `User` — the
entities `docs/data-model-v0.md` flags as having **no workbook
precedent** — as a genuinely new capability, decoupled from estimating.

**Scope:**
- Basic CRUD + pipeline view for Opportunity.
- Manual "convert opportunity → start new estimate" action that
  pre-fills `Start Page`-equivalent fields (job/show/booth details) from
  the Opportunity record, closing the gap identified in
  `docs/workflow-map.md` (workbook currently starts one stage later than
  the target lifecycle).
- No estimate math yet — estimates created here can still be authored in
  Excel and attached, or stubbed.

**Exit criteria:** a real opportunity can be tracked start-to-qualified
in ForgeOS with zero Excel involvement; estimate authoring is still
Excel-based.

## Phase 3 — Native estimate engine

**Goal:** replace the workbook's calculation chain with ForgeOS-native
logic, using Phase 1's comparison harness as the acceptance test.

**Scope, in dependency order (per `docs/workbook-dependency-map.md`):**
1. `LaborRate` (unified department + city model — business-rules.md Rule 10 remediation), `Material`, `RentalItem` catalogs.
2. `Component`/`EstimateSection`/`LineItem` line-item math (business-rules.md Rules 1–2): material qty×cost, labor hours×rate.
3. Category/component rollup into a `COST SUMMARY`-equivalent (**must first resolve business-rules.md Rule 5's open question** — reconcile or deliberately choose one of the two rollup mechanisms rather than porting both).
4. `Price Summary`-equivalent margin gross-up (business-rules.md Rule 6) — implement the `cost / ((100-margin%)/100)` formula exactly, with an explicit unit test asserting it is *not* accidentally simplified to a markup formula.
5. `Option` (alternates) — direct port of the OPTION sheet pattern.
6. Decide `PRICE OPTIONS`' fate (port, fix, or formally drop) **before** this phase closes — cannot be deferred further once the estimate engine is the system of record.
7. `EstimateVersion` snapshotting on every send/approval — the reproducibility fix that has no workbook precedent at all.

**Exit criteria:** a new estimate authored entirely in ForgeOS, for a
realistic scenario, produces the same totals a domain expert would expect
from the equivalent Excel workbook (validated by estimator sign-off, not
just automated diff — the automated harness only proves arithmetic
parity, not business correctness).

## Phase 4 — Proposal and approval workflow

**Goal:** `Proposal`, `ProposalTemplate`, approval gate, `ChangeOrder`.

**Scope:**
- Templated proposal generation replacing the single hardcoded `PROPOSAL`
  sheet layout (ForgeOS goal #3 — reusable branded templates, a genuine
  net-new capability).
- Explicit approval state + timestamp (replacing the manual/paper
  signature process inferred in `docs/workflow-map.md`) — `is_approved`,
  `approved_at`, `approved_by` on `EstimateVersion`.
- `ChangeOrder` authoring: **resolve the open question from
  `docs/workflow-map.md`** — build it as a diff against the approved
  EstimateVersion (ForgeOS-recommended) rather than porting the
  workbook's from-scratch "short form estimate" pattern, unless business
  stakeholders confirm the standalone re-pricing behavior is intentional
  and should be preserved as a UX option.

**Exit criteria:** a proposal can be generated, sent, and approved
end-to-end in ForgeOS with a full audit trail, for a job whose estimate
was also built in ForgeOS (Phase 3).

## Phase 5 — Project, production, and logistics tracking

**Goal:** `Project`, `WorkOrder`, `Task`, `Shipment` — operationalize the
timeline evidence found in the `WORK ORDER` sheet
(`docs/workflow-map.md`): deposit → production meeting → artwork
deadline(s) → balance due → installation.

**Scope:**
- `WorkOrder` timeline as trackable dates/milestones, not static text.
- `Task` breakdown per department (business-rules.md Rule 1's 15
  department codes) and per special line type (Rule 3's design
  time/engineering/estimating/packing slots) — giving production staff an
  actual worklist, which the workbook never provided (it only prices
  these activities, never assigns/tracks them).
- `Shipment`/load-list tracking, replacing the workbook's
  externally-linked (and currently broken) `TRUCKING & LOAD LIST` sheet
  with a self-contained ForgeOS record.
- `Vendor` + purchasing — genuinely new capability (workbook has zero
  vendor/purchasing data model, per `docs/data-model-v0.md`).

**Exit criteria:** a won project can be tracked from deposit through
installation entirely in ForgeOS, with task ownership and due dates
visible to production staff (not just costed, as in the workbook).

## Phase 6 — Actual-cost reporting and AI assistance

**Goal:** ForgeOS goals #7 and #8 — estimated-vs-actual reporting and
AI-assisted estimating/risk detection.

**Scope:**
- `CostActual` capture against `LineItem`/`Task` (formalizing the
  `Price Summary!"ESTIMATED COST"/"ACTUAL INCURRED"` header pair that
  exists conceptually in the workbook but was never populated with real
  structured data in the sample reviewed).
- Variance reporting (estimated vs. actual, by department/category/job).
- Only once sufficient `EstimateVersion` + `CostActual` history has
  accumulated in ForgeOS itself (not retrofitted from the workbook, which
  has no historical version data to mine): AI-assisted estimating
  (suggest line items/rates from similar past jobs) and risk detection
  (flag estimates whose margin or rate assumptions deviate from
  historical norms).

**Exit criteria:** at least one full historical project cycle (estimate →
approval → production → actuals) completed natively in ForgeOS, providing
the first trustworthy training/reference dataset for Phase 6's AI
features.

## Cross-phase risks to track

See `docs/risk-register.md` for full detail; the items most likely to
block or reshape this plan:
- Whether `COST SUMMARY`'s two rollup mechanisms double-count (blocks
  Phase 3 step 3 until resolved).
- Whether `PRICE OPTIONS` is dead or fix-pending (blocks Phase 3 step 6).
- Whether the external `MASTER` workbook link is still operationally
  relied upon anywhere in the business (affects Phase 1 scope — may need
  to import from two source systems, not one).
- Multi-tenant vs. single-company scope decision (affects every phase's
  data model from Phase 2 onward).
