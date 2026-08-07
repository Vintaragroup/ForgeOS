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

**Status: complete.** Full detail in `docs/phase1-findings.md`.

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
  job workbook, asserts an independent recompute of each populated
  section's totals matches the workbook's own `COST SUMMARY` values,
  localizing any mismatch to a specific stage rather than only a grand
  total.
- [x] Tested against the two known-broken areas: `PRICE OPTIONS`'s
  `#REF!` cells were traced to `COST SUMMARY`'s live `AD` (total cost)
  column and the repair was **verified empirically** by patching a
  scratch copy and recalculating — see `docs/business-rules.md` Rule 7.
  `COST SUMMARY`'s suspected double-count (R18) was **resolved as a
  false alarm** — two intentional, non-overlapping rollup bands, not a
  duplication — see Rule 5. One new finding surfaced in the process:
  `OVERHEAD` is silently zeroed workbook-wide (R19).
- [x] Ran against real historical job workbooks: **3 distinct clients,
  5 workbook files, 756/756 component-level checks passed, zero
  failures.** Two clients (Yoku Moku, Booksy) matched an independent
  real-world document to the penny; the third (Poly Coat, a multi-year
  contract) is internally verified with no external document available to
  cross-check. See `docs/phase1-findings.md` for the full breakdown.

**Exit criteria — met:** 3+ historical, distinct real job workbooks
reproduce their known-good final numbers within rounding tolerance, with
every intermediate populated rollup stage individually verified. 2 of the
3 clients are additionally confirmed against a document independent of
the workbook entirely (a sent proposal and a signed change order); the
third has no such document available but is fully internally consistent
under independent recalculation. Not yet extended: an independent
recompute of the `Price Summary`/`ESTIMATE` rollup stages themselves
(the grand total is currently read directly, not re-derived) — tracked as
non-blocking follow-up in `docs/phase1-findings.md`. Also surfaced: a
multi-year-contract data-model gap to resolve before Phase 3.

## Phase 2 — CRM and opportunity shell

**Status: complete.** Built in `web/` (Next.js 16 + Postgres + Prisma 7,
see `web/README.md`). Stack and tenancy were decided explicitly before
schema work began: TypeScript full-stack, single-company internal tool
(no `tenant_id` anywhere — see `web/prisma/schema.prisma`'s header
comment). Neither decision had been made anywhere in this project before
Phase 2 kickoff.

**Goal:** stand up `Company`, `Contact`, `Opportunity`, `User` — the
entities `docs/data-model-v0.md` flags as having **no workbook
precedent** — as a genuinely new capability, decoupled from estimating.

**Scope:**
- [x] Basic CRUD + pipeline view for Opportunity, plus Company/Contact/User
  CRUD. The pipeline view is a stage board (`/opportunities`, grouped
  New/Contacted/Qualified/Estimating/Won/Lost) rather than a raw list.
- [x] Opportunity stage changes are logged to a `StageChangeEvent` table
  (fromStage, toStage, note, timestamp) — satisfies `data-model-v0.md`'s
  "stage-change history required (sales reporting)" note. The full
  universal `AuditEvent` entity is explicitly out of scope for this phase.
- [x] "Convert opportunity → start new estimate" action: creates a stub
  `Estimate` (identity fields only, no line items) and auto-advances the
  opportunity to `ESTIMATING`, closing the gap identified in
  `docs/workflow-map.md` (workbook currently starts one stage later than
  the target lifecycle). No estimate math yet — that's Phase 3's
  `EstimateVersion`/`LineItem` work.

**Exit criteria — met:** a real opportunity can be tracked
start-to-qualified in ForgeOS with zero Excel involvement. Verified
manually in a browser: company → contact → opportunity created, walked
through New → Contacted → Qualified with a note logged at each
transition, then converted to a draft estimate. Estimate authoring
itself is still a stub, as scoped — that's Phase 3.

**Found along the way:** Prisma 7 removed the `datasource.url` field from
`schema.prisma` in favor of a driver-adapter pattern
(`@prisma/adapter-pg`) — not documented anywhere in this project before
now; see `web/README.md`'s stack notes so the next phase doesn't
rediscover it the hard way.

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
