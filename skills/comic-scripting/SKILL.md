---
name: comic-scripting
description: "Write panel-by-panel script: one drawable moment per panel, exact dialogue, captions, and sound effects."
origin: everything-ai-comics
category: story
---

# Comic Scripting

## Purpose

Write the script inside `page.yaml`: for each planned panel, the single
moment that gets drawn and the exact words that get lettered. A comic panel
is a frozen instant. A script that asks one panel for a sequence gets a
drawing of part of it, or the same character twice.

## Use When

- A page has a layout (`layout`, panel `size`, `purpose`) and needs its
  panel script.
- Dialogue, captions, or sound effects change after an edit or a user
  change.
- A review finds that a panel's moment could not be drawn as written.

## Inputs

- `issues/<ISS_ID>/pages/<PG_ID>/page.yaml` with layout and panel stubs.
- The scene file (`scenes/<SC_ID>.yaml`): cast, beats, geography.
- `production/story/story-bible.yaml` for facts and source references.
- `production/project.yaml`: `language`, `reading_direction`, and
  `lettering` (`case`, `max_words_per_balloon`, `max_words_per_panel`).
- Character files, for each character's `voice`.

## Process

1. Read the page's `purpose` and the beats it covers. List the moments the
   page has to deliver and match them to the planned panels. If there are
   more moments than panels, return the page to `/page-plan`. Do not pack
   two moments into one frame.
2. Write each panel's `moment` as one present-tense sentence with one
   subject and one visible action: "Mara lifts the tarpaulin off the
   crates." The test is whether a single photograph could show it. "Mara
   climbs down, crosses the deck, and lifts the tarpaulin" is three panels.
3. Choose the instant that implies the most. Mid-action reads better than
   before or after: the hand on the tarpaulin, already rising.
4. List who is visible. Every character drawn in the panel gets a row in
   `cast` with a visible `action`. Someone who speaks from outside the frame
   gets a row with `off_panel: true`, because a speaker must be in the cast.
   Positions, custody, and state on those rows belong to `state-tracking`;
   `acting` belongs to `performance-direction`.
5. Add simultaneous background action only when it stays legible at the
   panel's size: a second figure readable as a silhouette, doing one thing,
   away from the main subject. Write it in `background`. A `small` or
   `inset` panel carries none.
6. Write the lettering under the panel, one element per balloon, caption, or
   effect: `id` (`L##`, unique on the page), `type`, `speaker`, `text`,
   `order`. The `text` is final: exact words, exact accents and punctuation,
   in the project's `language`. `project.lettering.case` controls how it is
   drawn, so write normal sentence case here.
7. Count words. Each element stays within `max_words_per_balloon` and each
   panel's elements together within `max_words_per_panel`. A speech that
   does not fit is split across balloons or moved to the next panel. A
   small panel takes far less than the maximum.
8. Order the speakers. `order` runs across the whole page in reading order.
   Inside a panel, the first speaker should stand on the side where reading
   starts (left for `ltr`); if the staging says otherwise, flag it to the
   layout-artist before tails cross.
9. Use captions for what the picture cannot show: time, place, a narrating
   voice. Use `sfx` for sounds that matter to the story, spelled as they
   will be drawn ("KLANG"), one per sound source.
10. Set `transition_in` for every panel after the first of a scene, and
    write `ellipsis` when the gutter skips an action on purpose.
11. Make adaptation edits traceable. In the panel's `notes`, cite the source
    paragraph or fact ID behind each line, and mark lines that were trimmed
    or invented.
12. Set the page's `status` to `scripted`, then run
    `node scripts/validate-workspace.js --root <workspace> --issue <ISS_ID>`
    and `node scripts/check-continuity.js --root <workspace> --issue <ISS_ID>`.

## Outputs

- `page.yaml` (`page` schema) with every panel's `moment`, `background`,
  `cast[].action`, `transition_in`, `ellipsis`, `lettering`, and `notes`
  filled, and `status: scripted`.

## Quality Bar

- Each `moment` holds one instant: no "then", "and then", or "while" joining
  two actions by the same character.
- The number of panels equals the sum of `layout.tiers`.
- Every lettering element is within the balloon budget and every panel
  within the panel budget.
- Every spoken element's `speaker` has a cast row in that panel.
- Lettering `order` values are unique on the page and follow panel reading
  order.
- Every dialogue line and caption cites its source or is marked as an
  adaptation edit.
- Text is in `project.language`, with its accents.

## Common Failure Modes

- Two moments in one panel ("opens the hatch and sits down"). The model
  draws one of them, or draws the character twice.
- A reaction with no visible cause: the flinch is scripted, the noise that
  caused it is not on the page.
- Emotion labels where a drawing is needed. "Oskar is scared" gives the
  artist nothing; "Oskar presses back against the crates" does.
- Dialogue order that fights the staging, with the first speaker on the far
  side of the panel and tails crossing over the art.
- Forty words in a small panel. The text covers the drawing, or the image
  model garbles it.
- A caption that describes the picture under it.
- Approximate lettering ("Mara says something about the patrol"). Whatever
  the model writes then becomes the dialogue.
- Naming a character in a caption to make up for a drawing where two people
  look alike.
- Background action in a panel too small to hold it.
- A sound effect on every panel, so none of them registers.

## Related Agents

- comic-writer
- penciller
- letterer

## Related Commands

- panel-script
- smart-page

## Notes

Format rules are in `rules/writing/comic-script-format.md` and word economy
in `rules/writing/dialogue-economy.md`. Once a page has a render with
in-image lettering, changing a `text` value makes the image wrong; the page
needs a new render or a repair, and the change goes through `/panel-script`
rather than a quiet edit.
