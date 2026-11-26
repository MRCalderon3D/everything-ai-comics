---
description: Review rendered pages against plan and references; record findings, gates, and a verdict.
---

# /visual-review

## Purpose

Decide, by looking at the image, whether a rendered page shows what was
planned. The reviewer opens the file, compares it with the page plan, the
ledger, the reference sheets, and the neighboring pages, and writes down
what is visible for each of fourteen checks. Every problem becomes a
finding with the expectation, the observation, and the repair it needs.
The review ends with two gates and one verdict. "Continuity was checked"
is not an acceptable result; the file with its evidence is.

## Use When

- `/generate-pages` saved a render and the page has `status: rendered`.
- `/repair-page` produced a sibling version that has to be rechecked.
- A master or a bible changed after pages were reviewed and they need
  another look.
- The user wants a second, independent review of a page before approving
  it.

## Inputs

- `render` (ID, optional): a single render, e.g. `PG_001_002_V01`; or
- `page` / `issue` (ID, optional): review the `current_render` of one page,
  or of every page in the issue that has no review file.
- `reviewer` (string, optional, default `visual-reviewer`): an agent name
  or `human`, written to the review.
- `--recheck` (flag, optional): the render replaces an earlier one; carry
  that review's findings forward and recheck each.

## Invokes Agents

- visual-reviewer
- continuity-editor
- art-director

## Required Skills

- pixel-review
- continuity-checking

## Process

1. Establish independence. The reviewer is not the agent that generated the
   image. When the same session did both, hand the review to a fresh
   visual-reviewer or to the user. Write `reviewer` and set `independent`
   truthfully; a review with `independent: false` says so in its report
   and is not the page's only review.
2. Open what will be compared, as images: the render file itself, the
   reference assets from the page's reference plan, and the current
   renders of the previous and next pages. Open the page's `page.yaml` for
   the plan and the ledger. List the images in `compared_against`. The
   prompt and the captions are not evidence of what was drawn.
3. Inspect the whole page first for reading order: count the panels,
   compare the grid with `layout.tiers`, and follow `layout.reading_order`
   and the lettering `order` with the eye.
4. Inspect each panel at a size where faces, hands, objects, and lettering
   can be judged. Crop or zoom; a full-page view hides swapped faces and
   wrong hands.
5. Fill all fourteen `checks`, each with a `result` (`pass` | `fail` |
   `not_applicable`) and `evidence` that describes pixels.
   continuity-editor answers the checks that read the ledger, and
   art-director answers `style_fidelity`:
   - `identity`: face, hair, build, and clothing against the assigned
     sheet, feature by feature from `distinguishing_features`.
   - `cast_count`: each named character counted separately in every panel.
   - `position` and `movement`: level, side, and landmark against the
     ledger rows, and each character traced from appearance to appearance.
   - `role_causality`: the visible actor of each moment is the planned one.
   - `object_identity` and `object_custody`: the same object keeps its
     shape, and it is in the hand or place the ledger says.
   - `physical_state` and `wardrobe`: every state tag and every outfit
     layer, including hands.
   - `spatial_logic`: side convention, travel and threat directions,
     eyelines.
   - `drawing_clarity`: hands, limbs, and silhouettes separate and
     readable.
   - `lettering`: exact words and accents, speaker, tail, reading order,
     and placement that does not hide the action.
   - `page_structure`: panel count, grid, and order as planned.
   - `style_fidelity`: line, blacks, and texture against the look master.
6. Review the boundaries with the neighbors side by side: the last panel
   of the previous page against the first of this one, and the last of
   this one against the next.
7. Write a finding for every failed check: `id` (`F##`), `panel`, `check`,
   `expected` (from canon or plan), `visible` (what the pixels show),
   `severity`, `repair` (the smallest useful change), and `status: open`.
   Identity ambiguity, a duplicated character, an impossible position,
   broken causality, and a missing state transition that later panels
   depend on are `blocking`. If the pixels do not establish who acts,
   record the finding even when a caption supplies the name.
8. Set the two gates separately: `gates.style_fidelity` from the
   art-director and `gates.narrative_continuity` from the
   continuity-editor.
9. Set the verdict. `pass`: zero findings and every check `pass` or
   `not_applicable`. `flagged`: any blocking finding is open, a gate
   fails, or the visible evidence is ambiguous. `fixed`: only for a
   repaired render, after each carried finding has a `recheck` naming the
   render that was reopened and what is visible there. Set `repair_cycle`
   (0 for a first render) and `supersedes`.
10. Write `reviews/<RENDER_ID>.review.yaml` with `reviewed_at` and
    `human_approval.status: pending`. On `pass` or `fixed`, set the page's
    `status` to `reviewed` and `current_render` to this render. On
    `flagged`, leave the page at `rendered` and route to `/repair-page`.
11. Run `node scripts/validate-workspace.js --root production --issue
    <ISS_ID>` and the self-evaluation gates on the review file. Report the
    two kinds of result apart: what the scripts validated, and what the
    review saw, with the scope reviewed and any minor issue left.

## Outputs

- `production/issues/<ISS_ID>/pages/<PG_ID>/reviews/<RENDER_ID>.review.yaml`,
  validates against `schemas/visual-review.schema.json`.
- `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml`, with `status` and
  `current_render` updated (`schemas/page.schema.json`).

## Notes

- A verdict is the reviewer's finding. Human approval is a separate
  decision: the user sets `human_approval` (`status`, `by`, `at`), and only
  then does the page move to `approved`. A `pass` is never reported as an
  approval.
- A blocking finding cannot be `accepted`. A minor finding may be, and is
  listed in the report.
- Schema checks and repository tests verify files and tooling. They cannot
  certify identity, anatomy, geography, or continuity in a drawing
  (`rules/common/visual-evidence.md`).
- A page with `pass` or `fixed` can serve as the next page's spatial
  reference. A flagged page cannot.
- In `overlay` lettering mode the `lettering` check is made on the lettered
  output from `/lettering`. Until that exists, mark the check
  `not_applicable` and say why in its evidence.
- This command generates nothing and costs nothing.
- Related: `/generate-pages` (before), `/repair-page` (flagged pages),
  `/continuity-review` (the issue as a whole), `/build-edition` (takes only
  `pass` and `fixed` renders).
