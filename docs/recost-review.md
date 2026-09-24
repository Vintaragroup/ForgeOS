# Re-cost review

Status: proposed, not built. Written 2026-09-23 against Full Swing
American Baseball Chicago, which is the worked example throughout.

## The problem

A client asks for a cheaper number. On ABC Chicago:

> "client requested a revised design and estimate to meet their budget of
> 250k"

v2 stands at **$658,785.10** across 225 line items and 10 booths. The
client wants roughly **$250,000**. Reaching it means taking things out.

Their actual changes, as described by the estimator:

| change | what it touches in v2 |
| --- | --- |
| video wall removed, one 100" LED TV mounted instead | `LED Screen 8'h x 11.39'w — and monitor` $16,460, plus cantilever mounts $7,049 |
| touch screens replaced by two 100" LED screens | AV quote lines |
| hanging sign simplified to 3'H x 20' x 90' SEG | `Hanging Sign` $55,943 |
| reception counter removed | `FS - Reception Counter` booth — 25 items, $7,917 |
| most structure over the batting cage removed | `FS - Hitting Bay Wall` $44,477, `SS - Lit Spines Hit Bay` $54,240 |

Four of those five are **removals**. ForgeOS today cannot express a single
one of them.

## Why the existing paths don't get there

**Import is additive.** The revised spreadsheet parses to 150 rows; 89
match existing line items and are excluded as duplicates. The button
offers to *commit 61 draft line items*. Commit it and v2 goes from 225
items to 286 and the total goes **up**. There is no code path in import
that removes or reduces anything.

**The document diff only works on priced documents.** `document-diff.ts`
compares a revised document's parsed rows against the line items its
predecessor produced. That is correct and useful for a **vendor quote
PDF**, which carries prices. It cannot work on a `PRICING_SCHEDULE`
spreadsheet: that parser reads category/item/description/unit/qty and no
price at all (`unitCost: row.catalogMatch?.unitCost ?? 0` — the money
comes from the catalog at import). A pricing schedule is the blank form
you price against, not a document containing prices.

**`scope-diff.ts` exists and is unwired.** It compares two schedules on
scope — dropped, added, quantity moved — which is the right comparison
for a spreadsheet. Nothing calls it yet.

**The drawing is qualitative.** The revised drawing now analyses (33 scope
items after the batching fix) and its extraction does corroborate the
changes: no reception counter anywhere, `Two display screens showing
split-screen baseball statistics`, no video wall. But it is a rendering
package, and it says so itself — *"no dimensions or specifications called
out on these rendering pages"*. It can tell you the counter is gone. It
cannot tell you the screens are 100".

So: **no single document carries the whole change.** The scope change is
in the spreadsheet, the AV change is in the AV quote, and the design
change is in the drawing. A re-cost review has to read all three.

## The correctness risk that shapes everything

**Absence is not evidence of removal.**

A line item missing from the revised spreadsheet may have been cut — or
may simply live in a different document. The fabrication sheet never
mentioned the video wall; that does not mean the video wall was removed,
it means the video wall was never that sheet's business. Proposing its
removal on that basis would be confidently wrong.

This already bit us once this session, in the other direction: two vendor
quotes were suggested as a revision pair when they were an AV quote and a
graphics quote for the same job. Same error class — inferring a
relationship from proximity rather than provenance.

Two rules follow, and they are the spine of this feature:

1. **Scope every comparison by provenance.** `LineItem.documentId` records
   which document produced each row (212 of v2's 225 carry one). A
   revised document may only propose changes to line items whose
   `documentId` is its own predecessor. A fabrication sheet can propose
   removing fabrication lines and nothing else.

2. **Rank by evidence, and never pre-select a weak one.** A removal
   supported only by absence is a *question*, not a proposal. It is shown
   unchecked, labelled as inferred, and requires a human tick.

### Drawings need a second scoping rule

Provenance does not work for a drawing, because **a drawing usually
produces no line items at all** — both of ABC Chicago's carry `0`. There
is a path that proposes line items from a drawing, so `documentId` may be
set; in practice on a real job it is not, and a rule that only works when
somebody happened to use that path is not a rule.

So a drawing observation is scoped by **booth** instead. Sections carry
`groupLabel` — `FS - Reception Counter`, `SS - Lit Spines Hit Bay` — and
that is the vocabulary a rendering actually speaks: the model describes a
reception counter, not a line item. A drawing observation resolves to a
booth, and may propose changes only to that booth's sections.

An observation that resolves to no booth is reported to the estimator as
an unmatched finding rather than dropped. "The drawing shows something
changed and I could not tell you where" is useful; silently discarding it
is not.

### Corroboration is the confidence signal

The three sources overlap, and where they agree the evidence is strong:

| finding | drawing | schedule | AV quote | confidence |
| --- | --- | --- | --- | --- |
| reception counter gone | absent | absent | — | **stated** — two independent sources |
| video wall gone | absent | never present | needs the revised quote | inferred without it |
| hanging sign simplified | changed shape | — | — | inferred |

Agreement between two sources that were scoped independently promotes a
finding to `stated`. A single source, especially a single absence, stays
`inferred`.

**Conflict is surfaced, never resolved silently.** If the schedule still
carries a reception counter row and the drawing no longer shows one, that
is a real question for a human — the drawing may be older, or the sheet
may not have been updated. The review shows both and proposes neither.

## What is being compared against what

Two different baselines, and conflating them would be a bug.

**Documents compare against the documents they supersede.** The revised
schedule against the original schedule, the new drawing against the
drawing it replaces, a revised AV quote against the AV quote it replaces.
The `supersedesId` chain already models this and is set by hand, so the
system never has to guess which document answers which.

**Findings apply against the version the client actually received** —
the locked one the sent proposal was built from, v1 here. That is the
thing the client looked at and asked to change. The open version (v2) is
where the changes land, and on ABC Chicago it is currently an exact copy
of v1, so the two coincide today. They will not always: if an estimator
has already started re-costing by hand, proposing against v2 would
propose removing things they have already removed.

So: **baseline is the locked version, target is the open version.** The
review reads the locked one and writes the open one, and a finding whose
line item no longer exists in the open version is reported as "already
handled" rather than proposed again.

## Shape

Four stages. The first is deterministic and the second is the only one
that uses AI.

### 1. Evidence (deterministic, no AI)

Every revised document linked as superseding another is compared, and all
three kinds run — a re-cost reads the design, the scope and the pricing
together, because no one of them carries the whole change:

| document type | comparison | scoped by | yields |
| --- | --- | --- | --- |
| `VENDOR_QUOTE` (priced) | `computeDocumentDiff` — exists | provenance | REMOVED / ADDED / repriced, with amounts |
| `PRICING_SCHEDULE` | `computeScopeDiff` — exists, unwired | provenance | dropped / added / qty moved, no money |
| `DRAWING` / CAD / rendering | paired-image vision call — new | booth | qualitative presence, absence, changed form |

The drawing comparison is new and is the loosest of the three.

**It compares the images, not two descriptions of them.** The obvious
build is to diff the two `extractedSummary` scope lists, and that is too
weak to rely on: each summary was written independently, answering "what
is on this sheet", with no knowledge that another sheet exists. Neither
was ever asked to notice a change. On the hanging sign that yields

```
old:  Hanging sign dimensions: 90' x 20' x 8' (8' at thickest point,
      4' at thinnest point) double sided stretch fabric
new:  Overhead signage structures displaying 'FULL SWING KIT' ...
      - no dimensions provided
```

which is enough to flag "described differently" and not much more. The
difference that matters — a thick tapered fabric volume becoming a flat
band — is visible in the renderings and absent from both texts.

So the comparison pairs the two documents' page images in a single vision
request and asks what changed between them. That needs no dimension
label, no callout, and no tag naming the object: the model is looking at
two pictures. This is the one comparison in the feature that works on a
rendering package, which is what a revised design usually arrives as.

Notes on doing it well:

- **Page pairing is the hard part.** Two renderings rarely share a page
  order, and sheet 3 of the old set is not necessarily sheet 3 of the
  new. Pair by what the sheet shows, not by index — and where pairing is
  ambiguous, send the full sets and let the request handle it rather than
  guessing a pairing and comparing the wrong two.
- **Batch it the same way.** Two drawings' images together will exceed
  one request more often than one drawing's did; `chunkPagesByBudget`
  already handles this, and pages must stay legible — shrinking them to
  fit produced an empty extraction once already.
- **This is not `artwork-image-diff.ts`.** That is a pixelmatch diff for
  a vendor proof against approved artwork: same artwork, same size,
  looking for small deviations. Two booth renderings from different
  viewpoints would diff as near-totally different and mean nothing. The
  technique does not transfer; only the vision call does.
- **It still cannot invent a number.** It can report the sign is now a
  flat band rather than a tapered volume. It cannot report that the band
  is 3 feet tall unless a sheet says so. The estimator supplies the
  dimension; the system supplies the observation that it changed.

### 2. Proposal (AI, ADVANCED_MODEL)

The deterministic stage cannot map *"the reception counter is absent"* to
*"these 25 line items"*, nor *"a simpler SEG sign"* to a quantity. That
mapping is the AI's job, and it is the only thing it is asked to do.

Input:
- the client's own request note
- v2's booths, sections and line items with costs
- every observation from stage 1, with its source document
- the catalog rows available for anything newly added

Output, one row per proposed action:

```
{ lineItemId | sectionId, action: REMOVE | REDUCE_QTY | REPRICE | ADD,
  newQty?, reason, sourceDocumentId, sourceQuote, confidence }
```

`sourceQuote` must be verbatim from the cited document, the same
citation discipline the drawing and scope extractors already follow. A
proposal that cannot cite is dropped before it reaches a human.

Per `forgeos_multiproject_advanced_model_required` this runs on
ADVANCED_MODEL: it reasons across several named documents at once, which
is exactly the case BASIC_MODEL gets wrong.

Per `forgeos_ai_soft_instructions_unreliable`, correctness here is
enforced by validating the output against the database — every
`lineItemId` must exist in the open version, every `sourceDocumentId`
must be one of the documents actually supplied — not by asking the prompt
nicely. Anything failing validation is discarded and counted, not
repaired.

### 3. Review

One screen, grouped by booth, because that is how the estimator and the
client both talk about it.

```
RE-COST REVIEW — version 2                    target $250,000
current $658,785      proposed $?????      still over by $?????

FS - Reception Counter                         −$7,917   [x] remove booth
  25 items · absent from the revised drawing
  "no reception counter shown"            drawing p7   inferred

RENTAL                                        −$16,460   [x] remove
  LED Screen 8'h x 11.39'w — and monitor
  "video wall removed, 100in LED TV mounted"  AV quote   stated
```

Rules for this screen:

- Nothing is applied until the estimator presses apply.
- Every row shows its source and its quote. A row with no citation does
  not exist.
- `inferred` rows start unchecked. `stated` rows start checked.
- The running total updates as boxes change, against the client's number.
  Getting to the target is the whole job; the screen should answer "are
  we there yet" without arithmetic.
- Nothing here touches a locked version. The review only ever writes to
  the open one.

### 4. Apply

- `REMOVE` soft-deletes the line item; the row stays for audit.
- `REDUCE_QTY` / `REPRICE` writes the new value and recomputes totals.
- `ADD` creates a draft line item, consistent with import's posture that
  new rows arrive as drafts pending review.
- Every change writes a `LineItemAuditLog` row citing the proposal and
  its source document, so "why is this gone?" is answerable in three
  weeks.
- The whole apply is one transaction, then one `recomputeVersionTotals`.

## Data model

One new table. Proposals are durable because the review is not a single
sitting — an estimator will run it, leave, and come back.

```prisma
model RecostProposal {
  id                String   @id @default(cuid())
  estimateVersionId String            // the OPEN version being re-costed
  proposalId        String?           // the REVISIONS_REQUESTED proposal
  lineItemId        String?
  sectionId         String?
  action            RecostAction      // REMOVE | REDUCE_QTY | REPRICE | ADD
  newQty            Decimal?
  newUnitCost       Decimal?
  reason            String
  sourceDocumentId  String
  sourceQuote       String
  confidence        RecostConfidence  // STATED | INFERRED
  status            RecostStatus      // PROPOSED | ACCEPTED | REJECTED | APPLIED
  decidedById       String?
  decidedAt         DateTime?
}
```

Expand-only, matching how every migration in this repo has been done.

## Deliberately out of scope

- **Re-pricing from the catalog on a REPRICE.** Import already owns
  catalog matching; this feature proposes *what changes*, not what a
  thing costs.
- **Touching a locked version.** v1 is what the client received.
- **Auto-apply, at any confidence.** Not a phase-2 idea either. The
  entire value is a human reading a citation and deciding.
- **Guessing at a dimension the drawing does not state.** If the sheets
  do not say 100", the review does not say 100" — it says "screens
  changed, specifications not provided", which is what the extraction
  actually found.

## Build order

1. Wire `computeScopeDiff` into the import preview. Standalone value —
   it shows what the client dropped before anything is committed — and it
   is stage 1's spreadsheet half.
2. Drawing-vs-drawing comparison as a paired-image vision call. This is
   the step that reads a revised design with no dimensions on it, so it
   carries most of the feature's value on a rendering package -- and it
   is the step most likely to need iterating on page pairing.
3. `RecostProposal` model + the AI proposal stage, behind a button, with
   output validated against the database.
4. The review screen.
5. Apply + audit.

Each step is useful alone, which matters: if the AI stage proves
unreliable on real jobs, steps 1 and 2 still stand on their own and the
estimator does the mapping by eye.

## Open questions

1. **Does the AV change need a new document?** The revised AV quote does
   not appear to be uploaded. Without it the two 100" screens have no
   priced source, and the review can only say the old video wall is gone
   -- an unpriced removal, with nothing to put in its place. This is the
   clearest case of the three-source rule: the drawing shows the screens
   changed, the schedule is silent because AV was never its business, and
   only a revised quote can say what the new ones cost.
2. **How is a whole-booth removal expressed?** Proposing 25 individual
   removals for the reception counter is noisy. A booth-level action that
   expands to its line items reads better — worth confirming that matches
   how an estimator thinks about it.
3. **What happens to a client-owned or `excludedFromTotals` line?** They
   do not move the total, so a removal proposal for one is noise.
   Suggest: exclude from the review entirely.
