---
name: state-tracking
description: "Keep the panel ledger: position, custody, wardrobe, and physical state for every character and object."
origin: everything-ai-comics
category: production
---

# State Tracking

## Purpose

Record, panel by panel, where every character and plot-relevant object is,
what each character wears and holds, and what physical state they are in. The
record is the panel ledger, and it lives in the `cast`, `props`, and
`transfers` blocks of `page.yaml`. A ledger makes continuity something a
script can audit before a page is drawn and something a reviewer can hold a
render against afterwards.

## Use When

- `/panel-ledger` fills or audits the ledger of an issue.
- `/smart-page` writes new pages and their rows together.
- `/prop-bible` defines how a prop is handled and who has it when.
- `/continuity-review` carries state across pages and into the end-of-issue
  file.
- A page shows an object in a hand with no pickup, a wound that vanished, or
  a character in two places.

## Inputs

- Every `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml` of the issue, in
  page order.
- The scene files (`cast`, `geography`) and the blocking from
  `scene-blocking`.
- `production/locations/<LOC_ID>/map.yaml` for valid levels and landmarks.
- `production/characters/<CHAR_ID>/wardrobe.yaml` for outfit IDs, and
  `production/props/<PROP_ID>/prop.yaml` for `hands_required`.
- The previous issue's `production/continuity/<ISS_ID>.final-state.yaml` when
  `issue.yaml` names one in `opens_from`.

## Process

Think of the ledger as this table. Each line is one row of `page.yaml`.

| Page / panel | Character / object | Expected position | Action / role | State / custody | Transition into next appearance |
|---|---|---|---|---|---|
| Fill in | Named identity or specific object | Level, side, landmark | One visible moment | Wardrobe, injury, blood, held item | Shown movement, explicit ellipsis, or unchanged |
| Page 1 / panel 1 | CHAR_MARA | wheelhouse, right | Steers with one hand | WARD_MARA_OILSKIN, no injuries, hands empty | Unchanged |
| Page 1 / panel 1 | PROP_FLARE_GUN | wheelhouse, right, not drawn | Hangs by the wheel | No holder | Needs a shown pickup before anyone uses it |
| Page 1 / panel 3 | CHAR_OSKAR (off-panel) | deck, left, crates | Hides behind the crates | Hooded jacket, `cut_left_hand`, hands empty | Unchanged until he is found |
| Page 2 / panel 1 | CHAR_MARA | deck, right, ladder | Steps off the ladder | Same wardrobe | `moved`: climbed down the ladder |

1. Start from the incoming state. For the first page of an issue, read the
   file named in `opens_from`. For any other page, read the last appearance
   of each character and prop on the pages before it. Nothing starts blank.
2. Write one `cast` row per character per panel, and only one. Fill
   `position` (`level`, `side`, `landmark`), `facing`, `action`, `wardrobe`,
   `state`, `holding`, and `carrying`.
3. Add off-panel rows. When a character is outside the drawing and their
   state still matters (hidden, waiting on another level, speaking from
   beyond the frame), add the row with `off_panel: true`. Being outside the frame does not reset a
   location or an inventory. The row keeps both.
4. Track position. When `position.level` differs from the character's
   previous appearance in the scene, set `moved` on the later row with how
   they got there, or set `ellipsis` on the panel. Use only levels and
   landmarks that exist in the location's map.
5. Track custody. A prop in someone's hand is listed in that row's `holding`
   and nowhere else. A prop in nobody's hand gets a `props` row with its
   `position`, its `state`, and whether it is `visible`. One prop, one
   holder.
6. Record every custody change as a `transfers` entry in the panel where it
   happens: `prop`, `from`, `to`, and `how` (`handoff`, `pickup`, `drop`,
   `set_down`, `draw`, `holster`, `throw`, `take`). `from` is `null` for a
   pickup from a surface, and `to` is `null` for a drop or a set-down. When
   the transfer happens between two appearances, put the entry in a panel
   between them and say so in that panel's `ellipsis`.
7. Track physical state with tags. `state` lists what persists on the body:
   injuries, blood, soaked clothes, bound wrists. Name the part and the side
   (`cut_left_hand`, `blood_right_sleeve`). In the panel where a tag first
   appears, list it under `state_changes.adds`. A tag stays on every later
   row until a panel lists it under `state_changes.resolves`.
8. Track wardrobe. Every row names a wardrobe ID. A change inside a scene
   sets `wardrobe_change` with the reason (took the coat off to cover the
   boy).
9. Count hands. `carrying` another character uses two. Each held prop uses
   its `hands_required`, one if unstated. A row that needs more than two
   hands is wrong: add a `set_down` or `holster` before it.
10. Check the speakers. Every spoken lettering element names a `speaker` who
    has a row in that panel's `cast`, drawn or off-panel.
11. Run the audit:
    `node scripts/check-continuity.js --root <workspace> --issue <ISS_ID>`.
    Fix the ledger until it reports zero errors. Read each warning and
    either fix it or record why it stands in the panel's `notes`. Add
    `--json` to get the findings as data.
12. At the end of an issue, hand the last rows to `continuity-checking`,
    which writes `continuity/<ISS_ID>.final-state.yaml`.

For a prop bible, the same thinking applies one level up: set
`hands_required` and `plot_relevant` in `prop.yaml`, and note in which pages
the prop changes hands so the ledger has something to be checked against.

## Outputs

- Complete `cast`, `props`, and `transfers` blocks in every panel of the
  issue's page files (`page.schema.json`).
- `hands_required` and `plot_relevant` set on tracked props
  (`prop.schema.json`).
- The output of `check-continuity.js` with zero errors, kept with the
  session's report.
- The last-page rows that feed the end-of-issue continuity state.

## Quality Bar

- `check-continuity.js` exits 0 for the issue.
- No character appears twice in one panel's `cast`.
- Every prop is in exactly one place per panel: one `holding` list or one
  `props` row.
- Every change of holder has a `transfers` entry at or before the panel that
  shows the new holder.
- Every state tag that disappears is listed in a `state_changes.resolves`.
- Every level change has `moved` or an `ellipsis`.
- No row needs more than two hands.
- A character who matters to the scene and is not drawn has an off-panel row.

## Common Failure Modes

- A character leaves the frame and comes back with empty hands, because the
  row was dropped and the inventory reset.
- A dropped pistol lying on the ground in one panel and in someone's hand in
  the next, with no pickup.
- A bloodstained sleeve clean two pages later with nothing in `resolves`.
- A character carrying a wounded person and firing a weapon in the same
  panel.
- Gloves that appear without a `wardrobe_change`.
- State tags too vague to check (`hurt`), so the reviewer cannot tell which
  hand should show the cut.
- The ledger filled in after generation to match what came out. It then
  documents the render and tests nothing.
- A prop listed both in a `holding` list and in the panel's `props`.

## Related Agents

- continuity-editor
- layout-artist
- environment-designer

## Related Commands

- panel-ledger
- smart-page
- prop-bible
- continuity-review

## Notes

The script checks the plan. It reads `page.yaml` and never opens an image, so
a clean run says the pages are consistent on paper. Whether the drawing
matches the ledger is a question for `pixel-review`, which uses these rows as
its list of expectations.

The `detect-continuity-drift` hook runs the same audit whenever a page file
is written and prints the findings that touch that page. It warns and never
blocks, so the full run in step 11 is still required.
