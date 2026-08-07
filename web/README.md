# ForgeOS — web

Phase 2 (`docs/migration-plan.md`): CRM & opportunity shell. TypeScript
full-stack (Next.js 16 App Router + Postgres + Prisma 7), single-tenant
(no `tenant_id` — see `prisma/schema.prisma`'s header comment for why).

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

npm run dev                          # http://localhost:3000
```

`.env` (gitignored) needs:

```
DATABASE_URL="postgresql://<you>@localhost:5432/forgeos_dev?schema=public"
```

`.env.test` (also gitignored) needs the same, pointed at `forgeos_test`.
`src/test/setup.ts` refuses to run if `DATABASE_URL` doesn't contain
`forgeos_test` — the test suite truncates tables between every test.

## Scope (Phase 2 only)

- **Company, Contact, User** — CRUD.
- **Opportunity** — CRUD, a pipeline board (`/opportunities`, grouped by
  stage), and a full stage-change history (`StageChangeEvent`) satisfying
  `data-model-v0.md`'s "stage-change history required (sales reporting)"
  audit note.
- **"Convert to estimate"** — creates a stub `Estimate` (identity fields
  only) and auto-advances the opportunity to `ESTIMATING`. No pricing
  math — that's Phase 3 (`EstimateVersion`/`LineItem`).
- **`AuditEvent`** (the universal audit log in `data-model-v0.md`) is
  out of scope — only the one audit requirement Phase 2 explicitly calls
  for is modeled.

## Commands

```bash
npm run dev      # dev server
npm run build    # production build + typecheck
npm run lint     # eslint
npm test         # vitest, against forgeos_test
npx prisma studio # inspect the dev database visually
```

## Exit criteria (docs/migration-plan.md Phase 2)

"A real opportunity can be tracked start-to-qualified in ForgeOS with zero
Excel involvement." Verified manually in a browser: created a company, a
contact, and an opportunity; walked it New → Contacted → Qualified with
notes logged at each transition; converted it to a draft estimate
(auto-advancing to Estimating). All state changes persisted to Postgres,
no spreadsheet involved at any point.
