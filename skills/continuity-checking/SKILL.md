---
name: continuity-checking
description: Audit position, custody, state, wardrobe, and geography across panels, pages, and issues.
origin: everything-ai-comics
category: post
---

# Continuity Checking

## Purpose

Confirm that the comic holds together as one continuous world: characters
stay where they were left until they move, objects stay with whoever has
them, wounds and stains persist, clothes change only for a reason, and the
place keeps its shape from page to page and from one issue to the next. The
audit has two parts that are run and reported apart. The mechanical part
checks the written ledger with a script. The visual part checks the reviewed
renders with eyes.

## Use When

- `/continuity-review` runs at the end of an issue, or after a batch of
  pages.
- `/visual-review` reaches a page boundary and has to look at two pages
  together.
- A repair changed a page and its neighbors may no longer match.
- A new issue opens and has to inherit the state the last one left.
- A bible, a map, or a wardrobe file changed after pages were planned.

## Inputs

- Every `page.yaml` of the issue, in page order, with their ledger rows.
- The scene files (`geography`) and the location maps.
- The current render of each page and its review file under `reviews/`.
- `issue.yaml`, for `opens_from`, and the previous issue's
  `production/continuity/<ISS_ID>.final-state.yaml`.
- Character, wardrobe, and prop files for the canonical states.

## Process

1. Load the incoming state. If `issue.yaml` names a file in `opens_from`,
   read it and compare it with the first appearance of each character and
   prop in this issue: location, position, wardrobe, state tags, and what is
   held. Every difference needs a cause the reader is given: a `scene`
   transition, an `ellipsis`, a `wardrobe_change`, a `transfers` entry.
2. Run the mechanical audit:
   `node scripts/check-continuity.js --root <workspace> --issue <ISS_ID>`.
   Add `--json` to keep the findings as data. Each finding carries a code, a
   severity, and the page, panel, and entity it concerns. Send every error
   back to `state-tracking` and run again until none remain. Decide each
   warning: fix it or record why it stands.
3. Audit what the script cannot judge in the plan. Read the pages of each
   scene in order and check that the side convention of the map holds in
   every panel, that travel and threat keep the directions set in the
   scene's `geography`, and that characters who look at each other have
   opposing `facing` values. Between scenes, check time of day and wardrobe
   against the story's timeline.
4. Keep story order. Audit pages by page number, whatever order they were
   generated or repaired in. A page repaired last can still break the page
   after it.
5. Run the visual audit on reviewed renders only. Open the current render
   of each page beside its neighbors and look across the boundary: the last
   panel of one page against the first panel of the next. Check that each
   character is recognisably the same person, in the same outfit, with the
   same injuries, holding the same object of the same shape, and that
   landmarks have not changed sides.
6. Look along the whole issue for slow drift that no single boundary shows:
   a coat that gets longer, a scar that migrates, a lamp that gains a
   second bulb. Compare the first and last appearance of each character and
   each plot-relevant prop.
7. Record visual defects as findings in the review file of the page that
   shows them, under the matching check (`identity`, `object_custody`,
   `physical_state`, `wardrobe`, `spatial_logic`), with `expected`,
   `visible`, `severity`, and `repair`. A blocking finding flags that page
   again and sends it to `/repair-page`.
8. Repeat steps 5 to 7 across the issue boundary: the last reviewed page of
   the previous issue against the first page of this one.
9. Write the end-of-issue state to
   `production/continuity/<ISS_ID>.final-state.yaml`. Set `after_page` to
   the last page. For each character record `location`, `position`,
   `wardrobe`, `state`, and `holding`, taken from their last ledger row,
   off-panel rows included. For each tracked prop record `custody`,
   `location`, and `state`. List `open_threads` the next issue must pick
   up.
10. Check the state file against the pixels. Where the shipped render of the
    last page differs from the ledger, the next issue inherits what readers
    saw. Repair the page, or record the difference in `open_issues` with a
    severity and the page.
11. Set `last_validated`, then run
    `node scripts/validate-workspace.js --root <workspace> --issue <ISS_ID>`.
12. Report in two parts: the script result (errors and warnings, by count
    and code) and the visual findings (by page and check). Do not fold one
    into the other.

## Outputs

- `production/continuity/<ISS_ID>.final-state.yaml`
  (`continuity-state.schema.json`).
- Ledger corrections routed to `state-tracking`, and blocking visual
  findings added to the affected pages' review files.
- A two-part continuity report: mechanical audit, visual audit.

## Quality Bar

- `check-continuity.js` exits 0 for the issue.
- Every page boundary in the issue was looked at as a pair of renders, and
  the report says so.
- The state file names every character and tracked prop that appears in the
  issue, including those last seen off-panel.
- Every entry in the state file can be traced to a ledger row and agrees
  with the last reviewed render, or the difference is listed in
  `open_issues`.
- Every defect names the page, the panel, the check, and the skill that
  owns the fix.
- The report never presents a script result as a statement about the
  drawings.

## Common Failure Modes

- Running the script, getting zero errors, and declaring continuity sound
  without opening a render.
- Auditing pages in the order they were generated and missing a regression
  in story order.
- Checking each page against the plan and never against the page beside it.
- Writing the state file from the plan when the approved render shows
  something else, so the next issue contradicts what was published.
- Dropping a character from the state file because their last appearance
  was off-panel.
- Fixing a visual defect by editing the ledger to match the wrong drawing.
- A new issue that opens with clean clothes and full hands because nobody
  read `opens_from`.
- A slow drift accepted one page at a time until the last page no longer
  matches the first.

## Related Agents

- continuity-editor
- visual-reviewer
- production-qa

## Related Commands

- continuity-review
- visual-review

## Notes

`scripts/check-continuity.js` automates the ledger rules listed in
`docs/data-model.md`. It reads the page files, the bible entries they name,
and the state file an issue opens from. It opens no image, so its output
describes the plan. The visual audit uses the method and the finding
format of `pixel-review`, applied across pages where that skill works one
page at a time.

Reviewed pages go back into review when a source they depend on changes: a
character sheet, a wardrobe state, a map.
