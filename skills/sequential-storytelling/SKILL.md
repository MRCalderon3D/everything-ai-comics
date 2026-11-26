---
name: sequential-storytelling
description: "Order panels into readable sequences: transitions, gutter ellipses, and flow from panel to panel."
origin: everything-ai-comics
category: production
---

# Sequential Storytelling

## Purpose

Make the panels read as one continuous story. Between two panels there is a
gutter, and the reader fills it in: that act is closure. This skill decides
what each gutter asks the reader to supply, names the kind of jump, and labels
anything the page deliberately skips, so the reader's guess and the plan are
the same.

## Use When

- `/page-plan` orders the moments of a scene across pages and panels.
- `/smart-page` joins new panels into a sequence.
- A page reads as a set of separate pictures instead of an event.
- A reader cannot tell how a character got somewhere or how an object changed
  hands.

## Inputs

- `production/issues/<ISS_ID>/pages/<PG_ID>/page.yaml` for the page and its
  neighbors: `panels` with `moment`, `order`, `size`, and `cast` rows.
- The scene file: `beats` and `geography`.
- `production/project.yaml`: `reading_direction` and `comic_format`.
- `rules/layout/panel-transitions.md` and `rules/layout/pacing.md`.

## Process

1. List the moments of the scene in story order and mark the ones the reader
   has to see: every change of position between levels, every custody change
   of a plot-relevant prop, every injury, and every decision that turns the
   scene. Those get panels.
2. Set `transition_in` on every panel except the first of a scene, which
   takes `null`. Use the value that names the jump from the previous panel:
   - `moment`: the same subject an instant later. Slows time.
   - `action`: the same subject in the next step of an action. The default.
   - `subject`: a different subject inside the same scene and time.
   - `scene`: a jump across time or place.
   - `aspect`: another detail of the same place or mood, with time held
     still.
   - `non_sequitur`: no logical link. Use it only on purpose.
3. Check the closure each gutter asks for. Say in one sentence what happens
   between the two panels. If two readers would give different sentences, add
   a panel or change one of the moments.
4. Label every deliberate skip. When the gutter omits something a reader
   might wonder about, write it in `ellipsis` on the later panel ("Mara
   climbs down the ladder"). An unlabelled skip is indistinguishable from a
   continuity error, both for the reviewer and for `check-continuity.js`.
5. Omit only what the reader can infer without confusion about identity,
   position, or causality. Crossing a deck can be skipped. Who fired, who now
   holds the gun, and which of two similar men is on the platform cannot.
6. Show a critical handoff. When a later action depends on an object or a
   person changing hands, give the transfer its own panel or a clear place in
   one. Narration that explains a transfer the drawings contradict does not
   repair the page.
7. Keep direction steady across the gutter. A character who leaves a panel
   toward the right enters the next one from the left. Movement that follows
   the scene's `travel_direction` reads as progress, and movement against it
   reads as retreat or opposition. Turn a character around on the page, where
   the reader sees it happen.
8. Pace with the mix of transitions and sizes. Several `moment` transitions
   stretch a second across a tier. `action` transitions move at walking
   speed. A `scene` transition needs an anchor in the new panel: a caption,
   a change of light, or an establishing view.
9. Work the page boundary. The last panel of a page hands something to the
   first panel of the next: a look off-panel, an unfinished gesture, a
   question. Check that the first panel after a turn orients the reader
   again before going close.
10. Read the sequence without the text. If the pictures alone lose the
    thread, the fault is in the panels, and more captions will hide it
    without fixing it.
11. Write `transition_in` and `ellipsis` into `page.yaml`, then run
    `node scripts/check-continuity.js --root <workspace> --issue <ISS_ID>`
    and resolve every error that names a missing movement or transfer.

## Outputs

- `transition_in` and `ellipsis` on every panel of the page files
  (`page.schema.json`).
- Added, removed, or reordered panels, with `layout.tiers`,
  `layout.reading_order`, and `order` values updated to match.
- Notes to `page-layout` when a sequence needs more room than the page gives.

## Quality Bar

- Every panel after the first of a scene has a `transition_in` value from the
  enum.
- Every level change and custody change in the scene is either shown in a
  panel or named in an `ellipsis`.
- No `ellipsis` hides who acts, where a character stands, or what caused the
  next panel.
- Every `scene` transition has an anchor the reader can see.
- The sequence still makes sense with all lettering covered.
- Exit and entry directions agree across each gutter.

## Common Failure Modes

- A character on the deck in one panel and in the wheelhouse in the next,
  with no climb and no label.
- The handoff skipped because "the caption says she has it now".
- Every transition an `action` step, so nothing lingers and nothing jumps.
- A `scene` jump with no anchor, read as the same room a second later.
- An `aspect` panel dropped into a chase, stopping it dead.
- Two panels showing the same instant from two angles, which doubles the
  cast in the reader's head.
- A character exits right and enters from the right, and seems to have turned
  back.

## Related Agents

- layout-artist
- comic-writer

## Related Commands

- page-plan
- smart-page

## Notes

The six transition values follow Scott McCloud's classification in
*Understanding Comics*. Use them as labels for a decision already made about
what the gutter does. Picking the label first and the moments second produces
sequences that fit a category and tell nothing.

What this skill labels, `state-tracking` records row by row and
`continuity-checking` audits afterwards. An `ellipsis` satisfies the ledger
check for a level change. It does not make a confusing skip readable.
