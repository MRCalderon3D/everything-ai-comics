---
name: thumbnailing
description: Rough each page as thumbnails to test readability before any final generation.
origin: everything-ai-comics
category: production
---

# Thumbnailing

## Purpose

Draw the page small and rough to find out whether it reads, while changing it
is still free. A thumbnail shows the grid, the big shapes in each panel, where
the figures stand, and where the balloons go. It answers a narrow set of
questions: does the eye take the panels in the planned order, can a reader
tell who acts, does the text fit. Problems caught here cost a few minutes.
The same problems caught on a final page cost a generation and a repair
cycle.

## Use When

- A page is planned and scripted and `/thumbnails` runs before generation.
- A layout is unusual (inset, spread, broken grid) and its reading order is
  in doubt.
- Two layouts for the same page need comparing.
- A final page failed review on reading order or clarity and the plan has to
  be reworked.

## Inputs

- `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml`: `layout`, and each
  panel's `size`, `framing`, `moment`, `cast` rows, and `lettering`.
- `production/project.yaml`: `page.aspect_ratio`, `reading_direction`,
  `comic_format`, and the `lettering` word budgets.
- `production/locations/<LOC_ID>/map.yaml` for sides and landmarks.
- The thumbnails of the neighboring pages, when they exist.

## Process

1. Draw the page frame in the project's aspect ratio and divide it by
   `layout.tiers`. Give each panel the relative area its `size` implies. For
   a webtoon segment, draw the column with its vertical gaps.
2. Rough each panel from its `framing` and `cast` rows: one mass per figure,
   placed on the side and level the ledger gives, facing the way `facing`
   says. Mark the actor. Keep it loose. Faces are ovals with a nose line.
3. Add direction marks: an arrow for each movement, and a sight line where
   an eyeline matters.
4. Rough the lettering. Draw each balloon, caption, and sound effect at the
   size its word count needs, in the position the reading order requires,
   with a tail toward the speaker. Number them by `order`.
5. Choose the medium. A text thumbnail (a grid in Markdown with one line per
   panel describing the masses and the balloon positions) is enough for a
   regular grid. Draw or generate a rough image when the layout is irregular
   or the staging is complex. A generated rough is made with the harness's
   image tool or by a person, outside `generate-assets.js`, which handles
   finished pages and reference sheets only. Confirm the cost first when
   the tool charges, and note the tool in the round's file.
6. Run the reading-order test. Have a reader who has not seen `page.yaml`
   number the panels and the balloons in the order they would read them, or
   do it yourself from the image alone before looking at the plan. Compare
   with `layout.reading_order` and the lettering `order` values.
7. Run the clarity test. For each panel, say from the shapes alone who does
   what. Check that silhouettes are separate, that the actor is the clearest
   shape, and that no balloon covers a hand, a face, or a prop the panel is
   about.
8. Run the direction test. Screen left and right match the map's side
   convention in every panel, travel and threat run the way the scene's
   `geography` says, and exits match entries across gutters.
9. Squint at the page, or view it at the size of a postage stamp. The eye
   should land on the panel named in the page's `purpose`. If it lands
   elsewhere, the sizes or the blacks are wrong.
10. Paged format: put the thumbnail beside its facing page. Check that a
    reveal is not visible across the spread and that the two pages do not
    read as one tier running across both. Webtoon: scroll the column and
    check the gap before each reveal.
11. Fix the plan. Every problem found goes back into `page.yaml` through the
    skill that owns it (`page-layout`, `panel-composition`,
    `sequential-storytelling`, or `balloon-lettering`). Then thumbnail again.
    Do not patch the drawing and leave the plan as it was.
12. Save each round in the page's `thumbnails/` directory with a number
    (`thumb-01.md`, `thumb-02.png`) and keep the earlier rounds.

## Outputs

- Files in `production/issues/<ISS_ID>/pages/<PG_ID>/thumbnails/`: text or
  image thumbnails, numbered, never overwritten.
- For a generated rough, a note of the tool and its cost in the round's
  text file.
- Changes to `page.yaml` for every problem the thumbnail exposed.
- A short readability note per page: which tests ran and what changed.

## Quality Bar

- The thumbnail has the same number of panels, in the same tiers, as
  `layout.tiers`.
- A cold reading of the thumbnail gives the same order as
  `layout.reading_order`.
- Every balloon in the thumbnail corresponds to a lettering entry, and every
  entry has a place.
- The actor of each panel can be named from the shapes.
- `page.yaml` and the latest thumbnail agree. Where they differed, the plan
  was updated.

## Common Failure Modes

- Polishing a thumbnail into a finished drawing, which makes it too expensive
  to throw away.
- Thumbnails drawn from memory of the script instead of from `page.yaml`, so
  they test a page that does not exist.
- Balloons left out, and the text later covers the action.
- A reading-order test done by the person who planned the page, who reads
  what they intended.
- Fixing the drawing and leaving the old layout in `page.yaml`, so the prompt
  is compiled from the version that failed.
- Using a thumbnail as an identity or style reference for the final page.
- Checking each page alone and never the spread.

## Related Agents

- layout-artist
- penciller

## Related Commands

- thumbnails

## Notes

A thumbnail is a test of the plan. It is never a render: it gets no review
file, never becomes `current_render`, and never enters an edition. Reference
plans cite registered assets and reviewed renders only, so a thumbnail stays
out of them.

When the thumbnail and `page.yaml` disagree, `page.yaml` is the contract.
Change it deliberately or redraw the thumbnail.
