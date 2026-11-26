# Pacing

## Purpose

Spend pages and panels the way the story spends time. Pacing decides how
long the reader stays on a beat, where a scene's weight falls, and whether
the issue fits the page budget it was given.

## Scope

Layout layer. Applies to `page_budget` in `story/series-plan.yaml`,
`page_count` in `issue.yaml`, the `beats[].pages` map in scene files, and the
`purpose`, `page_turn`, panel count, and panel sizes of every `page.yaml`.
Used by `/issue-breakdown`, `/page-plan`, and `/smart-page`. What the
boundary between two pages does in each format is covered by
`paged/page-turn-grammar.md` and `webtoon/scroll-grammar.md`.

## Core Principles

- The page is the unit of pacing. Each page sets something up, raises it,
  and ends on a reason to keep reading.
- Space is time. A large panel holds the reader, and a row of small panels
  hurries them.
- Silence is a tool with a cost. A wordless panel buys weight and spends
  space.
- The page budget is decided before the pages are planned. Running over is
  a planning problem and is solved in the plan.

## The page as a unit

- Every page states its `purpose` in one sentence. A page whose purpose is
  "continue the conversation" has no purpose yet.
- The first panel orients: where we are, who is present, what changed since
  the previous page. On a page that continues a scene, a single clear figure
  or landmark is enough.
- The middle panels escalate. Each one adds information or pressure that the
  previous panel did not have.
- The last panel ends the page. It closes the page's small question, or it
  opens the next one. `page_turn` records which: `none`, `continuation`,
  `reveal`, or `cliffhanger`.
- Default: no more than two pages in a row with the same `layout.tiers`,
  unless the project works on a fixed grid.

## Panel size and count as time

- More panels on a page means shorter story time per panel and a faster
  read. Fewer and larger panels slow the page down.
- A wide panel reads as duration. A tall, narrow panel reads as an instant.
  A run of equal small panels reads as a steady beat, useful for a countdown
  or for repeated action.
- Words slow a panel more than size does. A fast sequence keeps its panels
  under about ten words each, and a panel meant to be glanced at carries
  none.
- Match density to the beat. Default ranges: quiet or emotional pages, 3 to
  5 panels; conversation, 5 to 7; physical action, 3 to 5 with one dominant
  panel (see `page-composition.md`).
- The turning beat of a scene gets the largest panel of its page. If it is
  sharing a tier with two other panels, the page is planned around the wrong
  moment.

## Silent panels

- A silent panel is a panel with an empty `lettering` list. It still needs a
  `moment` that draws: a reaction, an aftermath, an empty place.
- Use silence after a line that has to land, before a reveal, and for time
  passing. One silent panel after a heavy line does more than a caption
  explaining how the character feels.
- A fully silent page is a decision recorded in the page's `purpose`. It
  MUST still pass the test of the reading path: each panel leads to the
  next without words to carry it.
- Do not fill a silent panel with a sound effect to keep it busy (see
  `lettering/sound-effects.md`).

## Beats across pages

- `/issue-breakdown` gives every beat of a scene a page budget, and each
  beat's `pages` list in the scene file names the pages that carry it. Every
  beat lands on at least one page, and every page serves at least one beat.
- A beat SHOULD finish on the page where it starts. Split a beat across a
  page boundary only when the split is the point, and set `page_turn` to
  `continuation`, `reveal`, or `cliffhanger` on the earlier page.
- Start a major scene at the top of a page. A scene change in the middle of
  a page is allowed for short scenes and needs the anchor required by
  `panel-transitions.md`.
- End a scene on its consequence. A scene that stops on its last line of
  dialogue usually needs one more panel.

## Page budgets

- `page_budget` in the series plan is the contract for an issue. The pages
  planned for the issue add up to it, and `issue.yaml` records the result in
  `page_count`.
- When the beats do not fit, compress first: merge beats, cut dialogue, turn
  two panels into one. If the story still does not fit, change
  `page_budget` in the series plan deliberately and report it. NEVER let an
  issue grow page by page.
- Working defaults for a first pass: one page for each major beat, half a
  page for a connecting beat, and one full page reserved for the issue's
  largest moment.
- A page added late shifts every page after it. Re-run `/page-plan` for the
  rest of the issue so the `continuity.enters_from` and `exits_to` chain
  and the format layer's page positions stay correct.

## Validation

- `schemas/page.schema.json` requires `purpose` and restricts `page_turn` to
  its four values. `schemas/series-plan.schema.json` requires an integer
  `page_budget` of at least 1 for every issue.
- `scripts/validate-workspace.js` resolves the page IDs that scene files
  list, and fails an issue whose `page_count` differs from the number of
  page directories on disk.
- `scripts/check-continuity.js` checks that `continuity.enters_from` and
  `exits_to` form one unbroken chain through the issue, which catches a page
  inserted without replanning its neighbors.
- Agreement between `page_budget` in the series plan and `page_count` in
  the issue file has no script. Production-qa compares them at issue review,
  and `scripts/build-board.js` shows the pages of an issue side by side for
  that review.
- Rhythm, density, and whether a page ends well are human review on the
  thumbnails and again on the rendered pages.
