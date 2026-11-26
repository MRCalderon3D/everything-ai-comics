---
name: pixel-review
description: Inspect the rendered pixels against plan and references and record evidence-based findings.
origin: everything-ai-comics
category: post
---

# Pixel Review

## Purpose

Judge the image that was actually returned. A successful tool call means a
file exists. A correct prompt means the request was right. Neither says what
is in the picture. This skill opens the render, compares it with the page
plan, the reference images, and the pages on either side, and writes down
what is visible: fourteen named checks with evidence, findings for everything
that differs, two gates, and a verdict.

## Use When

- A page has a new render and `/visual-review` runs.
- `/repair-page` has produced a sibling version that needs its recheck.
- A page is about to be attached as a reference for the next one.
- An earlier review said "looks good" with nothing to back it.

## Inputs

- The render file:
  `production/issues/<ISS_ID>/pages/<PG_ID>/renders/<RENDER_ID>.png` (or
  `.jpg`), the one named in `current_render`.
- `page.yaml` for the page: layout, each panel's `moment`, the ledger rows,
  and the exact lettering text.
- The reference images listed in the page's `reference-plan.yaml`, opened as
  images.
- The current renders of the previous and the next page, when they exist.
- The prompt package's `lettering_text` and, for a repair, its `repair`
  block and the earlier review file.
- `production/project.yaml`: `repair_policy.max_cycles` and
  `reading_direction`.

## Process

1. Open the file itself. Confirm that the image on screen is the render the
   page names in `current_render`, at full resolution. A thumbnail preview
   or a description returned by the generation tool is not the render.
2. State your independence. Set `independent: true` only if you did not
   generate this image. If you did, set it to `false`, finish the review,
   and ask for a second pass by another reviewer or a person before the page
   is approved.
3. Read the whole page first, before opening `page.yaml`. Count the panels
   and follow the reading order as a new reader would. Then compare with
   `layout.tiers` and `layout.reading_order`.
4. Go through each panel at a size where faces, hands, objects, and
   lettering can be judged. Zoom in. A page viewed whole hides a sixth
   finger and a swapped accent.
5. Put the references beside the panel. Compare each face with its identity
   sheet, each outfit with its wardrobe reference, the linework with the
   look master. Compare the first panel with the last panel of the previous
   page, and the last panel with the first of the next.
6. Fill all fourteen checks with a `result` and `evidence`. Evidence
   describes pixels: which panel, what is drawn. "As specified in the
   prompt" is not evidence. Use `not_applicable` only when the page has
   nothing for the check to judge, and say why.

   | Check | Evidence to inspect | Failure examples |
   |---|---|---|
   | `identity` | Face, hair, facial hair, build, and costume against the assigned reference | The boy is drawn with the pilot's long face; a caption names one character and the drawing shows another |
   | `cast_count` | Count each named identity separately in every panel | Two versions of the same character in one panel; a character missing or replaced by a stranger |
   | `position` | Level, side, landmark, and orientation against the ledger row | A character acts from the wheelhouse they never climbed to, then stands on the deck |
   | `movement` | Trace each character's appearances and what happens between them | Unexplained teleporting; a carried character suddenly standing |
   | `role_causality` | Match the visible actor to the planned action | The wrong person fires; someone carries a wounded person and uses both hands for something else |
   | `object_identity` | Shape, type, and distinctive features across appearances | A wide-barrelled flare pistol becomes a revolver |
   | `object_custody` | Trace possession through draws, drops, pickups, and handoffs | An object appears in a hand with no plausible transfer |
   | `physical_state` | Injury, blood, damage, fatigue, and ability to move | A cut hand drawn whole; a badly hurt character acting healthy |
   | `wardrobe` | Clothing layers, equipment, accessories, and hands (bare, gloved, bandaged) | Gloves appear without a change; a torn cuff is mended; a civilian coat turns into a uniform |
   | `spatial_logic` | Travel direction, threat direction, landmarks, eyelines, levels | The ladder switches sides; the threat arrives from the wrong direction |
   | `drawing_clarity` | Hands, limbs, silhouettes, separation of bodies, points of contact | Merged bodies hide who is attacked; an impossible hand changes the action |
   | `lettering` | Exact words, accents, speaker, tail, reading order, placement | Narration missing; a tail points at the wrong person; text covers the action |
   | `page_structure` | Count panels; inspect the grid and the narrative order | Extra insets change the sequence; the last beat is missing |
   | `style_fidelity` | Line weight, black placement, texture, and color mode against the look master | Grey gradients on a pure ink page; one panel in a painted style; a spot color used outside its stated purpose |

7. Write a finding for every difference: `id`, `panel` (or `null` for the
   whole page), `check`, `expected` (from canon or the plan), `visible`
   (what the pixels show), `severity`, `repair` (the smallest change that
   would fix it), and `status: open`.
8. Mark as `blocking`: identity ambiguity, duplicated characters, impossible
   positions, broken causality, and missing critical state transitions. If
   the pixels do not establish who acts, record a blocking finding even
   when a caption supplies the name. A blocking finding can never be
   `accepted`.
9. Set the two gates. `style_fidelity` answers whether the page looks like
   this comic and rests on the check of the same name. `narrative_continuity`
   answers whether the page tells the planned story without contradiction
   and rests on the other thirteen. A gate is `fail` while a blocking
   finding behind it is open.
10. Give the verdict. `pass`: no findings, every check `pass` or
    `not_applicable`. `flagged`: a blocking finding is open, a gate fails,
    or the evidence is too ambiguous to decide. `fixed`: there were
    findings, no blocking one is open, and every finding marked `fixed` has
    a recheck.
11. Review a repair as a new render. Write a new review file for the sibling
    version with `supersedes` set to the old render and `repair_cycle` one
    higher. Open the new file and check that each requested change
    happened. Set a finding to `fixed` only then, with `recheck.render` and
    `recheck.evidence` describing what is now drawn. A repair request that
    returned without error proves nothing.
12. After a repair, check the whole page and its neighbors again for
    collateral changes to text, identities, anatomy, clothing, and
    geography. Local edits move things nobody asked them to move.
13. Stop at the limit. `repair_cycle` never exceeds
    `repair_policy.max_cycles`. A page still flagged at the limit goes back
    to its plan or its references, with the upstream cause written into the
    review's `notes`.
14. Save the review, leave `human_approval.status` as `pending`, and set the
    page's `status` to `reviewed` only when the verdict is `pass` or
    `fixed`. Then run
    `node scripts/validate-workspace.js --root <workspace> --issue <ISS_ID>`.

## Outputs

- `production/issues/<ISS_ID>/pages/<PG_ID>/reviews/<RENDER_ID>.review.yaml`
  (`visual-review.schema.json`), one per render reviewed. Earlier review
  files stay.
- `status` updated in `page.yaml` when the verdict allows it.
- A list of repairs for `page-repair`, or an upstream issue for the plan or
  the references.
- A report line that states the reviewed scope (which renders, compared
  against which references and neighbors) and any minor issues left.

## Quality Bar

- All fourteen checks have a result and evidence that names panels and
  describes what is drawn.
- `compared_against` lists the references and neighbor renders that were
  opened.
- Every finding has `expected`, `visible`, `severity`, and `repair`, and
  every `fixed` finding has a `recheck` that cites the corrected render.
- No blocking finding is `accepted`, and none is open under a `pass` or
  `fixed` verdict.
- `independent` tells the truth about who generated the image.
- `validate-workspace.js` reports no errors for the review file.
- The report keeps the script result and the visual verdict apart.

## Common Failure Modes

- Passing a page because the prompt was correct. The prompt described the
  right boy; the picture shows someone else.
- Trusting the caption: the name in the box is right, so the face goes
  unexamined.
- Reviewing at page size only and missing a hand, a prop silhouette, or a
  misspelled word.
- Checking the two defects someone reported and nothing else.
- Evidence such as "continuity checked, all good", which records nothing a
  later reader can verify.
- Marking a finding `fixed` because the edit call succeeded, without opening
  the new file.
- Rechecking only the repaired panel while the edit changed lettering in
  another.
- The generating agent reviewing its own page and recording
  `independent: true`.
- Lowering a severity to `minor` so the page can move on.

## Related Agents

- visual-reviewer
- art-director
- continuity-editor

## Related Commands

- visual-review
- repair-page

## Notes

`scripts/validate-workspace.js` checks that the review file is consistent
with itself and with the rules: a `pass` has no findings, a `fixed` finding
has a recheck, the cycle count is within the limit. It does not look at the
art. A valid review file can still be a wrong review, and only a person or
an agent looking at the image can tell.

A verdict of `pass` or `fixed` is the reviewer's judgment. Approval is the
user's, recorded separately. Do not describe a draft or a flagged page as
approved anywhere in a report.
