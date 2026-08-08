# ForgeOS — web

Phases 2–6 (`docs/migration-plan.md`): CRM & opportunity shell, a native
estimate engine, the proposal/approval/change-order workflow,
project/production/logistics tracking, and actual-cost/variance
reporting (Phase 6's AI features are deliberately deferred — see below).
TypeScript full-stack (Next.js 16 App Router + Postgres + Prisma 7),
single-tenant (no `tenant_id` — see `prisma/schema.prisma`'s header
comment for why).

## Stack notes (read before touching Prisma or app-router code)

This repo was scaffolded against **Next.js 16** and **Prisma 7**, both
newer than most training data. Two things that look like bugs are actually
this version's intended behavior:

- **Next.js**: `params`/`searchParams` are `Promise`s — `await params`.
  Use the global `PageProps<'/route/[param]'>` helper type instead of
  hand-writing prop types. Full docs are bundled at
  `node_modules/next/dist/docs/` — read them before assuming an older
  API surface applies.
- **Prisma**: the datasource `url` field in `schema.prisma` is **no longer
  valid** — the CLI/Migrate connection string lives in `prisma.config.ts`;
  the runtime client requires an explicit driver adapter
  (`@prisma/adapter-pg`, wired up in `src/lib/db.ts`). See
  `prisma/schema.prisma`'s datasource comment.

## Setup

```bash
brew install postgresql@16          # if not already installed (see repo root)
brew services start postgresql@16
createdb forgeos_dev
createdb forgeos_test               # for the test suite -- kept separate from dev data

npm install
npx prisma generate
npx prisma migrate deploy           # applies prisma/migrations/ to forgeos_dev
npm run seed                         # loads real Rule 1/Rule 9 labor rates + rental prices

npm run dev                          # http://localhost:3000
```

`.env` (gitignored) needs:

```
DATABASE_URL="postgresql://<you>@localhost:5432/forgeos_dev?schema=public"
```

`.env.test` (also gitignored) needs the same, pointed at `forgeos_test`.
`src/test/setup.ts` refuses to run if `DATABASE_URL` doesn't contain
`forgeos_test` — the test suite truncates tables between every test.

## Scope (Phase 2)

- **Company, Contact, User** — CRUD.
- **Opportunity** — CRUD, a pipeline board (`/opportunities`, grouped by
  stage), and a full stage-change history (`StageChangeEvent`) satisfying
  `data-model-v0.md`'s "stage-change history required (sales reporting)"
  audit note.
- **"Convert to estimate"** — creates a stub `Estimate` (identity fields
  only) and auto-advances the opportunity to `ESTIMATING`.
- **`AuditEvent`** (the universal audit log in `data-model-v0.md`) is
  out of scope — only the one audit requirement Phase 2 explicitly calls
  for is modeled.

## Scope (Phase 3)

- **Catalogs** (`/catalog`) — `LaborRate` (department + city-market,
  business-rules.md Rule 1/Rule 10), `Material`, `RentalItem`
  (Rule 9), each with full list/create/edit/soft-delete CRUD. Seeded
  with real values via `npm run seed`.
- **Estimate engine** (`web/src/lib/estimate-service.ts`) — line item
  totals (`qty × unitCost`), section rollup, and the margin gross-up
  formula (`cost / ((100-margin%)/100)`, business-rules.md Rule 6) —
  deliberately *not* a markup formula; see the regression test in
  `estimate-service.test.ts`.
- **Estimate detail UI** (`/estimates/[id]`) — sections and line items,
  a live-recomputed running total, an editable margin target, and a
  lock/new-version workflow (`EstimateVersion.isLocked`; locking freezes
  totals, "Create new version" duplicates a locked version's
  sections/line items into a fresh editable one instead of mutating
  history).
- **`PRICE OPTIONS`** (business-rules.md Rule 7) was **formally dropped**
  this phase, not ported — see `prisma/schema.prisma`'s Phase 3 header
  comment for why. **`Option`** (alternates) was deferred to Phase 4.
- Acceptance tests (`estimate-acceptance.test.ts`) reproduce real,
  Phase-1-validated numbers from the Yoku Moku job through the full
  DB-backed service, not just the pure compute functions.

## Scope (Phase 4)

- **Proposal + approval** (`web/src/lib/proposal-service.ts`) —
  `ProposalTemplate` CRUD at `/catalog/proposal-templates`; an internal
  approval gate on `EstimateVersion` (`isApproved`/`approvedAt`/
  `approvedById`, requires the version to already be locked); generating
  a `Proposal` snapshots the template's branding/layout config so later
  template edits don't retroactively change an already-generated
  proposal; send/sign lifecycle at `/proposals/[id]`.
- **`ChangeOrder`** (`web/src/lib/change-order-service.ts`) — a diff
  against an approved `EstimateVersion` (the ForgeOS-recommended
  resolution to `workflow-map.md`'s open question, not the workbook's
  standalone re-pricing pattern). Reuses `EstimateVersion`'s existing
  copy/lock machinery rather than a parallel delta model — the diff is
  computed on read (`computeChangeOrderDiff`) by comparing base vs.
  result line items. UI at `/change-orders/[id]`.
- **`Option`** (alternates, moved from Phase 3) — one full
  `EstimateSection` set per alternate, priced separately from the base
  estimate via `computeOptionTotal`. Implemented as
  `EstimateSection.optionId` (nullable) rather than a duplicate model, so
  it reuses every existing section/line-item function.
- **Design-intake prototype** (moved from Phase 3, minimal scope by
  explicit decision) — `Attachment` is a text reference (filename or an
  external link), not an uploaded file. Draft `LineItem`s
  (`isDraft`/`attachmentId`) are excluded from cost rollups until
  `confirmDraftLineItem` marks them reviewed and priced.
- **Multi-year `Contract` concept** (moved from Phase 3) — **skipped**,
  same reasoning as `PRICE OPTIONS`: no second real multi-year job exists
  yet to validate a `Contract` model against.

## Scope (Phase 5)

- **`Project`** (`web/src/lib/project-service.ts`) — created via "Convert
  to Project" from a WON `Opportunity`, mirroring Phase 2's "Convert to
  estimate" pattern. No direct FK to `Estimate`: both hang off the same
  `Opportunity` already, so a second link would be a redundant path to
  the same data.
- **`WorkOrder`** — timeline milestones (deposit, production meeting,
  artwork deadline, balance due, install) as trackable dates, not the
  workbook's static text.
- **`Task`** — a real worklist per department code (business-rules.md
  Rule 1) or special slot (Rule 3), with an assignee, due date, status,
  and an optional `Vendor` link for procurement tasks.
- **`Shipment`** — carrier, load-list note, ship date, tracking
  reference, status; a self-contained record replacing the workbook's
  broken externally-linked `TRUCKING & LOAD LIST` sheet.
- **`Vendor`** (`/catalog/vendors`) — genuinely new capability, no
  workbook precedent. Scoped minimally: a catalog plus `Task.vendorId`,
  not a full purchase-order model.
- **`ChangeOrder` → `Project`** (carried from Phase 4): decided to leave
  `ChangeOrder` referencing `Estimate` — no functional benefit to moving
  it, since its diff logic only touches `EstimateVersion` data.

## Scope (Phase 6)

- **`CostActual`** (`web/src/lib/cost-actual-service.ts`) — append-only
  actual-cost capture against a locked `EstimateVersion`'s `LineItem`s;
  formalizes `Price Summary`'s `"ESTIMATED COST"`/`"ACTUAL INCURRED"`
  header pair, a concept the workbook names but never populates with real
  data.
- **Variance reporting** — a per-line-item estimated-vs-actual table plus
  a department-level rollup, both shown on the locked `EstimateVersion`
  view in `/estimates/[id]`.
- **AI-assisted estimating and risk detection — deliberately deferred.**
  This phase's own scope gates them on real accumulated
  `EstimateVersion`/`CostActual` history, which doesn't exist yet (no
  real production usage of ForgeOS at the time this phase was built).
  Building them against synthetic history would have broken from this
  project's real-data-driven testing philosophy rather than served it —
  same reasoning as skipping `PRICE OPTIONS` and the multi-year
  `Contract` concept. See `prisma/schema.prisma`'s Phase 6 header
  comment.

## Commands

```bash
npm run dev      # dev server
npm run build    # production build + typecheck
npm run lint     # eslint
npm test         # vitest, against forgeos_test
npm run seed     # loads real labor rate / rental price catalog data
npx prisma studio # inspect the dev database visually
```

## Exit criteria (docs/migration-plan.md Phase 2)

"A real opportunity can be tracked start-to-qualified in ForgeOS with zero
Excel involvement." Verified manually in a browser: created a company, a
contact, and an opportunity; walked it New → Contacted → Qualified with
notes logged at each transition; converted it to a draft estimate
(auto-advancing to Estimating). All state changes persisted to Postgres,
no spreadsheet involved at any point.

## Exit criteria (docs/migration-plan.md Phase 3)

"A new estimate authored entirely in ForgeOS ... produces the same totals
a domain expert would expect from the equivalent Excel workbook." Verified
live in a browser: created an estimate version, set a margin target, added
a section and a line item using Yoku Moku's real Phase-1-validated cost
figure, watched the grand total recompute live, locked the version, then
created a new version from the locked one and confirmed its totals carried
over correctly (a bug caught and fixed during this verification — see
`estimate-service.ts`'s `createNewVersionFromLocked`). Catalog CRUD
(labor rates, materials, rental items) was verified the same way. Full
detail in `docs/migration-plan.md`'s Phase 3 section.

## Exit criteria (docs/migration-plan.md Phase 4)

"A proposal can be generated, sent, and approved end-to-end in ForgeOS
with a full audit trail, for a job whose estimate was also built in
ForgeOS." Verified live in a browser: approved a locked estimate version,
generated a proposal from a real branded template, sent it, and marked it
signed — each step timestamped and attributed. Opened a `ChangeOrder`
against that approved version, edited its result version through the
normal estimate UI, locked and approved it, and confirmed the diff view
showed the correct added line item and dollar delta. `Option` (an
alternate priced separately from the base estimate) and the draft-line-item
workflow (excluded from totals until confirmed) were each verified the
same way. Full detail in `docs/migration-plan.md`'s Phase 4 section.

## Exit criteria (docs/migration-plan.md Phase 5)

"A won project can be tracked from deposit through installation entirely
in ForgeOS, with task ownership and due dates visible to production
staff." Verified live in a browser: converted a WON opportunity to a
Project, set a job number, started a WorkOrder and filled in its
timeline, added a department-coded Task assigned to a user and linked to
a Vendor, and added a Shipment with a carrier and tracking reference —
every step persisted and displayed correctly on reload. A real bug was
caught and fixed during this verification: the Task/Shipment status
`<select>` elements needed `key={status}` to force remount on Server
Action re-render, the same stale-uncontrolled-input bug already fixed
once for the Opportunity stage select in Phase 2. Full detail in
`docs/migration-plan.md`'s Phase 5 section.

## Exit criteria (docs/migration-plan.md Phase 6)

Partially met, by explicit decision. Verified live in a browser: recorded
a real actual cost against a locked estimate's line item, and confirmed
both the per-line-item variance and the department-rollup variance
updated correctly and matched. An acceptance test confirms the variance
math is correct against a real, Phase-1-validated estimated cost. Not
met, by design: a full historical project cycle (estimate → approval →
production → actuals) completed natively in ForgeOS, and the AI-assisted
estimating/risk-detection features that depend on it — both require real
usage accumulating over time, not something buildable in one session.
Full detail in `docs/migration-plan.md`'s Phase 6 section.
