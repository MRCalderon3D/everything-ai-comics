# The Night Ferry

A complete sample workspace: a two-page noir one-shot adapted from a short
prose text. A ferry pilot finds a stowaway the harbour patrol is hunting, and
decides not to hand him over.

It is small on purpose. Two pages are enough to show a source adaptation with
a user change, a panel ledger that has something to track, a failed review, a
repair, a cover, and a draft edition.

## The images are placeholders

Every PNG in this workspace is a flat placeholder: the four reference
"masters", the three page renders, and the cover render. They let paths resolve and give the
scripts files to work with. They are not art, and the reviews do not describe
them. The review files show what a finding and its evidence look like when a
real page is inspected.

## What is here

```
the-night-ferry/
  project.yaml                      paged, monochrome, lettering in the image, provider harness-native
  story/
    source/night-ferry.txt          the source prose, nine paragraphs
    story-bible.yaml                thirteen facts: nine from the source, one user change, three additions
    series-plan.yaml                one issue
  style/                            style bible, frozen style block, color script
  characters/CHAR_MARA/             character.yaml, wardrobe.yaml, refs/
  characters/CHAR_OSKAR/            character.yaml, wardrobe.yaml, refs/
  locations/LOC_FERRY_DECK/         location.yaml, map.yaml (levels deck and wheelhouse), refs/
  props/PROP_FLARE_GUN/             prop.yaml
  props/PROP_TARPAULIN/             prop.yaml
  references/manifest.yaml          registry of the four reference assets
  issues/ISS_001/
    issue.yaml                      "Crossing", 2 pages, 8 panels
    scenes/SC_001_01.yaml           one scene on the ferry deck
    pages/PG_001_001/               page.yaml, reference-plan.yaml, prompts/, renders/, reviews/
    pages/PG_001_002/               page.yaml, reference-plan.yaml, prompts/, renders/, reviews/
    cover/                          cover.yaml (approved), prompts/, renders/CV_001_V01.png, reviews/
  generations/                      one record per generation attempt
  continuity/ISS_001.final-state.yaml
  editions/ED_001_01/edition.yaml   draft edition with the cover first, no exports yet
```

## What to read first

Start with `story/story-bible.yaml`. In the source the boy hides in a chain
locker. `FACT_010` is a user change that moves him under a tarpaulin on the
open deck and replaces `FACT_007`. The change reaches the location dressing,
a new prop, and one line of dialogue.

Then open `issues/ISS_001/pages/PG_001_002/page.yaml`. Its ledger rows show
the rules that `check-continuity.js` enforces:

| What happens | Where | How the ledger records it |
|---|---|---|
| Mara takes the flare gun. | PG_001_001, panel 4 | A `transfers` entry (`pickup`), the gun moves from `props` to her `holding`. |
| Mara goes from the wheelhouse to the deck. | PG_001_002, panel 1 | Her row sets `moved`, and the descent is drawn. |
| Mara lifts the tarpaulin, then lets it go. | PG_001_002, panels 3 and 4 | Two `transfers` entries. In panel 3 she holds two props, one hand each. |
| Oskar is hidden for six panels. | PG_001_001, and panels 1 and 2 of PG_001_002 | An `off_panel: true` row in each of them keeps his position and his state. |
| Oskar's left hand is cut. | Every row of his | The state tag `cut_left_hand` stays until something resolves it. Nothing does. |
| Oskar whispers. | PG_001_002, panel 3 | The speaker of `L03` has a drawn row in that panel's `cast`. |

`continuity/ISS_001.final-state.yaml` repeats the last row of each character
and the last custody of each prop.

## The review trail

Page 2 was rendered twice.

1. `PG_001_002_V01` was flagged. Finding `F01` is blocking: the boy was drawn
   with Mara's face. The review traces it to two gaps upstream. Oskar's sheet
   had not been attached, and neither character named the other in
   `visually_adjacent_to`.
2. Both gaps were closed, and the reference plan now requires Oskar's sheet.
3. `PG_001_002_V02` is the repair, a sibling file. Its review marks `F01` as
   fixed with a `recheck` against the new render, sets `repair_cycle: 1`, and
   gives the verdict `fixed`.

`PG_001_001_V01` passed on the first render. The edition `ED_001_01` lists
`PG_001_001_V01` and `PG_001_002_V02`. `V01` of page 2 stays on disk and out
of the edition. Human approval is `pending` on every page review, because a
verdict and an approval are separate decisions.

## The cover

`issues/ISS_001/cover/cover.yaml` plans one image with no panels: Mara in
the wheelhouse doorway, the flare gun lowered, the tarpaulin lifted at one
corner. Its prompt package attaches the look master, Mara's sheet, and the
deck plate, and lists the two cover strings.

`CV_001_V01` passed its review. That review uses the same fourteen checks
as a page review. `position`, `movement`, and `role_causality` are marked
`not_applicable`, because a cover has no ledger and no panels around it.
The render was then approved, so `cover.yaml` has `status: approved` and
the edition lists it under `cover:`.

## Run the scripts against it

From the repository root:

```bash
# schema, cross-references, review and edition gates
node scripts/validate-workspace.js --root examples/the-night-ferry

# panel ledger audit
node scripts/check-continuity.js --root examples/the-night-ferry

# one-page HTML board of the issue
node scripts/build-board.js --issue examples/the-night-ferry/issues/ISS_001 --out night-ferry-board.html

# compile the prompt package for a page (writes prompts/harness-native.yaml next to page.yaml)
node scripts/compile-prompts.js --page examples/the-night-ferry/issues/ISS_001/pages/PG_001_001/page.yaml

# compile the cover package (writes cover/prompts/harness-native.yaml)
node scripts/compile-prompts.js --cover ISS_001 --root examples/the-night-ferry

# build the edition (writes under editions/ED_001_01/exports/, never overwrites)
node scripts/build-edition.js --edition examples/the-night-ferry/editions/ED_001_01/edition.yaml --formats cbz
```

The same commands exist as npm scripts, for example
`npm run validate:workspace -- --root examples/the-night-ferry`.

Four scripts write into the workspace when you point them at it:

- `build-reference-plan.js --page <page.yaml>` rewrites `reference-plan.yaml`
  next to the page.
- `compile-prompts.js --page <page.yaml>` rewrites
  `prompts/harness-native.yaml` next to the page, and `--cover ISS_001`
  rewrites the one under `cover/prompts/`.
- `generate-assets.js --page <page.yaml>` is a dry run by default and adds a
  generation record and its `GEN_*.request.json` under `generations/`.
- `build-edition.js` adds files under `editions/ED_001_01/exports/`
  (`the-night-ferry-001-ed01.cbz`) and lists them under `exports` in
  `edition.yaml`. The formats are `pdf`, `cbz`, `web`, `images`, and
  `epub`, and the cover is `000-cover.png` in each.

`letter-pages.js` has nothing to do here. The project letters in the image
(`lettering.mode: in_image`), so there is no `lettering.yaml`.

## What passing means

`validate-workspace.js` and `check-continuity.js` check the YAML: shapes,
references between files, the ledger, and the review and edition rules. They
do not open an image. A clean run on this workspace says the structured data
is consistent. It says nothing about a drawing.
