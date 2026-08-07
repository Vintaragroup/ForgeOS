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

**Status: complete.** Built in `web/` on top of Phase 2's stack. Real
department labor rates (Rule 1) and Standard Cost Sheet rental prices
(Rule 9) are seeded from `docs/business-rules.md` via `web/prisma/seed.ts`
— not placeholders. `PRICE OPTIONS` (Rule 7) was formally dropped this
phase, per explicit decision below, rather than ported or repaired.

**Goal:** replace the workbook's calculation chain with ForgeOS-native
logic, using Phase 1's comparison harness as the acceptance test.

**Scope, in dependency order (per `docs/workbook-dependency-map.md`):**
1. [x] `LaborRate` (unified department + city model — business-rules.md Rule 10 remediation), `Material`, `RentalItem` catalogs, with full CRUD UI at `/catalog`.
2. [x] `EstimateSection`/`LineItem` line-item math (business-rules.md Rules 1–2): `totalCost = qty × unitCost` for both material and labor lines, implemented in `web/src/lib/estimate-service.ts`.
3. [x] Section rollup into a version-level `totalCost` (`computeSectionTotal`/`computeVersionTotals`) — Rule 5's two-rollup-band question was already resolved in Phase 1 (false alarm, not a double-count), so this phase implements the single confirmed mechanism directly rather than porting both bands.
4. [x] `Price Summary`-equivalent margin gross-up (business-rules.md Rule 6): `computeMarginGrossUp(cost, marginTargetPct) = cost / ((100-marginTargetPct)/100)`, with an explicit regression test (`estimate-service.test.ts`) proving it diverges from the markup formula (`cost * (1 + margin/100)`) for every nonzero margin, and a real-data test reproducing Yoku Moku's actual $66,044.83 client-sent total from its independently-recovered cost and margin (Phase 1).
5. **Moved to Phase 4:** `Option` (alternates) — no workbook precedent was exercised in Phase 1's validated jobs beyond the base estimate; folded into Phase 4's scope alongside `ChangeOrder`, since both are "diff against a base estimate" mechanisms.
6. [x] `PRICE OPTIONS`' fate decided: **formally dropped**, by explicit user choice ("skip it for now") when this phase started, given no business-side confirmation ever arrived for what its 43/57…65/35 tiers and `×1.075` multiplier mean (Rule 7). Documented in `web/prisma/schema.prisma`'s Phase 3 header comment rather than silently omitted.
7. [x] `EstimateVersion` snapshotting: `isCurrent`/`isLocked` fields, `lockEstimateVersion` freezes `totalCost`/`grandTotal`/`grossMarginPct` and stamps `lockedAt`; `createNewVersionFromLocked` duplicates a locked version's sections/line items into a fresh unlocked one rather than mutating history — the reproducibility fix that has no workbook precedent at all.

**Exit criteria — met:** a new estimate, authored entirely in ForgeOS
through the UI at `/estimates/[id]` (margin target → sections → line
items → live-computed totals → lock → new version), was built end-to-end
in a live browser session using Yoku Moku's real, Phase-1-validated cost
and margin figures and reproduced its real total within the schema's
2-decimal-place rounding (a $0.37 delta on ~$66k, from margin/cost
columns that store 2 decimal places — not a formula defect; the formula
itself reproduces the real total to the penny at full precision, per
`estimate-service.test.ts`). Catalog CRUD (labor rates, materials, rental
items) and the full estimate version lifecycle (create → edit → lock →
copy-to-new-version → delete line item) were each verified live, not just
via automated tests. 24 automated tests cover the compute functions, the
DB-backed service, and two Phase-1-derived acceptance scenarios
(`estimate-acceptance.test.ts`). Not yet done: estimator sign-off on a
full realistic multi-section job (this phase's testing used a
single-line-item stand-in for the real job's full section/component
breakdown) — tracked as follow-up before Phase 4 relies on estimate data
for proposals.

## Phase 4 — Proposal and approval workflow

**Status: complete.** Built in `web/` on top of Phase 3's estimate
engine. `Option` and the design-intake prototype (moved in from Phase 3)
were both built this phase too. The multi-year `Contract` concept was
formally skipped, same call as `PRICE OPTIONS` in Phase 3 — see below.

**Goal:** `Proposal`, `ProposalTemplate`, approval gate, `ChangeOrder`.

**Scope:**
- [x] Templated proposal generation replacing the single hardcoded
  `PROPOSAL` sheet layout (ForgeOS goal #3 — reusable branded templates).
  `ProposalTemplate` (name, brandingConfig, layoutConfig) gets full CRUD
  at `/catalog/proposal-templates`; `generateProposal` snapshots the
  template's config onto the `Proposal` row at generation time
  (`templateConfigSnapshot`) so a later template edit never changes how
  an already-generated proposal renders.
- [x] Explicit approval state + timestamp (replacing the manual/paper
  signature process inferred in `docs/workflow-map.md`) —
  `isApproved`/`approvedAt`/`approvedById` on `EstimateVersion`, gated on
  the version already being locked. Distinct from `Proposal`'s own
  `sentAt`/`signedAt` (the client-facing side, also built — "send" and
  "mark as signed" actions on `/proposals/[id]`).
- [x] `ChangeOrder` authoring: resolved the open question from
  `docs/workflow-map.md` by building it as a diff against the approved
  EstimateVersion (ForgeOS-recommended), **not** the workbook's
  from-scratch "short form estimate" pattern — no business-side
  confirmation ever arrived to justify the standalone-re-pricing
  alternative, so the recommended default stood. Implemented by reusing
  `EstimateVersion`'s existing copy/lock machinery rather than a parallel
  delta-storage model: `ChangeOrder.resultVersionId` is a normal
  `EstimateVersion`, edited with the same estimate UI already built in
  Phase 3; the diff (`computeChangeOrderDiff`) is computed on read by
  comparing `baseVersion` and `resultVersion` line items.
- [x] **Moved from Phase 3:** `Option` (alternates) — one full
  `EstimateSection` set per alternate, direct port of the OPTION sheet
  pattern. Implemented via `EstimateSection.optionId` (nullable) rather
  than a duplicate section/line-item model — an Option's sections reuse
  every existing section/line-item function, priced separately from the
  base estimate via `computeOptionTotal`.
- [x] **Moved from Phase 3:** design-intake prototype — minimal scope, by
  explicit decision: `Attachment` is a text reference (filename or an
  external FTP/WeTransfer link, matching how the workbook's own artwork
  already moves outside the file entirely — no upload pipeline built).
  Draft `LineItem`s (`isDraft`, `attachmentId`) are excluded from cost
  rollups until `confirmDraftLineItem` marks them human-reviewed and
  priced. No automated pull-sheet table extraction this phase.
- [x] **Moved from Phase 3, decided:** multi-year `Contract` concept —
  **skipped**, by explicit user choice, same reasoning as `PRICE OPTIONS`
  in Phase 3: no second real multi-year job exists yet to validate a
  `Contract` model against (Poly Coat, Phase 1, remains the only
  evidence). Revisit if another multi-year deal shows up.

**Exit criteria — met:** a proposal was generated, sent, and marked
signed end-to-end in ForgeOS for a job whose estimate was also built in
ForgeOS (Phase 3), verified live in a browser: approve → generate
proposal (branded, from a real template) → send → sign, all with a full
audit trail (`approvedAt`/`approvedById`, `sentAt`, `signedAt`). A
`ChangeOrder` was opened against a locked+approved version, edited
through the normal estimate UI, locked, and approved, with its diff view
showing the correct added line item and dollar delta. `Option` and the
draft-line-item workflow were each verified live too. 48 automated tests
cover the compute functions, the DB-backed services, and — new this
phase — acceptance tests proving the real Yoku Moku total (Phase 3)
passes through approve/generate/send/sign unchanged, and that a
change order's diff against it produces a correctly-priced real-dollar
delta (`estimate-acceptance.test.ts`).

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
- **Carried from Phase 4:** `ChangeOrder` currently references `Estimate`
  directly (schema.prisma's comment) since `Project` didn't exist yet.
  Once `Project` is built, decide whether `ChangeOrder` should move to
  reference `Project` instead, per data-model-v0.md's original design.

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
