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

## Two worked cases

### The clean one: the reception counter

Every source agrees, and none of them needed a label.

The superseded drawing described it from the picture alone — no tag, no
callout naming it:

```
p7: L shape reception counter dimensions: 8' x 6' x 40".
p7: Counter thickness: 20".
p7: Include 3" white LED toe kick, 5 lockable doors, 1 shelf ...
p7: 4'6" x 1' pierce logo with white LED glow.
```

The revised drawing: absent from all 33 extracted items. The revised
schedule: absent from all 150 rows — no `reception`, no `counter`. The
estimate: `FS - Reception Counter`, 25 line items, **$7,917**.

Two independently scoped sources agree, so this is `stated`, checked by
default, and applies as one booth-level removal. No judgement call.

### The hard one: AV with no revised quote

This is the case that shapes the feature, and the naive answer is wrong.

**A removal is not one line.** The video wall's own line is $16,460. The
AV quote produced sixteen line items totalling $46,830:

| | |
| --- | --- |
| LED Screen 8'h x 11.39'w | $16,460 |
| LED Lead Engineer (4 entries) | $8,550 |
| Media Server Programmer (2 entries) | $6,750 |
| Video Utility (3 entries) | $3,400 |
| Power Package, Data Package | $1,600 |
| Truck, airfare, hotel, per diem | $10,070 |

A Media Server Programmer for four days exists **because there is an LED
wall to drive**. Two 100" televisions on brackets do not need one, and do
not need him flown in and housed for fifteen nights. A line-by-line diff
cuts $16,460 and leaves $30,370 of crew and travel for equipment that is
no longer in the booth.

So removals carry **dependent costs**, and the review has to propose the
dependents alongside the thing itself — grouped, so the estimator sees
"remove the video wall and its crew, −$46,830" as one decision with its
parts visible, not sixteen unrelated rows. Getting this wrong is not a
rounding error; on this job it is most of the gap to the client's number.

Dependents are proposed at `inferred` and never auto-applied. The link
between an LED engineer and an LED wall is real but it is a judgement,
and the estimator is the one who knows whether that engineer is also
running something else.

**The replacement cannot be priced, and must not be guessed.** The
catalog has `43"`, `55"` and `65" Flat Screen Monitor & Mount Bracket` —
no 100" entry, and every one of those carries a null unit cost. There is
no honest number available for two 100" screens.

What the review does instead:

1. Proposes the removals, with their dependents, at `inferred`.
2. Raises a **gap**: this booth now has scope with no price.
3. Proposes a **bid package** for the AV trade, with the scope read off
   the drawing — *"two 100" LED screens, mounted"* — which is the artifact
   you send the vendor to get the number. `BidPackage.tradeCode` already
   exists for exactly this.

The estimate is then honestly incomplete rather than dishonestly
complete, and the next action is obvious and belongs to a person.

**A removal whose replacement is unpriced is never silently a saving.**
The running total must show the booth as unpriced, not as $46,830
cheaper — otherwise the review reports hitting the client's budget by
deleting scope that is coming straight back at an unknown price.

## What the estimating rules already settle

`data/Estimate-Guidelines/Custom and standard assemblies Estimating
rules.pdf` — Taze Ankerstein, 2026-09-21 — is the estimating playbook for
EXPO Orlando. It is written for estimating from scratch and says nothing
about revisions, but several of its rules govern this feature directly
and should be followed rather than re-invented.

**Use its question vocabulary, not ours.** §1 already defines the two
kinds of question an estimator is allowed to raise:

- **Need Your Decision** — the documentation does not support a reliable
  determination.
- **Recommend and Confirm** — a method can be recommended, but the
  selection materially affects the estimate.

That is a better split than `stated` / `inferred`, because it says what
the reader must *do* rather than how sure the machine is. A reception
counter absent from two independent sources is Recommend and Confirm. A
removal resting on one absence is Need Your Decision. The confidence
field should carry these names.

§1 also sets the precedence this feature must respect: project-specific
instructions override general rules, and **when governing sources
conflict, identify the conflict and confirm which source controls** —
which is the conflict rule above, already house policy.

**Citation is already required.** §2: *"Record the drawing, page, and
revision used."* The `sourceQuote` + `sourceDocumentId` requirement is
not a new discipline, it is the existing one.

**Flagging beats guessing, in their words.** §2: *"Flag unknown
dimensions instead of guessing"* and *"Do not apply arbitrary percentage
inflation."* This is exactly why the review may say the sign changed
shape and may not say it is three feet tall.

**Three rules constrain what a drawing may conclude.** These are the
sharpest constraints in the document for a vision-based comparison, and
all three forbid inferring cost from a picture:

- §11: *"Do not infer LED strips, drivers, power supplies, dimmers, or
  power strips solely because a rendering shows illumination."*
- §10: *"Do not automatically assume every monitor requires a mount"*,
  and confirm responsibility for monitors, mounts, brackets, screens,
  cabling, power strips, AV hardware.
- §15: *"Do not assume the following without supporting scope or
  direction: Hardware, Mounts, Power accessories, Freight, Installation,
  Engineering, Repairs, Refurbishment."*

So a rendering showing two screens may **not** generate mounts, brackets,
cabling or power. It generates an observation and a question. This is the
single rule most likely to be violated by a naive implementation of the
paired-image comparison, and it is worth encoding as a refusal in the
prompt and a filter on the output.

**Shared labour does not scale with quantity.** §9: *"Distinguish shared
labor from unit-based labor"* and *"Do not multiply shared labor blindly
by unit quantity."* A `REDUCE_QTY` proposal that halves the hitting bays
must not halve planning, drafting or programming. Shared-labour lines are
excluded from proportional reduction and raised separately.

**Some costs recompute rather than being removed.** §13 sets the
rental-booth I&D consumables allowance at $1.00/sq ft for 100–1,600 sq ft
and $0.50/sq ft above that. It is derived from booth size, so shrinking
scope changes it by recalculation, not by a removal proposal. The same
shape applies to any per-project or percentage-based line — which
answers the open question about Show Services Management: **recompute,
never propose for removal.**

**And one rule that may reshape the whole feature.** §14: *"Optional,
removable, alternate, or value-engineering features must remain separable
from the base scope."*

What the client has asked for here is value engineering. Read strictly,
that rule says the cut scope should stay separable rather than be deleted
— which points at ForgeOS's existing `Option` model rather than at
soft-deleting line items. Worth settling before building the apply stage,
because it changes what apply does. See the open questions.

## Gaps the rules do not cover

None of these are failures of the document; it was written to govern
estimating a job, not revising one.

1. **Revisions are out of its scope entirely.** There is no rule for what
   happens when a design changes: whether removed scope is deleted or
   retained as an alternate, whether a superseded drawing still governs
   anything, or how to record why something left the estimate.
2. **It says what to include, never what to release.** §15's "do not
   assume" list disciplines *adding* hardware, freight, installation and
   engineering. Nothing states the converse — that when the equipment
   those costs existed for is removed, they are candidates to come out
   too. The symmetry is obvious to an estimator and absent from the text,
   which is exactly the kind of thing that should not be inferred by a
   machine without being written down.
3. **Vendor crew is not modelled.** §10 covers AV hardware and
   responsibility. It says nothing about a vendor's labour scaling with
   the equipment — an LED Lead Engineer and a Media Server Programmer
   exist because there is an LED wall, and that relationship has no rule.
4. **"Materially affects" is undefined.** §1 gates questions on material
   effect on cost, scope, fabrication method, labour, finish, schedule,
   installation or responsibility. With no threshold, the review has no
   principled way to decide which findings are worth a person's
   attention and which are noise.
5. **Revision precedence is unstated.** §2 says to record the revision
   used; §1 says to identify conflicts. Neither says the newer drawing
   controls — which is nearly always true and should be stated, so the
   system can act on it rather than asking every time.

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
  action            RecostAction      // REMOVE | REDUCE_QTY | REPRICE | ADD | NEEDS_QUOTE
  dependsOnId       String?           // the removal this one follows from --
                                      // an LED engineer removed because the
                                      // LED wall was. Grouped in the review,
                                      // decided together, never automatic --
                                      // the rules forbid assuming freight,
                                      // installation or engineering without
                                      // supporting scope (§15), and the
                                      // converse is not written down at all.
  newQty            Decimal?
  newUnitCost       Decimal?
  reason            String
  sourceDocumentId  String
  sourceQuote       String
  confidence        RecostConfidence  // RECOMMEND_AND_CONFIRM | NEED_YOUR_DECISION
                                      // -- the estimating rules' own two
                                      // question types (§1), not a
                                      // second vocabulary for the same idea
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

4. **How far do dependent costs reach?** Partly answered: §13 makes
   size-derived allowances recompute rather than be removed, and the same
   applies to any per-project or percentage line, so Show Services
   Management recomputes. Unanswered for vendor crew -- an LED Lead
   Engineer and a Media Server Programmer exist because there is an LED
   wall, and no rule covers that. Needs Taze.

5. **Should cut scope be deleted, or kept as an alternate?** §14 says
   optional, removable, alternate and value-engineering features must
   remain separable from the base scope. What the client has asked for
   IS value engineering. Read strictly, the reception counter should move
   to an `Option` rather than be soft-deleted -- which preserves the
   ability to show the client what their budget bought and what it cost
   them, and is a different apply stage from the one specced. This is the
   biggest open decision in the document.

6. **What counts as "materially affects"?** §1 gates every question on
   it and never defines it. Without a threshold the review cannot tell a
   finding worth raising from noise. A dollar figure, a percentage of
   booth cost, or both.

7. **Does the newer drawing simply control?** §2 requires recording the
   revision used and §1 requires identifying conflicts, but nothing says
   the later drawing wins. It nearly always does; stating it lets the
   system act instead of asking every time.
