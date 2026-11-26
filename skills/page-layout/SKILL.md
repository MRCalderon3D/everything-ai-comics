---
name: page-layout
description: "Design the page: panel count, grid, relative panel size, reading order, and page turns."
origin: everything-ai-comics
category: production
---

# Page Layout

## Purpose

Decide the shape of each page before any panel is scripted in detail: how many
panels it has, how they sit in tiers, how big each one is against the others,
the order the eye takes them in, and what the reader meets when the page ends.
The layout sets the pace. A page of six equal panels and a page with one
splash tell the same beat at different speeds.

## Use When

- `/page-plan` divides a scene's beats into pages.
- `/smart-page` builds pages for one scene from scratch.
- A thumbnail shows that a page reads in the wrong order or feels crowded.
- A reveal lands where the reader has already seen it across the spread.

## Inputs

- `production/project.yaml`: `comic_format`, `reading_direction`,
  `page.aspect_ratio`, and the `lettering` word budgets.
- `production/issues/<ISS_ID>/issue.yaml` (`page_count`) and the scene files
  with `beats` and the pages each beat owns.
- `production/story/series-plan.yaml` for the issue's `page_budget`.
- `rules/layout/` and the one format layer the project uses (`rules/paged/`
  or `rules/webtoon/`).

## Process

1. Read `comic_format` and `reading_direction` first. They decide which half
   of this procedure applies and which way every tier reads.
2. Give each page one job and write it in `purpose`. If the sentence needs
   "and then" twice, the page holds too much: move a beat to the next page.
3. Choose the panel count from the beats. One drawable moment is one panel.
   Default to four to six panels on a paged page. Go as high as nine only on
   a regular grid of short beats with little text. Use one panel when the
   moment deserves the whole page.
4. Build the grid as tiers. `layout.tiers` lists the panels in each tier from
   top to bottom, so `[1, 2, 1]` is a wide panel, two side by side, and a
   wide panel. Describe the same grid in words in `layout.grid`. The tiers
   must add up to the panel count.
5. Size panels by weight and time. A larger panel holds the eye longer. Give
   `wide` or `large` to the establishing view and to the moment the page
   turns on, `small` to quick beats, `splash` to a full-page image, and
   `inset` to a detail set inside a bigger panel. An inset belongs to the
   tier of the panel that hosts it.
6. Set the reading order. In `ltr` the eye goes left to right inside a tier
   and then down to the next tier. In `rtl` it goes right to left inside a
   tier. Number the panels with `order` along that path and list the same
   path in `layout.reading_order`. Avoid any arrangement where two panels
   could both be next, such as a tall panel beside two stacked ones without a
   clear lead.
7. Paged format: set `side` and plan the turn. Facing pages are seen together,
   so a surprise placed on the second page of a spread is already visible
   from the first. Put the setup in the last panel of the page before the
   turn and the reveal in the first panel after it. In an `ltr` book whose
   page 1 stands alone on the right, odd pages are right-hand pages and the
   turn follows them. In `rtl` the sides mirror. Record what the end of the
   page does in `page_turn`: `none`, `continuation`, `reveal`, or
   `cliffhanger`.
8. Paged format: plan a double-page spread on purpose. Set `spread_with` on
   both pages, make sure the pair faces each other, and keep faces and
   lettering out of the fold.
9. Webtoon format: a page is one scroll segment and there is no turn. Stack
   panels in a single column (`tiers` of ones), control pace with the
   vertical gap between panels, and put empty space before a reveal so the
   reader scrolls into it. Record the gaps in `layout.notes`. Leave `side`
   out.
10. Check density against the lettering budget. Add up the words planned for
    each panel and compare with `lettering.max_words_per_panel`. A `small`
    panel cannot carry a long exchange: enlarge it, split the dialogue across
    two panels, or cut words with the writer.
11. Chain the pages. Set `continuity.enters_from` and `continuity.exits_to`
    so the issue forms one unbroken sequence, with `null` only at the first
    and last page.
12. Write `page.yaml` with `status: planned`, then run
    `node scripts/validate-workspace.js --root <workspace> --issue <ISS_ID>`
    and fix every error.

## Outputs

- `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml` (`page.schema.json`)
  with `number`, `scene`, `side`, `spread_with`, `purpose`, `page_turn`, the
  `layout` block, each panel's `order`, `tier`, and `size`, and the
  `continuity` links.
- `page_count` and `panel_count` in `issue.yaml` updated to match.

## Quality Bar

- `layout.tiers` sums to the number of panels and `layout.reading_order` is a
  permutation of the panels' `order` values.
- A cold reader traces the page in one order, and it is the planned one.
- Every `reveal` or `cliffhanger` sits on a page that ends at a turn (paged)
  or is preceded by a recorded gap (webtoon).
- No panel's planned text exceeds the project's word budget for its size.
- The page count of the issue matches its `page_budget`, or the difference is
  recorded.
- The largest panel on the page holds the moment named in `purpose`.

## Common Failure Modes

- The same grid on every page, so the climax has the weight of a hallway
  conversation.
- A reveal on a left-hand page of an `ltr` book whose facing page gives it
  away, or the reverse in `rtl`.
- Nine panels with dialogue in each. Nobody can read it, and a full-page
  generation loses the faces.
- Stacked panels beside a tall one with no cue for which comes next.
- A splash spent on a moment that changes nothing.
- An `rtl` project laid out with `ltr` tiers because the order was copied
  from another page.
- Webtoon segments planned as print pages, with side-by-side panels too small
  to read on a phone.

## Related Agents

- layout-artist
- comic-writer

## Related Commands

- page-plan
- smart-page

## Notes

Layout decides how many panels exist and how large they are.
`sequential-storytelling` decides how one panel leads to the next, and
`panel-composition` decides what goes inside each. Settle them in that order.

The panel limits above are defaults. Where `rules/layout/pacing.md` or the
project's format layer sets a different number, that number wins. Test any
layout you are unsure about with `thumbnailing` before spending on a final
page.
