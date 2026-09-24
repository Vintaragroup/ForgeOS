# Re-cost review

Status: steps 1-4 built and running on production as of 2026-09-24;
steps 5-6 (the AI proposal stage, and apply + audit) not started. Written
2026-09-23 against Full Swing American Baseball Chicago, which is the
worked example throughout and is still the job every number below comes
from.

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

## What a revised document actually does

A document being replaced does not remove anything from the estimate. It
stops being the authority for what it produced.

This is the correction that reshaped the whole feature, and it came from
the estimator: *"the line items do not disappear unless the client has
requested a full redesign which changes all elements within the exhibit.
If the client loves the design but they want it value engineered to save
costs, all line items need to be flagged as potentially changing but not
necessarily being removed."*

So when `ABCA_2027_Exhibit_Cost_Breakout.xlsx` is superseded, its 192
line items do not go anywhere. They keep sitting in the estimate costing
money, and they carry a flag: **sourced from a document that is no longer
current**. That flag is the whole output of stage 1. Everything after it
decides what to do about each one.

### Two ways a source stops being current

Conflating these is a bug, and they are genuinely different situations:

- **SUPERSEDED** — a newer version of the same document exists. The
  revised schedule against the original schedule. There is a replacement
  to compare against.
- **WITHDRAWN** — the source is no longer valid and nothing replaces it.
  On this job Fuse Technical Group is no longer supplying the AV, so
  quote 369711 V2 is dead: its 16 line items, $46,830 including $18,700
  of Fuse crew and $8,330 of their travel, all come out together. Not
  because anyone reasoned about dependent costs, but because the vendor
  went and took their quote with them.

### Two modes, and the mode sets the default

- **VALUE_ENGINEERING** — the client likes the design and wants cost out.
  Every affected line item is *may change*. `REMOVE` is never
  pre-selected and removals are not what the screen leads with.
- **REDESIGN** — the client wants something different. Removals are
  genuinely on the table.

This job is value engineering, and the numbers show why the distinction
matters: of roughly forty elements, exactly **two** are true eliminations
— the reception counter and one diamond sign logo. Everything else is
repriced, reduced, or re-sourced. A review built to lead with removals
would be wrong about 95% of the job and would push an estimator toward
deleting scope that is only being re-quoted.

### Actions, in the order they actually occur

| action | means | this job |
| --- | --- | --- |
| `REPRICE` | same scope, new number | hanging sign $55,943 → ~$13,000 |
| `RE_SOURCE` | new vendor or cost basis | AV: Fuse rental → purchased screens |
| `REDUCE_QTY` | less of the same thing | hitting bay wall, spines |
| `REMOVE` | genuinely gone | reception counter, one diamond sign |
| `NEEDS_QUOTE` | changed, nobody has priced it | the revised sign |

`RE_SOURCE` is not a removal and not a reprice. The estimating rules
already carry the distinction: §13 separates existing, rental and
purchased property and warns against pricing a rental as a new build,
and §14 lists Rental and Purchased as distinct cost bases.

## Absence is still not evidence of removal

The scoping rules below stand, and they matter most in REDESIGN mode
where removal is a live option. In VALUE_ENGINEERING they do quieter
work: they decide which line items a given document is even allowed to
raise a question about.

A line missing from the revised fabrication sheet may have been cut, or
may simply never have been that sheet's business — the video wall was
never on it either way. This already bit us once in the other direction:
two vendor quotes were suggested as a revision pair when they were an AV
quote and a graphics quote for the same job. Inferring a relationship
from proximity rather than provenance.

1. **Scope every comparison by provenance.** `LineItem.documentId`
   records which document produced each row (212 of v2's 225 carry one).
   A revised document may only speak about line items whose `documentId`
   is its own predecessor.

2. **Rank by evidence, and never pre-select a weak one.** A finding
   supported only by absence is a *question*, not a proposal. Shown
   unchecked, raised as Need Your Decision.

### Drawings need a second scoping rule

Provenance does not work for a drawing, because **a drawing usually
produces no line items at all** — both of ABC Chicago's carry `0`. There
is a path that proposes line items from a drawing, so `documentId` may be
set; in practice on a real job it is not, and a rule that only works when
somebody happened to use that path is not a rule.

So a drawing observation is scoped by **booth** instead, falling back to
a specific line item when it names one unambiguously. Sections carry
`groupLabel` — and note those prefixes are CLIENT names, not positions:
`FS -` is Full Swing and `SS -` is Second Swing, two customers sharing
one workbook. The V1 breakout subtotals them separately ($101,504 and
$100,406) and its own Data Notes tab records three source files that
arrived under the wrong client's name. Stripping the prefix to match a
booth would conflate two customers.

An observation that resolves to nothing is reported as an unmatched
finding rather than dropped. "Something changed and I could not tell you
where" is worth an estimator's attention.

### Corroboration is the confidence signal

| finding | drawing | schedule | AV quote | raised as |
| --- | --- | --- | --- | --- |
| reception counter gone | absent | `Eliminated 091827 TA` | — | **Recommend and Confirm** |
| hanging sign changed | visibly simpler | — | — | Need Your Decision |
| AV re-sourced | screens differ | — | vendor withdrawn | Need Your Decision |

Agreement between two independently scoped sources makes a finding
**Recommend and Confirm**. A single source, especially a single absence,
is **Need Your Decision**. Those are the estimating rules' own two
question types (§1).

**Conflict is surfaced, never resolved silently.**

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

One screen, grouped by element, and it **leads with the gap rather than
the saving**. On this job the reductions are large and still nowhere
near the target, and a screen that celebrates $180,000 of savings while
the number is $111,000 over is actively misleading.

```
RE-COST REVIEW — version 2        value engineering
target $250,000

  fabrication   re-costed by TA 9/18            −61,028
  hanging sign  needs a revised quote           −42,943  est.
  lit letters   optional, appears out           −43,750  ?
  AV            Fuse withdrawn, 5 x $2,800      −32,830  + labour
  banners, G-Floor                               no change

  projected                                    ~$361,000
  STILL OVER BY                                 ~$111,000

  the only untouched items with that much in them:
    FS - Lit Angled Spines (Lounge)              37,281   no change
    SS - Lounge Wall Structure                   47,798   no change
```

Rules for this screen:

- Nothing applies until the estimator presses apply.
- Every row shows its source and a verbatim quote. A row with no citation
  does not exist.
- In VALUE_ENGINEERING, `REMOVE` is never pre-checked and never leads.
- `Recommend and Confirm` rows start checked; `Need Your Decision` rows
  start unchecked.
- A removal whose replacement is unpriced is **never shown as a saving**.
  The AV line reads "−$32,830 + labour", not "−$32,830".
- The gap to the client's number is the headline, and when the changes
  do not reach it the screen says so and names where the remaining money
  actually is.

### 4. Apply

- `REMOVE` soft-deletes the line item; the row stays for audit.
- `REDUCE_QTY` / `REPRICE` writes the new value and recomputes totals.
- `ADD` creates a draft line item, consistent with import's posture that
  new rows arrive as drafts pending review.
- Every change writes a `LineItemAuditLog` row citing the proposal and
  its source document, so "why is this gone?" is answerable in three
  weeks.
- The whole apply is one transaction, then one `recomputeVersionTotals`.

## Three worked cases, from the real job

These are the three shapes a finding takes. Every element on ABC Chicago
is one of them.

### 1. Written down — read it, do not infer it

`Full Swing @ ABCA 2027 estimates updated 091826.xlsx` carries a status
column, initialled and dated by the estimator:

```
FS - Hitting Bay Wall     43,849 → 19,202   Updated 091826 TA
FS - Diamond Sign 3'1      6,110 →  2,542   Updated 091827 TA
FS - Diamond Sign 5'4      2,508 →      0   Eliminated 091827 TA
FS - Diamond Sign 6'6      4,288 →  2,550   Updated 091827 TA
FS - Reception Counter     7,469 →      0   Eliminated 091827 TA
FS - Lit Spines (Lounge)  37,281 → 37,281   No change 091827 TA
SS - Lit Spines (Hit Bay) 52,608 → 31,510   Updated 091827 TA
SS - Lounge Wall          47,798 → 47,798   No change 091827 TA
                         201,910 → 140,883        −61,028
```

**This is the primary source and it beats every inference.** It is
deterministic, exactly citable, and signed by the person who made the
decision. No vision call competes with it, and the review must read it
rather than re-derive it from renderings.

It is also why the drawing comparison's job is smaller than it first
looked: it exists to corroborate this, and to cover what this does not —
which is most of the money.

### 2. Visible but unspecified — describe it, suggest, and ask

The system can see *what* changed and cannot price it. That is exactly
Recommend and Confirm: state the observation, propose a treatment, ask
for the number. It must never invent the missing spec.

```
HANGING SIGN — changed, needs a revised quote     Recommend and Confirm

  v1 specified   90' x 20' x 8' tapered (8' thickest → 4' thinnest)
                 double-sided stretch fabric
                 2 large can letter sets 24' x 5'9"
                 1 small can letter set 13' x 3'
                 1 edge-lit diamond sign 5'3.5" sq
                                       COMPONENTS.pdf p2

  v2 shows       one uniform height, no dimensional letters,
                 printed fabric only
                                       90X20 9-16-2026.pdf p1, p5

  Suggested      single-height tension-fabric (pillowcase) sign;
                 the can letter sets and the edge-lit diamond
                 appear to be out

  Currently      $55,943  Hanging Sign        (IAC 55672)
                 $43,750  Lit Letters & Logo  — marked Optional
```

The discipline is in "appears to be out". No sheet states the new height,
so the review does not state one either. The estimator supplies the
dimension; the system supplies the observation that it changed, the
evidence for it, and a proposed treatment.

### 3. Vendor withdrawn — the quote goes, the scope does not

```
AUDIO VISUAL — vendor changed                      Need Your Decision

  Fuse Technical Group is no longer supplying this scope.
  Withdrawing quote 369711 V2 removes 16 line items, $46,830:

     35 Brompton LED tiles + processor + fibre + media server
     8 x 55" portrait monitors, 2 x 65" flown monitors
     $18,700 Fuse crew   (LED engineer 9d, media server prog 5d)
     $8,330 travel       (2 airfare, 15 hotel, 15 per diem)

  Replaced by    5 x 100" monitors purchased at $2,800 = $14,000
                 plus in-house install labour
  Needs          the labour estimate
```

The crew and the travel leave because the vendor leaves. Nothing has to
reason about dependent costs here — vendor withdrawal takes its whole
quote with it, which is both simpler and more correct than inferring that
an LED engineer follows an LED wall.

### And the fourth shape: silence

Banners $5,098 and G-Floor $21,655 are unchanged. They are recorded as
unchanged and **not raised as questions**. A review that lists everything
is a review nobody reads twice.

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

Three additions, and the first is the one that carries the reframe.

**Document validity.** A document is `CURRENT`, `SUPERSEDED` (a newer
version exists) or `WITHDRAWN` (the source is dead, nothing replaces it).
Today ForgeOS models only the supersedes link, which makes those last two
indistinguishable — and they are completely different situations for the
line items hanging off them.

```prisma
enum DocumentValidity { CURRENT  SUPERSEDED  WITHDRAWN }

model Document {
  // ...
  validity       DocumentValidity @default(CURRENT)
  // Why it stopped being current, in the estimator's words -- "Fuse is
  // no longer supplying AV on this job". Read by the review, so it is
  // worth a sentence rather than a flag alone.
  validityNote   String?
  validityAt     DateTime?
}
```

Nothing is deleted when validity changes. A line item whose
`documentId` points at a non-`CURRENT` document is **stale**, which is a
derived read, not a stored one: it is in the estimate, it still costs
money, and it is a candidate for a question. That is the entire
mechanism.

**The re-cost itself**, so a review survives being left and returned to,
and so the mode is recorded rather than re-guessed each time.

```prisma
model RecostReview {
  id                String       @id @default(cuid())
  estimateVersionId String       // the OPEN version
  proposalId        String?      // the REVISIONS_REQUESTED proposal
  mode              RecostMode   // VALUE_ENGINEERING | REDESIGN
  targetAmount      Decimal?     // the client's number, when stated
  createdById       String?
  proposals         RecostProposal[]
}

enum RecostMode { VALUE_ENGINEERING  REDESIGN }
```

**The proposals**, as already specced, with `RE_SOURCE` added and a
vendor field, because "who is supplying this" is the thing that changed
on the AV and it is not expressible as a price or a quantity.

```prisma
model RecostProposal {
  // ... as before ...
  action         RecostAction  // REMOVE | REDUCE_QTY | REPRICE
                               // | RE_SOURCE | ADD | NEEDS_QUOTE
  newVendorName  String?       // RE_SOURCE only
  newCostBasis   String?       // RE_SOURCE only -- "purchase" vs "rental"
}
```

All expand-only: new enums, new nullable columns, one new table.

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

Reordered by what the real documents turned out to contain. Reading the
estimator's own status column is now step one, because it is the primary
source and it needs no AI at all.

1. **Document validity.** The enum, the column, and the UI to mark a
   document superseded or withdrawn. Line items read as stale from it.
   Standalone value: "these 16 line items come from a quote by a vendor
   who is off the job" is worth knowing on its own.
2. **Read the status column.** Parse `Updated` / `Eliminated` /
   `No change` out of a revised schedule and turn it into proposals
   directly. Deterministic, exactly citable, and on this job it is
   $61,028 of the answer.
3. **The re-cost review screen**, gap-led, over those two sources alone.
   At this point the feature is useful with no AI in it. *Built —
   `recost-rollup.ts` does the arithmetic, `recost-review-service.ts`
   assembles it, `RecostReviewCard` renders it under the steps card on
   the estimate. On Full Swing it reads: projected $558,146, still over
   by $308,146, with the Fuse quote's $46,830 held separately as
   unpriced rather than counted as a saving.*
4. **Drawing comparison into the review** — corroboration, plus the
   changes no spreadsheet covers, like the sign. *Built —
   `recost-corroboration.ts` pairs each drawing finding with a schedule
   row by token containment, never by a model. On Full Swing the two
   sources agree about the reception counter ($7,469, "Eliminated 091827
   TA" and gone from sheet 7) and disagree about six other things,
   including two additions nobody has priced. `readStoredComparison`
   also cleans contradictions out of comparisons written before that fix
   existed, which is why the hanging banners stopped reading as both
   removed and moved.*
5. **The AI proposal stage** for what is left: mapping an observation
   onto line items, and the Recommend-and-Confirm questions.
6. **Apply + audit.**

Steps 1-3 carry most of the value and none of the risk. If the AI stage
never proves reliable on a second job, the feature still works.

## Answered by the estimator

These were working assumptions. The estimator has since answered them
directly, and the answers reshaped the feature rather than just filling
blanks.

**Cut scope is not cut.** *"The line items do not disappear unless the
client has requested a full redesign which changes all elements within
the exhibit. If the client loves the design but they want it value
engineered to save costs, all line items need to be flagged as
potentially changing but not necessarily being removed."* Hence
`RecostMode`, and hence `REMOVE` never leading a value-engineering
review. The Option question is moot: nothing is being moved out of the
base scope, it is being re-quoted in place.

**A withdrawn vendor takes its quote with it.** *"Fuse will not be the
vendor on this job now so the quote will be removed from the estimate
and replaced by the purchase price for the monitor along with our
estimate of labor to install the 5 100" monitors."* That is `RE_SOURCE`,
and it answers the dependent-cost question far more cleanly than
inference would: the LED engineer and the hotel nights leave because the
vendor leaves.

**When the documentation does not state the change, suggest and ask.**
*"The system should flag the sign as a change and ask the question if the
documentation does not specifically state what the change is. It should
give a suggestion."* Which is Recommend and Confirm, applied to a case
where the evidence is visual and the number is missing.

Still open: the $500 materiality threshold, and whether the newest
document in a chain simply controls. Neither blocks the build.

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
